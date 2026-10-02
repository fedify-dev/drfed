CREATE TYPE "activity_log_direction" AS ENUM('inbound', 'outbound');--> statement-breakpoint
CREATE TYPE "activity_log_status" AS ENUM('received', 'acknowledged', 'unverified', 'rejected', 'queued', 'sent', 'failed', 'permanently_failed', 'abandoned');--> statement-breakpoint
CREATE TYPE "activity_log_verification_mechanism" AS ENUM('http_signature', 'ld_signature', 'object_integrity_proof');--> statement-breakpoint
CREATE TYPE "activity_log_verification_result" AS ENUM('verified', 'invalid_signature', 'key_fetch_error', 'no_signature', 'unattempted', 'unobserved');--> statement-breakpoint
CREATE TABLE "activity_log_actor_collections" (
	"log_id" uuid,
	"actor_id" uuid,
	"collection_iri" text,
	CONSTRAINT "activity_log_actor_collections_pkey" PRIMARY KEY("log_id","actor_id","collection_iri")
);
--> statement-breakpoint
CREATE TABLE "activity_log_actors" (
	"log_id" uuid,
	"actor_id" uuid,
	"inbox_owner" boolean DEFAULT false NOT NULL,
	"addressed" boolean DEFAULT false NOT NULL,
	"addressed_directly" boolean DEFAULT false NOT NULL,
	"sender" boolean DEFAULT false NOT NULL,
	"created" timestamp with time zone NOT NULL,
	CONSTRAINT "activity_log_actors_pkey" PRIMARY KEY("log_id","actor_id"),
	CONSTRAINT "activity_log_actors_role_check" CHECK ("inbox_owner" OR "addressed" OR "sender"),
	CONSTRAINT "activity_log_actors_addressed_directly_check" CHECK (NOT "addressed_directly" OR "addressed")
);
--> statement-breakpoint
CREATE TABLE "activity_log_attempts" (
	"id" uuid PRIMARY KEY,
	"log_id" uuid NOT NULL,
	"succeeded" boolean NOT NULL,
	"status_code" integer,
	"response_body" text,
	"error" text,
	"created" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "activity_log_attempts_status_code_check" CHECK ("status_code" IS NULL OR "status_code" BETWEEN 100 AND 599),
	CONSTRAINT "activity_log_attempts_error_check" CHECK ("succeeded" = ("error" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "activity_logs" (
	"id" uuid PRIMARY KEY,
	"instance_id" uuid NOT NULL,
	"actor_id" uuid,
	"direction" "activity_log_direction" NOT NULL,
	"status" "activity_log_status" NOT NULL,
	"verification_mechanism" "activity_log_verification_mechanism",
	"verification_result" "activity_log_verification_result",
	"type" text,
	"types" text[] DEFAULT '{}'::text[] NOT NULL,
	"activity_iri" text,
	"object_type" text,
	"object_iri" text,
	"signed_key_iri" text,
	"verification_key_id" uuid,
	"remote_actor_iri" text,
	"remote_host" text,
	"inbox_url" text NOT NULL,
	"request_url" text,
	"headers" jsonb,
	"body" bytea,
	"status_code" integer,
	"response_body" text,
	"error" text,
	"payload" jsonb,
	"recipient_iris" text[] DEFAULT '{}'::text[] NOT NULL,
	"created" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"completed" timestamp with time zone,
	CONSTRAINT "activity_logs_direction_status_check" CHECK (("direction" = 'inbound' AND "status" IN ('received', 'acknowledged', 'unverified', 'rejected')) OR ("direction" = 'outbound' AND "status" IN ('queued', 'sent', 'failed', 'permanently_failed', 'abandoned'))),
	CONSTRAINT "activity_logs_completed_check" CHECK (("completed" IS NULL) = ("status" = 'queued')),
	CONSTRAINT "activity_logs_status_code_check" CHECK ("status_code" IS NULL OR "status_code" BETWEEN 100 AND 599),
	CONSTRAINT "activity_logs_outbound_key_check" CHECK ("direction" <> 'outbound' OR "verification_key_id" IS NULL),
	CONSTRAINT "activity_logs_verification_result_check" CHECK (("direction" = 'inbound') = ("verification_result" IS NOT NULL)),
	CONSTRAINT "activity_logs_verification_mechanism_check" CHECK ("verification_mechanism" IS NULL OR ("direction" = 'inbound' AND "verification_result" NOT IN ('unattempted', 'unobserved'))),
	CONSTRAINT "activity_logs_body_check" CHECK (("direction" = 'inbound') = ("body" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "key_versions" (
	"id" uuid PRIMARY KEY,
	"key_id" uuid NOT NULL,
	"public_key" jsonb NOT NULL,
	"fingerprint" text NOT NULL,
	"first_seen" timestamp with time zone NOT NULL,
	"last_seen" timestamp with time zone NOT NULL,
	CONSTRAINT "key_versions_key_id_fingerprint_unique" UNIQUE("key_id","fingerprint"),
	CONSTRAINT "key_versions_seen_check" CHECK ("last_seen" >= "first_seen"),
	CONSTRAINT "key_versions_public_key_check" CHECK (NOT ("public_key" ?| array['d','p','q','dp','dq','qi','oth','k']))
);
--> statement-breakpoint
CREATE TABLE "keys" (
	"id" uuid PRIMARY KEY,
	"iri" text NOT NULL UNIQUE,
	"created" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX "activity_log_actor_created_index" ON "activity_log_actors" ("actor_id","created" desc,"log_id" desc);--> statement-breakpoint
CREATE INDEX "activity_log_attempt_log_index" ON "activity_log_attempts" ("log_id","created","id");--> statement-breakpoint
CREATE INDEX "activity_log_instance_created_index" ON "activity_logs" ("instance_id","created" desc,"id" desc);--> statement-breakpoint
CREATE INDEX "activity_log_actor_index" ON "activity_logs" ("actor_id");--> statement-breakpoint
CREATE INDEX "activity_log_verification_key_index" ON "activity_logs" ("verification_key_id");--> statement-breakpoint
CREATE INDEX "activity_log_outbound_index" ON "activity_logs" ("activity_iri","inbox_url") WHERE "direction" = 'outbound';--> statement-breakpoint
CREATE INDEX "key_version_key_first_seen_index" ON "key_versions" ("key_id","first_seen","id");--> statement-breakpoint
ALTER TABLE "activity_log_actor_collections" ADD CONSTRAINT "activity_log_actor_collections_link_fkey" FOREIGN KEY ("log_id","actor_id") REFERENCES "activity_log_actors"("log_id","actor_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "activity_log_actors" ADD CONSTRAINT "activity_log_actors_log_id_activity_logs_id_fkey" FOREIGN KEY ("log_id") REFERENCES "activity_logs"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "activity_log_actors" ADD CONSTRAINT "activity_log_actors_actor_id_actors_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "actors"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "activity_log_attempts" ADD CONSTRAINT "activity_log_attempts_log_id_activity_logs_id_fkey" FOREIGN KEY ("log_id") REFERENCES "activity_logs"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "activity_logs" ADD CONSTRAINT "activity_logs_instance_id_instances_id_fkey" FOREIGN KEY ("instance_id") REFERENCES "instances"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "activity_logs" ADD CONSTRAINT "activity_logs_actor_id_actors_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "actors"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "activity_logs" ADD CONSTRAINT "activity_logs_verification_key_id_key_versions_id_fkey" FOREIGN KEY ("verification_key_id") REFERENCES "key_versions"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "key_versions" ADD CONSTRAINT "key_versions_key_id_keys_id_fkey" FOREIGN KEY ("key_id") REFERENCES "keys"("id") ON DELETE RESTRICT;