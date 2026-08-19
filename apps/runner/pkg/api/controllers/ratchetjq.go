/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

package controllers

import (
	"errors"
	"log/slog"
	"net/http"

	"github.com/boxlite-ai/runner/pkg/api/dto"
	"github.com/boxlite-ai/runner/pkg/ratchetjq"
	"github.com/gin-gonic/gin"

	common_errors "github.com/boxlite-ai/common-go/pkg/errors"
)

// SyncRatchetJob 			godoc
//
//	@Tags			ratchetjq
//	@Summary		Run a RatchetJQ job synchronously
//	@Description	Instantiate the executor registered for the job type and run it inline, returning its outParams — or status "failed" with errMsg when the run raised
//	@Accept			json
//	@Produce		json
//	@Param			job	body		dto.SyncRatchetJobDTO	true	"Job to run"
//	@Success		200	{object}	dto.SyncRatchetJobResponseDTO
//	@Failure		400	{object}	common_errors.ErrorResponse
//	@Failure		401	{object}	common_errors.ErrorResponse
//	@Failure		409	{object}	common_errors.ErrorResponse
//	@Failure		500	{object}	common_errors.ErrorResponse
//	@Router			/ratchetjq/jobs/sync [post]
//
//	@id				SyncRatchetJob
//
// SyncRatchetJob serves the EXECUTOR's pushed path (spec §9.4): the control
// plane hands over one job, this runner builds the job its type names and
// runs it inline, and the outcome travels back on the same response.
// Reporting the outcome to the PROPOSER is the caller's business — on this
// path the caller *is* the PROPOSER, waiting on this reply.
func SyncRatchetJob(factory *ratchetjq.JobFactory, log *slog.Logger) gin.HandlerFunc {
	return func(ctx *gin.Context) {
		var jobDto dto.SyncRatchetJobDTO
		if err := ctx.ShouldBindJSON(&jobDto); err != nil {
			ctx.Error(common_errors.NewInvalidBodyRequestError(err))
			return
		}

		entity := ratchetjq.Job{
			ID:         jobDto.Id,
			Type:       jobDto.Type,
			ResourceID: jobDto.ResourceId,
			InParams:   jobDto.InParams,
		}

		job, err := factory.Create(entity)
		if err != nil {
			// A type this runner has no implementation for is the caller
			// asking for something it cannot get here, not a runner fault.
			if errors.Is(err, ratchetjq.ErrUnknownJobType) {
				ctx.Error(common_errors.NewBadRequestError(err))
				return
			}
			ctx.Error(err)
			return
		}

		result, err := ratchetjq.SyncExecutor{}.Exec(ctx.Request.Context(), job)
		if err != nil {
			// A registered type that only runs asynchronously cannot serve
			// this call style at all — a conflict with how it was asked for,
			// distinct from the job itself failing.
			if errors.Is(err, ratchetjq.ErrSyncUnsupported) {
				ctx.Error(&common_errors.ConflictError{Message: err.Error()})
				return
			}

			log.ErrorContext(ctx.Request.Context(), "RatchetJQ sync job failed",
				slog.String("job_id", entity.ID),
				slog.String("job_type", job.Type()),
				slog.String("resource_id", entity.ResourceID),
				slog.Any("error", err),
			)

			// Everything left is the run itself raising, including a panic the
			// executor recovered. That is an outcome and not a fault of this
			// runner — the job was dispatched, it ran, and it failed — so it
			// answers 200 carrying it. A 5xx here would say the runner is
			// broken, which sends the caller down the unreachable-executor path
			// and leaves the row to spend its rounds repeating a failure nobody
			// wrote down.
			ctx.JSON(http.StatusOK, dto.SyncRatchetJobResponseDTO{
				Id:     entity.ID,
				Status: string(ratchetjq.StatusFailed),
				ErrMsg: err.Error(),
			})
			return
		}

		ctx.JSON(http.StatusOK, dto.SyncRatchetJobResponseDTO{
			Id:        entity.ID,
			Status:    string(result.Status),
			OutParams: result.OutParams,
		})
	}
}
