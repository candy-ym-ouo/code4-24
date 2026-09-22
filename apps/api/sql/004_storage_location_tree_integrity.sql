-- Keep storage_locations.parent_id an acyclic tree. The statement trigger takes
-- the lock before any row locks, so concurrent edge changes serialize instead
-- of deadlocking. The deferred row trigger checks complete statements at commit;
-- application code takes the same lock before validating a location move.

DO $$
BEGIN
  IF EXISTS (
    WITH RECURSIVE reachable AS (
      SELECT id FROM storage_locations WHERE parent_id IS NULL
      UNION
      SELECT l.id
      FROM storage_locations l
      JOIN reachable r ON l.parent_id = r.id
    )
    SELECT 1
    FROM storage_locations l
    WHERE NOT EXISTS (SELECT 1 FROM reachable r WHERE r.id = l.id)
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23P01',
      MESSAGE = 'storage_locations already contains a parent cycle',
      CONSTRAINT = 'storage_locations_tree_acyclic_chk';
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION lock_storage_location_tree_for_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('handcraft_storage_locations_tree'));
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION prevent_storage_location_cycle()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.parent_id IS NOT DISTINCT FROM OLD.parent_id THEN
    RETURN NEW;
  END IF;

  IF NEW.parent_id = NEW.id THEN
    RAISE EXCEPTION USING
      ERRCODE = '23P01',
      MESSAGE = 'location cannot be its own parent',
      CONSTRAINT = 'storage_locations_tree_acyclic_chk';
  END IF;

  IF NEW.parent_id IS NOT NULL
     AND EXISTS (
       WITH RECURSIVE ancestors AS (
         SELECT id, parent_id
         FROM storage_locations
         WHERE id = NEW.parent_id
         UNION
         SELECT l.id, l.parent_id
         FROM storage_locations l
         JOIN ancestors a ON l.id = a.parent_id
       )
       SELECT 1 FROM ancestors WHERE id = NEW.id
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23P01',
      MESSAGE = 'storage location hierarchy cannot contain a cycle',
      CONSTRAINT = 'storage_locations_tree_acyclic_chk';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER storage_locations_lock_tree_change
BEFORE INSERT OR UPDATE ON storage_locations
FOR EACH STATEMENT
EXECUTE FUNCTION lock_storage_location_tree_for_change();

CREATE CONSTRAINT TRIGGER storage_locations_no_cycle
AFTER INSERT OR UPDATE ON storage_locations
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION prevent_storage_location_cycle();
