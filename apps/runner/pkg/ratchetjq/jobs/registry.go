/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

// Package jobs holds the RatchetJQ job types this runner can execute, as one
// static list that ratchetjq.Startup turns into a factory.
//
// It depends on the ratchetjq framework and the framework never depends on
// it, so a job type can pull in whatever runtime it needs — the box backend,
// the object store — without the framework inheriting those dependencies.
package jobs

import "github.com/boxlite-ai/runner/pkg/ratchetjq"

// jobTypes is the static list of job types this runner can run, one prototype
// each. Adding a job type is one line here; nothing else has to be told
// about it.
//
// The entries carry no entity: the factory keys them by their own Type and
// calls Attach to bind one to each delivered job.
var jobTypes = []ratchetjq.IJob{
	&Echo{},
}

// JobTypes returns every built-in job type, for ratchetjq.Startup to
// register. The slice is copied so a caller cannot reshape the static list.
func JobTypes() []ratchetjq.IJob {
	return append([]ratchetjq.IJob(nil), jobTypes...)
}
