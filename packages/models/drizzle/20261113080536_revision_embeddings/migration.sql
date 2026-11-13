CREATE TYPE "revision_embedding_relation" AS ENUM('snapshot', 'derived');--> statement-breakpoint
CREATE TABLE "revision_embeddings" (
	"revision_id" uuid,
	"path" jsonb,
	"source_revision_id" uuid NOT NULL,
	"relation" "revision_embedding_relation" NOT NULL,
	CONSTRAINT "revision_embeddings_pkey" PRIMARY KEY("revision_id","path"),
	CONSTRAINT "revision_embeddings_path_check" CHECK (jsonb_typeof("path") = 'array' AND jsonb_array_length("path") > 0),
	CONSTRAINT "revision_embeddings_source_check" CHECK ("source_revision_id" <> "revision_id")
);
--> statement-breakpoint
CREATE INDEX "revision_embeddings_source_index" ON "revision_embeddings" ("source_revision_id");--> statement-breakpoint
ALTER TABLE "revision_embeddings" ADD CONSTRAINT "revision_embeddings_revision_id_resource_revisions_id_fkey" FOREIGN KEY ("revision_id") REFERENCES "resource_revisions"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "revision_embeddings" ADD CONSTRAINT "revision_embeddings_source_revision_fkey" FOREIGN KEY ("source_revision_id") REFERENCES "resource_revisions"("id") ON DELETE RESTRICT;