CREATE TABLE "actor_collection_references" (
	"actorId" uuid,
	"role" "collection_role",
	"collectionId" uuid NOT NULL,
	CONSTRAINT "actor_collection_references_pkey" PRIMARY KEY("actorId","role")
);
--> statement-breakpoint
CREATE INDEX "actor_collection_reference_collection_index" ON "actor_collection_references" ("collectionId");--> statement-breakpoint
ALTER TABLE "actor_collection_references" ADD CONSTRAINT "actor_collection_references_actorId_actors_id_fkey" FOREIGN KEY ("actorId") REFERENCES "actors"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "actor_collection_references" ADD CONSTRAINT "actor_collection_references_collectionId_collections_id_fkey" FOREIGN KEY ("collectionId") REFERENCES "collections"("id") ON DELETE CASCADE;
--> statement-breakpoint
-- Recover every actor-declared role from the legacy snapshots, including
-- multiple roles or actors naming the same collection IRI.
INSERT INTO actor_collection_references ("actorId", role, "collectionId")
SELECT a.id, roles.role::collection_role, r.id
FROM actors a CROSS JOIN (VALUES ('followers'), ('following'), ('featured'), ('outbox')) roles(role)
JOIN resources r ON r.iri = a.document ->> roles.role
JOIN collections c ON c.id = r.id
ON CONFLICT DO NOTHING;
--> statement-breakpoint
-- Also upgrade databases that already applied the initial resource migration
-- before it started retaining legacy snapshots, plus subsequently created actors.
INSERT INTO actor_collection_references ("actorId", role, "collectionId")
SELECT "ownerActorId", role, id FROM collections
WHERE "ownerActorId" IS NOT NULL AND role IS NOT NULL
ON CONFLICT DO NOTHING;
