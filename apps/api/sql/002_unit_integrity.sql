ALTER TABLE materials
  ADD CONSTRAINT materials_id_stock_unit_uq UNIQUE (id, stock_unit);

ALTER TABLE batches
  ADD CONSTRAINT batches_id_stock_unit_uq UNIQUE (id, stock_unit),
  ADD CONSTRAINT batches_material_stock_unit_fk
    FOREIGN KEY (material_id, stock_unit) REFERENCES materials(id, stock_unit);

ALTER TABLE stock_movements
  ADD CONSTRAINT stock_movements_batch_stock_unit_fk
    FOREIGN KEY (batch_id, stock_unit) REFERENCES batches(id, stock_unit);

ALTER TABLE project_requirements
  ADD CONSTRAINT project_requirements_material_stock_unit_fk
    FOREIGN KEY (material_id, stock_unit) REFERENCES materials(id, stock_unit);

ALTER TABLE consumptions
  ADD CONSTRAINT consumptions_batch_stock_unit_fk
    FOREIGN KEY (batch_id, stock_unit) REFERENCES batches(id, stock_unit);

ALTER TABLE color_changes
  ADD CONSTRAINT color_changes_batch_stock_unit_fk
    FOREIGN KEY (batch_id, stock_unit) REFERENCES batches(id, stock_unit),
  ADD CONSTRAINT color_changes_affected_unit_chk
    CHECK ((affected_quantity IS NULL) = (stock_unit IS NULL));
