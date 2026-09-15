CREATE TYPE "activity_type" AS ENUM('Create');--> statement-breakpoint
CREATE TYPE "addressing_property" AS ENUM('to', 'cc', 'bto', 'bcc', 'audience');--> statement-breakpoint
CREATE TYPE "collection_role" AS ENUM('followers', 'following', 'featured', 'outbox', 'public');--> statement-breakpoint
CREATE TYPE "collection_type" AS ENUM('Collection', 'OrderedCollection');--> statement-breakpoint
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
CREATE TABLE "addressing" (
	"id" uuid PRIMARY KEY,
	"sourceId" uuid NOT NULL,
	"property" "addressing_property" NOT NULL,
	"position" integer NOT NULL,
	"targetId" uuid NOT NULL,
	"target" json,
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
	"role" "collection_role",
	"totalItems" integer,
	"document" json,
	"updated" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "resources" (
	"id" uuid PRIMARY KEY,
	"iri" text NOT NULL UNIQUE,
	"kind" "resource_kind" NOT NULL,
	"created" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
ALTER TABLE "actors" DROP CONSTRAINT "actors_iri_key";--> statement-breakpoint
ALTER TABLE "objects" DROP CONSTRAINT "objects_iri_key";--> statement-breakpoint
ALTER TABLE "actors" ADD COLUMN "document" json;--> statement-breakpoint
ALTER TABLE "objects" ADD COLUMN "document" json;--> statement-breakpoint
-- Preserve existing identifiers before dropping their old columns.
INSERT INTO resources (id, iri, kind, created) SELECT id, iri, 'actor', created FROM actors;
--> statement-breakpoint
INSERT INTO resources (id, iri, kind, created) SELECT id, iri, 'object', created FROM objects;
--> statement-breakpoint
INSERT INTO resources (id, iri, kind) VALUES ('00000000-0000-4000-8000-000000000000', 'https://www.w3.org/ns/activitystreams#Public', 'collection');
--> statement-breakpoint
INSERT INTO collections (id, type, role) VALUES ('00000000-0000-4000-8000-000000000000', 'Collection', 'public');
--> statement-breakpoint
INSERT INTO resources (id, iri, kind)
SELECT gen_random_uuid(), iri, 'collection' FROM (
  SELECT DISTINCT c.iri FROM actors a CROSS JOIN LATERAL (VALUES
    (a."followersUrl"), (a."followingUrl"), (a."featuredUrl"), (a."outboxUrl")
  ) c(iri) WHERE c.iri IS NOT NULL
) urls ON CONFLICT (iri) DO NOTHING;
--> statement-breakpoint
-- These are reconstructed legacy relationship snapshots, not fetched documents.
UPDATE actors SET document = json_strip_nulls(json_build_object(
  '@context', 'https://www.w3.org/ns/activitystreams', 'id', iri, 'type', type,
  'inbox', "inboxUrl", 'outbox', "outboxUrl", 'followers', "followersUrl",
  'following', "followingUrl", 'featured', "featuredUrl"
));
--> statement-breakpoint
INSERT INTO collections (id, type, "ownerActorId", role)
SELECT r.id, 'OrderedCollection',
  CASE WHEN count(DISTINCT a.id) = 1 THEN min(a.id::text)::uuid END,
  CASE WHEN count(DISTINCT c.role) = 1 THEN min(c.role)::collection_role END
FROM actors a CROSS JOIN LATERAL (VALUES
  ('followers', a."followersUrl"), ('following', a."followingUrl"),
  ('featured', a."featuredUrl"), ('outbox', a."outboxUrl")
) c(role, iri) JOIN resources r ON r.iri = c.iri
WHERE r.kind = 'collection'
GROUP BY r.id ON CONFLICT (id) DO NOTHING;
--> statement-breakpoint
INSERT INTO addressing (id, "sourceId", property, position, "targetId")
SELECT gen_random_uuid(), o.id,
  CASE WHEN o.visibility = 'public' THEN 'to' ELSE 'cc' END::addressing_property,
  0, '00000000-0000-4000-8000-000000000000'
FROM objects o WHERE o.visibility IN ('public', 'unlisted');
--> statement-breakpoint
INSERT INTO addressing (id, "sourceId", property, position, "targetId")
SELECT gen_random_uuid(), o.id,
  CASE WHEN o.visibility = 'public' THEN 'cc' ELSE 'to' END::addressing_property,
  0, r.id
FROM objects o JOIN actors a ON a.id = o."actorId"
JOIN resources r ON r.iri = a."followersUrl";
--> statement-breakpoint
INSERT INTO resources (id, iri, kind, created)
SELECT gen_random_uuid(), 'https://' || i.host || '/ap/creates/' || o.id, 'activity', o.created
FROM objects o JOIN actors a ON a.id = o."actorId" JOIN instances i ON i.id = a."instanceId";
--> statement-breakpoint
INSERT INTO activities (id, type, "actorId", "objectId", published, created)
SELECT r.id, 'Create', o."actorId", o.id, o.published, o.created
FROM objects o JOIN actors a ON a.id = o."actorId" JOIN instances i ON i.id = a."instanceId"
JOIN resources r ON r.iri = 'https://' || i.host || '/ap/creates/' || o.id;
--> statement-breakpoint
INSERT INTO addressing (id, "sourceId", property, position, "targetId", target)
SELECT gen_random_uuid(), a.id, d.property, d.position, d."targetId", d.target
FROM activities a JOIN addressing d ON d."sourceId" = a."objectId";
--> statement-breakpoint
CREATE INDEX "activity_actor_published_index" ON "activities" ("actorId","published" desc,"id" desc);--> statement-breakpoint
CREATE INDEX "addressing_target_property_index" ON "addressing" ("targetId","property");--> statement-breakpoint
CREATE INDEX "collection_item_position_index" ON "collection_items" ("collectionId","position");--> statement-breakpoint
CREATE UNIQUE INDEX "collection_owner_role_key" ON "collections" ("ownerActorId","role") WHERE "role" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "activities" ADD CONSTRAINT "activities_id_resources_id_fkey" FOREIGN KEY ("id") REFERENCES "resources"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "activities" ADD CONSTRAINT "activities_actorId_actors_id_fkey" FOREIGN KEY ("actorId") REFERENCES "actors"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "activities" ADD CONSTRAINT "activities_objectId_resources_id_fkey" FOREIGN KEY ("objectId") REFERENCES "resources"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "actors" ADD CONSTRAINT "actors_id_resources_id_fkey" FOREIGN KEY ("id") REFERENCES "resources"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "addressing" ADD CONSTRAINT "addressing_sourceId_resources_id_fkey" FOREIGN KEY ("sourceId") REFERENCES "resources"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "addressing" ADD CONSTRAINT "addressing_targetId_resources_id_fkey" FOREIGN KEY ("targetId") REFERENCES "resources"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "collection_items" ADD CONSTRAINT "collection_items_collectionId_collections_id_fkey" FOREIGN KEY ("collectionId") REFERENCES "collections"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "collection_items" ADD CONSTRAINT "collection_items_itemId_resources_id_fkey" FOREIGN KEY ("itemId") REFERENCES "resources"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "collections" ADD CONSTRAINT "collections_id_resources_id_fkey" FOREIGN KEY ("id") REFERENCES "resources"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "collections" ADD CONSTRAINT "collections_ownerActorId_actors_id_fkey" FOREIGN KEY ("ownerActorId") REFERENCES "actors"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "objects" ADD CONSTRAINT "objects_id_resources_id_fkey" FOREIGN KEY ("id") REFERENCES "resources"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "actors" DROP COLUMN "iri";--> statement-breakpoint
ALTER TABLE "actors" DROP COLUMN "outboxUrl";--> statement-breakpoint
ALTER TABLE "actors" DROP COLUMN "followersUrl";--> statement-breakpoint
ALTER TABLE "actors" DROP COLUMN "followingUrl";--> statement-breakpoint
ALTER TABLE "actors" DROP COLUMN "featuredUrl";--> statement-breakpoint
ALTER TABLE "objects" DROP COLUMN "iri";--> statement-breakpoint
ALTER TABLE "objects" DROP COLUMN "visibility";--> statement-breakpoint
DROP TYPE "object_visibility";