CREATE TYPE "public"."intake_session_status" AS ENUM('queued', 'running', 'failed', 'completed');--> statement-breakpoint
CREATE TABLE "intake_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"attempt" integer NOT NULL,
	"provider" varchar(120) NOT NULL,
	"model" varchar(200) NOT NULL,
	"request_id" varchar(255),
	"prompt_version" varchar(120) NOT NULL,
	"outcome" varchar(40) NOT NULL,
	"error_code" varchar(120),
	"error_message" text,
	"input_tokens" integer,
	"cached_input_tokens" integer,
	"output_tokens" integer,
	"reasoning_tokens" integer,
	"input_characters" integer,
	"output_characters" integer,
	"cost_microunits" integer,
	"pricing_version" varchar(120),
	"context_manifest" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"latency_ms" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "intake_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"status" "intake_session_status" DEFAULT 'queued' NOT NULL,
	"input" jsonb NOT NULL,
	"input_hash" varchar(64) NOT NULL,
	"brief" jsonb,
	"brief_hash" varchar(64),
	"video_run_id" uuid,
	"failure_code" varchar(120),
	"failure_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "source_documents" ADD COLUMN "source_bytes_sha256" varchar(64);--> statement-breakpoint
ALTER TABLE "intake_attempts" ADD CONSTRAINT "intake_attempts_session_id_intake_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."intake_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_sessions" ADD CONSTRAINT "intake_sessions_video_run_id_video_runs_id_fk" FOREIGN KEY ("video_run_id") REFERENCES "public"."video_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "intake_attempt_number_idx" ON "intake_attempts" USING btree ("session_id","attempt");--> statement-breakpoint
CREATE INDEX "intake_attempts_session_idx" ON "intake_attempts" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "intake_sessions_status_idx" ON "intake_sessions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "intake_sessions_created_idx" ON "intake_sessions" USING btree ("created_at");