/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

// Package ratchetjq implements the runner half of RatchetJQ: the EXECUTOR
// role of the design (spec §0), whose whole job is to perform a job's side
// effect and hand back its output.
//
// The job is the entity and it carries its own behaviour: a job type embeds
// Job for the data and implements ISyncJob, IAsyncJob, or both for the work.
// SyncExecutor and AsyncExecutor are thin wrappers that call into those, so
// dispatch is one step — the control plane names a type, JobFactory builds
// that type's job, and an executor runs it.
//
// Delivery is at-least-once (spec §0): an expired lease means redelivery, so
// every job type implemented here must be idempotent. The same job may reach
// this runner more than once, and re-running it must land the same state
// rather than a second side effect.
package ratchetjq

import (
	"context"
	"encoding/json"
	"time"
)

// Status is a job's business result. The spec keeps it deliberately separate
// from the scheduling stage (`period`, §2.4), which only the control plane
// owns and which never reaches this layer. The full enum is left open by the
// spec (§12-2); the value defined here is the one this runner produces.
type Status string

// StatusOK reports that the side effect landed and OutParams holds its result.
const StatusOK Status = "ok"

// Job is the entity an executor runs: the fields of the job row (spec §2.1)
// that cross the wire to the runner. A job type embeds it, which gives that
// type both the data and Entity, so it satisfies part of IJob for free.
//
// Carrying Type here is what lets a claimed job travel as one value: the
// factory reads the name off the entity itself, so nothing has to pair an
// entity with a separate type string on the way in.
//
// The scheduling columns — period, visibleAt, attempt, ttl — are absent. They
// belong to the control plane, and nothing in this layer may act on them: a
// runner that read its own backoff or attempt count would be second-guessing
// the scheduler that granted them. LeaseExpiresAt is the one exception, and it
// is not second-guessing but the opposite: it is how long the scheduler said
// this runner may hold the job, and a runner that runs past it is executing a
// job that may already have been handed to someone else.
type Job struct {
	// ID identifies the job row the outcome is reported against.
	ID string
	// Type names the job type to run this entity, and is the key JobFactory
	// looks up. It matches the name that type's own IJob.Type reports.
	//
	// A job type embedding Job also declares a Type method, which shadows
	// this field on that type. Callers holding a plain Job — the factory and
	// the poller — read the field directly; inside a job type's own methods
	// the name resolves to the method, so reach the string as Entity().Type
	// there.
	Type string
	// ResourceID names the resource the side effect touches. It is part of
	// the control plane's exclusion key (spec §2.6); here it only identifies
	// the target in logs and errors.
	ResourceID string
	// InParams is the job input. Its shape is defined by the job type, so it
	// stays raw until the type that understands it decodes it.
	InParams json.RawMessage
	// LeaseExpiresAt is when this runner's claim on the job lapses (spec §2.3),
	// as the control plane stamped it while claiming. It is the deadline a run
	// is given: past it the job is claimable again, so a runner still working on
	// it is racing whoever picked it up next.
	//
	// The zero value means the job arrived without one, which the poller treats
	// as "use the local default" rather than "no deadline" — an unbounded run
	// would hold its slot for the process's whole life.
	LeaseExpiresAt time.Time
}

// Entity implements half of IJob. The receiver is a pointer, so a job type
// has to be used through a pointer — &Echo{Job: job} — for the promotion
// to apply.
func (j *Job) Entity() *Job { return j }

// Result is what a job produces.
type Result struct {
	// Status is the business outcome.
	Status Status
	// OutParams is the job output, shaped by the job type.
	OutParams json.RawMessage
}

// ReportFunc receives one job's outcome exactly once: a result, or the error
// that stopped the run — when err is non-nil the result carries nothing. The
// caller supplies it and closes over the job it belongs to; in the poller that
// callback is the REST report back to the PROPOSER (spec §9.4).
type ReportFunc func(result *Result, err error)

// IJob is what every job type provides: the type name the control plane
// dispatches on, the entity it was built from, and a way to bind itself to a
// new entity. Naming the type on the implementation is what makes it the
// single source of truth — JobFactory keys the registry off it rather than
// off a string passed at the registration call site, the same shape as
// River's JobArgs.Kind() (riverqueue/river@v0.44.0/worker.go:177).
//
// On its own a job is not runnable — it becomes so by also implementing
// ISyncJob, IAsyncJob, or both.
type IJob interface {
	Type() string
	Entity() *Job

	// Attach returns this job type bound to job. The value it is called on is
	// the prototype the factory holds, shared by every job of the type, so an
	// implementation must return a new value and never mutate its receiver —
	// otherwise two jobs running at once would trample each other's entity.
	Attach(job Job) IJob
}

// ISyncJob is a job that runs inline and returns its own outcome. This is the
// spec's JobExecutor.SyncRun and JobExecutor.Exec (§9.4) — one operation under
// two names there, because the pushed and pulled paths reach it differently.
type ISyncJob interface {
	IJob
	SyncExec(ctx context.Context) (*Result, error)
}

// IAsyncJob is a job that starts work and delivers its outcome later through
// report. A job type implements this when its side effect is already
// asynchronous — waiting on a completion event, say — and holding a caller
// blocked for it would buy nothing.
type IAsyncJob interface {
	IJob
	AsyncExec(ctx context.Context, report ReportFunc) error
}
