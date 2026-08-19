import { MigrationInterface, QueryRunner } from 'typeorm'

export class AddRatchetjqJobErrMsg1786410000000 implements MigrationInterface {
  name = 'AddRatchetjqJobErrMsg1786410000000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    // The rename-and-swap rather than `ALTER TYPE ... ADD VALUE`. Both work on
    // Postgres 16, but only this one is symmetric with `down`, which has to
    // shrink the type and can only do that by swapping — so writing `up` the
    // other way would leave the pair reading as two unrelated statements.
    await queryRunner.query(
      `ALTER TYPE "public"."ratchetjq_job_status_enum" RENAME TO "ratchetjq_job_status_enum_old"`,
    )
    await queryRunner.query(
      `CREATE TYPE "public"."ratchetjq_job_status_enum" AS ENUM('ok', 'rejected', 'timeout', 'failed')`,
    )
    await queryRunner.query(
      `ALTER TABLE "ratchetjq_job" ALTER COLUMN "status" TYPE "public"."ratchetjq_job_status_enum" USING "status"::"text"::"public"."ratchetjq_job_status_enum"`,
    )
    await queryRunner.query(`DROP TYPE "public"."ratchetjq_job_status_enum_old"`)

    // Bounded, not `text`: the value is whatever a remote executor said, and the
    // length is the backstop under the truncation that feeds it
    // (RATCHETJQ_ERR_MSG_MAX_CHARS).
    await queryRunner.query(`ALTER TABLE "ratchetjq_job" ADD "errMsg" character varying(1024)`)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "ratchetjq_job" DROP COLUMN "errMsg"`)

    // Rows holding the value being removed have to go somewhere before the cast,
    // or it fails on them. `rejected` is the closest surviving meaning — the
    // outcome did not stand — and the loss is real but unavoidable: the column
    // that held the reason was just dropped, so there is nothing left to
    // preserve the distinction with.
    await queryRunner.query(`UPDATE "ratchetjq_job" SET "status" = 'rejected' WHERE "status" = 'failed'`)
    await queryRunner.query(
      `ALTER TYPE "public"."ratchetjq_job_status_enum" RENAME TO "ratchetjq_job_status_enum_old"`,
    )
    await queryRunner.query(`CREATE TYPE "public"."ratchetjq_job_status_enum" AS ENUM('ok', 'rejected', 'timeout')`)
    await queryRunner.query(
      `ALTER TABLE "ratchetjq_job" ALTER COLUMN "status" TYPE "public"."ratchetjq_job_status_enum" USING "status"::"text"::"public"."ratchetjq_job_status_enum"`,
    )
    await queryRunner.query(`DROP TYPE "public"."ratchetjq_job_status_enum_old"`)
  }
}
