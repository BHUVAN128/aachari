CREATE TABLE "viewer_outcomes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"kind" varchar(40) NOT NULL,
	"segment" varchar(200),
	"metric" varchar(200) NOT NULL,
	"value_millionths" integer NOT NULL,
	"unit" varchar(40),
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"recorded_by" varchar(255) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "viewer_outcomes" ADD CONSTRAINT "viewer_outcomes_run_id_video_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."video_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "viewer_outcomes_run_idx" ON "viewer_outcomes" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "viewer_outcomes_kind_idx" ON "viewer_outcomes" USING btree ("kind");