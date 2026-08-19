/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

package ratchetjq

import (
	"encoding/json"
	"errors"
	"testing"
)

// unnamed reports no type name, so it cannot be keyed in the registry.
type unnamed struct {
	syncOnly
}

func (*unnamed) Type() string { return "" }

// detached returns nothing from Attach, which would otherwise hand the
// executors a nil job.
type detached struct {
	syncOnly
}

func (*detached) Type() string    { return "detached" }
func (*detached) Attach(Job) IJob { return nil }

func TestCreateAttachesTheEntityToTheRegisteredType(t *testing.T) {
	factory := NewJobFactory()

	prototype := &syncOnly{result: &Result{Status: StatusOK}}
	if err := factory.Register(prototype); err != nil {
		t.Fatalf("Register failed: %v", err)
	}

	entity := Job{ID: "job-1", Type: "sync-only", ResourceID: "box-1", InParams: json.RawMessage(`{"in":1}`)}
	job, err := factory.Create(entity)
	if err != nil {
		t.Fatalf("Create failed: %v", err)
	}

	// The registry key comes from the job's own Type, so the name the caller
	// looks up has to be the one the implementation declares.
	if job.Type() != "sync-only" {
		t.Fatalf("job type = %q, want %q", job.Type(), "sync-only")
	}

	// The entity the control plane sent has to reach the job intact — that is
	// the whole point of the job holding its own data.
	built := job.Entity()
	if built.ID != entity.ID || built.ResourceID != entity.ResourceID {
		t.Fatalf("entity = %+v, want %+v", *built, entity)
	}
	if string(built.InParams) != string(entity.InParams) {
		t.Fatalf("inParams = %s, want %s", built.InParams, entity.InParams)
	}
}

// The registered value is one prototype shared by every delivery, so Attach
// has to hand back a new job rather than rebind the prototype — otherwise two
// jobs running at once would overwrite each other's entity.
func TestCreateLeavesThePrototypeUntouched(t *testing.T) {
	factory := NewJobFactory()

	prototype := &syncOnly{result: &Result{Status: StatusOK}}
	if err := factory.Register(prototype); err != nil {
		t.Fatalf("Register failed: %v", err)
	}

	first, err := factory.Create(Job{ID: "job-1", Type: "sync-only"})
	if err != nil {
		t.Fatalf("first Create failed: %v", err)
	}
	second, err := factory.Create(Job{ID: "job-2", Type: "sync-only"})
	if err != nil {
		t.Fatalf("second Create failed: %v", err)
	}

	if first == second {
		t.Fatal("both Creates returned the same job, want one per delivery")
	}
	if first.Entity().ID != "job-1" || second.Entity().ID != "job-2" {
		t.Fatalf("entities = %q and %q, want job-1 and job-2", first.Entity().ID, second.Entity().ID)
	}
	if prototype.Entity().ID != "" {
		t.Fatalf("prototype entity id = %q, want it left empty", prototype.Entity().ID)
	}
}

func TestCreateRejectsAnUnregisteredType(t *testing.T) {
	factory := NewJobFactory()

	_, err := factory.Create(Job{ID: "job-1", Type: "nowhere"})
	if !errors.Is(err, ErrUnknownJobType) {
		t.Fatalf("Create error = %v, want %v", err, ErrUnknownJobType)
	}
}

func TestCreateRejectsATypeThatAttachesNothing(t *testing.T) {
	factory := NewJobFactory()

	if err := factory.Register(&detached{}); err != nil {
		t.Fatalf("Register failed: %v", err)
	}
	if _, err := factory.Create(Job{ID: "job-1", Type: "detached"}); err == nil {
		t.Fatal("Create of a type that attaches nothing succeeded, want an error")
	}
}

func TestRegisterRejectsASecondClaimOnAType(t *testing.T) {
	factory := NewJobFactory()

	if err := factory.Register(&syncOnly{}); err != nil {
		t.Fatalf("first Register failed: %v", err)
	}
	if err := factory.Register(&syncOnly{}); !errors.Is(err, ErrDuplicateJobType) {
		t.Fatalf("second Register error = %v, want %v", err, ErrDuplicateJobType)
	}
}

// A type implementing neither run mode must fail at registration — process
// start — rather than on the first job that names it.
func TestRegisterRejectsATypeWithNoRunMode(t *testing.T) {
	factory := NewJobFactory()

	if err := factory.Register(&noModes{}); !errors.Is(err, ErrNoRunMode) {
		t.Fatalf("Register error = %v, want %v", err, ErrNoRunMode)
	}
	if _, err := factory.Create(Job{Type: "no-modes"}); !errors.Is(err, ErrUnknownJobType) {
		t.Fatalf("Create after a rejected Register error = %v, want %v", err, ErrUnknownJobType)
	}
}

// Async-only is a legitimate run mode: registration must accept it, and only a
// synchronous request against it may fail.
func TestRegisterAcceptsAnAsyncOnlyType(t *testing.T) {
	factory := NewJobFactory()

	if err := factory.Register(&asyncOnly{}); err != nil {
		t.Fatalf("Register failed: %v", err)
	}
	if _, err := factory.Create(Job{Type: "async-only"}); err != nil {
		t.Fatalf("Create failed: %v", err)
	}
}

func TestRegisterRejectsMalformedJobTypes(t *testing.T) {
	factory := NewJobFactory()

	if err := factory.Register(nil); err == nil {
		t.Fatal("Register(nil) succeeded, want an error")
	}
	if err := factory.Register(&unnamed{}); err == nil {
		t.Fatal("Register of a job type with an empty name succeeded, want an error")
	}
}
