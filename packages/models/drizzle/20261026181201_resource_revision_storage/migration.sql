CREATE TYPE "resource_revision_capture" AS ENUM('local', 'received', 'embedded', 'fetched');--> statement-breakpoint
CREATE TYPE "resource_revision_kind" AS ENUM('snapshot', 'unavailable', 'whiteout');--> statement-breakpoint
CREATE TYPE "resource_revision_projection" AS ENUM('partial', 'complete');--> statement-breakpoint
CREATE TYPE "revision_receipt_role" AS ENUM('activity', 'object');--> statement-breakpoint
CREATE TYPE "revision_relation_representation" AS ENUM('reference', 'embedded', 'link');--> statement-breakpoint
CREATE TABLE "resource_heads" (
	"resource_id" uuid PRIMARY KEY,
	"revision_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "resource_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"resource_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"kind" "resource_revision_kind" NOT NULL,
	"capture" "resource_revision_capture" NOT NULL,
	"backfilled" boolean DEFAULT false NOT NULL,
	"document" json,
	"former_types" text[],
	"deleted" timestamp with time zone,
	"projection" "resource_revision_projection" DEFAULT 'partial'::"resource_revision_projection" NOT NULL,
	"created" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "resource_revisions_resource_sequence_key" UNIQUE("resource_id","sequence"),
	CONSTRAINT "resource_revisions_resource_id_key" UNIQUE("resource_id","id"),
	CONSTRAINT "resource_revisions_sequence_check" CHECK ("sequence" > 0),
	CONSTRAINT "resource_revisions_document_check" CHECK (("kind" = 'snapshot' AND "document" IS NOT NULL)
        OR ("kind" IN ('unavailable', 'whiteout') AND "document" IS NULL)),
	CONSTRAINT "resource_revisions_deletion_check" CHECK (("kind" = 'whiteout' AND "deleted" IS NOT NULL AND "former_types" IS NOT NULL)
        OR ("kind" <> 'whiteout' AND "deleted" IS NULL AND "former_types" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "revision_addressing" (
	"revision_id" uuid,
	"property" "addressing_property",
	"position" integer,
	"iri" text NOT NULL,
	CONSTRAINT "revision_addressing_pkey" PRIMARY KEY("revision_id","property","position"),
	CONSTRAINT "revision_addressing_position_check" CHECK ("position" >= 0)
);
--> statement-breakpoint
CREATE TABLE "revision_receipts" (
	"delivery_id" uuid,
	"revision_id" uuid,
	"role" "revision_receipt_role",
	CONSTRAINT "revision_receipts_pkey" PRIMARY KEY("delivery_id","revision_id","role")
);
--> statement-breakpoint
CREATE TABLE "revision_relations" (
	"revision_id" uuid,
	"occurrence" integer,
	"property" text NOT NULL,
	"path" json,
	"representation" "revision_relation_representation" NOT NULL,
	"target_iri" text,
	CONSTRAINT "revision_relations_pkey" PRIMARY KEY("revision_id","occurrence"),
	CONSTRAINT "revision_relations_occurrence_check" CHECK ("occurrence" >= 0),
	CONSTRAINT "revision_relations_path_check" CHECK ("path" IS NULL OR json_typeof("path") = 'array'),
	CONSTRAINT "revision_relations_reference_check" CHECK ("representation" <> 'reference' OR "target_iri" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "activities" DROP CONSTRAINT "activities_objectId_resources_id_fkey";--> statement-breakpoint
CREATE INDEX "revision_addressing_iri_property_index" ON "revision_addressing" ("iri","property");--> statement-breakpoint
CREATE INDEX "revision_receipts_revision_index" ON "revision_receipts" ("revision_id");--> statement-breakpoint
CREATE INDEX "revision_relations_property_target_index" ON "revision_relations" ("property","target_iri","revision_id");--> statement-breakpoint
ALTER TABLE "activities" ADD CONSTRAINT "activities_object_id_resources_id_fkey" FOREIGN KEY ("object_id") REFERENCES "resources"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "resource_heads" ADD CONSTRAINT "resource_heads_resource_id_resources_id_fkey" FOREIGN KEY ("resource_id") REFERENCES "resources"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "resource_heads" ADD CONSTRAINT "resource_heads_resource_revision_fkey" FOREIGN KEY ("resource_id","revision_id") REFERENCES "resource_revisions"("resource_id","id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "resource_revisions" ADD CONSTRAINT "resource_revisions_resource_id_resources_id_fkey" FOREIGN KEY ("resource_id") REFERENCES "resources"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "revision_addressing" ADD CONSTRAINT "revision_addressing_revision_id_resource_revisions_id_fkey" FOREIGN KEY ("revision_id") REFERENCES "resource_revisions"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "revision_receipts" ADD CONSTRAINT "revision_receipts_delivery_id_activity_deliveries_id_fkey" FOREIGN KEY ("delivery_id") REFERENCES "activity_deliveries"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "revision_receipts" ADD CONSTRAINT "revision_receipts_revision_id_resource_revisions_id_fkey" FOREIGN KEY ("revision_id") REFERENCES "resource_revisions"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "revision_relations" ADD CONSTRAINT "revision_relations_revision_id_resource_revisions_id_fkey" FOREIGN KEY ("revision_id") REFERENCES "resource_revisions"("id") ON DELETE RESTRICT;