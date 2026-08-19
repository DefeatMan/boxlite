/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

package controllers

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/boxlite-ai/runner/pkg/common"
	"github.com/boxlite-ai/runner/pkg/ratchetjq"
	"github.com/boxlite-ai/runner/pkg/ratchetjq/jobs"
	"github.com/gin-gonic/gin"

	common_errors "github.com/boxlite-ai/common-go/pkg/errors"
)

// asyncOnlyJob runs only through a callback, so the synchronous endpoint has
// no inline form of it to call.
type asyncOnlyJob struct {
	ratchetjq.Job
}

func (*asyncOnlyJob) Type() string { return "async-only" }

func (*asyncOnlyJob) Attach(job ratchetjq.Job) ratchetjq.IJob {
	return &asyncOnlyJob{Job: job}
}

func (*asyncOnlyJob) AsyncExec(_ context.Context, report ratchetjq.ReportFunc) error {
	go report(&ratchetjq.Result{Status: ratchetjq.StatusOK}, nil)
	return nil
}

// postSyncJob routes body through the same middleware chain production uses,
// so ctx.Error is translated into a status code the way it is at runtime.
func postSyncJob(t *testing.T, body string) *httptest.ResponseRecorder {
	t.Helper()

	// Startup is how the runner registers job types, so the endpoint is
	// tested against the same factory production hands it. The async-only
	// type rides along to cover the call style the endpoint must refuse.
	factory, err := ratchetjq.Startup(context.Background(), ratchetjq.StartupConfig{
		JobTypes: append(jobs.JobTypes(), &asyncOnlyJob{}),
		Logger:   slog.New(slog.DiscardHandler),
	})
	if err != nil {
		t.Fatalf("Startup failed: %v", err)
	}

	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.Use(common_errors.NewErrorMiddleware(common.HandlePossibleDockerError))
	router.POST("/ratchetjq/jobs/sync", SyncRatchetJob(factory, slog.Default()))

	request := httptest.NewRequest(http.MethodPost, "/ratchetjq/jobs/sync", strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")

	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	return recorder
}

func TestSyncRatchetJobRunsTheEchoJob(t *testing.T) {
	recorder := postSyncJob(t, `{"id":"job-1","type":"echo","resourceId":"box-1","inParams":{"echo":"me"}}`)

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d (body: %s)", recorder.Code, http.StatusOK, recorder.Body)
	}

	var response struct {
		Id        string          `json:"id"`
		Status    string          `json:"status"`
		OutParams json.RawMessage `json:"outParams"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatalf("decoding response failed: %v (body: %s)", err, recorder.Body)
	}

	if response.Id != "job-1" {
		t.Fatalf("id = %q, want %q", response.Id, "job-1")
	}
	if response.Status != string(ratchetjq.StatusOK) {
		t.Fatalf("status = %q, want %q", response.Status, ratchetjq.StatusOK)
	}
	if string(response.OutParams) != `{"echo":"me"}` {
		t.Fatalf("outParams = %s, want {\"echo\":\"me\"}", response.OutParams)
	}
}

func TestSyncRatchetJobRejectsAnUnregisteredType(t *testing.T) {
	recorder := postSyncJob(t, `{"id":"job-1","type":"nowhere"}`)

	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d (body: %s)", recorder.Code, http.StatusBadRequest, recorder.Body)
	}
}

// A registered type that only runs asynchronously is a conflict with the call
// style asked for, not a malformed request and not a runner fault.
func TestSyncRatchetJobRejectsAnAsyncOnlyType(t *testing.T) {
	recorder := postSyncJob(t, `{"id":"job-1","type":"async-only"}`)

	if recorder.Code != http.StatusConflict {
		t.Fatalf("status = %d, want %d (body: %s)", recorder.Code, http.StatusConflict, recorder.Body)
	}
}

func TestSyncRatchetJobRejectsAMalformedBody(t *testing.T) {
	recorder := postSyncJob(t, `{"id":`)

	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d (body: %s)", recorder.Code, http.StatusBadRequest, recorder.Body)
	}
}
