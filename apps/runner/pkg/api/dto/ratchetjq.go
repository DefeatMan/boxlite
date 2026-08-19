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
type SyncRatchetJobResponseDTO struct {
	Id        string          `json:"id" validate:"required"`
	Status    string          `json:"status" validate:"required"`
	OutParams json.RawMessage `json:"outParams,omitempty" swaggertype:"object"`
} //	@name	SyncRatchetJobResponseDTO
