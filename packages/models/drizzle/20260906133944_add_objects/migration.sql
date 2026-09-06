CREATE TYPE "object_type" AS ENUM('Article', 'Note');--> statement-breakpoint
CREATE TYPE "object_visibility" AS ENUM('public', 'unlisted', 'followers');--> statement-breakpoint
CREATE TABLE "objects" (
	"id" uuid PRIMARY KEY,
	"actorId" uuid NOT NULL,
	"type" "object_type" NOT NULL,
	"iri" text NOT NULL UNIQUE,
	"url" text,
	"visibility" "object_visibility" DEFAULT 'public'::"object_visibility" NOT NULL,
	"name" text,
	"summary" text,
	"contentHtml" text NOT NULL,
	"language" varchar(35),
	"sensitive" boolean DEFAULT false NOT NULL,
	"published" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"created" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"deleted" timestamp with time zone,
	CONSTRAINT "objects_content_html_check" CHECK (trim(both from "contentHtml") <> '')
);
--> statement-breakpoint
CREATE INDEX "object_actor_published_index" ON "objects" ("actorId","published" desc,"id" desc);--> statement-breakpoint
ALTER TABLE "objects" ADD CONSTRAINT "objects_actorId_actors_id_fkey" FOREIGN KEY ("actorId") REFERENCES "actors"("id") ON DELETE CASCADE;