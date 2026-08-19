/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

package ratchetjq

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"
)

// Transfer is the runner's side of the TRANSFER role (spec §6, §9.3): where
// claimed jobs come from, and where their outcomes go. The runner implements
// it over REST against the control plane.
type Transfer interface {
	// ClaimJobs pulls at most limit jobs this runner may run now. The runner
	// names the limit because it is the one that knows how much of its
	// concurrency gate is still free, and it is also the ceiling on what one
	// claim may return (spec §6.5, §9.4).
	//
	// ignoreLeaseExpire is the restart reclaim of spec §6.3: on the first call
	// after start, take back every job on this host without waiting for its
	// lease to expire, because a restart is not a failed attempt.
	ClaimJobs(ctx context.Context, limit int, ignoreLeaseExpire bool) ([]Job, error)

	// Report hands one job's outcome back to the PROPOSER (spec §9.1). A
	// non-nil runErr means the run failed and there is no result.
	Report(ctx context.Context, job Job, result *Result, runErr error) error
}

// Poller is the EXECUTOR's pulled path (spec §9.4): claim, dispatch, and claim
// again. It is the first of the two forces that advance a job, the
// proposer-side Scanner being the second.
//
// A round dispatches its jobs and does not wait for them, so one slow job never
// holds up the rest of its batch — which also means a job type has to be safe to
// run concurrently with itself. What bounds the runner is the gate: it claims
// only as much as its remaining budget, so the batch it gets always fits.
type Poller struct {
	factory  *JobFactory
	transfer Transfer
	log      *slog.Logger
	pollWait time.Duration

	// jobTimeout bounds a run whose entity carried no lease, so the gate is
	// bounded even when the deadline the control plane granted did not arrive.
	jobTimeout time.Duration

	// slots is the gate: one element per job dispatched and not yet reported, so
	// cap is the limit and len is what is in flight. A channel rather than a
	// counter because taking a slot is then one atomic step needing no lock of
	// its own, and reading the depth is what tells the next claim how much to
	// ask for.
	slots chan struct{}

	// drained carries one token whenever the last in-flight job finishes, which
	// is the other thing a waiting round wakes on. Buffered to one and sent
	// without blocking, so a job that finishes while nothing is waiting leaves
	// the token behind rather than stalling on the send: the next wait then
	// returns at once, which is right, because budget has just come free.
	drained chan struct{}

	// hasReclaimed records that the restart reclaim has been made, so it happens
	// once per process and not once per Run. Needs no lock: it is touched only
	// on the goroutine running Run, and the supervisor runs it sequentially.
	hasReclaimed bool
}

// PollerConfig configures a Poller. Only Factory and Transfer are required.
type PollerConfig struct {
	Factory  *JobFactory
	Transfer Transfer
	Logger   *slog.Logger
	// PollWait is the longest a round waits before claiming again (spec §9.4's
	// {POLL_WAIT}). Zero takes the default.
	PollWait time.Duration
	// ChanLimit caps the jobs running at once, and with them the size of one
	// claim (spec §9.4's {CHAN_LIMIT}). Zero takes the default.
	ChanLimit int
	// JobTimeout bounds a run only when its job arrived with no lease of its
	// own; a job that has one is bounded by that instead. Zero takes the
	// default.
	JobTimeout time.Duration
}

const (
	defaultPollWait  = 5 * time.Second
	defaultChanLimit = 16
	// Long enough not to cut short a job doing real work, short enough that a
	// hung one does not hold its slot for an operator's whole afternoon. It only
	// applies to a job that arrived without a lease, which is a control plane or
	// transport fault rather than a normal round.
	defaultJobTimeout = 5 * time.Minute
)

// NewPoller builds a poller. It does not start anything; call Run.
func NewPoller(cfg PollerConfig) (*Poller, error) {
	if cfg.Factory == nil {
		return nil, fmt.Errorf("ratchetjq: poller needs a job factory")
	}
	if cfg.Transfer == nil {
		return nil, fmt.Errorf("ratchetjq: poller needs a transfer")
	}

	pollWait := cfg.PollWait
	if pollWait <= 0 {
		pollWait = defaultPollWait
	}
	chanLimit := cfg.ChanLimit
	if chanLimit <= 0 {
		chanLimit = defaultChanLimit
	}
	jobTimeout := cfg.JobTimeout
	if jobTimeout <= 0 {
		jobTimeout = defaultJobTimeout
	}
	log := cfg.Logger
	if log == nil {
		log = slog.Default()
	}

	return &Poller{
		factory:    cfg.Factory,
		transfer:   cfg.Transfer,
		log:        log.With(slog.String("component", "ratchetjq_poller")),
		pollWait:   pollWait,
		jobTimeout: jobTimeout,
		slots:      make(chan struct{}, chanLimit),
		drained:    make(chan struct{}, 1),
	}, nil
}

// Run claims and dispatches until ctx is cancelled (spec §9.4).
//
// The process's first claim passes ignoreLeaseExpire, which is what makes a
// restart reclaim this host's in-flight jobs instead of waiting out leases
// granted to the process that died (spec §6.3, §9.4). Only the first: the
// supervisor relaunches Run on this same Poller, and after an in-process crash
// the rows still marked as running on this host belong to goroutines running
// here, not to a process that is gone. Reclaiming them would dispatch them a
// second time alongside the first, and a reclaim is charged no round, so nothing
// would stop that repeating on every crash.
//
// Each round then waits on whichever comes first: PollWait elapsing, or every
// in-flight job finishing. The second lets a finished batch be followed straight
// away instead of waiting out the full delay; the first covers what raises no
// completion event — some jobs finishing and freeing part of the budget, and
// having nothing running at all. With nothing in flight there is no completion
// event, so an empty round is exactly one PollWait of sleep.
//
// A Wakeup pushed during that sleep is not lost: the hint stays in its Redis
// list, so the claim picks it up as soon as the round comes round. The price is
// that an idle runner's worst-case pickup latency is one PollWait.
func (p *Poller) Run(ctx context.Context) {
	p.log.InfoContext(ctx, "RatchetJQ poller started")

	// Marked before the attempt, not after it: a claim that dies mid-flight may
	// still have committed on the control plane, so its rows can already be
	// reclaimed and leased. A second reclaim would take them while the first
	// batch runs, which is the thing this flag exists to prevent.
	shouldReclaim := !p.hasReclaimed
	p.hasReclaimed = true

	claimed := p.claimWithinBudget(ctx, shouldReclaim)

	for ctx.Err() == nil {
		p.dispatchAll(ctx, claimed)
		claimed = nil

		if !p.waitForNextRound(ctx) {
			return
		}

		claimed = p.claimWithinBudget(ctx, false)
	}

	p.log.InfoContext(ctx, "RatchetJQ poller stopped")
}

// claimWithinBudget claims only what the gate can still take, so the batch it
// gets always fits. At zero the runner is saturated and it does not query at
// all: asking would cost the control plane a round trip to be told about jobs
// this runner would have to refuse, their leases already moved for it.
//
// Every claim goes through here, the first one included. A restart's first claim
// is made while the crash's survivors are still running and still holding their
// slots, so it is precisely the claim that must not assume an empty gate — which
// is how river's producer computes its own fetch limit, for every fetch alike
// (`producer.go:958`, `producer.go:644`).
func (p *Poller) claimWithinBudget(ctx context.Context, ignoreLeaseExpire bool) []Job {
	budget := cap(p.slots) - len(p.slots)
	if budget <= 0 {
		return nil
	}

	return p.claim(ctx, budget, ignoreLeaseExpire)
}

// dispatchAll starts every job in a batch without waiting for any of them.
//
// The batch is capped at the remaining budget rather than trusted: a control
// plane that returned more than the claim asked for would otherwise push the
// gate past its limit, and the jobs beyond it are left to their leases, which
// brings them back on a later round.
func (p *Poller) dispatchAll(ctx context.Context, claimed []Job) {
	for _, entity := range claimed {
		if ctx.Err() != nil {
			return
		}
		if !p.reserveSlot() {
			p.log.WarnContext(ctx, "Leaving a claimed RatchetJQ job for a later round: gate is full",
				slog.String("job_id", entity.ID),
				slog.String("job_type", entity.Type),
				slog.Int("chan_limit", cap(p.slots)),
			)
			return
		}
		p.dispatch(ctx, entity)
	}
}

// claim pulls the next batch, treating a transport failure as an empty round
// rather than an end: the control plane being briefly unreachable must not
// take down the pull path.
func (p *Poller) claim(ctx context.Context, limit int, ignoreLeaseExpire bool) []Job {
	if ctx.Err() != nil {
		return nil
	}

	claimed, err := p.transfer.ClaimJobs(ctx, limit, ignoreLeaseExpire)
	if err != nil {
		p.log.ErrorContext(ctx, "Claiming RatchetJQ jobs failed",
			slog.Int("limit", limit),
			slog.Bool("ignore_lease_expire", ignoreLeaseExpire),
			slog.Any("error", err),
		)
		return nil
	}

	return claimed
}

// dispatch builds the claimed job and starts it. The slot is already reserved by
// the caller; this always releases it, on every path — the ones where no outcome
// is ever reported, the one where the job type panics on the way in, and the one
// where the job simply never finishes.
func (p *Poller) dispatch(ctx context.Context, entity Job) {
	deadline := p.runDeadline(entity)
	jobCtx, cancelJob := context.WithDeadline(ctx, deadline)

	// One step ends a dispatch, from whichever side ends it: the outcome
	// arriving, the run being built or started failing, the job type panicking,
	// or the lease lapsing. Once, because more than one of those can happen —
	// a job that reports after its lease lapsed still runs its callback.
	//
	// Cancelling here and not in a defer: Exec returns while the run is still
	// going, so the job's ctx has to outlive this function.
	finish := sync.OnceFunc(func() {
		cancelJob()
		p.releaseSlot()
	})

	// The lease is what bounds a run. Without it a job that hangs holds its slot
	// for the process's whole life, and ChanLimit such jobs wedge the pull path
	// for good — the same end the panic recovery below exists to prevent, reached
	// by waiting rather than by crashing. Past the lease this runner has no claim
	// on the job either: it is claimable again, so someone else may already be
	// running it.
	//
	// Cancelling is all this can do about the run itself. Nothing in Go preempts
	// a goroutine, so a job that ignores its ctx keeps going; the slot is freed
	// regardless, because holding it would charge the rest of the queue for one
	// job's misbehaviour. A well-behaved job sees the cancellation and reports
	// the error, which is why this only warns and never reports for the job.
	context.AfterFunc(jobCtx, func() {
		if !errors.Is(jobCtx.Err(), context.DeadlineExceeded) {
			// The parent went away — the runner is shutting down, and the slots
			// go with the process.
			return
		}

		p.log.WarnContext(ctx, "Cancelling a RatchetJQ job that outlived its lease, and freeing its slot",
			slog.String("job_id", entity.ID),
			slog.String("job_type", entity.Type),
			slog.Time("deadline", deadline),
		)
		finish()
	})

	// Everything between here and the report callback runs on the loop's own
	// goroutine: Attach while the job is built, and an async job's own start.
	// A panic in either would otherwise unwind past the release and strand
	// the slot for the process's whole life — the supervisor restarts the
	// poller but reuses this same gate, so ChanLimit such panics wedge the
	// pull path for good.
	//
	// Containing it here rather than letting it reach the supervisor also
	// stops a deterministically panicking job type from crash-looping the
	// poller on every redelivery. It is one job failing, the same class
	// AsyncExecutor already absorbs for a sync job's own run.
	defer func() {
		recovered := recover()
		if recovered == nil {
			return
		}

		finish()
		p.log.ErrorContext(ctx, "RatchetJQ job panicked before it could run",
			slog.String("job_id", entity.ID),
			slog.String("job_type", entity.Type),
			slog.Any("error", fmt.Errorf("%w: %v", ErrExecutorPanic, recovered)),
		)
	}()

	job, err := p.factory.Create(entity)
	if err != nil {
		finish()
		// Nothing useful can be reported for a type this runner cannot
		// build, so the job is left to its lease: the control plane
		// redelivers it and, once the rounds are used up, rolls it back.
		p.log.ErrorContext(ctx, "Cannot run claimed RatchetJQ job",
			slog.String("job_id", entity.ID),
			slog.String("job_type", entity.Type),
			slog.Any("error", err),
		)
		return
	}

	err = AsyncExecutor{}.Exec(jobCtx, job, func(result *Result, runErr error) {
		defer finish()
		p.report(ctx, entity, result, runErr)
	})
	if err != nil {
		finish()
		p.log.ErrorContext(ctx, "Starting RatchetJQ job failed",
			slog.String("job_id", entity.ID),
			slog.String("job_type", entity.Type),
			slog.Any("error", err),
		)
	}
}

// runDeadline is when this runner must stop running a job: the moment the lease
// the control plane granted with it lapses.
//
// A job that arrived without one falls back to JobTimeout. That case is a fault
// — a control plane that omitted the field, a transport that dropped it — but the
// fallback is not a nicety: without a deadline a hung job holds its slot for the
// process's whole life, which is the one outcome the gate must never reach.
//
// Reading the control plane's instant against this host's clock makes the bound
// only as good as the skew between the two. That is the cost of taking the lease
// literally, and it is the right way round: a runner whose clock runs fast gives
// up a job early and the control plane redelivers it, where one whose clock runs
// slow would keep working on a job already handed to someone else.
func (p *Poller) runDeadline(entity Job) time.Time {
	if entity.LeaseExpiresAt.IsZero() {
		return time.Now().Add(p.jobTimeout)
	}

	return entity.LeaseExpiresAt
}

// report hands the outcome back to the control plane.
//
// It recovers its own panics because of where it runs: for a sync job this is
// the goroutine AsyncExecutor spawned, so nothing above is in a position to
// catch anything — an escaping panic from the transport would take the whole
// runner down, not just the pull path.
func (p *Poller) report(ctx context.Context, entity Job, result *Result, runErr error) {
	defer func() {
		if recovered := recover(); recovered != nil {
			p.log.ErrorContext(ctx, "Reporting a RatchetJQ job outcome panicked",
				slog.String("job_id", entity.ID),
				slog.String("job_type", entity.Type),
				slog.Any("error", fmt.Errorf("%w: %v", ErrExecutorPanic, recovered)),
			)
		}
	}()

	if runErr != nil {
		p.log.ErrorContext(ctx, "RatchetJQ job failed",
			slog.String("job_id", entity.ID),
			slog.String("job_type", entity.Type),
			slog.Any("error", runErr),
		)
	}

	if err := p.transfer.Report(ctx, entity, result, runErr); err != nil {
		// The outcome is lost for now; the lease expires and the job comes
		// back, which is what at-least-once delivery is for (spec §0).
		p.log.ErrorContext(ctx, "Reporting RatchetJQ job outcome failed",
			slog.String("job_id", entity.ID),
			slog.String("job_type", entity.Type),
			slog.Any("error", err),
		)
	}
}

// reserveSlot takes one unit of the gate, reporting false when it is full.
//
// It never blocks: a round claims only what the gate can take, so a full gate
// here means the control plane returned more than was asked for, which is the
// caller's cue to stop dispatching rather than to wait.
func (p *Poller) reserveSlot() bool {
	select {
	case p.slots <- struct{}{}:
		return true
	default:
		return false
	}
}

// releaseSlot gives one unit of the gate back, and signals a waiting round when
// that was the last job running.
//
// The emptiness test is not atomic with the receive, which is sound here for a
// reason worth stating: slots are only ever taken on the poller's own goroutine,
// and it takes them while dispatching, never while waiting. So during a wait the
// depth only falls, and whichever release empties the gate sees it empty. Two
// releases racing to the same conclusion both try to send, and the second send is
// simply dropped.
func (p *Poller) releaseSlot() {
	<-p.slots

	if len(p.slots) > 0 {
		return
	}
	select {
	case p.drained <- struct{}{}:
	default:
	}
}

// waitForNextRound waits out PollWait or every in-flight job finishing,
// whichever comes first, reporting false if ctx ended instead.
func (p *Poller) waitForNextRound(ctx context.Context) bool {
	timer := time.NewTimer(p.pollWait)
	defer timer.Stop()

	select {
	case <-timer.C:
		return true
	case <-p.drained:
		return true
	case <-ctx.Done():
		return false
	}
}
