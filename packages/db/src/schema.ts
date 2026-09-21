import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import type { InputSnapshot, ModelRoute, QaFinding } from "@upcraft/contracts";

export const runStatus = pgEnum("run_status", ["queued", "running", "awaiting_approval", "failed", "completed"]);
export const intakeSessionStatus = pgEnum("intake_session_status", ["queued", "running", "failed", "completed"]);
export const runDomain = pgEnum("run_domain", ["standard", "engineering", "client-production"]);
export const stageName = pgEnum("stage_name", [
  "preflight", "research", "fact-verification", "blueprint", "script", "visual-bible", "assets",
  "voiceover", "captions", "spatial-layout", "manifest", "preview-render", "qa", "approval",
  "final-render", "release-record",
]);
export const artifactStatus = pgEnum("artifact_status", ["pending", "valid", "invalid", "failed", "superseded"]);
export const approvalDecision = pgEnum("approval_decision", ["approved", "rejected"]);
export const qaSeverity = pgEnum("qa_severity", ["info", "warning", "critical"]);

const id = () => uuid("id").defaultRandom().primaryKey();
const createdAt = () => timestamp("created_at", { withTimezone: true }).defaultNow().notNull();

export const videoRuns = pgTable("video_runs", {
  id: id(),
  status: runStatus("status").notNull().default("queued"),
  domain: runDomain("domain").notNull(),
  currentStage: stageName("current_stage"),
  title: varchar("title", { length: 500 }).notNull(),
  snapshot: jsonb("snapshot").$type<InputSnapshot>().notNull(),
  snapshotHash: varchar("snapshot_hash", { length: 64 }).notNull(),
  rendererVersion: varchar("renderer_version", { length: 120 }),
  failureCode: varchar("failure_code", { length: 120 }),
  failureMessage: text("failure_message"),
  createdAt: createdAt(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
}, (table) => [index("video_runs_status_idx").on(table.status), index("video_runs_created_idx").on(table.createdAt)]);

export const intakeSessions = pgTable("intake_sessions", {
  id: id(),
  status: intakeSessionStatus("status").notNull().default("queued"),
  input: jsonb("input").$type<Record<string, unknown>>().notNull(),
  inputHash: varchar("input_hash", { length: 64 }).notNull(),
  brief: jsonb("brief").$type<Record<string, unknown>>(),
  briefHash: varchar("brief_hash", { length: 64 }),
  videoRunId: uuid("video_run_id").references(() => videoRuns.id, { onDelete: "set null" }),
  failureCode: varchar("failure_code", { length: 120 }),
  failureMessage: text("failure_message"),
  createdAt: createdAt(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [index("intake_sessions_status_idx").on(table.status), index("intake_sessions_created_idx").on(table.createdAt)]);

export const intakeAttempts = pgTable("intake_attempts", {
  id: id(),
  sessionId: uuid("session_id").notNull().references(() => intakeSessions.id, { onDelete: "cascade" }),
  attempt: integer("attempt").notNull(),
  provider: varchar("provider", { length: 120 }).notNull(),
  model: varchar("model", { length: 200 }).notNull(),
  requestId: varchar("request_id", { length: 255 }),
  promptVersion: varchar("prompt_version", { length: 120 }).notNull(),
  outcome: varchar("outcome", { length: 40 }).notNull(),
  errorCode: varchar("error_code", { length: 120 }),
  errorMessage: text("error_message"),
  inputTokens: integer("input_tokens"),
  cachedInputTokens: integer("cached_input_tokens"),
  outputTokens: integer("output_tokens"),
  reasoningTokens: integer("reasoning_tokens"),
  inputCharacters: integer("input_characters"),
  outputCharacters: integer("output_characters"),
  costMicrounits: integer("cost_microunits"),
  pricingVersion: varchar("pricing_version", { length: 120 }),
  contextManifest: jsonb("context_manifest").$type<Record<string, unknown>>().notNull().default({}),
  latencyMs: integer("latency_ms").notNull(),
  createdAt: createdAt(),
}, (table) => [uniqueIndex("intake_attempt_number_idx").on(table.sessionId, table.attempt), index("intake_attempts_session_idx").on(table.sessionId)]);

export const sourceDocuments = pgTable("source_documents", {
  id: id(),
  runId: uuid("run_id").notNull().references(() => videoRuns.id, { onDelete: "cascade" }),
  kind: varchar("kind", { length: 32 }).notNull(),
  originalName: varchar("original_name", { length: 500 }).notNull(),
  objectKey: varchar("object_key", { length: 1024 }),
  sourceUrl: text("source_url"),
  retrievedUrl: text("retrieved_url"),
  retrievalStatus: varchar("retrieval_status", { length: 40 }),
  sourceByteSize: integer("source_byte_size"),
  sha256: varchar("sha256", { length: 64 }).notNull(),
  sourceBytesSha256: varchar("source_bytes_sha256", { length: 64 }),
  mimeType: varchar("mime_type", { length: 255 }).notNull(),
  extractedText: text("extracted_text"),
  retrievedAt: timestamp("retrieved_at", { withTimezone: true }),
  createdAt: createdAt(),
}, (table) => [index("source_documents_run_idx").on(table.runId)]);

export const sourceClaims = pgTable("source_claims", {
  id: id(),
  runId: uuid("run_id").notNull().references(() => videoRuns.id, { onDelete: "cascade" }),
  sourceId: uuid("source_id").notNull().references(() => sourceDocuments.id, { onDelete: "cascade" }),
  claim: text("claim").notNull(),
  locator: varchar("locator", { length: 1000 }).notNull(),
  evidence: jsonb("evidence").$type<Record<string, unknown>>().notNull().default({}),
  critical: boolean("critical").notNull().default(false),
  verifiedAt: timestamp("verified_at", { withTimezone: true }),
  verifierModel: varchar("verifier_model", { length: 200 }),
  createdAt: createdAt(),
}, (table) => [index("source_claims_run_idx").on(table.runId)]);

export const artifacts = pgTable("artifacts", {
  id: id(),
  runId: uuid("run_id").notNull().references(() => videoRuns.id, { onDelete: "cascade" }),
  stage: stageName("stage").notNull(),
  role: varchar("role", { length: 120 }).notNull(),
  version: integer("version").notNull().default(1),
  status: artifactStatus("status").notNull().default("pending"),
  schemaVersion: varchar("schema_version", { length: 120 }).notNull(),
  content: jsonb("content").$type<Record<string, unknown>>(),
  objectKey: varchar("object_key", { length: 1024 }),
  sha256: varchar("sha256", { length: 64 }),
  mimeType: varchar("mime_type", { length: 255 }),
  byteSize: integer("byte_size"),
  provenance: jsonb("provenance").$type<Record<string, unknown>>().notNull().default({}),
  inputHash: varchar("input_hash", { length: 64 }).notNull(),
  createdAt: createdAt(),
  validatedAt: timestamp("validated_at", { withTimezone: true }),
}, (table) => [
  uniqueIndex("artifacts_run_stage_role_version_idx").on(table.runId, table.stage, table.role, table.version),
  index("artifacts_run_stage_idx").on(table.runId, table.stage),
]);

export const artifactAttempts = pgTable("artifact_attempts", {
  id: id(),
  artifactId: uuid("artifact_id").notNull().references(() => artifacts.id, { onDelete: "cascade" }),
  attempt: integer("attempt").notNull(),
  inputHash: varchar("input_hash", { length: 64 }),
  outputHash: varchar("output_hash", { length: 64 }),
  schemaVersion: varchar("schema_version", { length: 120 }),
  provider: varchar("provider", { length: 120 }),
  model: varchar("model", { length: 200 }),
  promptVersion: varchar("prompt_version", { length: 120 }),
  outcome: varchar("outcome", { length: 40 }).notNull(),
  errorCode: varchar("error_code", { length: 120 }),
  errorMessage: text("error_message"),
  validationEvidence: jsonb("validation_evidence").$type<Record<string, unknown>>().notNull().default({}),
  latencyMs: integer("latency_ms"),
  costMicrounits: integer("cost_microunits"),
  createdAt: createdAt(),
}, (table) => [uniqueIndex("artifact_attempt_number_idx").on(table.artifactId, table.attempt)]);

export const stageCheckpoints = pgTable("stage_checkpoints", {
  id: id(),
  runId: uuid("run_id").notNull().references(() => videoRuns.id, { onDelete: "cascade" }),
  stage: stageName("stage").notNull(),
  inputHash: varchar("input_hash", { length: 64 }).notNull(),
  outputHash: varchar("output_hash", { length: 64 }),
  outcome: varchar("outcome", { length: 40 }).notNull(),
  leaseToken: uuid("lease_token"),
  leaseOwner: varchar("lease_owner", { length: 255 }),
  leaseHeartbeatAt: timestamp("lease_heartbeat_at", { withTimezone: true }),
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
  attemptCount: integer("attempt_count").notNull().default(0),
  evidence: jsonb("evidence").$type<Record<string, unknown>>().notNull().default({}),
  /** Frozen route resolved before this stage started; null for legacy rows. */
  modelRoute: jsonb("model_route").$type<ModelRoute>(),
  createdAt: createdAt(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [uniqueIndex("stage_checkpoints_run_stage_idx").on(table.runId, table.stage)]);

export const mediaAssets = pgTable("media_assets", {
  id: id(),
  runId: uuid("run_id").notNull().references(() => videoRuns.id, { onDelete: "cascade" }),
  sceneId: uuid("scene_id"),
  role: varchar("role", { length: 120 }).notNull(),
  objectKey: varchar("object_key", { length: 1024 }).notNull(),
  sha256: varchar("sha256", { length: 64 }).notNull(),
  mimeType: varchar("mime_type", { length: 255 }).notNull(),
  byteSize: integer("byte_size").notNull(),
  width: integer("width"),
  height: integer("height"),
  selected: boolean("selected").notNull().default(false),
  provenance: jsonb("provenance").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: createdAt(),
}, (table) => [
  index("media_assets_run_idx").on(table.runId),
  uniqueIndex("media_assets_run_role_hash_idx").on(table.runId, table.role, table.sha256),
]);

export const assetAnchors = pgTable("asset_anchors", {
  id: id(),
  assetId: uuid("asset_id").notNull().references(() => mediaAssets.id, { onDelete: "cascade" }),
  name: varchar("name", { length: 200 }).notNull(),
  x: integer("x_millionths").notNull(),
  y: integer("y_millionths").notNull(),
  provider: varchar("provider", { length: 40 }).notNull(),
  confidenceMillionths: integer("confidence_millionths"),
  createdAt: createdAt(),
}, (table) => [uniqueIndex("asset_anchor_name_idx").on(table.assetId, table.name)]);

export const qaFindings = pgTable("qa_findings", {
  id: id(),
  runId: uuid("run_id").notNull().references(() => videoRuns.id, { onDelete: "cascade" }),
  artifactId: uuid("artifact_id").references(() => artifacts.id, { onDelete: "set null" }),
  rule: varchar("rule", { length: 200 }).notNull(),
  severity: qaSeverity("severity").notNull(),
  evidence: jsonb("evidence").$type<QaFinding["evidence"]>().notNull(),
  remediation: text("remediation").notNull(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  createdAt: createdAt(),
}, (table) => [index("qa_findings_run_idx").on(table.runId)]);

export const approvals = pgTable("approvals", {
  id: id(),
  runId: uuid("run_id").notNull().references(() => videoRuns.id, { onDelete: "cascade" }),
  decision: approvalDecision("decision").notNull(),
  reviewerId: varchar("reviewer_id", { length: 255 }).notNull(),
  notes: text("notes").notNull().default(""),
  createdAt: createdAt(),
}, (table) => [index("approvals_run_idx").on(table.runId)]);

export const renderOutputs = pgTable("render_outputs", {
  id: id(),
  runId: uuid("run_id").notNull().references(() => videoRuns.id, { onDelete: "cascade" }),
  kind: varchar("kind", { length: 40 }).notNull(),
  objectKey: varchar("object_key", { length: 1024 }).notNull(),
  sha256: varchar("sha256", { length: 64 }).notNull(),
  durationMs: integer("duration_ms").notNull(),
  width: integer("width").notNull(),
  height: integer("height").notNull(),
  createdAt: createdAt(),
}, (table) => [uniqueIndex("render_outputs_run_kind_idx").on(table.runId, table.kind)]);

export const viewerOutcomes = pgTable("viewer_outcomes", {
  id: id(),
  runId: uuid("run_id").notNull().references(() => videoRuns.id, { onDelete: "cascade" }),
  kind: varchar("kind", { length: 40 }).notNull(),
  segment: varchar("segment", { length: 200 }),
  metric: varchar("metric", { length: 200 }).notNull(),
  value: integer("value_millionths").notNull(),
  unit: varchar("unit", { length: 40 }),
  detail: jsonb("detail").$type<Record<string, unknown>>().notNull().default({}),
  recordedBy: varchar("recorded_by", { length: 255 }).notNull(),
  createdAt: createdAt(),
}, (table) => [index("viewer_outcomes_run_idx").on(table.runId), index("viewer_outcomes_kind_idx").on(table.kind)]);

export const runEvents = pgTable("run_events", {
  id: id(),
  runId: uuid("run_id").notNull().references(() => videoRuns.id, { onDelete: "cascade" }),
  sequence: integer("sequence").notNull(),
  stage: stageName("stage"),
  type: varchar("type", { length: 40 }).notNull(),
  message: text("message").notNull(),
  data: jsonb("data").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: createdAt(),
}, (table) => [uniqueIndex("run_events_run_sequence_idx").on(table.runId, table.sequence), index("run_events_run_created_idx").on(table.runId, table.createdAt)]);

export const providerUsage = pgTable("provider_usage", {
  id: id(),
  runId: uuid("run_id").notNull().references(() => videoRuns.id, { onDelete: "cascade" }),
  stage: stageName("stage").notNull(),
  provider: varchar("provider", { length: 120 }).notNull(),
  model: varchar("model", { length: 200 }).notNull(),
  requestId: varchar("request_id", { length: 255 }),
  outcome: varchar("outcome", { length: 40 }).notNull().default("completed"),
  errorCode: varchar("error_code", { length: 120 }),
  inputTokens: integer("input_tokens"),
  cachedInputTokens: integer("cached_input_tokens"),
  outputTokens: integer("output_tokens"),
  reasoningTokens: integer("reasoning_tokens"),
  inputCharacters: integer("input_characters"),
  outputCharacters: integer("output_characters"),
  costMicrounits: integer("cost_microunits"),
  pricingVersion: varchar("pricing_version", { length: 120 }),
  promptVersion: varchar("prompt_version", { length: 120 }),
  contextManifest: jsonb("context_manifest").$type<Record<string, unknown>>().notNull().default({}),
  latencyMs: integer("latency_ms").notNull(),
  createdAt: createdAt(),
}, (table) => [index("provider_usage_run_idx").on(table.runId)]);

export const outbox = pgTable("outbox", {
  id: id(),
  topic: varchar("topic", { length: 120 }).notNull(),
  key: varchar("key", { length: 255 }).notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
  publishedAt: timestamp("published_at", { withTimezone: true }),
  createdAt: createdAt(),
}, (table) => [uniqueIndex("outbox_topic_key_idx").on(table.topic, table.key)]);

export const runArtifactLinks = pgTable("run_artifact_links", {
  runId: uuid("run_id").notNull().references(() => videoRuns.id, { onDelete: "cascade" }),
  artifactId: uuid("artifact_id").notNull().references(() => artifacts.id, { onDelete: "cascade" }),
  relation: varchar("relation", { length: 80 }).notNull(),
  createdAt: createdAt(),
}, (table) => [primaryKey({ columns: [table.runId, table.artifactId, table.relation] })]);

export const dbNow = sql`now()`;
