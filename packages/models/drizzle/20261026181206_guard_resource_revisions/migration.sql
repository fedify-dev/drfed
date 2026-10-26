-- Canonical resource locks serialize appenders without conflicting with the
-- foreign-key key-share locks taken by references to those resources.
CREATE FUNCTION drfed_guard_revision_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  resource_kind resource_kind;
  previous_sequence integer;
  previous_kind resource_revision_kind;
BEGIN
  SELECT kind INTO resource_kind FROM resources
    WHERE id = NEW.resource_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Revision resource does not exist'
      USING ERRCODE = '23503', CONSTRAINT = 'resource_revisions_resource_id_resources_id_fkey';
  END IF;
  IF resource_kind NOT IN ('object', 'activity') THEN
    RAISE EXCEPTION 'Only object and activity resources have revisions'
      USING ERRCODE = '23514', CONSTRAINT = 'resource_revisions_kind_guard';
  END IF;

  -- Read again after acquiring the lock so READ COMMITTED sees the preceding
  -- appender's committed revision, including when the lock acquisition waited.
  SELECT sequence, kind INTO previous_sequence, previous_kind
    FROM resource_revisions WHERE resource_id = NEW.resource_id
    ORDER BY sequence DESC LIMIT 1;
  IF NEW.sequence <> coalesce(previous_sequence, 0) + 1 THEN
    RAISE EXCEPTION 'Revision sequence does not follow the latest revision'
      USING ERRCODE = '23514', CONSTRAINT = 'resource_revisions_sequence_guard';
  END IF;
  IF previous_kind = 'whiteout' THEN
    RAISE EXCEPTION 'A whiteout is terminal'
      USING ERRCODE = '23514', CONSTRAINT = 'resource_revisions_terminal_guard';
  END IF;
  IF resource_kind = 'activity' AND previous_sequence IS NOT NULL THEN
    RAISE EXCEPTION 'A saved activity has only one revision'
      USING ERRCODE = '23514', CONSTRAINT = 'resource_revisions_activity_guard';
  END IF;
  IF NEW.kind = 'whiteout' AND previous_sequence IS NULL THEN
    RAISE EXCEPTION 'A whiteout requires a preceding revision'
      USING ERRCODE = '23514', CONSTRAINT = 'resource_revisions_initial_guard';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER resource_revisions_insert_guard BEFORE INSERT ON resource_revisions
FOR EACH ROW EXECUTE FUNCTION drfed_guard_revision_insert();
--> statement-breakpoint
CREATE FUNCTION drfed_guard_resource_head() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  next_sequence integer;
  old_sequence integer;
  latest_sequence integer;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.resource_id <> OLD.resource_id THEN
    RAISE EXCEPTION 'A resource head cannot change its resource'
      USING ERRCODE = '23514', CONSTRAINT = 'resource_heads_resource_guard';
  END IF;
  PERFORM 1 FROM resources WHERE id = NEW.resource_id FOR NO KEY UPDATE;
  SELECT sequence INTO next_sequence FROM resource_revisions
    WHERE id = NEW.revision_id AND resource_id = NEW.resource_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Head revision does not belong to the resource'
      USING ERRCODE = '23503', CONSTRAINT = 'resource_heads_resource_revision_fkey';
  END IF;
  SELECT max(sequence) INTO latest_sequence FROM resource_revisions
    WHERE resource_id = NEW.resource_id;
  IF next_sequence <> latest_sequence THEN
    RAISE EXCEPTION 'A head must name the latest revision'
      USING ERRCODE = '23514', CONSTRAINT = 'resource_heads_latest_guard';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    SELECT sequence INTO old_sequence FROM resource_revisions
      WHERE id = OLD.revision_id;
    IF next_sequence <= old_sequence THEN
      RAISE EXCEPTION 'A resource head must advance'
        USING ERRCODE = '23514', CONSTRAINT = 'resource_heads_forward_guard';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER resource_heads_write_guard BEFORE INSERT OR UPDATE ON resource_heads
FOR EACH ROW EXECUTE FUNCTION drfed_guard_resource_head();
--> statement-breakpoint
CREATE FUNCTION drfed_require_published_revision() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  head_sequence integer;
BEGIN
  SELECT revision.sequence INTO head_sequence
    FROM resource_heads AS head
    JOIN resource_revisions AS revision ON revision.id = head.revision_id
      AND revision.resource_id = head.resource_id
    WHERE head.resource_id = NEW.resource_id;
  -- A transaction may append a content revision and its whiteout before
  -- publishing one final head. Every deferred event must accept that head.
  IF head_sequence IS NULL OR head_sequence < NEW.sequence THEN
    RAISE EXCEPTION 'An appended revision must be published by its head'
      USING ERRCODE = '23514', CONSTRAINT = 'resource_revisions_published';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER resource_revisions_published
AFTER INSERT ON resource_revisions DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION drfed_require_published_revision();
--> statement-breakpoint
CREATE FUNCTION drfed_guard_revision_projection_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  owner_id uuid;
  revision_sequence integer;
  head_sequence integer;
BEGIN
  SELECT resource_id, sequence INTO owner_id, revision_sequence
    FROM resource_revisions WHERE id = NEW.revision_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Projection revision does not exist'
      USING ERRCODE = '23503', CONSTRAINT = TG_TABLE_NAME || '_revision_fkey';
  END IF;
  PERFORM 1 FROM resources WHERE id = owner_id FOR NO KEY UPDATE;
  SELECT revision.sequence INTO head_sequence
    FROM resource_heads AS head
    JOIN resource_revisions AS revision ON revision.id = head.revision_id
      AND revision.resource_id = head.resource_id
    WHERE head.resource_id = owner_id;
  IF coalesce(head_sequence, 0) >= revision_sequence THEN
    RAISE EXCEPTION 'A published revision cannot acquire more projections'
      USING ERRCODE = '23514', CONSTRAINT = TG_TABLE_NAME || '_sealed';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER revision_addressing_insert_guard BEFORE INSERT ON revision_addressing
FOR EACH ROW EXECUTE FUNCTION drfed_guard_revision_projection_insert();
--> statement-breakpoint
CREATE TRIGGER revision_relations_insert_guard BEFORE INSERT ON revision_relations
FOR EACH ROW EXECUTE FUNCTION drfed_guard_revision_projection_insert();
--> statement-breakpoint
CREATE FUNCTION drfed_reject_revision_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Retained revision history cannot be changed or removed'
    USING ERRCODE = '23514', CONSTRAINT = TG_TABLE_NAME || '_immutable';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER resource_revisions_immutable BEFORE UPDATE OR DELETE ON resource_revisions
FOR EACH ROW EXECUTE FUNCTION drfed_reject_revision_mutation();
--> statement-breakpoint
CREATE TRIGGER resource_revisions_no_truncate BEFORE TRUNCATE ON resource_revisions
FOR EACH STATEMENT EXECUTE FUNCTION drfed_reject_revision_mutation();
--> statement-breakpoint
CREATE TRIGGER revision_addressing_immutable BEFORE UPDATE OR DELETE ON revision_addressing
FOR EACH ROW EXECUTE FUNCTION drfed_reject_revision_mutation();
--> statement-breakpoint
CREATE TRIGGER revision_addressing_no_truncate BEFORE TRUNCATE ON revision_addressing
FOR EACH STATEMENT EXECUTE FUNCTION drfed_reject_revision_mutation();
--> statement-breakpoint
CREATE TRIGGER revision_relations_immutable BEFORE UPDATE OR DELETE ON revision_relations
FOR EACH ROW EXECUTE FUNCTION drfed_reject_revision_mutation();
--> statement-breakpoint
CREATE TRIGGER revision_relations_no_truncate BEFORE TRUNCATE ON revision_relations
FOR EACH STATEMENT EXECUTE FUNCTION drfed_reject_revision_mutation();
--> statement-breakpoint
CREATE TRIGGER resource_heads_no_delete BEFORE DELETE ON resource_heads
FOR EACH ROW EXECUTE FUNCTION drfed_reject_revision_mutation();
--> statement-breakpoint
CREATE TRIGGER resource_heads_no_truncate BEFORE TRUNCATE ON resource_heads
FOR EACH STATEMENT EXECUTE FUNCTION drfed_reject_revision_mutation();
