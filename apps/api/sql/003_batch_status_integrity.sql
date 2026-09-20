ALTER TABLE batches
  ADD CONSTRAINT batches_status_quantity_chk CHECK (
    (status = 'ACTIVE' AND remaining_quantity > 0)
    OR (status = 'DEPLETED' AND remaining_quantity = 0)
    OR (status = 'ARCHIVED' AND remaining_quantity = 0)
  );
