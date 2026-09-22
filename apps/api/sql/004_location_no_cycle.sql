-- 库位层级的最终防环保障：
-- 任何写入（包括绕过应用层的直接 SQL）一旦使 storage_locations 的 parent_id
-- 引用成环，语句在此触发器中被中止，事务整体回滚，不会留下断链或半移动。
CREATE OR REPLACE FUNCTION storage_locations_reject_cycle()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  cycle_id uuid;
BEGIN
  IF NEW.parent_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- 从新父节点沿父链向上查找：若能回到本行，则移动后必然成环。
  -- 该行级 BEFORE 触发器在 UPDATE 的行镜像生效前运行，链上看到的仍是旧状态，
  -- 因此自身环（parent_id = id）以及把节点移入自己后代子树都能被发现。
  WITH RECURSIVE ancestors AS (
    SELECT id, parent_id
      FROM storage_locations
     WHERE id = NEW.parent_id
    UNION
    SELECT l.id, l.parent_id
      FROM storage_locations l
      JOIN ancestors a ON l.id = a.parent_id
  )
  SELECT id INTO cycle_id
    FROM ancestors
   WHERE id = NEW.id
   LIMIT 1;

  IF cycle_id IS NOT NULL THEN
    RAISE EXCEPTION 'storage_locations cycle detected: % cannot be moved under its own descendant', NEW.id
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER storage_locations_reject_cycle_trg
  BEFORE INSERT OR UPDATE OF parent_id ON storage_locations
  FOR EACH ROW
  EXECUTE FUNCTION storage_locations_reject_cycle();
