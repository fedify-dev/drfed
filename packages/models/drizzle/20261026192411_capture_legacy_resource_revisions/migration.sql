-- Copy legacy parsed JSON without JSON-LD processing or a jsonb conversion.
-- The same function is used for the stopped-server migration and runtime
-- capture, so provenance and projections have identical meanings in both.
CREATE FUNCTION drfed_capture_legacy_resource(
  requested_resource_id uuid,
  is_backfilled boolean DEFAULT false
) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE
  canonical_kind resource_kind;
  legacy_document json;
  legacy_created timestamptz;
  legacy_deleted timestamptz;
  legacy_former_types text[];
  legacy_capture resource_revision_capture;
  expected_kind resource_revision_kind;
  first_revision resource_revisions%ROWTYPE;
  current_revision resource_revisions%ROWTYPE;
  first_revision_id uuid;
  final_revision_id uuid;
  expected_sequence integer;
BEGIN
  SELECT kind INTO canonical_kind FROM resources
    WHERE id = requested_resource_id FOR NO KEY UPDATE;
  IF NOT FOUND OR canonical_kind NOT IN ('object', 'activity') THEN
    RAISE EXCEPTION 'Legacy capture requires a registered object or activity'
      USING ERRCODE = '23514', CONSTRAINT = 'resource_revisions_legacy_guard';
  END IF;

  IF canonical_kind = 'object' THEN
    SELECT stored.document, stored.created, stored.deleted,
        ARRAY[stored.type::text],
        CASE
          WHEN author.local_id IS NOT NULL THEN 'local'::resource_revision_capture
          WHEN stored.fetched THEN 'fetched'::resource_revision_capture
          ELSE 'embedded'::resource_revision_capture
        END
      INTO legacy_document, legacy_created, legacy_deleted,
        legacy_former_types, legacy_capture
      FROM objects AS stored
      JOIN actors AS author ON author.id = stored.actor_id
      WHERE stored.id = requested_resource_id
      FOR KEY SHARE OF stored;
  ELSE
    SELECT stored.document, stored.created,
        CASE
          WHEN author.local_id IS NOT NULL THEN 'local'::resource_revision_capture
          ELSE 'received'::resource_revision_capture
        END
      INTO legacy_document, legacy_created, legacy_capture
      FROM activities AS stored
      JOIN actors AS author ON author.id = stored.actor_id
      WHERE stored.id = requested_resource_id
      FOR KEY SHARE OF stored;
    legacy_deleted := NULL;
    legacy_former_types := NULL;
  END IF;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Legacy resource has no current typed row'
      USING ERRCODE = '23514', CONSTRAINT = 'resource_revisions_legacy_guard';
  END IF;

  expected_kind := CASE WHEN legacy_document IS NULL
    THEN 'unavailable'::resource_revision_kind
    ELSE 'snapshot'::resource_revision_kind END;
  expected_sequence := CASE WHEN legacy_deleted IS NULL THEN 1 ELSE 2 END;

  SELECT revision.* INTO current_revision
    FROM resource_heads AS head
    JOIN resource_revisions AS revision ON revision.id = head.revision_id
      AND revision.resource_id = head.resource_id
    WHERE head.resource_id = requested_resource_id;
  SELECT * INTO first_revision FROM resource_revisions
    WHERE resource_id = requested_resource_id AND sequence = 1;

  IF first_revision.id IS NOT NULL OR current_revision.id IS NOT NULL THEN
    -- Every supported capture copied these SQL JSON bytes directly. A later
    -- unsupported typed-row rewrite must not silently replace that history.
    IF first_revision.id IS NULL OR current_revision.id IS NULL
      OR first_revision.kind <> expected_kind
      OR first_revision.capture <> legacy_capture
      OR first_revision.projection <> 'partial'
      OR first_revision.document::text IS DISTINCT FROM legacy_document::text
      OR current_revision.sequence <> expected_sequence
      OR current_revision.capture <> legacy_capture
      OR current_revision.projection <> 'partial'
      OR (expected_sequence = 1 AND current_revision.id <> first_revision.id)
      OR (expected_sequence = 2 AND (
        current_revision.kind <> 'whiteout'
        OR current_revision.deleted IS DISTINCT FROM legacy_deleted
        OR current_revision.former_types IS DISTINCT FROM legacy_former_types
      ))
      OR EXISTS (
        SELECT 1 FROM revision_relations
        WHERE revision_id IN (first_revision.id, current_revision.id)
      )
    THEN
      RAISE EXCEPTION 'Legacy typed state differs from its retained revision'
        USING ERRCODE = '23514', CONSTRAINT = 'resource_revisions_legacy_guard';
    END IF;

    IF EXISTS (
      SELECT 1 FROM resource_revisions AS revision
      WHERE revision.id IN (first_revision.id, current_revision.id)
        AND (
          EXISTS (
            (SELECT saved.property, saved.position, saved.iri
              FROM revision_addressing AS saved
              WHERE saved.revision_id = revision.id)
            EXCEPT ALL
            (SELECT declared.property, declared.position, target.iri
              FROM addressing AS declared
              JOIN resources AS target ON target.id = declared.target_id
              WHERE declared.source_id = requested_resource_id)
          )
          OR EXISTS (
            (SELECT declared.property, declared.position, target.iri
              FROM addressing AS declared
              JOIN resources AS target ON target.id = declared.target_id
              WHERE declared.source_id = requested_resource_id)
            EXCEPT ALL
            (SELECT saved.property, saved.position, saved.iri
              FROM revision_addressing AS saved
              WHERE saved.revision_id = revision.id)
          )
        )
    ) THEN
      RAISE EXCEPTION 'Legacy addressing differs from its retained revision'
        USING ERRCODE = '23514', CONSTRAINT = 'resource_revisions_legacy_guard';
    END IF;
    RETURN first_revision.id;
  END IF;

  -- A missing head with some other uncommitted/orphan history is not a fresh
  -- capture. Normal callers cannot create it through the append API.
  IF EXISTS (
    SELECT 1 FROM resource_revisions WHERE resource_id = requested_resource_id
  ) THEN
    RAISE EXCEPTION 'Legacy resource has unpublished revision history'
      USING ERRCODE = '23514', CONSTRAINT = 'resource_revisions_legacy_guard';
  END IF;

  first_revision_id := gen_random_uuid();
  final_revision_id := first_revision_id;
  INSERT INTO resource_revisions
    (id, resource_id, sequence, kind, capture, backfilled, document,
      projection, created)
    SELECT first_revision_id, requested_resource_id, 1, expected_kind,
      legacy_capture, is_backfilled, legacy_document, 'partial', legacy_created;

  IF legacy_deleted IS NOT NULL THEN
    final_revision_id := gen_random_uuid();
    INSERT INTO resource_revisions
      (id, resource_id, sequence, kind, capture, backfilled, former_types,
        deleted, projection, created)
      SELECT final_revision_id, requested_resource_id, 2, 'whiteout',
        legacy_capture, is_backfilled, legacy_former_types, legacy_deleted,
        'partial', legacy_deleted;
  END IF;

  -- Publish only after both sets of projections are complete. The installed
  -- C1 guards allow the final head to cover both deferred revision events.
  INSERT INTO revision_addressing (revision_id, property, position, iri)
    SELECT revision.id, declared.property, declared.position, target.iri
      FROM resource_revisions AS revision
      JOIN addressing AS declared ON declared.source_id = revision.resource_id
      JOIN resources AS target ON target.id = declared.target_id
      WHERE revision.id IN (first_revision_id, final_revision_id);
  INSERT INTO resource_heads (resource_id, revision_id)
    VALUES (requested_resource_id, final_revision_id);
  RETURN first_revision_id;
END;
$$;
--> statement-breakpoint
-- A canonical IRI order matches the runtime promotion lock order. The upgrade
-- requires the old application to be stopped; capture does not support an old
-- process continuing to write unversioned typed rows during this migration.
DO $$
DECLARE
  legacy_resource record;
BEGIN
  FOR legacy_resource IN
    SELECT registry.id FROM resources AS registry
      WHERE (registry.kind = 'object' AND EXISTS (
        SELECT 1 FROM objects WHERE objects.id = registry.id
      )) OR (registry.kind = 'activity' AND EXISTS (
        SELECT 1 FROM activities WHERE activities.id = registry.id
      ))
      ORDER BY registry.iri
  LOOP
    PERFORM drfed_capture_legacy_resource(legacy_resource.id, true);
  END LOOP;
END;
$$;
--> statement-breakpoint
-- Receipts are a mutable compatibility index. Rebuild them only from existing
-- verified inbound marks, leaving the source flags and payload evidence intact.
DELETE FROM revision_receipts;
--> statement-breakpoint
INSERT INTO revision_receipts (delivery_id, revision_id, role)
  SELECT delivery.id, revision.id, 'activity'
    FROM activity_deliveries AS delivery
    JOIN resource_revisions AS revision ON revision.resource_id = delivery.activity_id
      AND revision.sequence = 1 AND revision.kind = 'snapshot'
    WHERE delivery.direction = 'inbound'
      AND delivery.status IN ('received', 'acknowledged')
      AND delivery.verification_result = 'verified'
      AND delivery.carried_snapshot;
--> statement-breakpoint
INSERT INTO revision_receipts (delivery_id, revision_id, role)
  SELECT delivery.id, revision.id, 'object'
    FROM activity_deliveries AS delivery
    JOIN objects AS stored ON stored.activity_id = delivery.activity_id
    JOIN resource_revisions AS revision ON revision.resource_id = stored.id
      AND revision.sequence = 1 AND revision.kind = 'snapshot'
    WHERE delivery.direction = 'inbound'
      AND delivery.status IN ('received', 'acknowledged')
      AND delivery.verification_result = 'verified'
      AND delivery.carried_snapshot AND delivery.carried_object_snapshot;
--> statement-breakpoint
CREATE FUNCTION drfed_remove_deleted_object_revision_receipts() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- Recompute holds this typed object's KEY SHARE lock before touching receipt
  -- rows. No delivery-row lock belongs here: first linkage may be uncommitted.
  DELETE FROM revision_receipts AS receipt
    USING resource_revisions AS revision
    WHERE receipt.revision_id = revision.id
      AND receipt.role = 'object' AND revision.resource_id = OLD.id;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER objects_remove_revision_receipts
AFTER DELETE ON objects FOR EACH ROW
EXECUTE FUNCTION drfed_remove_deleted_object_revision_receipts();
--> statement-breakpoint
CREATE FUNCTION drfed_remove_unlinked_revision_receipts() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM revision_receipts WHERE delivery_id = NEW.id;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER activity_deliveries_remove_revision_receipts
AFTER UPDATE OF activity_id ON activity_deliveries FOR EACH ROW
WHEN (OLD.activity_id IS DISTINCT FROM NEW.activity_id)
EXECUTE FUNCTION drfed_remove_unlinked_revision_receipts();
