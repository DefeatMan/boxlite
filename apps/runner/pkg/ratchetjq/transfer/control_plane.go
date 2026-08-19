/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

// Package transfer carries the runner's half of the TRANSFER role over REST to
// the control plane (spec §6, §9.3).
//
// It sits beside the ratchetjq core rather than inside it so that the core —
// job types, the factory, the poller, the two executors — stays free of the
// generated API client and of any transport at all. What crosses this boundary
// is only ratchetjq.Job and ratchetjq.Result, which is what lets the poller be
// tested against a fake and lets this be tested against an HTTP server.
package transfer

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"

	apiclient "github.com/boxlite-ai/boxlite/libs/api-client-go"
	"github.com/boxlite-ai/runner/pkg/ratchetjq"
)

// ControlPlaneConfig configures ControlPlane. Client is required; everything
// else about how to reach the control plane — base URL, the runner's bearer
// token, the OTel-instrumented transport — is already decided by whoever built
// that client (pkg/apiclient.GetApiClient), which is why this takes one rather
// than a URL and a token of its own.
type ControlPlaneConfig struct {
	Client *apiclient.APIClient
	Logger *slog.Logger
}

// ControlPlane is the default Transfer: it claims and reports against the
// control plane's RatchetJQ endpoints.
//
// Which runner is calling is never sent. Both endpoints derive the executor pair
// from the authenticated caller, so the bearer token on the client *is* the
// identity — a runner cannot claim, or report against, another runner's jobs
// even by asking.
//
// It holds no state beyond its client, so one instance serves the whole poll
// loop and every concurrent report the poller fires from its dispatched jobs.
type ControlPlane struct {
	client *apiclient.APIClient
	log    *slog.Logger
}

// NewControlPlane builds the Transfer. It refuses a missing client rather than
// deferring the failure to the first poll, where it would look like the control
// plane being unreachable.
func NewControlPlane(cfg ControlPlaneConfig) (*ControlPlane, error) {
	if cfg.Client == nil {
		return nil, fmt.Errorf("ratchetjq transfer: an API client is required")
	}

	log := cfg.Logger
	if log == nil {
		log = slog.Default()
	}

	return &ControlPlane{client: cfg.Client, log: log.With(slog.String("component", "ratchetjq-transfer"))}, nil
}

// ClaimJobs implements ratchetjq.Transfer.
//
// The call blocks for as long as the control plane holds it — the claim is a
// long poll that waits until the next job falls due, capped server-side — so it
// is bounded by ctx and by nothing here. A client timeout would be the wrong
// bound: it would cut short exactly the wait that makes the pushed path
// unnecessary.
//
// A claim asking for nothing is refused rather than sent. The poller only calls
// with free capacity, so a limit of zero is a bug worth naming here instead of
// spending a round trip to be told the same thing.
func (c *ControlPlane) ClaimJobs(ctx context.Context, limit int, ignoreLeaseExpire bool) ([]ratchetjq.Job, error) {
	if limit <= 0 {
		return nil, fmt.Errorf("ratchetjq transfer: a claim needs a positive limit, got %d", limit)
	}

	body := apiclient.NewClaimRatchetJQJobsRequest()
	claimLimit := float32(limit)
	body.Limit = &claimLimit
	body.IgnoreLeaseExpire = &ignoreLeaseExpire

	claimed, response, err := c.client.RatchetjqAPI.ClaimRatchetJQJobs(ctx).ClaimRatchetJQJobsRequest(*body).Execute()
	if err != nil {
		return nil, fmt.Errorf("ratchetjq transfer: claiming jobs%s: %w", statusSuffix(response), err)
	}
	if claimed == nil {
		// A 2xx with no body is not an empty claim, it is a contract this side
		// cannot read: reporting it as "no jobs" would hide it behind a poll
		// loop that looks merely idle.
		return nil, fmt.Errorf("ratchetjq transfer: claiming jobs returned no body")
	}

	jobs := make([]ratchetjq.Job, 0, len(claimed.Jobs))
	for _, job := range claimed.Jobs {
		entity, err := toEntity(job)
		if err != nil {
			return nil, fmt.Errorf("ratchetjq transfer: reading a claimed job: %w", err)
		}
		jobs = append(jobs, entity)
	}

	return jobs, nil
}

// Report implements ratchetjq.Transfer.
//
// A run that raised is reported, as StatusFailed carrying the error text. The
// alternative — staying silent and letting the lease redeliver — spends every
// round the job has on an error that will very likely repeat, and then retires
// it as a timeout that says nothing about what went wrong, because the reason
// never left this process. Reporting hands the control plane something its
// accept segment can act on and its operators can read.
//
// A run that never finished is still not reported, and roundLost is the line
// between the two: a job cancelled because its own lease lapsed has not failed,
// it has been taken back, and the row may already belong to another round. That
// one keeps the original recovery — say nothing, let the lease redeliver — which
// is also the path a runner that crashed mid-job takes.
//
// An outcome the control plane did not record is not an error either. `accepted:
// false` means this runner held no `running` row of that id — a repeat report, or
// a job whose lease the Scanner took back while the run was in flight — and
// neither is worth failing a poll over.
func (c *ControlPlane) Report(ctx context.Context, job ratchetjq.Job, result *ratchetjq.Result, runErr error) error {
	if runErr != nil {
		if roundLost(runErr) {
			c.log.DebugContext(ctx, "Not reporting a RatchetJQ run that lost its round; its lease is what redelivers it",
				slog.String("job_id", job.ID),
				slog.String("job_type", job.Type),
				slog.Any("error", runErr),
			)
			return nil
		}

		body := apiclient.NewReportRatchetJQJobRequest(string(ratchetjq.StatusFailed))
		body.SetErrMsg(runErr.Error())

		return c.send(ctx, job, body)
	}
	if result == nil {
		return fmt.Errorf("ratchetjq transfer: reporting job %s needs either a result or an error", job.ID)
	}

	body := apiclient.NewReportRatchetJQJobRequest(string(result.Status))
	outParams, err := toParams(result.OutParams)
	if err != nil {
		return fmt.Errorf("ratchetjq transfer: reporting job %s: %w", job.ID, err)
	}
	body.OutParams = outParams

	return c.send(ctx, job, body)
}

// roundLost says whether a run ended because the round it was running in ended,
// rather than because the job itself failed.
//
// The poller gives every run a context bounded by the lease the control plane
// granted (poller.go:dispatch), so a deadline here means this runner no longer
// holds the job — reporting an outcome for it could overwrite a round somebody
// else has already been given. A plain cancellation means the runner is shutting
// down, which is the same story: nobody here is entitled to close the job.
//
// A job that wraps a context error of its own — an internal call that timed out
// — reads as a lost round and is redelivered instead of reported. That is the
// behaviour every failure had before, so the cost of the false positive is the
// old path rather than a wrong one.
func roundLost(runErr error) bool {
	return errors.Is(runErr, context.DeadlineExceeded) || errors.Is(runErr, context.Canceled)
}

// send puts one already-built outcome on the wire. Both shapes of report — an
// outcome and a failure — differ only in the body, so the call, the error
// wrapping and the not-recorded warning live here once.
func (c *ControlPlane) send(ctx context.Context, job ratchetjq.Job, body *apiclient.ReportRatchetJQJobRequest) error {
	reported, response, err := c.client.RatchetjqAPI.
		ReportRatchetJQJob(ctx, job.ID).
		ReportRatchetJQJobRequest(*body).
		Execute()
	if err != nil {
		return fmt.Errorf("ratchetjq transfer: reporting job %s%s: %w", job.ID, statusSuffix(response), err)
	}

	if reported != nil && !reported.Accepted {
		c.log.WarnContext(ctx, "The control plane held no running RatchetJQ job to record this outcome against",
			slog.String("job_id", job.ID),
			slog.String("job_type", job.Type),
		)
	}

	return nil
}

// toEntity maps one claimed row onto the entity the executor runs.
//
// `inParams` changes representation here and nowhere else: the generated client
// decodes it into a map, while a job type owns its own shape and so takes it
// raw. Re-encoding is what keeps that ownership — this layer never has to know
// what a job type's input looks like.
func toEntity(job apiclient.ClaimedRatchetJQJob) (ratchetjq.Job, error) {
	entity := ratchetjq.Job{
		ID:             job.Id,
		Type:           job.Type,
		ResourceID:     job.ResourceId,
		LeaseExpiresAt: job.LeaseExpiresAt,
	}

	// An absent input and an empty one are the same thing to a job type: both
	// leave InParams nil, which is what "the type takes no input" looks like.
	if len(job.InParams) == 0 {
		return entity, nil
	}

	raw, err := json.Marshal(job.InParams)
	if err != nil {
		return ratchetjq.Job{}, fmt.Errorf("encoding the inParams of job %s: %w", job.Id, err)
	}
	entity.InParams = raw

	return entity, nil
}

// toParams maps a job's output back into what the client sends.
//
// A non-object output is refused rather than dropped: the contract declares
// `outParams` an object, so a job type producing an array or a scalar is a bug
// in that type, and silently reporting no output would complete the job with its
// result missing.
func toParams(raw json.RawMessage) (map[string]interface{}, error) {
	if len(raw) == 0 {
		return nil, nil
	}

	var params map[string]interface{}
	if err := json.Unmarshal(raw, &params); err != nil {
		return nil, fmt.Errorf("outParams must be a JSON object: %w", err)
	}

	return params, nil
}

// statusSuffix names the HTTP status in an error when there is one. The
// generated client's error already carries the body, but not the code, and the
// code is what separates "this runner is not allowed" from "the control plane is
// down".
func statusSuffix(response *http.Response) string {
	if response == nil {
		return ""
	}

	return fmt.Sprintf(" (HTTP %d)", response.StatusCode)
}
