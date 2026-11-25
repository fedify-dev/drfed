CREATE TYPE "revision_expansion_outcome" AS ENUM('expanded', 'failed', 'no_document');--> statement-breakpoint
CREATE TABLE "revision_expansions" (
	"revision_id" uuid PRIMARY KEY,
	"outcome" "revision_expansion_outcome" NOT NULL,
	"document" jsonb,
	"dropped_terms" text[],
	"undefined_terms" text[],
	"failure" text,
	"source_revision_id" uuid,
	CONSTRAINT "revision_expansions_outcome_check" CHECK (("outcome" = 'expanded'
          AND "document" IS NOT NULL
          AND "dropped_terms" IS NOT NULL
          AND "undefined_terms" IS NOT NULL
          AND "failure" IS NULL)
        OR ("outcome" = 'failed'
          AND "document" IS NULL
          AND "dropped_terms" IS NULL
          AND "undefined_terms" IS NULL
          AND "failure" IS NOT NULL)
        OR ("outcome" = 'no_document'
          AND "document" IS NULL
          AND "dropped_terms" IS NULL
          AND "undefined_terms" IS NULL
          AND "failure" IS NULL
          AND "source_revision_id" IS NULL)),
	CONSTRAINT "revision_expansions_source_check" CHECK ("source_revision_id" <> "revision_id")
);
--> statement-breakpoint
CREATE INDEX "revision_expansions_source_index" ON "revision_expansions" ("source_revision_id");--> statement-breakpoint
ALTER TABLE "revision_expansions" ADD CONSTRAINT "revision_expansions_revision_id_resource_revisions_id_fkey" FOREIGN KEY ("revision_id") REFERENCES "resource_revisions"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "revision_expansions" ADD CONSTRAINT "revision_expansions_source_revision_fkey" FOREIGN KEY ("source_revision_id") REFERENCES "resource_revisions"("id") ON DELETE RESTRICT;