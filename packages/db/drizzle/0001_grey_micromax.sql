ALTER TABLE "provider_usage" ADD COLUMN "request_id" varchar(255);--> statement-breakpoint
ALTER TABLE "provider_usage" ADD COLUMN "outcome" varchar(40) DEFAULT 'completed' NOT NULL;--> statement-breakpoint
ALTER TABLE "provider_usage" ADD COLUMN "error_code" varchar(120);--> statement-breakpoint
ALTER TABLE "provider_usage" ADD COLUMN "cached_input_tokens" integer;--> statement-breakpoint
ALTER TABLE "provider_usage" ADD COLUMN "reasoning_tokens" integer;--> statement-breakpoint
ALTER TABLE "provider_usage" ADD COLUMN "input_characters" integer;--> statement-breakpoint
ALTER TABLE "provider_usage" ADD COLUMN "output_characters" integer;--> statement-breakpoint
ALTER TABLE "provider_usage" ADD COLUMN "pricing_version" varchar(120);--> statement-breakpoint
ALTER TABLE "provider_usage" ADD COLUMN "prompt_version" varchar(120);--> statement-breakpoint
ALTER TABLE "provider_usage" ADD COLUMN "context_manifest" jsonb DEFAULT '{}'::jsonb NOT NULL;