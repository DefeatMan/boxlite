/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

package jobs

import (
	"context"
	"encoding/json"
	"log/slog"
	"testing"
	"time"

	"github.com/boxlite-ai/runner/pkg/ratchetjq"
)

// newRegisteredFactory brings the built-in job types up the way the runner
// does, through Startup, so the tests below run against the same registration
// path production uses.
func newRegisteredFactory(t *testing.T) *ratchetjq.JobFactory {
	t.Helper()

	factory, err := ratchetjq.Startup(context.Background(), ratchetjq.StartupConfig{
		JobTypes: JobTypes(),
		Logger:   slog.New(slog.DiscardHandler),
	})
	if err != nil {
		t.Fatalf("Startup failed: %v", err)
	}
	return factory
}

func TestEchoReturnsItsInputUnchanged(t *testing.T) {
	factory := newRegisteredFactory(t)

	inParams := json.RawMessage(`{"nested":{"n":1},"list":[1,2,3]}`)
	job, err := factory.Create(ratchetjq.Job{ID: "job-1", Type: EchoType, InParams: inParams})
	if err != nil {
		t.Fatalf("Create(%q) failed: %v", EchoType, err)
	}

	result, err := ratchetjq.SyncExecutor{}.Exec(context.Background(), job)
	if err != nil {
		t.Fatalf("Exec failed: %v", err)
	}

	if result.Status != ratchetjq.StatusOK {
		t.Fatalf("status = %q, want %q", result.Status, ratchetjq.StatusOK)
	}
	if string(result.OutParams) != string(inParams) {
		t.Fatalf("outParams = %s, want %s", result.OutParams, inParams)
	}
}

// Echo implements only ISyncJob, so reaching it through AsyncExecutor
// proves the adaptation works for a real registered job type, not just a fake.
func TestEchoIsReachableThroughAsyncExecutor(t *testing.T) {
	factory := newRegisteredFactory(t)

	inParams := json.RawMessage(`{"echo":"me"}`)
	job, err := factory.Create(ratchetjq.Job{ID: "job-1", Type: EchoType, InParams: inParams})
	if err != nil {
		t.Fatalf("Create(%q) failed: %v", EchoType, err)
	}

	type outcome struct {
		result *ratchetjq.Result
		err    error
	}
	delivered := make(chan outcome, 1)

	err = ratchetjq.AsyncExecutor{}.Exec(context.Background(), job, func(result *ratchetjq.Result, err error) {
		delivered <- outcome{result: result, err: err}
	})
	if err != nil {
		t.Fatalf("Exec failed: %v", err)
	}

	select {
	case got := <-delivered:
		if got.err != nil {
			t.Fatalf("reported error = %v, want nil", got.err)
		}
		if got.result.Status != ratchetjq.StatusOK {
			t.Fatalf("status = %q, want %q", got.result.Status, ratchetjq.StatusOK)
		}
		if string(got.result.OutParams) != string(inParams) {
			t.Fatalf("outParams = %s, want %s", got.result.OutParams, inParams)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("report was never called")
	}
}
