/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

package ratchetjq

import (
	"context"
	"log/slog"
	"strings"
	"testing"
	"time"
)

// The runner names how many jobs a claim may return, because it is the one that
// knows how much of its gate is free. The first claim of a freshly started
// runner has nothing running, so it asks for the whole gate.
func TestPollerAsksForTheWholeGateOnItsFirstClaim(t *testing.T) {
	transfer := newFakeTransfer(nil)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	if _, err := Startup(ctx, StartupConfig{
		JobTypes:     []IJob{&echoJob{}},
		Transfer:     transfer,
		Logger:       quietLogger(),
		PollWait:     time.Millisecond,
		RestartDelay: time.Millisecond,
		ChanLimit:    4,
	}); err != nil {
		t.Fatalf("Startup failed: %v", err)
	}

	awaitSignal(t, transfer.claimed, "the first claim")

	limits := transfer.claimLimits()
	if len(limits) == 0 || limits[0] != 4 {
		t.Fatalf("first claim limit = %v, want 4", limits)
	}
}

// blockingJob never reports, so it holds its slot for the whole test — which is
// how a test can observe the gate being full.
type blockingJob struct {
	Job
	started chan struct{}
}

func (b *blockingJob) Type() string { return "blocking" }

func (b *blockingJob) Attach(job Job) IJob {
	return &blockingJob{Job: job, started: b.started}
}

func (b *blockingJob) AsyncExec(context.Context, ReportFunc) error {
	// Reports nothing, ever: the slot stays taken and no outcome arrives.
	b.started <- struct{}{}
	return nil
}

// With the gate full the poller must not query at all. Asking would spend a
// round trip to be handed jobs it has to refuse, and the control plane would
// have moved their leases for a runner that cannot take them.
func TestPollerDoesNotClaimWhileItsGateIsFull(t *testing.T) {
	started := make(chan struct{}, 1)
	transfer := newFakeTransfer([]Job{{ID: "job-1", Type: "blocking"}})

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	if _, err := Startup(ctx, StartupConfig{
		JobTypes:     []IJob{&blockingJob{started: started}},
		Transfer:     transfer,
		Logger:       quietLogger(),
		PollWait:     time.Millisecond,
		RestartDelay: time.Millisecond,
		ChanLimit:    1,
	}); err != nil {
		t.Fatalf("Startup failed: %v", err)
	}

	awaitSignal(t, transfer.claimed, "the first claim")
	awaitSignal(t, started, "the blocking job to take the only slot")

	// PollWait is a millisecond, so many rounds elapse in this window. Every one
	// of them has to find the gate full and skip its claim entirely.
	time.Sleep(50 * time.Millisecond)

	if claims := transfer.claimCount(); claims != 1 {
		t.Fatalf("claims = %d, want 1: the gate was full for every round after the first", claims)
	}
}

// A claim made while work is still running may only ask for what is left of the
// gate, or the runner takes on more than it can run.
func TestPollerClaimsOnlyItsRemainingBudget(t *testing.T) {
	started := make(chan struct{}, 2)
	transfer := newFakeTransfer([]Job{{ID: "job-1", Type: "blocking"}})

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	if _, err := Startup(ctx, StartupConfig{
		JobTypes:     []IJob{&blockingJob{started: started}},
		Transfer:     transfer,
		Logger:       quietLogger(),
		PollWait:     time.Millisecond,
		RestartDelay: time.Millisecond,
		ChanLimit:    3,
	}); err != nil {
		t.Fatalf("Startup failed: %v", err)
	}

	awaitSignal(t, transfer.claimed, "the first claim")
	awaitSignal(t, started, "the blocking job to take one of three slots")
	awaitSignal(t, transfer.claimed, "the claim after one slot was taken")

	limits := transfer.claimLimits()
	if len(limits) < 2 {
		t.Fatalf("claim limits = %v, want at least two claims", limits)
	}
	if limits[1] != 2 {
		t.Fatalf("second claim limit = %d, want 2 (a gate of 3 minus one job in flight)", limits[1])
	}
}

// hangingJob starts and then never reports, the way a job wedged on an
// unresponsive dependency behaves. It watches its own ctx, so a test can see
// that the cancellation reached the job and not only that its slot came back.
type hangingJob struct {
	Job
	started   chan struct{}
	cancelled chan struct{}
}

func (*hangingJob) Type() string { return "hanging" }

func (h *hangingJob) Attach(job Job) IJob {
	return &hangingJob{Job: job, started: h.started, cancelled: h.cancelled}
}

func (h *hangingJob) AsyncExec(ctx context.Context, _ ReportFunc) error {
	h.started <- struct{}{}

	go func() {
		<-ctx.Done()
		h.cancelled <- struct{}{}
	}()

	return nil
}

// A job that never finishes would otherwise hold its slot for the process's
// whole life, and ChanLimit such jobs wedge the pull path for good. The lease is
// the bound: at it the run is cancelled, the slot goes back, and the runner says
// so, because a slot freed under a job still running is worth an operator's
// attention.
func TestPollerCancelsAJobThatOutlivesItsLease(t *testing.T) {
	started := make(chan struct{}, 1)
	cancelled := make(chan struct{}, 1)
	recorder := newRecordingLogger(slog.LevelWarn)
	lease := time.Now().Add(50 * time.Millisecond)
	transfer := newFakeTransfer([]Job{{ID: "job-1", Type: "hanging", LeaseExpiresAt: lease}})

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	if _, err := Startup(ctx, StartupConfig{
		JobTypes:     []IJob{&hangingJob{started: started, cancelled: cancelled}},
		Transfer:     transfer,
		Logger:       recorder.logger(),
		PollWait:     time.Millisecond,
		RestartDelay: time.Millisecond,
		ChanLimit:    1,
	}); err != nil {
		t.Fatalf("Startup failed: %v", err)
	}

	awaitSignal(t, transfer.claimed, "the first claim")
	awaitSignal(t, started, "the hanging job to take the only slot")
	awaitSignal(t, cancelled, "the hanging job's context to be cancelled at its lease")

	// The gate held one slot and the job still has not reported, so a claim
	// asking for one again is the slot having come back.
	awaitSignal(t, transfer.claimed, "the claim that follows the freed slot")
	limits := transfer.claimLimits()
	if limits[len(limits)-1] != 1 {
		t.Fatalf("claim limits = %v, want the last one to be 1: the slot came back", limits)
	}

	warnings := recorder.messagesAt(slog.LevelWarn)
	if len(warnings) == 0 || !strings.Contains(warnings[0], "outlived its lease") {
		t.Fatalf("warnings = %v, want one about a job outliving its lease", warnings)
	}
	deadline, ok := recorder.attr("outlived its lease", "deadline")
	if !ok {
		t.Fatal("the warning carries no deadline attribute")
	}
	if !deadline.Time().Equal(lease) {
		t.Fatalf("warning deadline = %v, want the job's lease %v", deadline.Time(), lease)
	}
}

// A job that arrives with no lease still has to be bounded, or the gate leaks a
// slot per hung job exactly as before. JobTimeout is that bound.
func TestPollerBoundsAJobThatArrivesWithoutALease(t *testing.T) {
	started := make(chan struct{}, 1)
	cancelled := make(chan struct{}, 1)
	transfer := newFakeTransfer([]Job{{ID: "job-1", Type: "hanging"}})

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	if _, err := Startup(ctx, StartupConfig{
		JobTypes:     []IJob{&hangingJob{started: started, cancelled: cancelled}},
		Transfer:     transfer,
		Logger:       quietLogger(),
		PollWait:     time.Millisecond,
		RestartDelay: time.Millisecond,
		ChanLimit:    1,
		JobTimeout:   50 * time.Millisecond,
	}); err != nil {
		t.Fatalf("Startup failed: %v", err)
	}

	awaitSignal(t, transfer.claimed, "the first claim")
	awaitSignal(t, started, "the hanging job to take the only slot")
	awaitSignal(t, cancelled, "the hanging job's context to be cancelled at the job timeout")
	awaitSignal(t, transfer.claimed, "the claim that follows the freed slot")
}

// A job that reports inside its lease must not be warned about, and its slot
// must not be released twice — the release is what a second one would steal from
// whatever job holds the gate by then.
func TestPollerDoesNotWarnAboutAJobThatFinishesInTime(t *testing.T) {
	recorder := newRecordingLogger(slog.LevelWarn)
	transfer := newFakeTransfer([]Job{{ID: "job-1", Type: "echo", LeaseExpiresAt: time.Now().Add(time.Hour)}})

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	if _, err := Startup(ctx, StartupConfig{
		JobTypes:     []IJob{&echoJob{}},
		Transfer:     transfer,
		Logger:       recorder.logger(),
		PollWait:     time.Millisecond,
		RestartDelay: time.Millisecond,
		ChanLimit:    2,
	}); err != nil {
		t.Fatalf("Startup failed: %v", err)
	}

	awaitSignal(t, transfer.claimed, "the first claim")
	awaitSignal(t, transfer.reports, "the job's outcome")

	// Long enough for many further rounds, all of which must find a gate of two
	// with nothing in it.
	time.Sleep(50 * time.Millisecond)

	if warnings := recorder.messagesAt(slog.LevelWarn); len(warnings) != 0 {
		t.Fatalf("warnings = %v, want none for a job that reported inside its lease", warnings)
	}
	for index, limit := range transfer.claimLimits() {
		if limit != 2 {
			t.Fatalf("claim %d asked for %d, want 2: a released slot was released twice", index+1, limit)
		}
	}
}

// A crash does not stop the jobs already dispatched: they run on their own
// goroutines, keep their slots, and the supervisor relaunches Run on this same
// Poller. So the claim that follows a restart is made with the gate already part
// full, and it may only ask for what is left — the same rule every other claim
// follows, and the one case where "a runner that has just started has nothing
// running" is false.
func TestPollerAsksOnlyForFreeSlotsAfterACrashRestart(t *testing.T) {
	started := make(chan struct{}, 2)
	transfer := newFakeTransfer([]Job{{ID: "job-1", Type: "blocking"}})
	transfer.panicOnClaim = 2

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	if _, err := Startup(ctx, StartupConfig{
		JobTypes:     []IJob{&blockingJob{started: started}},
		Transfer:     transfer,
		Logger:       quietLogger(),
		PollWait:     time.Millisecond,
		RestartDelay: time.Millisecond,
		ChanLimit:    3,
	}); err != nil {
		t.Fatalf("Startup failed: %v", err)
	}

	awaitSignal(t, transfer.claimed, "the first claim")
	awaitSignal(t, started, "the blocking job to take one of three slots")
	awaitSignal(t, transfer.claimed, "the claim that panics")
	awaitSignal(t, transfer.claimed, "the claim after the restart")

	limits := transfer.claimLimits()
	if len(limits) < 3 {
		t.Fatalf("claim limits = %v, want at least three claims", limits)
	}
	if limits[2] != 2 {
		t.Fatalf("claim after the restart = %d, want 2: a gate of 3 minus the job that survived the crash", limits[2])
	}
}

// Reclaiming without waiting out leases is for a process start, where the jobs
// still marked as running on this host belong to a process that is gone. After
// an in-process crash they belong to goroutines still running here, so a
// reclaiming claim hands them back for a second dispatch alongside the first —
// and, since a reclaim is charged no round, it would do so again on every crash.
func TestPollerDoesNotReclaimAgainAfterACrashRestart(t *testing.T) {
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
		ChanLimit:    4,
	}); err != nil {
		t.Fatalf("Startup failed: %v", err)
	}

	awaitSignal(t, transfer.claimed, "the claim that panics")
	awaitSignal(t, transfer.claimed, "the claim after the restart")

	ignores := transfer.claimIgnores()
	if len(ignores) < 2 {
		t.Fatalf("claim ignoreLeaseExpire = %v, want at least two claims", ignores)
	}
	if !ignores[0] {
		t.Fatal("first claim passed ignoreLeaseExpire = false, want true")
	}
	if ignores[1] {
		t.Fatal("claim after the restart passed ignoreLeaseExpire = true, want false")
	}
}

// A finished batch is followed by the next one straight away rather than waiting
// out PollWait: every in-flight job finishing is the round's other wake
// condition. With PollWait set to an hour, only that path can produce a second
// claim.
func TestPollerClaimsAgainAsSoonAsItsBatchFinishes(t *testing.T) {
	transfer := newFakeTransfer([]Job{{ID: "job-1", Type: "echo"}})

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	if _, err := Startup(ctx, StartupConfig{
		JobTypes:     []IJob{&echoJob{}},
		Transfer:     transfer,
		Logger:       quietLogger(),
		PollWait:     time.Hour,
		RestartDelay: time.Millisecond,
		ChanLimit:    4,
	}); err != nil {
		t.Fatalf("Startup failed: %v", err)
	}

	awaitSignal(t, transfer.claimed, "the first claim")
	awaitSignal(t, transfer.reports, "the job's outcome")
	awaitSignal(t, transfer.claimed, "the claim that follows the finished batch")
}
