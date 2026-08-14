/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { setupWorker } from 'msw/browser'
import { MOCK_VOLUME_USAGE } from './fixtures'
import { handlers } from './handlers'

// Stands in for the not-yet-exposed "which boxes mount this volume" lookup so
// the Volumes page can be built against its real shape. See PRD §7.
;(globalThis as { __BOXLITE_VOLUME_USAGE__?: unknown }).__BOXLITE_VOLUME_USAGE__ = MOCK_VOLUME_USAGE

export const worker = setupWorker(...handlers)
