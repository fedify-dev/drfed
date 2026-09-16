CREATE TYPE "activity_type" AS ENUM('Create');--> statement-breakpoint
CREATE TYPE "addressing_property" AS ENUM('to', 'cc', 'bto', 'bcc', 'audience');--> statement-breakpoint
CREATE TYPE "collection_role" AS ENUM('followers', 'following', 'featured', 'outbox');--> statement-breakpoint
CREATE TYPE "collection_type" AS ENUM('Collection', 'OrderedCollection');--> statement-breakpoint
CREATE TYPE "object_type" AS ENUM('Article', 'Note');--> statement-breakpoint
CREATE TYPE "resource_kind" AS ENUM('actor', 'object', 'activity', 'collection', 'unknown');--> statement-breakpoint
CREATE TABLE "activities" (
	"id" uuid PRIMARY KEY,
	"type" "activity_type" NOT NULL,
	"actorId" uuid NOT NULL,
	"objectId" uuid,
	"published" timestamp with time zone NOT NULL,
	"document" json,
	"created" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "actor_collection_references" (
	"actorId" uuid,
	"role" "collection_role",
	"collectionId" uuid NOT NULL,
	CONSTRAINT "actor_collection_references_pkey" PRIMARY KEY("actorId","role")
);
--> statement-breakpoint
CREATE TABLE "addressing" (
	"id" uuid PRIMARY KEY,
	"sourceId" uuid NOT NULL,
	"property" "addressing_property" NOT NULL,
	"position" integer NOT NULL,
	"targetId" uuid NOT NULL,
	CONSTRAINT "addressing_source_property_position_key" UNIQUE("sourceId","property","position")
);
--> statement-breakpoint
CREATE TABLE "collection_items" (
	"collectionId" uuid,
	"itemId" uuid,
	"position" integer,
	"observed" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "collection_items_pkey" PRIMARY KEY("collectionId","itemId")
);
--> statement-breakpoint
CREATE TABLE "collections" (
	"id" uuid PRIMARY KEY,
	"type" "collection_type" NOT NULL,
	"ownerActorId" uuid,
	"totalItems" integer,
	"document" json,
	"updated" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "objects" (
	"id" uuid PRIMARY KEY,
	"actorId" uuid NOT NULL,
	"type" "object_type" NOT NULL,
	"document" json,
	"url" text,
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
CREATE TABLE "resources" (
	"id" uuid PRIMARY KEY,
	"iri" text NOT NULL UNIQUE,
	"kind" "resource_kind" NOT NULL,
	"created" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
-- Register existing actors as resources before their IRI column disappears.
INSERT INTO resources (id, iri, kind, created) SELECT id, iri, 'actor', created FROM actors;
--> statement-breakpoint
ALTER TABLE "actors" DROP CONSTRAINT "actors_iri_key";--> statement-breakpoint
ALTER TABLE "actors" ADD COLUMN "document" json;--> statement-breakpoint
ALTER TABLE "actors" DROP COLUMN "iri";--> statement-breakpoint
ALTER TABLE "actors" DROP COLUMN "outboxUrl";--> statement-breakpoint
ALTER TABLE "actors" DROP COLUMN "followersUrl";--> statement-breakpoint
ALTER TABLE "actors" DROP COLUMN "followingUrl";--> statement-breakpoint
ALTER TABLE "actors" DROP COLUMN "featuredUrl";--> statement-breakpoint
-- Object counts are derived from objects.deleted instead of a stored counter.
ALTER TABLE "actors" DROP COLUMN "postsCount";--> statement-breakpoint
CREATE INDEX "activity_actor_published_index" ON "activities" ("actorId","published" desc,"id" desc);--> statement-breakpoint
CREATE INDEX "actor_collection_reference_collection_index" ON "actor_collection_references" ("collectionId");--> statement-breakpoint
CREATE INDEX "addressing_target_property_index" ON "addressing" ("targetId","property");--> statement-breakpoint
CREATE INDEX "collection_item_position_index" ON "collection_items" ("collectionId","position");--> statement-breakpoint
CREATE INDEX "object_actor_published_index" ON "objects" ("actorId","published" desc,"id" desc);--> statement-breakpoint
ALTER TABLE "activities" ADD CONSTRAINT "activities_id_resources_id_fkey" FOREIGN KEY ("id") REFERENCES "resources"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "activities" ADD CONSTRAINT "activities_actorId_actors_id_fkey" FOREIGN KEY ("actorId") REFERENCES "actors"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "activities" ADD CONSTRAINT "activities_objectId_resources_id_fkey" FOREIGN KEY ("objectId") REFERENCES "resources"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "actor_collection_references" ADD CONSTRAINT "actor_collection_references_actorId_actors_id_fkey" FOREIGN KEY ("actorId") REFERENCES "actors"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "actor_collection_references" ADD CONSTRAINT "actor_collection_references_collectionId_collections_id_fkey" FOREIGN KEY ("collectionId") REFERENCES "collections"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "actors" ADD CONSTRAINT "actors_id_resources_id_fkey" FOREIGN KEY ("id") REFERENCES "resources"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "addressing" ADD CONSTRAINT "addressing_sourceId_resources_id_fkey" FOREIGN KEY ("sourceId") REFERENCES "resources"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "addressing" ADD CONSTRAINT "addressing_targetId_resources_id_fkey" FOREIGN KEY ("targetId") REFERENCES "resources"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "collection_items" ADD CONSTRAINT "collection_items_collectionId_collections_id_fkey" FOREIGN KEY ("collectionId") REFERENCES "collections"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "collection_items" ADD CONSTRAINT "collection_items_itemId_resources_id_fkey" FOREIGN KEY ("itemId") REFERENCES "resources"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "collections" ADD CONSTRAINT "collections_id_resources_id_fkey" FOREIGN KEY ("id") REFERENCES "resources"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "collections" ADD CONSTRAINT "collections_ownerActorId_actors_id_fkey" FOREIGN KEY ("ownerActorId") REFERENCES "actors"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "objects" ADD CONSTRAINT "objects_id_resources_id_fkey" FOREIGN KEY ("id") REFERENCES "resources"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "objects" ADD CONSTRAINT "objects_actorId_actors_id_fkey" FOREIGN KEY ("actorId") REFERENCES "actors"("id") ON DELETE CASCADE;
--> statement-breakpoint
-- The public addressing collection has a fixed identifier (PUBLIC_RESOURCE_ID).
INSERT INTO resources (id, iri, kind) VALUES ('00000000-0000-4000-8000-000000000000', 'https://www.w3.org/ns/activitystreams#Public', 'collection');
--> statement-breakpoint
INSERT INTO collections (id, type) VALUES ('00000000-0000-4000-8000-000000000000', 'Collection');
