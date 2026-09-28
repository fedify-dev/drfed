CREATE TYPE "activity_log_direction" AS ENUM('inbound', 'outbound');--> statement-breakpoint
CREATE TYPE "activity_log_status" AS ENUM('received', 'unverified', 'rejected', 'queued', 'sent', 'failed', 'permanently_failed');--> statement-breakpoint
CREATE TABLE "activity_logs" (
	"id" uuid PRIMARY KEY,
	"instance_id" uuid NOT NULL,
	"actor_id" uuid,
	"direction" "activity_log_direction" NOT NULL,
	"status" "activity_log_status" NOT NULL,
	"type" text,
	"activity_iri" text,
	"object_type" text,
	"object_iri" text,
	"signed_key_iri" text,
	"verification_key_id" uuid,
	"remote_actor_iri" text,
	"remote_host" text,
	"inbox_url" text NOT NULL,
	"status_code" integer,
	"error" text,
	"payload" jsonb NOT NULL,
	"created" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "activity_logs_direction_status_check" CHECK (("direction" = 'inbound' AND "status" IN ('received', 'unverified', 'rejected')) OR ("direction" = 'outbound' AND "status" IN ('queued', 'sent', 'failed', 'permanently_failed'))),
	CONSTRAINT "activity_logs_status_code_check" CHECK ("status_code" IS NULL OR "status_code" BETWEEN 100 AND 599),
	CONSTRAINT "activity_logs_outbound_key_check" CHECK ("direction" <> 'outbound' OR "verification_key_id" IS NULL)
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
CREATE INDEX "activity_log_instance_created_index" ON "activity_logs" ("instance_id","created" desc,"id" desc);--> statement-breakpoint
CREATE INDEX "activity_log_actor_created_index" ON "activity_logs" ("actor_id","created" desc,"id" desc);--> statement-breakpoint
CREATE INDEX "activity_log_verification_key_index" ON "activity_logs" ("verification_key_id");--> statement-breakpoint
CREATE INDEX "activity_log_outbound_index" ON "activity_logs" ("activity_iri","inbox_url") WHERE "direction" = 'outbound';--> statement-breakpoint
ALTER TABLE "activity_logs" ADD CONSTRAINT "activity_logs_instance_id_instances_id_fkey" FOREIGN KEY ("instance_id") REFERENCES "instances"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "activity_logs" ADD CONSTRAINT "activity_logs_actor_id_actors_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "actors"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "activity_logs" ADD CONSTRAINT "activity_logs_verification_key_id_key_versions_id_fkey" FOREIGN KEY ("verification_key_id") REFERENCES "key_versions"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "key_versions" ADD CONSTRAINT "key_versions_key_id_keys_id_fkey" FOREIGN KEY ("key_id") REFERENCES "keys"("id") ON DELETE RESTRICT;