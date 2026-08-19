/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

package ratchetjq

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"strings"
	"sync"
	"testing"
	"time"
)

// --- fake transfer -----------------------------------------------------------

// fakeTransfer scripts what each claim round hands over and records what came
// back, so a test can drive the poller through a fixed sequence of rounds.
type fakeTransfer struct {
	mu sync.Mutex

	rounds  [][]Job // consumed one per ClaimJobs call
	claims  int
	limits  []int  // the limit asked for on each claim, in order
	ignored []bool // ignoreLeaseExpire passed on each claim, in order

	reported  []reportedOutcome
	reportErr error

	claimed chan struct{} // signalled after every claim
	reports chan struct{} // signalled after every report

	panicOnClaim int // claim round number that panics, 1-based; 0 never
}

type reportedOutcome struct {
	job    Job
	result *Result
	runErr error
}

func newFakeTransfer(rounds ...[]Job) *fakeTransfer {
	return &fakeTransfer{
		rounds:  rounds,
		claimed: make(chan struct{}, 64),
		reports: make(chan struct{}, 64),
	}
}

func (f *fakeTransfer) ClaimJobs(_ context.Context, limit int, ignoreLeaseExpire bool) ([]Job, error) {
	f.mu.Lock()
	f.claims++
	round := f.claims
	f.limits = append(f.limits, limit)
	f.ignored = append(f.ignored, ignoreLeaseExpire)
	var claimed []Job
	if round <= len(f.rounds) {
		claimed = f.rounds[round-1]
	}
	shouldPanic := f.panicOnClaim == round
	f.mu.Unlock()

	f.claimed <- struct{}{}

	if shouldPanic {
		panic("transfer exploded")
	}
	return claimed, nil
}

func (f *fakeTransfer) Report(_ context.Context, job Job, result *Result, runErr error) error {
	f.mu.Lock()
	f.reported = append(f.reported, reportedOutcome{job: job, result: result, runErr: runErr})
	err := f.reportErr
	f.mu.Unlock()

	f.reports <- struct{}{}
	return err
}

func (f *fakeTransfer) claimCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.claims
}

func (f *fakeTransfer) claimLimits() []int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]int(nil), f.limits...)
}

func (f *fakeTransfer) claimIgnores() []bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]bool(nil), f.ignored...)
}

func (f *fakeTransfer) outcomes() []reportedOutcome {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]reportedOutcome(nil), f.reported...)
}

// failingClaimTransfer makes the first ClaimJobs calls fail at the transport
// level, which the poller must treat as an empty round.
type failingClaimTransfer struct {
	*fakeTransfer
	mu           sync.Mutex
	failuresLeft int
}

func (f *failingClaimTransfer) ClaimJobs(ctx context.Context, limit int, ignoreLeaseExpire bool) ([]Job, error) {
	f.mu.Lock()
	failing := f.failuresLeft > 0
	if failing {
		f.failuresLeft--
	}
	f.mu.Unlock()

	claimed, err := f.fakeTransfer.ClaimJobs(ctx, limit, ignoreLeaseExpire)
	if failing {
		return nil, errors.New("control plane unreachable")
	}
	return claimed, err
}

// --- helpers -----------------------------------------------------------------

func quietLogger() *slog.Logger { return slog.New(slog.DiscardHandler) }

// recordingLogger keeps every record at or above level, so a test can assert on
// what the poller actually logged rather than only on what it did.
type recordingLogger struct {
	slog.Handler
	mu      sync.Mutex
	level   slog.Level
	records []slog.Record
}

func newRecordingLogger(level slog.Level) *recordingLogger {
	return &recordingLogger{Handler: slog.DiscardHandler, level: level}
}

func (r *recordingLogger) Enabled(_ context.Context, level slog.Level) bool {
	return level >= r.level
}

func (r *recordingLogger) Handle(_ context.Context, record slog.Record) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.records = append(r.records, record)
	return nil
}

// WithAttrs and WithGroup return the recorder itself: Startup calls With to tag
// the component, and a copy would send those records somewhere this cannot read.
func (r *recordingLogger) WithAttrs([]slog.Attr) slog.Handler { return r }
func (r *recordingLogger) WithGroup(string) slog.Handler      { return r }

func (r *recordingLogger) logger() *slog.Logger { return slog.New(r) }

// messagesAt returns the messages logged at exactly level, in order.
func (r *recordingLogger) messagesAt(level slog.Level) []string {
	r.mu.Lock()
	defer r.mu.Unlock()

	var messages []string
	for _, record := range r.records {
		if record.Level == level {
			messages = append(messages, record.Message)
		}
	}
	return messages
}

// attr returns the value of the named attribute on the first record whose
// message contains substring, and whether such a record was found.
func (r *recordingLogger) attr(substring, name string) (slog.Value, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()

	for _, record := range r.records {
		if !strings.Contains(record.Message, substring) {
			continue
		}

		var found slog.Value
		var ok bool
		record.Attrs(func(a slog.Attr) bool {
			if a.Key == name {
				found, ok = a.Value, true
				return false
			}
			return true
		})
		return found, ok
	}
	return slog.Value{}, false
}

// echoJob hands its input back, so a poller test can assert that the entity
// travelled all the way from a claim to a report.
type echoJob struct {
	Job
}

func (*echoJob) Type() string        { return "echo" }
func (*echoJob) Attach(job Job) IJob { return &echoJob{Job: job} }

func (e *echoJob) SyncExec(context.Context) (*Result, error) {
	return &Result{Status: StatusOK, OutParams: e.InParams}, nil
}

// awaitSignal waits for one send on ch, failing the test rather than hanging.
func awaitSignal(t *testing.T, ch <-chan struct{}, what string) {
	t.Helper()
	select {
	case <-ch:
	case <-time.After(5 * time.Second):
		t.Fatalf("timed out waiting for %s", what)
	}
}

// --- registration ------------------------------------------------------------

func TestStartupRegistersEveryJobType(t *testing.T) {
	factory, err := Startup(context.Background(), StartupConfig{
		JobTypes: []IJob{&echoJob{}},
		Logger:   quietLogger(),
	})
	if err != nil {
		t.Fatalf("Startup failed: %v", err)
	}

	if _, err := factory.Create(Job{ID: "job-1", Type: "echo"}); err != nil {
		t.Fatalf("Create after Startup failed: %v", err)
	}
}

func TestStartupFailsOnAJobTypeThatCannotRun(t *testing.T) {
	_, err := Startup(context.Background(), StartupConfig{
		JobTypes: []IJob{&noModes{}},
		Logger:   quietLogger(),
	})
	if !errors.Is(err, ErrNoRunMode) {
		t.Fatalf("Startup error = %v, want %v", err, ErrNoRunMode)
	}
}

// Without a transfer there is no pulled path, but the pushed one still has to
// come up — that is the configuration the runner ships in today.
func TestStartupWithoutATransferStillReturnsAUsableFactory(t *testing.T) {
	factory, err := Startup(context.Background(), StartupConfig{
		JobTypes: []IJob{&echoJob{}},
		Logger:   quietLogger(),
	})
	if err != nil {
		t.Fatalf("Startup failed: %v", err)
	}
	if factory == nil {
		t.Fatal("Startup returned a nil factory")
	}
}

// --- poller ------------------------------------------------------------------

func TestStartupRunsClaimedJobsAndReportsTheirOutcome(t *testing.T) {
	claimed := Job{ID: "job-1", Type: "echo", InParams: json.RawMessage(`{"in":1}`)}
	transfer := newFakeTransfer([]Job{claimed})

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	if _, err := Startup(ctx, StartupConfig{
		JobTypes: []IJob{&echoJob{}},
		Transfer: transfer,
		Logger:   quietLogger(),
		PollWait: time.Millisecond,
	}); err != nil {
		t.Fatalf("Startup failed: %v", err)
	}

	awaitSignal(t, transfer.reports, "the job outcome")

	outcomes := transfer.outcomes()
	if len(outcomes) != 1 {
		t.Fatalf("reported outcomes = %d, want 1", len(outcomes))
	}
	if outcomes[0].runErr != nil {
		t.Fatalf("reported error = %v, want nil", outcomes[0].runErr)
	}
	if outcomes[0].job.ID != "job-1" {
		t.Fatalf("reported job id = %q, want %q", outcomes[0].job.ID, "job-1")
	}
	if string(outcomes[0].result.OutParams) != `{"in":1}` {
		t.Fatalf("reported outParams = %s, want {\"in\":1}", outcomes[0].result.OutParams)
	}
}

// The first claim is the restart reclaim of spec §6.3: without it a restarted
// runner waits out leases granted to the process that died.
func TestPollerIgnoresLeaseExpiryOnItsFirstClaimOnly(t *testing.T) {
	transfer := newFakeTransfer()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	if _, err := Startup(ctx, StartupConfig{
		JobTypes: []IJob{&echoJob{}},
		Transfer: transfer,
		Logger:   quietLogger(),
		PollWait: time.Millisecond,
	}); err != nil {
		t.Fatalf("Startup failed: %v", err)
	}

	awaitSignal(t, transfer.claimed, "the first claim")

	ignores := transfer.claimIgnores()
	if len(ignores) == 0 || !ignores[0] {
		t.Fatalf("claim ignoreLeaseExpire = %v, want the first one true", ignores)
	}
}

func TestPollerStopsWhenTheContextIsCancelled(t *testing.T) {
	transfer := newFakeTransfer()

	ctx, cancel := context.WithCancel(context.Background())
	if _, err := Startup(ctx, StartupConfig{
		JobTypes: []IJob{&echoJob{}},
		Transfer: transfer,
		Logger:   quietLogger(),
		PollWait: time.Millisecond,
	}); err != nil {
		t.Fatalf("Startup failed: %v", err)
	}

	awaitSignal(t, transfer.claimed, "the first claim")
	cancel()

	// Drain whatever was already in flight, then confirm the loop went quiet.
	time.Sleep(50 * time.Millisecond)
	settled := transfer.claimCount()
	time.Sleep(100 * time.Millisecond)

	if after := transfer.claimCount(); after != settled {
		t.Fatalf("claims kept coming after cancellation: %d then %d", settled, after)
	}
}

// --- supervision -------------------------------------------------------------

// A crash in the loop itself must not leave the runner silently not pulling:
// the supervisor has to bring it back.
func TestSupervisorRestartsACrashedPoller(t *testing.T) {
	transfer := newFakeTransfer()
	transfer.panicOnClaim = 1

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	if _, err := Startup(ctx, StartupConfig{
		JobTypes:     []IJob{&echoJob{}},
		Transfer:     transfer,
		Logger:       quietLogger(),
		PollWait:     time.Millisecond,
		RestartDelay: time.Millisecond,
	}); err != nil {
		t.Fatalf("Startup failed: %v", err)
	}

	// The first claim panics; a second one can only happen if the supervisor
	// relaunched the poller.
	awaitSignal(t, transfer.claimed, "the claim that panics")
	awaitSignal(t, transfer.claimed, "the claim after the restart")

	if claims := transfer.claimCount(); claims < 2 {
		t.Fatalf("claims = %d, want at least 2 (one crash, one restart)", claims)
	}
}

func TestSupervisorStopsRestartingOnceTheContextIsCancelled(t *testing.T) {
	transfer := newFakeTransfer()
	transfer.panicOnClaim = 1

	ctx, cancel := context.WithCancel(context.Background())

	if _, err := Startup(ctx, StartupConfig{
		JobTypes:     []IJob{&echoJob{}},
		Transfer:     transfer,
		Logger:       quietLogger(),
		PollWait:     time.Millisecond,
		RestartDelay: 50 * time.Millisecond,
	}); err != nil {
		t.Fatalf("Startup failed: %v", err)
	}

	awaitSignal(t, transfer.claimed, "the claim that panics")
	cancel()

	time.Sleep(150 * time.Millisecond)
	if claims := transfer.claimCount(); claims != 1 {
		t.Fatalf("claims = %d, want 1: the supervisor restarted after cancellation", claims)
	}
}

// --- error paths -------------------------------------------------------------

// A job type the runner cannot build must not take the poller down with it.
func TestPollerSurvivesAnUnknownClaimedType(t *testing.T) {
	transfer := newFakeTransfer(
		[]Job{{ID: "job-1", Type: "nowhere"}},
		[]Job{{ID: "job-2", Type: "echo"}},
	)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	if _, err := Startup(ctx, StartupConfig{
		JobTypes: []IJob{&echoJob{}},
		Transfer: transfer,
		Logger:   quietLogger(),
		PollWait: time.Millisecond,
	}); err != nil {
		t.Fatalf("Startup failed: %v", err)
	}

	awaitSignal(t, transfer.reports, "the outcome of the job after the unknown one")

	outcomes := transfer.outcomes()
	if len(outcomes) != 1 || outcomes[0].job.ID != "job-2" {
		t.Fatalf("reported outcomes = %+v, want only job-2", outcomes)
	}
}

// A claim that fails is an empty round, not the end of the pull path.
func TestPollerKeepsGoingAfterAClaimFails(t *testing.T) {
	transfer := &failingClaimTransfer{fakeTransfer: newFakeTransfer(), failuresLeft: 1}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	if _, err := Startup(ctx, StartupConfig{
		JobTypes: []IJob{&echoJob{}},
		Transfer: transfer,
		Logger:   quietLogger(),
		PollWait: time.Millisecond,
	}); err != nil {
		t.Fatalf("Startup failed: %v", err)
	}

	awaitSignal(t, transfer.claimed, "the claim that fails")
	awaitSignal(t, transfer.claimed, "the claim after the failure")
}

// panicOnAttachJob blows up while being built, which is the one failure that
// lands after the poller has taken a slot and before anything can give it back.
type panicOnAttachJob struct {
	Job
}

func (*panicOnAttachJob) Type() string    { return "panic-on-attach" }
func (*panicOnAttachJob) Attach(Job) IJob { panic("attach exploded") }

func (*panicOnAttachJob) SyncExec(context.Context) (*Result, error) {
	return &Result{Status: StatusOK}, nil
}

// A job type that panics on the way in must not strand the slot it was given:
// with one slot in the pool, a leak wedges every job claimed after it.
func TestPollerSurvivesAJobTypeThatPanicsWhileBeingBuilt(t *testing.T) {
	transfer := newFakeTransfer(
		[]Job{{ID: "job-1", Type: "panic-on-attach"}},
		[]Job{{ID: "job-2", Type: "echo"}},
	)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	if _, err := Startup(ctx, StartupConfig{
		JobTypes:     []IJob{&echoJob{}, &panicOnAttachJob{}},
		Transfer:     transfer,
		Logger:       quietLogger(),
		PollWait:     time.Millisecond,
		RestartDelay: time.Millisecond,
		ChanLimit:    1,
	}); err != nil {
		t.Fatalf("Startup failed: %v", err)
	}

	awaitSignal(t, transfer.reports, "the outcome of the job claimed after the one that panicked")

	outcomes := transfer.outcomes()
	if len(outcomes) != 1 || outcomes[0].job.ID != "job-2" {
		t.Fatalf("reported outcomes = %+v, want only job-2", outcomes)
	}
}

// panicOnReportTransfer blows up while reporting. For a sync job that callback
// runs on the goroutine AsyncExecutor spawned, where an escaping panic takes
// the process down and no supervisor is in a position to catch it.
type panicOnReportTransfer struct {
	*fakeTransfer
}

func (p *panicOnReportTransfer) Report(context.Context, Job, *Result, error) error {
	p.reports <- struct{}{}
	panic("report exploded")
}

// A transport that panics must not end the runner, and must not strand the
// slot the reporting job was holding.
func TestPollerSurvivesAPanicWhileReporting(t *testing.T) {
	transfer := &panicOnReportTransfer{fakeTransfer: newFakeTransfer(
		[]Job{{ID: "job-1", Type: "echo"}},
		[]Job{{ID: "job-2", Type: "echo"}},
	)}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	if _, err := Startup(ctx, StartupConfig{
		JobTypes:     []IJob{&echoJob{}},
		Transfer:     transfer,
		Logger:       quietLogger(),
		PollWait:     time.Millisecond,
		RestartDelay: time.Millisecond,
		ChanLimit:    1,
	}); err != nil {
		t.Fatalf("Startup failed: %v", err)
	}

	awaitSignal(t, transfer.reports, "the report that panics")
	awaitSignal(t, transfer.reports, "the report after the panic")
}
