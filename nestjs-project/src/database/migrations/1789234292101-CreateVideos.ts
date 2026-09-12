import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateVideos1789234292101 implements MigrationInterface {
  name = 'CreateVideos1789234292101';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."videos_status_enum" AS ENUM('draft', 'uploading', 'processing', 'ready', 'failed')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."videos_error_reason_enum" AS ENUM('INVALID_MEDIA', 'PROCESSING_FAILED', 'UPLOAD_ABANDONED', 'THUMBNAIL_FAILED')`,
    );
    await queryRunner.query(
      `CREATE TABLE "videos" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "public_id" character varying(12) NOT NULL, "channel_id" uuid NOT NULL, "title" character varying(100) NOT NULL, "original_filename" character varying(255) NOT NULL, "content_type" character varying(50) NOT NULL, "size_bytes" bigint NOT NULL, "status" "public"."videos_status_enum" NOT NULL DEFAULT 'draft', "storage_key" character varying(255) NOT NULL, "upload_id" text, "part_size_bytes" integer NOT NULL, "part_count" integer NOT NULL, "duration_seconds" numeric(10,3), "width" integer, "height" integer, "codec_name" character varying(50), "container_format" character varying(100), "moov_at_end" boolean, "metadata" jsonb, "thumbnail_key" character varying(255), "error_reason" "public"."videos_error_reason_enum", "error_detail" text, "processing_attempts" integer NOT NULL DEFAULT '0', "uploaded_at" TIMESTAMP, "processed_at" TIMESTAMP, "created_at" TIMESTAMP NOT NULL DEFAULT now(), "updated_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "UQ_39a1f0fe7991162aace659078ec" UNIQUE ("public_id"), CONSTRAINT "PK_e4c86c0cf95aff16e9fb8220f6b" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_fa92ce74fa6331a7ad7743dea5" ON "videos" ("status", "created_at") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_33b997d60e0bac645832489a2a" ON "videos" ("channel_id", "status") `,
    );
    await queryRunner.query(
      `ALTER TABLE "videos" ADD CONSTRAINT "FK_023a8e4f3f1a34ff3d8ca04a4cc" FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "videos" DROP CONSTRAINT "FK_023a8e4f3f1a34ff3d8ca04a4cc"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_33b997d60e0bac645832489a2a"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_fa92ce74fa6331a7ad7743dea5"`,
    );
    await queryRunner.query(`DROP TABLE "videos"`);
    await queryRunner.query(`DROP TYPE "public"."videos_error_reason_enum"`);
    await queryRunner.query(`DROP TYPE "public"."videos_status_enum"`);
  }
}
