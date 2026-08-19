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
	"time"
)

// ErrPollerCrashed means the poller panicked and was caught by its supervisor.
var ErrPollerCrashed = errors.New("ratchetjq: poller crashed")

const defaultRestartDelay = 5 * time.Second

// StartupConfig configures Startup. Only JobTypes is required — a runner with
// no Transfer still serves the pushed path.
type StartupConfig struct {
	// JobTypes is one prototype per job type this runner can run, normally
	// jobs.JobTypes().
	JobTypes []IJob
	// Transfer is the pulled path's transport. Leaving it nil starts no
	// poller: the runner then only runs jobs the control plane pushes to it
	// over SyncRun, which is the whole of §9.4 that works without ClaimJobs.
	Transfer Transfer
	Logger   *slog.Logger
	// PollWait, ChanLimit, JobTimeout and RestartDelay are passed through to
	// the poller and its supervisor; zero takes each default.
	PollWait     time.Duration
	ChanLimit    int
	JobTimeout   time.Duration
	RestartDelay time.Duration
}

// Startup brings the EXECUTOR up when the runner does. It registers every job
// type and, when a Transfer is configured, starts the poller under a
// supervisor that relaunches it if it crashes.
//
// The factory it returns is what the pushed path (SyncRun) dispatches
// through, so one call gives the caller both halves of spec §9.4. The poller
// runs until ctx is cancelled.
func Startup(ctx context.Context, cfg StartupConfig) (*JobFactory, error) {
	log := cfg.Logger
	if log == nil {
		log = slog.Default()
	}

	factory := NewJobFactory()
	for _, prototype := range cfg.JobTypes {
		if err := factory.Register(prototype); err != nil {
			return nil, fmt.Errorf("registering RatchetJQ job types: %w", err)
		}
	}
	log.InfoContext(ctx, "RatchetJQ job types registered", slog.Int("count", len(cfg.JobTypes)))

	if cfg.Transfer == nil {
		log.InfoContext(ctx, "RatchetJQ poller disabled: no transfer configured")
		return factory, nil
	}

	poller, err := NewPoller(PollerConfig{
		Factory:    factory,
		Transfer:   cfg.Transfer,
		Logger:     log,
		PollWait:   cfg.PollWait,
		ChanLimit:  cfg.ChanLimit,
		JobTimeout: cfg.JobTimeout,
	})
	if err != nil {
		return nil, fmt.Errorf("starting the RatchetJQ poller: %w", err)
	}

	restartDelay := cfg.RestartDelay
	if restartDelay <= 0 {
		restartDelay = defaultRestartDelay
	}

	go supervisePoller(ctx, poller, restartDelay, log)

	return factory, nil
}

// supervisePoller keeps the poller running for as long as ctx lives.
//
// A crash has to be survivable here rather than fatal: the pulled path is one
// of the two forces that advance a job, and a runner whose poller died
// silently stops draining its queue while still answering health checks and
// still holding leases on jobs nobody is running. Jobs themselves are already
// insulated one level down — AsyncExecutor turns a panicking sync job into
// that job's error — so a panic reaching this far is the loop itself failing,
// which is exactly the case worth relaunching.
func supervisePoller(ctx context.Context, poller *Poller, restartDelay time.Duration, log *slog.Logger) {
	for {
		crash := runPollerRecovered(ctx, poller)

		if ctx.Err() != nil {
			return
		}
		if crash == nil {
			// The poller returned on its own without a cancellation; take it
			// at its word rather than spinning it back up forever.
			log.WarnContext(ctx, "RatchetJQ poller returned; not restarting")
			return
		}

		log.ErrorContext(ctx, "RatchetJQ poller crashed; restarting",
			slog.Duration("restart_delay", restartDelay),
			slog.Any("error", crash),
		)

		timer := time.NewTimer(restartDelay)
		select {
		case <-timer.C:
		case <-ctx.Done():
			timer.Stop()
			return
		}
	}
}

// runPollerRecovered runs the poller and returns the panic it died on, or nil
// if it returned normally.
func runPollerRecovered(ctx context.Context, poller *Poller) (crash error) {
	defer func() {
		if recovered := recover(); recovered != nil {
			crash = fmt.Errorf("%w: %v", ErrPollerCrashed, recovered)
		}
	}()

	poller.Run(ctx)
	return nil
}
