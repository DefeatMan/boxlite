/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

package ratchetjq

import (
	"fmt"
	"sync"
)

// JobFactory maps a type name to the job that serves it. It is the only way
// to reach a job type, so a caller names a type and never a package — the
// same indirection asynq's ServeMux (hibiken/asynq@v0.26.0/servemux.go:101)
// and Temporal's activity registry
// (go.temporal.io/sdk@v1.48.0/internal/internal_worker.go:838) provide.
//
// What it stores is one prototype per type, keyed by that prototype's own
// Type. A job for a specific entity comes from the prototype's Attach, which
// is the spec's CreateJobExecutor (§9.4): one fresh job per delivery, so a
// job may hold state scoped to the entity it was made for.
type JobFactory struct {
	mu         sync.RWMutex
	prototypes map[string]IJob
}

// NewJobFactory returns an empty factory. Job types are added with Register.
func NewJobFactory() *JobFactory {
	return &JobFactory{prototypes: make(map[string]IJob)}
}

// Register adds a job type, keyed by the name its own IJob.Type reports.
//
// Everything that can be checked once is checked here, at process start,
// rather than on the first job that names the type: a missing prototype, an
// empty type name, a job type implementing neither run mode, and a second
// claim on a name already taken.
func (f *JobFactory) Register(prototype IJob) error {
	if prototype == nil {
		return fmt.Errorf("ratchetjq: nil job type")
	}

	jobType := prototype.Type()
	if jobType == "" {
		return fmt.Errorf("ratchetjq: job type reported an empty name")
	}
	if !runnable(prototype) {
		return fmt.Errorf("%w: job type %q", ErrNoRunMode, jobType)
	}

	f.mu.Lock()
	defer f.mu.Unlock()

	if _, taken := f.prototypes[jobType]; taken {
		return fmt.Errorf("%w: %q", ErrDuplicateJobType, jobType)
	}
	f.prototypes[jobType] = prototype

	return nil
}

// Create binds the job type named by job.Type to the entity, or reports
// ErrUnknownJobType when this runner cannot run that type at all.
func (f *JobFactory) Create(job Job) (IJob, error) {
	f.mu.RLock()
	prototype, registered := f.prototypes[job.Type]
	f.mu.RUnlock()

	if !registered {
		return nil, fmt.Errorf("%w: %q", ErrUnknownJobType, job.Type)
	}

	attached := prototype.Attach(job)
	if attached == nil {
		return nil, fmt.Errorf("ratchetjq: job type %q attached nothing", job.Type)
	}

	return attached, nil
}

// runnable reports whether a job implements a run mode any executor can call.
func runnable(job IJob) bool {
	if _, sync := job.(ISyncJob); sync {
		return true
	}
	_, async := job.(IAsyncJob)
	return async
}
