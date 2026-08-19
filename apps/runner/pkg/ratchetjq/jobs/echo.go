/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

package jobs

import (
	"context"

	"github.com/boxlite-ai/runner/pkg/ratchetjq"
)

// EchoType is the name Echo is registered under.
const EchoType = "echo"

// Echo hands its input straight back as its output. It performs no side
// effect at all, which makes it the type to submit when what is being
// exercised is the pipeline itself — dispatch, transport, accept — rather
// than any real work. Implementing only ISyncJob, it is also what puts
// ratchetjq.AsyncExecutor's sync-to-async adaptation on a live path.
type Echo struct {
	ratchetjq.Job
}

var (
	_ ratchetjq.IJob     = (*Echo)(nil)
	_ ratchetjq.ISyncJob = (*Echo)(nil)
)

// Type implements ratchetjq.IJob.
func (*Echo) Type() string { return EchoType }

// Attach implements ratchetjq.IJob.
func (*Echo) Attach(job ratchetjq.Job) ratchetjq.IJob { return &Echo{Job: job} }

// SyncExec returns the job's inParams unchanged as its outParams.
func (e *Echo) SyncExec(context.Context) (*ratchetjq.Result, error) {
	return &ratchetjq.Result{Status: ratchetjq.StatusOK, OutParams: e.InParams}, nil
}
