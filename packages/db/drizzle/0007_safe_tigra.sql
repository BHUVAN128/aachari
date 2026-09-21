ALTER TABLE "approvals" DROP CONSTRAINT "approvals_clinician_approver_id_clinician_approvers_id_fk";
--> statement-breakpoint
ALTER TABLE "approvals" DROP COLUMN "clinician_approver_id";
--> statement-breakpoint
DROP TABLE "clinician_approvers";
--> statement-breakpoint
ALTER TABLE "video_runs" ALTER COLUMN "domain" SET DATA TYPE text;
--> statement-breakpoint
-- Data-migration guard: existing medical rows become standard (medical is no
-- longer a domain). Must happen before the enum value is removed so a live
-- database with medical rows migrates cleanly.
UPDATE "video_runs" SET "domain" = 'standard' WHERE "domain" = 'medical';
--> statement-breakpoint
DROP TYPE "public"."run_domain";
--> statement-breakpoint
CREATE TYPE "public"."run_domain" AS ENUM('standard', 'engineering', 'client-production');
--> statement-breakpoint
ALTER TABLE "video_runs" ALTER COLUMN "domain" SET DATA TYPE "public"."run_domain" USING "domain"::"public"."run_domain";
