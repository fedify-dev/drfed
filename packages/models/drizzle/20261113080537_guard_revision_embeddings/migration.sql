-- An embedding names the stored snapshot of another resource it came from.
CREATE FUNCTION drfed_guard_revision_embedding_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  owner_id uuid;
  source_owner_id uuid;
  source_kind resource_revision_kind;
BEGIN
  SELECT resource_id INTO owner_id
    FROM resource_revisions WHERE id = NEW.revision_id;
  SELECT resource_id, kind INTO source_owner_id, source_kind
    FROM resource_revisions WHERE id = NEW.source_revision_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Embedding source revision does not exist'
      USING ERRCODE = '23503',
        CONSTRAINT = 'revision_embeddings_source_revision_fkey';
  END IF;
  IF source_kind <> 'snapshot' THEN
    RAISE EXCEPTION 'An embedding source must be a snapshot'
      USING ERRCODE = '23514',
        CONSTRAINT = 'revision_embeddings_source_kind_guard';
  END IF;
  IF source_owner_id = owner_id THEN
    RAISE EXCEPTION 'An embedding source must belong to another resource'
      USING ERRCODE = '23514',
        CONSTRAINT = 'revision_embeddings_source_resource_guard';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER revision_embeddings_source_guard BEFORE INSERT ON revision_embeddings
FOR EACH ROW EXECUTE FUNCTION drfed_guard_revision_embedding_insert();
--> statement-breakpoint
CREATE TRIGGER revision_embeddings_insert_guard BEFORE INSERT ON revision_embeddings
FOR EACH ROW EXECUTE FUNCTION drfed_guard_revision_projection_insert();
--> statement-breakpoint
CREATE TRIGGER revision_embeddings_immutable BEFORE UPDATE OR DELETE ON revision_embeddings
FOR EACH ROW EXECUTE FUNCTION drfed_reject_revision_mutation();
--> statement-breakpoint
CREATE TRIGGER revision_embeddings_no_truncate BEFORE TRUNCATE ON revision_embeddings
FOR EACH STATEMENT EXECUTE FUNCTION drfed_reject_revision_mutation();
