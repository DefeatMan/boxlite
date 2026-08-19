/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

package ratchetjq

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"
)

// --- fakes -------------------------------------------------------------------

// syncOnly implements just the inline form, so it is what exercises
// AsyncExecutor's adaptation.
type syncOnly struct {
	Job
	calls  int
	result *Result
	err    error
}

func (*syncOnly) Type() string { return "sync-only" }

func (s *syncOnly) Attach(job Job) IJob {
	return &syncOnly{Job: job, result: s.result, err: s.err}
}

func (s *syncOnly) SyncExec(context.Context) (*Result, error) {
	s.calls++
	return s.result, s.err
}

// asyncOnly implements just the callback form, so a synchronous request
// against it has nothing to fall back on.
type asyncOnly struct {
	Job
	calls  int
	result *Result
	err    error
}

func (*asyncOnly) Type() string { return "async-only" }

func (a *asyncOnly) Attach(job Job) IJob {
	return &asyncOnly{Job: job, result: a.result, err: a.err}
}

func (a *asyncOnly) AsyncExec(_ context.Context, report ReportFunc) error {
	a.calls++
	go report(a.result, a.err)
	return nil
}

// bothModes implements both forms, so each executor must reach its own.
type bothModes struct {
	Job
	syncCalls  int
	asyncCalls int
}

func (*bothModes) Type() string { return "both-modes" }

func (*bothModes) Attach(job Job) IJob { return &bothModes{Job: job} }

func (b *bothModes) SyncExec(context.Context) (*Result, error) {
	b.syncCalls++
	return &Result{Status: StatusOK}, nil
}

func (b *bothModes) AsyncExec(_ context.Context, report ReportFunc) error {
	b.asyncCalls++
	go report(&Result{Status: StatusOK}, nil)
	return nil
}

// noModes is an entity and nothing more: it can run in neither form.
type noModes struct {
	Job
}

func (*noModes) Type() string { return "no-modes" }

func (*noModes) Attach(job Job) IJob { return &noModes{Job: job} }

// panicking stands in for a job type with a bug in it.
type panicking struct {
	Job
}

func (*panicking) Type() string { return "panicking" }

func (*panicking) Attach(job Job) IJob { return &panicking{Job: job} }

func (panicking) SyncExec(context.Context) (*Result, error) {
	panic("boom")
}

// --- helpers -----------------------------------------------------------------

// outcome is one delivery through a ReportFunc.
type outcome struct {
	result *Result
	err    error
}

// collectOne returns a ReportFunc and a receive that waits for its single
// delivery, so a test fails on timeout instead of hanging.
func collectOne(t *testing.T) (ReportFunc, func() outcome) {
	t.Helper()

	delivered := make(chan outcome, 1)

	report := func(result *Result, err error) {
		delivered <- outcome{result: result, err: err}
	}

	receive := func() outcome {
		t.Helper()
		select {
		case got := <-delivered:
			return got
		case <-time.After(5 * time.Second):
			t.Fatal("report was never called")
			return outcome{}
		}
	}

	return report, receive
}

func testEntity() Job {
	return Job{ID: "job-1", InParams: json.RawMessage(`{"in":1}`)}
}

// --- SyncExecutor ------------------------------------------------------------

func TestSyncExecReturnsTheJobResult(t *testing.T) {
	job := &syncOnly{
		Job:    testEntity(),
		result: &Result{Status: StatusOK, OutParams: json.RawMessage(`{"a":1}`)},
	}

	result, err := SyncExecutor{}.Exec(context.Background(), job)
	if err != nil {
		t.Fatalf("Exec failed: %v", err)
	}
	if job.calls != 1 {
		t.Fatalf("job SyncExec calls = %d, want 1", job.calls)
	}
	if result.Status != StatusOK {
		t.Fatalf("status = %q, want %q", result.Status, StatusOK)
	}
	if string(result.OutParams) != `{"a":1}` {
		t.Fatalf("outParams = %s, want {\"a\":1}", result.OutParams)
	}
}

func TestSyncExecPropagatesTheJobError(t *testing.T) {
	wantErr := errors.New("side effect failed")
	job := &syncOnly{Job: testEntity(), err: wantErr}

	if _, err := (SyncExecutor{}).Exec(context.Background(), job); !errors.Is(err, wantErr) {
		t.Fatalf("Exec error = %v, want %v", err, wantErr)
	}
}

// A synchronous request is only servable by a job implementing ISyncJob; an
// async-only one must be refused rather than adapted.
func TestSyncExecRejectsAnAsyncOnlyJob(t *testing.T) {
	job := &asyncOnly{Job: testEntity()}

	_, err := SyncExecutor{}.Exec(context.Background(), job)
	if !errors.Is(err, ErrSyncUnsupported) {
		t.Fatalf("Exec error = %v, want %v", err, ErrSyncUnsupported)
	}
	if job.calls != 0 {
		t.Fatalf("job AsyncExec calls = %d, want 0", job.calls)
	}
}

// --- AsyncExecutor -----------------------------------------------------------

func TestAsyncExecPrefersTheJobsOwnAsyncForm(t *testing.T) {
	job := &asyncOnly{
		Job:    testEntity(),
		result: &Result{Status: StatusOK, OutParams: json.RawMessage(`{"c":3}`)},
	}
	report, receive := collectOne(t)

	if err := (AsyncExecutor{}).Exec(context.Background(), job, report); err != nil {
		t.Fatalf("Exec failed: %v", err)
	}

	got := receive()
	if got.err != nil {
		t.Fatalf("reported error = %v, want nil", got.err)
	}
	if string(got.result.OutParams) != `{"c":3}` {
		t.Fatalf("reported outParams = %s, want {\"c\":3}", got.result.OutParams)
	}
	if job.calls != 1 {
		t.Fatalf("job AsyncExec calls = %d, want 1", job.calls)
	}
}

// The other direction: a sync-only job is adapted onto a goroutine instead of
// being refused.
func TestAsyncExecAdaptsASyncOnlyJob(t *testing.T) {
	job := &syncOnly{
		Job:    testEntity(),
		result: &Result{Status: StatusOK, OutParams: json.RawMessage(`{"b":2}`)},
	}
	report, receive := collectOne(t)

	if err := (AsyncExecutor{}).Exec(context.Background(), job, report); err != nil {
		t.Fatalf("Exec failed: %v", err)
	}

	got := receive()
	if got.err != nil {
		t.Fatalf("reported error = %v, want nil", got.err)
	}
	if string(got.result.OutParams) != `{"b":2}` {
		t.Fatalf("reported outParams = %s, want {\"b\":2}", got.result.OutParams)
	}
	if job.calls != 1 {
		t.Fatalf("job SyncExec calls = %d, want 1", job.calls)
	}
}

func TestAsyncExecAdaptationReportsTheJobError(t *testing.T) {
	wantErr := errors.New("side effect failed")
	job := &syncOnly{Job: testEntity(), err: wantErr}
	report, receive := collectOne(t)

	if err := (AsyncExecutor{}).Exec(context.Background(), job, report); err != nil {
		t.Fatalf("Exec failed: %v", err)
	}

	if got := receive(); !errors.Is(got.err, wantErr) {
		t.Fatalf("reported error = %v, want %v", got.err, wantErr)
	}
}

// A panic on the adaptation's goroutine cannot be recovered by the caller, so
// it has to come back as the job's error rather than end the process.
func TestAsyncExecAdaptationTurnsAPanicIntoTheJobError(t *testing.T) {
	job := &panicking{Job: testEntity()}
	report, receive := collectOne(t)

	if err := (AsyncExecutor{}).Exec(context.Background(), job, report); err != nil {
		t.Fatalf("Exec failed: %v", err)
	}

	got := receive()
	if !errors.Is(got.err, ErrExecutorPanic) {
		t.Fatalf("reported error = %v, want %v", got.err, ErrExecutorPanic)
	}
	if got.result != nil {
		t.Fatalf("reported result = %+v, want nil", got.result)
	}
}

func TestAsyncExecRejectsAJobWithNoRunMode(t *testing.T) {
	report, _ := collectOne(t)

	err := (AsyncExecutor{}).Exec(context.Background(), &noModes{Job: testEntity()}, report)
	if !errors.Is(err, ErrNoRunMode) {
		t.Fatalf("Exec error = %v, want %v", err, ErrNoRunMode)
	}
}

func TestAsyncExecRejectsANilReportCallback(t *testing.T) {
	job := &syncOnly{Job: testEntity(), result: &Result{Status: StatusOK}}

	if err := (AsyncExecutor{}).Exec(context.Background(), job, nil); err == nil {
		t.Fatal("Exec with a nil report callback succeeded, want an error")
	}
}

// A job implementing both forms must have each executor reach its own — no
// adaptation, in either direction.
func TestBothFormsAreUsedByTheirOwnExecutor(t *testing.T) {
	job := &bothModes{Job: testEntity()}

	if _, err := (SyncExecutor{}).Exec(context.Background(), job); err != nil {
		t.Fatalf("SyncExecutor.Exec failed: %v", err)
	}
	if job.syncCalls != 1 || job.asyncCalls != 0 {
		t.Fatalf("after SyncExecutor: syncCalls = %d, asyncCalls = %d, want 1 and 0", job.syncCalls, job.asyncCalls)
	}

	report, receive := collectOne(t)
	if err := (AsyncExecutor{}).Exec(context.Background(), job, report); err != nil {
		t.Fatalf("AsyncExecutor.Exec failed: %v", err)
	}
	receive()

	if job.syncCalls != 1 || job.asyncCalls != 1 {
		t.Fatalf("after AsyncExecutor: syncCalls = %d, asyncCalls = %d, want 1 and 1", job.syncCalls, job.asyncCalls)
	}
}
