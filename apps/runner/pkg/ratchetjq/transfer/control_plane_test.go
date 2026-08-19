/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

package transfer

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	apiclient "github.com/boxlite-ai/boxlite/libs/api-client-go"
	"github.com/boxlite-ai/runner/pkg/ratchetjq"
)

// recorded is one request the fake control plane received. The tests assert on
// the wire, not on the generated client's builders: what matters is the method,
// the path and the body a real control plane would have to read.
type recorded struct {
	method string
	path   string
	body   map[string]interface{}
}

// newControlPlane points a ControlPlane at a fake control plane that answers
// every request with status and body, and records what it was asked.
//
// The generated client is configured exactly as pkg/apiclient builds the real
// one — a Configuration with one server URL — so the request this produces is
// the request production produces, with only the host changed.
func newControlPlane(t *testing.T, status int, body string) (*ControlPlane, *[]recorded) {
	t.Helper()

	var requests []recorded
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, err := io.ReadAll(r.Body)
		if err != nil {
			t.Errorf("reading the request body: %v", err)
		}

		received := recorded{method: r.Method, path: r.URL.Path}
		if len(raw) > 0 {
			if err := json.Unmarshal(raw, &received.body); err != nil {
				t.Errorf("the request body is not a JSON object: %v", err)
			}
		}
		requests = append(requests, received)

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		if _, err := io.WriteString(w, body); err != nil {
			t.Errorf("writing the response: %v", err)
		}
	}))
	t.Cleanup(server.Close)

	configuration := apiclient.NewConfiguration()
	configuration.Servers = apiclient.ServerConfigurations{{URL: server.URL}}

	transfer, err := NewControlPlane(ControlPlaneConfig{Client: apiclient.NewAPIClient(configuration)})
	if err != nil {
		t.Fatalf("NewControlPlane returned %v, want a transfer", err)
	}

	return transfer, &requests
}

func TestNewControlPlaneRefusesAMissingClient(t *testing.T) {
	if _, err := NewControlPlane(ControlPlaneConfig{}); err == nil {
		t.Fatal("NewControlPlane with no client succeeded, want an error")
	}
}

// The two things the runner decides are the budget and the claim mode, and both
// have to reach the control plane: a claim that dropped ignoreLeaseExpire would
// silently turn a restart reclaim into an ordinary poll and leave the interrupted
// jobs waiting out their leases.
func TestClaimJobsSendsTheBudgetAndTheClaimMode(t *testing.T) {
	transfer, requests := newControlPlane(t, http.StatusCreated, `{"jobs":[]}`)

	if _, err := transfer.ClaimJobs(context.Background(), 4, true); err != nil {
		t.Fatalf("ClaimJobs returned %v, want no error", err)
	}

	if len(*requests) != 1 {
		t.Fatalf("the control plane saw %d requests, want 1", len(*requests))
	}
	claim := (*requests)[0]
	if claim.method != http.MethodPost || claim.path != "/ratchetjq/jobs/claim" {
		t.Fatalf("claim went to %s %s, want POST /ratchetjq/jobs/claim", claim.method, claim.path)
	}
	if claim.body["limit"] != float64(4) {
		t.Fatalf("claim asked for limit %v, want 4", claim.body["limit"])
	}
	if claim.body["ignoreLeaseExpire"] != true {
		t.Fatalf("claim sent ignoreLeaseExpire %v, want true", claim.body["ignoreLeaseExpire"])
	}
}

// The whole point of the claim: what comes back has to be runnable, which means
// the type the factory dispatches on, the input the job type decodes, and the
// lease the run is bounded by.
func TestClaimJobsMapsRowsOntoRunnableEntities(t *testing.T) {
	transfer, _ := newControlPlane(t, http.StatusCreated, `{"jobs":[
		{"id":"job-1","type":"echo","resourceId":"box-1","inParams":{"message":"hi"},
		 "leaseExpiresAt":"2026-08-21T00:00:30.000Z"},
		{"id":"job-2","type":"echo","resourceId":"box-2","leaseExpiresAt":"2026-08-21T00:01:00.000Z"}
	]}`)

	jobs, err := transfer.ClaimJobs(context.Background(), 2, false)
	if err != nil {
		t.Fatalf("ClaimJobs returned %v, want no error", err)
	}

	if len(jobs) != 2 {
		t.Fatalf("ClaimJobs returned %d jobs, want 2", len(jobs))
	}
	if jobs[0].ID != "job-1" || jobs[0].Type != "echo" || jobs[0].ResourceID != "box-1" {
		t.Fatalf("first job = %+v, want job-1/echo/box-1", jobs[0])
	}
	if string(jobs[0].InParams) != `{"message":"hi"}` {
		t.Fatalf("first job inParams = %s, want {\"message\":\"hi\"}", jobs[0].InParams)
	}
	wantLease := time.Date(2026, 8, 21, 0, 0, 30, 0, time.UTC)
	if !jobs[0].LeaseExpiresAt.Equal(wantLease) {
		t.Fatalf("first job lease = %s, want %s", jobs[0].LeaseExpiresAt, wantLease)
	}
	// Absent input stays absent rather than becoming an empty object, which is
	// what a job type reads as "no input".
	if jobs[1].InParams != nil {
		t.Fatalf("second job inParams = %s, want nil", jobs[1].InParams)
	}
}

// The status code is what separates "this runner is not allowed" from "the
// control plane is down", and the generated client's error does not carry it.
func TestClaimJobsReportsTheHTTPStatus(t *testing.T) {
	transfer, _ := newControlPlane(t, http.StatusForbidden, `{"message":"not an executor"}`)

	_, err := transfer.ClaimJobs(context.Background(), 1, false)
	if err == nil {
		t.Fatal("ClaimJobs against a 403 succeeded, want an error")
	}
	if !strings.Contains(err.Error(), "HTTP 403") {
		t.Fatalf("error = %v, want it to name HTTP 403", err)
	}
}

func TestClaimJobsRefusesAnEmptyBudget(t *testing.T) {
	transfer, requests := newControlPlane(t, http.StatusCreated, `{"jobs":[]}`)

	if _, err := transfer.ClaimJobs(context.Background(), 0, false); err == nil {
		t.Fatal("ClaimJobs with a limit of 0 succeeded, want an error")
	}
	if len(*requests) != 0 {
		t.Fatalf("the control plane saw %d requests, want none", len(*requests))
	}
}

func TestReportPostsTheOutcomeAgainstTheJob(t *testing.T) {
	transfer, requests := newControlPlane(t, http.StatusCreated, `{"accepted":true}`)
	job := ratchetjq.Job{ID: "job-1", Type: "echo"}
	result := &ratchetjq.Result{Status: ratchetjq.StatusOK, OutParams: json.RawMessage(`{"echoed":1}`)}

	if err := transfer.Report(context.Background(), job, result, nil); err != nil {
		t.Fatalf("Report returned %v, want no error", err)
	}

	if len(*requests) != 1 {
		t.Fatalf("the control plane saw %d requests, want 1", len(*requests))
	}
	report := (*requests)[0]
	if report.method != http.MethodPost || report.path != "/ratchetjq/jobs/job-1/report" {
		t.Fatalf("report went to %s %s, want POST /ratchetjq/jobs/job-1/report", report.method, report.path)
	}
	if report.body["status"] != string(ratchetjq.StatusOK) {
		t.Fatalf("report sent status %v, want %s", report.body["status"], ratchetjq.StatusOK)
	}
	outParams, ok := report.body["outParams"].(map[string]interface{})
	if !ok || outParams["echoed"] != float64(1) {
		t.Fatalf("report sent outParams %v, want {\"echoed\":1}", report.body["outParams"])
	}
}

// A failed run has no outcome an accept round could judge, and reporting one
// would move the row out of `running` and spend the retry the failure is owed.
// Its lease is the recovery, exactly as for a runner that crashed mid-job.
func TestReportSaysNothingAboutAFailedRun(t *testing.T) {
	transfer, requests := newControlPlane(t, http.StatusCreated, `{"accepted":true}`)

	err := transfer.Report(context.Background(), ratchetjq.Job{ID: "job-1"}, nil, errors.New("the box was gone"))
	if err != nil {
		t.Fatalf("Report returned %v, want no error", err)
	}
	if len(*requests) != 0 {
		t.Fatalf("the control plane saw %d requests, want none", len(*requests))
	}
}

func TestReportRefusesNeitherAResultNorAnError(t *testing.T) {
	transfer, requests := newControlPlane(t, http.StatusCreated, `{"accepted":true}`)

	if err := transfer.Report(context.Background(), ratchetjq.Job{ID: "job-1"}, nil, nil); err == nil {
		t.Fatal("Report with no result and no error succeeded, want an error")
	}
	if len(*requests) != 0 {
		t.Fatalf("the control plane saw %d requests, want none", len(*requests))
	}
}

// The contract declares outParams an object, so a job type producing an array is
// a bug in that type — and reporting the job with its output silently dropped
// would complete it with the result missing.
func TestReportRefusesANonObjectOutput(t *testing.T) {
	transfer, requests := newControlPlane(t, http.StatusCreated, `{"accepted":true}`)
	result := &ratchetjq.Result{Status: ratchetjq.StatusOK, OutParams: json.RawMessage(`[1,2]`)}

	err := transfer.Report(context.Background(), ratchetjq.Job{ID: "job-1"}, result, nil)
	if err == nil {
		t.Fatal("Report of a non-object output succeeded, want an error")
	}
	if !strings.Contains(err.Error(), "JSON object") {
		t.Fatalf("error = %v, want it to name the object contract", err)
	}
	if len(*requests) != 0 {
		t.Fatalf("the control plane saw %d requests, want none", len(*requests))
	}
}

// A repeat report, or one for a job whose lease the Scanner took back. Normal
// under at-least-once delivery, so the poller must not be told its report failed.
func TestReportToleratesAnOutcomeThatWasNotRecorded(t *testing.T) {
	transfer, _ := newControlPlane(t, http.StatusCreated, `{"accepted":false}`)
	result := &ratchetjq.Result{Status: ratchetjq.StatusOK}

	if err := transfer.Report(context.Background(), ratchetjq.Job{ID: "job-1"}, result, nil); err != nil {
		t.Fatalf("Report returned %v, want no error", err)
	}
}

func TestReportReportsTheHTTPStatus(t *testing.T) {
	transfer, _ := newControlPlane(t, http.StatusInternalServerError, `{"message":"boom"}`)
	result := &ratchetjq.Result{Status: ratchetjq.StatusOK}

	err := transfer.Report(context.Background(), ratchetjq.Job{ID: "job-1"}, result, nil)
	if err == nil {
		t.Fatal("Report against a 500 succeeded, want an error")
	}
	if !strings.Contains(err.Error(), "HTTP 500") {
		t.Fatalf("error = %v, want it to name HTTP 500", err)
	}
}

// The interface the poller holds, satisfied by the type main.go builds. It is a
// compile-time assertion: nothing else in this package would catch a signature
// drifting from ratchetjq.Transfer.
var _ ratchetjq.Transfer = (*ControlPlane)(nil)
