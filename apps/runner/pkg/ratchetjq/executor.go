/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

package ratchetjq

import (
	"context"
	"errors"
	"fmt"
)

var (
	// ErrUnknownJobType means no job type is registered under the name the
	// caller used.
	ErrUnknownJobType = errors.New("ratchetjq: unknown job type")

	// ErrSyncUnsupported means the job runs only asynchronously, so a
	// synchronous request against it cannot be served.
	ErrSyncUnsupported = errors.New("ratchetjq: job type does not support synchronous execution")

	// ErrNoRunMode means a job type implements neither ISyncJob nor
	// IAsyncJob, so nothing could ever run it.
	ErrNoRunMode = errors.New("ratchetjq: job type implements neither ISyncJob nor IAsyncJob")

	// ErrDuplicateJobType means two constructors claim the same job type.
	ErrDuplicateJobType = errors.New("ratchetjq: job type already registered")

	// ErrExecutorPanic means a job panicked while running.
	ErrExecutorPanic = errors.New("ratchetjq: job panicked")
)

// SyncExecutor runs a job inline. The zero value is ready to use.
//
// It is the strict half of the pair: a synchronous request is only servable by
// a job that implements ISyncJob, and one that does not is refused rather than
// served by blocking on IAsyncJob's callback — adapting that direction would
// leave the caller's request timeout as the only bound on a run the job type
// never promised to finish inline.
type SyncExecutor struct{}

// Exec runs job through its ISyncJob form, or reports ErrSyncUnsupported when
// it has none.
//
// A panic comes back as an ErrExecutorPanic error rather than unwinding into
// the caller. The caller here is an HTTP handler behind gin's recovery, so the
// panic would be survivable either way — but it would reach the control plane
// as a 500, which says the runner is broken, when what happened is that one job
// failed. Recovering makes it an outcome the control plane can record and
// compensate, the same one the pulled path already produces.
func (SyncExecutor) Exec(ctx context.Context, job IJob) (*Result, error) {
	syncJob, isSync := job.(ISyncJob)
	if !isSync {
		return nil, fmt.Errorf("%w: job type %q", ErrSyncUnsupported, job.Type())
	}
	return runSyncRecovered(ctx, syncJob)
}

// AsyncExecutor runs a job through a callback. The zero value is ready to use.
//
// It is the accommodating half of the pair: it prefers a job's own IAsyncJob
// form and falls back to adapting its ISyncJob one, which is what lets a job
// type implement only the inline side and still be pollable.
type AsyncExecutor struct{}

// Exec starts job and delivers its outcome to report exactly once.
//
// A job with an IAsyncJob form owns its own scheduling and is called directly.
// A sync-only job is adapted instead: its run moves onto a goroutine of its
// own and report fires when that run returns. The goroutine is one per job the
// caller already asked to start, so the adaptation adds no concurrency the
// caller did not choose — but ctx has to outlive Exec's return, because that
// goroutine keeps running under it.
func (AsyncExecutor) Exec(ctx context.Context, job IJob, report ReportFunc) error {
	if report == nil {
		return fmt.Errorf("ratchetjq: nil report callback for job type %q", job.Type())
	}

	if asyncJob, isAsync := job.(IAsyncJob); isAsync {
		return asyncJob.AsyncExec(ctx, report)
	}

	syncJob, isSync := job.(ISyncJob)
	if !isSync {
		return fmt.Errorf("%w: job type %q", ErrNoRunMode, job.Type())
	}

	go func() {
		// report is called outside the recover in runSyncRecovered, so a
		// panic raised by report itself cannot loop back and report twice.
		report(runSyncRecovered(ctx, syncJob))
	}()

	return nil
}

// runSyncRecovered runs a sync job and turns a panic into the job's error, so
// that both executors treat a panicking job type as one failed job rather than
// as a fault of the process running it.
//
// The two need it for different reasons. AsyncExecutor calls it from a
// goroutine of its own, where an escaping panic has no one to recover it and
// takes the whole runner down. SyncExecutor calls it from a request handler
// that would survive, but would answer the control plane with a 500 instead of
// the failure the job actually had.
func runSyncRecovered(ctx context.Context, job ISyncJob) (result *Result, err error) {
	defer func() {
		if recovered := recover(); recovered != nil {
			result = nil
			err = fmt.Errorf("%w: job type %q: %v", ErrExecutorPanic, job.Type(), recovered)
		}
	}()

	return job.SyncExec(ctx)
}
