CREATE TYPE "public"."approval_decision" AS ENUM('approved', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."artifact_status" AS ENUM('pending', 'valid', 'invalid', 'failed', 'superseded');--> statement-breakpoint
CREATE TYPE "public"."qa_severity" AS ENUM('info', 'warning', 'critical');--> statement-breakpoint
CREATE TYPE "public"."run_domain" AS ENUM('standard', 'engineering', 'medical', 'client-production');--> statement-breakpoint
CREATE TYPE "public"."run_status" AS ENUM('queued', 'running', 'awaiting_approval', 'failed', 'completed');--> statement-breakpoint
CREATE TYPE "public"."stage_name" AS ENUM('preflight', 'research', 'fact-verification', 'blueprint', 'script', 'visual-bible', 'assets', 'voiceover', 'captions', 'spatial-layout', 'manifest', 'preview-render', 'qa', 'approval', 'final-render', 'release-record');--> statement-breakpoint
CREATE TABLE "approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"decision" "approval_decision" NOT NULL,
	"reviewer_id" varchar(255) NOT NULL,
	"clinician_approver_id" uuid,
	"notes" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "artifact_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"artifact_id" uuid NOT NULL,
	"attempt" integer NOT NULL,
	"provider" varchar(120),
	"model" varchar(200),
	"prompt_version" varchar(120),
	"outcome" varchar(40) NOT NULL,
	"error_code" varchar(120),
	"error_message" text,
	"latency_ms" integer,
	"cost_microunits" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"stage" "stage_name" NOT NULL,
	"role" varchar(120) NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"status" "artifact_status" DEFAULT 'pending' NOT NULL,
	"schema_version" varchar(120) NOT NULL,
	"content" jsonb,
	"object_key" varchar(1024),
	"sha256" varchar(64),
	"mime_type" varchar(255),
	"byte_size" integer,
	"provenance" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"input_hash" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"validated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "asset_anchors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"asset_id" uuid NOT NULL,
	"name" varchar(200) NOT NULL,
	"x_millionths" integer NOT NULL,
	"y_millionths" integer NOT NULL,
	"provider" varchar(40) NOT NULL,
	"confidence_millionths" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "clinician_approvers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clerk_user_id" varchar(255) NOT NULL,
	"display_name" varchar(255) NOT NULL,
	"credential_reference" varchar(255) NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "media_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"scene_id" uuid,
	"role" varchar(120) NOT NULL,
	"object_key" varchar(1024) NOT NULL,
	"sha256" varchar(64) NOT NULL,
	"mime_type" varchar(255) NOT NULL,
	"byte_size" integer NOT NULL,
	"width" integer,
	"height" integer,
	"selected" boolean DEFAULT false NOT NULL,
	"provenance" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"topic" varchar(120) NOT NULL,
	"key" varchar(255) NOT NULL,
	"payload" jsonb NOT NULL,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"stage" "stage_name" NOT NULL,
	"provider" varchar(120) NOT NULL,
	"model" varchar(200) NOT NULL,
	"input_tokens" integer,
	"output_tokens" integer,
	"cost_microunits" integer,
	"latency_ms" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "qa_findings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"artifact_id" uuid,
	"rule" varchar(200) NOT NULL,
	"severity" "qa_severity" NOT NULL,
	"evidence" jsonb NOT NULL,
	"remediation" text NOT NULL,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "render_outputs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"kind" varchar(40) NOT NULL,
	"object_key" varchar(1024) NOT NULL,
	"sha256" varchar(64) NOT NULL,
	"duration_ms" integer NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "run_artifact_links" (
	"run_id" uuid NOT NULL,
	"artifact_id" uuid NOT NULL,
	"relation" varchar(80) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "run_artifact_links_run_id_artifact_id_relation_pk" PRIMARY KEY("run_id","artifact_id","relation")
);
--> statement-breakpoint
CREATE TABLE "run_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"stage" "stage_name",
	"type" varchar(40) NOT NULL,
	"message" text NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source_claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"claim" text NOT NULL,
	"locator" varchar(1000) NOT NULL,
	"critical" boolean DEFAULT false NOT NULL,
	"verified_at" timestamp with time zone,
	"verifier_model" varchar(200),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"kind" varchar(32) NOT NULL,
	"original_name" varchar(500) NOT NULL,
	"object_key" varchar(1024),
	"source_url" text,
	"sha256" varchar(64) NOT NULL,
	"mime_type" varchar(255) NOT NULL,
	"extracted_text" text,
	"retrieved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stage_checkpoints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"stage" "stage_name" NOT NULL,
	"input_hash" varchar(64) NOT NULL,
	"output_hash" varchar(64),
	"outcome" varchar(40) NOT NULL,
	"lease_token" uuid,
	"lease_expires_at" timestamp with time zone,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "video_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"status" "run_status" DEFAULT 'queued' NOT NULL,
	"domain" "run_domain" NOT NULL,
	"current_stage" "stage_name",
	"title" varchar(500) NOT NULL,
	"snapshot" jsonb NOT NULL,
	"snapshot_hash" varchar(64) NOT NULL,
	"renderer_version" varchar(120),
	"failure_code" varchar(120),
	"failure_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_run_id_video_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."video_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_clinician_approver_id_clinician_approvers_id_fk" FOREIGN KEY ("clinician_approver_id") REFERENCES "public"."clinician_approvers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_attempts" ADD CONSTRAINT "artifact_attempts_artifact_id_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_run_id_video_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."video_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_anchors" ADD CONSTRAINT "asset_anchors_asset_id_media_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."media_assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_run_id_video_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."video_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_usage" ADD CONSTRAINT "provider_usage_run_id_video_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."video_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qa_findings" ADD CONSTRAINT "qa_findings_run_id_video_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."video_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qa_findings" ADD CONSTRAINT "qa_findings_artifact_id_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "render_outputs" ADD CONSTRAINT "render_outputs_run_id_video_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."video_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_artifact_links" ADD CONSTRAINT "run_artifact_links_run_id_video_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."video_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_artifact_links" ADD CONSTRAINT "run_artifact_links_artifact_id_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_events" ADD CONSTRAINT "run_events_run_id_video_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."video_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_claims" ADD CONSTRAINT "source_claims_run_id_video_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."video_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_claims" ADD CONSTRAINT "source_claims_source_id_source_documents_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."source_documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_documents" ADD CONSTRAINT "source_documents_run_id_video_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."video_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stage_checkpoints" ADD CONSTRAINT "stage_checkpoints_run_id_video_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."video_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "approvals_run_idx" ON "approvals" USING btree ("run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "artifact_attempt_number_idx" ON "artifact_attempts" USING btree ("artifact_id","attempt");--> statement-breakpoint
CREATE UNIQUE INDEX "artifacts_run_stage_role_version_idx" ON "artifacts" USING btree ("run_id","stage","role","version");--> statement-breakpoint
CREATE INDEX "artifacts_run_stage_idx" ON "artifacts" USING btree ("run_id","stage");--> statement-breakpoint
CREATE UNIQUE INDEX "asset_anchor_name_idx" ON "asset_anchors" USING btree ("asset_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "clinician_approvers_clerk_idx" ON "clinician_approvers" USING btree ("clerk_user_id");--> statement-breakpoint
CREATE INDEX "media_assets_run_idx" ON "media_assets" USING btree ("run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "outbox_topic_key_idx" ON "outbox" USING btree ("topic","key");--> statement-breakpoint
CREATE INDEX "provider_usage_run_idx" ON "provider_usage" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "qa_findings_run_idx" ON "qa_findings" USING btree ("run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "render_outputs_run_kind_idx" ON "render_outputs" USING btree ("run_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "run_events_run_sequence_idx" ON "run_events" USING btree ("run_id","sequence");--> statement-breakpoint
CREATE INDEX "run_events_run_created_idx" ON "run_events" USING btree ("run_id","created_at");--> statement-breakpoint
CREATE INDEX "source_claims_run_idx" ON "source_claims" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "source_documents_run_idx" ON "source_documents" USING btree ("run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "stage_checkpoints_run_stage_idx" ON "stage_checkpoints" USING btree ("run_id","stage");--> statement-breakpoint
CREATE INDEX "video_runs_status_idx" ON "video_runs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "video_runs_created_idx" ON "video_runs" USING btree ("created_at");