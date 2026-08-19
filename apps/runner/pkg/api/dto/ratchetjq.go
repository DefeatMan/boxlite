/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

package dto

import "encoding/json"

// SyncRatchetJobDTO is the job the control plane pushes for inline execution
// (RatchetJQ spec §9.4, SyncRun). InParams stays raw so it reaches the job
// type that defines its shape without being reshaped in transit.
type SyncRatchetJobDTO struct {
	Id         string          `json:"id" validate:"required"`
	Type       string          `json:"type" validate:"required"`
	ResourceId string          `json:"resourceId,omitempty"`
	InParams   json.RawMessage `json:"inParams,omitempty" swaggertype:"object"`
} //	@name	SyncRatchetJobDTO

// SyncRatchetJobResponseDTO carries the job's outcome back to the caller.
//
// A run that raised is an outcome too, and travels here rather than as a 5xx:
// Status is then "failed" and ErrMsg says what the job said. The two output
// fields are mutually exclusive by construction — a run that raised produced no
// OutParams — which is why they are separate fields and both omitempty.
type SyncRatchetJobResponseDTO struct {
	Id        string          `json:"id" validate:"required"`
	Status    string          `json:"status" validate:"required"`
	OutParams json.RawMessage `json:"outParams,omitempty" swaggertype:"object"`
	ErrMsg    string          `json:"errMsg,omitempty"`
} //	@name	SyncRatchetJobResponseDTO
