import { MigrationInterface, QueryRunner } from 'typeorm'

export class AddRatchetjqJobTable1786400000000 implements MigrationInterface {
  name = 'AddRatchetjqJobTable1786400000000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."ratchetjq_job_period_enum" AS ENUM('pending_run', 'running', 'accepting', 'completed')`,
    )
    await queryRunner.query(`CREATE TYPE "public"."ratchetjq_job_status_enum" AS ENUM('ok', 'rejected', 'timeout')`)
    // The new job service's own table, added beside the legacy "job" table
    // rather than replacing it.
    //
    // "ttlSeconds" and "attlSeconds" — the spec's ttl and attl — are counts of
    // seconds, which keeps them comparable to the backoff as plain numbers: the
    // scheduler writes now() + GREATEST("ttlSeconds", POW(attempt, 4)) *
    // interval '1s' and converts once. "channel" is an integer
    // because 0 means "do not deduplicate", which the unique index below tests
    // for. "pr" defaults mid-range rather than to 0: claims order by pr ASC and
    // negatives are refused, so 0 is the most urgent value and defaulting to it
    // would leave no way to ask for anything more urgent than ordinary work. "period" has no default: the asynchronous and synchronous submission
    // paths deliberately start a job at different stages.
    await queryRunner.query(
      `CREATE TABLE "ratchetjq_job" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "channel" integer NOT NULL DEFAULT '0', "executor" character varying NOT NULL, "executorId" character varying NOT NULL, "resourceId" character varying NOT NULL, "pr" integer NOT NULL DEFAULT '12', "type" character varying NOT NULL, "inParams" jsonb, "outParams" jsonb, "period" "public"."ratchetjq_job_period_enum" NOT NULL, "status" "public"."ratchetjq_job_status_enum", "leaseExpiresAt" TIMESTAMP WITH TIME ZONE NOT NULL, "visibleAt" TIMESTAMP WITH TIME ZONE NOT NULL, "attempt" integer NOT NULL, "ttlSeconds" integer NOT NULL, "attlSeconds" integer NOT NULL, "rollbackType" character varying, "rollbackJobId" uuid, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "ratchetjq_job_id_pk" PRIMARY KEY ("id"))`,
    )
    // Steady-state claim: an executor instance's own runnable rows. Ordering
    // comes from the index, so the query stops at its LIMIT without sorting.
    await queryRunner.query(
      `CREATE INDEX "ratchetjq_job_lease_expires_idx" ON "ratchetjq_job" ("executor", "executorId", "period", "pr", "leaseExpiresAt")`,
    )
    // Restart reclaim: same prefix, ordered by backoff instead of lease, so a
    // runner coming back up does not have to scan its own in-flight rows.
    await queryRunner.query(
      `CREATE INDEX "ratchetjq_job_visible_idx" ON "ratchetjq_job" ("executor", "executorId", "period", "pr", "visibleAt")`,
    )
    // Scanner's global sweep. No executor prefix, so neither index above serves
    // it.
    await queryRunner.query(
      `CREATE INDEX "ratchetjq_job_proposer_idx" ON "ratchetjq_job" ("period", "pr", "leaseExpiresAt")`,
    )
    // At most one unfinished job per channel, executor instance and resource.
    // Partial on both counts: channel 0 opts out of deduplication, and a
    // completed job must not block the next submission.
    await queryRunner.query(
      `CREATE UNIQUE INDEX "ratchetjq_job_dedup_unique" ON "ratchetjq_job" ("channel", "executor", "executorId", "resourceId") WHERE "channel" <> 0 AND "period" <> 'completed'`,
    )
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "public"."ratchetjq_job_dedup_unique"`)
    await queryRunner.query(`DROP INDEX IF EXISTS "public"."ratchetjq_job_proposer_idx"`)
    await queryRunner.query(`DROP INDEX IF EXISTS "public"."ratchetjq_job_visible_idx"`)
    await queryRunner.query(`DROP INDEX IF EXISTS "public"."ratchetjq_job_lease_expires_idx"`)
    await queryRunner.query(`DROP TABLE "ratchetjq_job"`)
    await queryRunner.query(`DROP TYPE "public"."ratchetjq_job_status_enum"`)
    await queryRunner.query(`DROP TYPE "public"."ratchetjq_job_period_enum"`)
  }
}
