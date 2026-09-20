CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS citext;

CREATE TYPE craft_type AS ENUM ('DYEING', 'WOODWORKING', 'POTTERY', 'METALWORKING', 'GENERAL', 'OTHER');
CREATE TYPE source_type AS ENUM ('PURCHASED', 'GIFTED', 'SELF_MADE', 'SALVAGED', 'OTHER');
CREATE TYPE stock_unit AS ENUM ('g', 'kg', 'ml', 'l', 'mm', 'cm', 'm', 'm2', 'pcs');
CREATE TYPE batch_status AS ENUM ('ACTIVE', 'DEPLETED', 'ARCHIVED');
CREATE TYPE movement_type AS ENUM ('OPENING', 'PURCHASE', 'CONSUMPTION', 'ADJUSTMENT_IN', 'ADJUSTMENT_OUT', 'REVERSAL');
CREATE TYPE consumption_status AS ENUM ('ACTIVE', 'REVERSED');
CREATE TYPE project_status AS ENUM ('PLANNED', 'IN_PROGRESS', 'COMPLETED', 'ARCHIVED');
CREATE TYPE color_change_type AS ENUM ('OXIDATION', 'DYE_BATH', 'FINISHING', 'GLAZE', 'PATINA', 'WEATHERING', 'MIXING', 'OTHER');
CREATE TYPE attachment_owner_type AS ENUM ('BATCH', 'COLOR_CHANGE', 'PROJECT', 'CONSUMPTION');

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name varchar(80) NOT NULL,
  password_hash text NOT NULL,
  last_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_singleton_uq ON users ((true));

CREATE TABLE sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash char(64) NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user_idx ON sessions(user_id);
CREATE INDEX sessions_expiry_idx ON sessions(expires_at);

CREATE TABLE sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name varchar(120) NOT NULL,
  type source_type NOT NULL,
  contact_name varchar(80),
  contact_phone varchar(40),
  contact_email varchar(120),
  address text,
  notes text,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX sources_type_name_uq ON sources(type, lower(name)) WHERE archived_at IS NULL;
CREATE INDEX sources_name_trgm_idx ON sources USING gin (lower(name) gin_trgm_ops);

CREATE TABLE storage_locations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name varchar(120) NOT NULL,
  parent_id uuid REFERENCES storage_locations(id),
  notes text,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX locations_parent_name_uq ON storage_locations(coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(name)) WHERE archived_at IS NULL;
CREATE INDEX locations_parent_idx ON storage_locations(parent_id);

CREATE TABLE materials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code varchar(64),
  name varchar(120) NOT NULL,
  craft_types craft_type[] NOT NULL CHECK (cardinality(craft_types) > 0),
  subtype varchar(80),
  stock_unit stock_unit NOT NULL,
  low_stock_threshold numeric(18,6) CHECK (low_stock_threshold IS NULL OR low_stock_threshold >= 0),
  default_color_name varchar(80),
  default_color_hex char(7) CHECK (default_color_hex IS NULL OR default_color_hex ~ '^#[0-9A-Fa-f]{6}$'),
  tags text[] NOT NULL DEFAULT '{}',
  notes text,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX materials_code_uq ON materials(lower(code)) WHERE code IS NOT NULL AND archived_at IS NULL;
CREATE INDEX materials_name_trgm_idx ON materials USING gin (lower(name) gin_trgm_ops);
CREATE INDEX materials_craft_types_idx ON materials USING gin (craft_types);
CREATE INDEX materials_tags_idx ON materials USING gin (tags);

CREATE TABLE batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  material_id uuid NOT NULL REFERENCES materials(id),
  batch_code varchar(64),
  source_id uuid REFERENCES sources(id),
  source_note varchar(200),
  location_id uuid REFERENCES storage_locations(id),
  received_at date NOT NULL,
  expiry_at date,
  initial_quantity numeric(18,6) NOT NULL CHECK (initial_quantity > 0),
  remaining_quantity numeric(18,6) NOT NULL CHECK (remaining_quantity >= 0),
  stock_unit stock_unit NOT NULL,
  entry_unit stock_unit NOT NULL,
  total_cost numeric(18,2) CHECK (total_cost IS NULL OR total_cost >= 0),
  currency char(3),
  initial_color_name varchar(80),
  initial_color_hex char(7) CHECK (initial_color_hex IS NULL OR initial_color_hex ~ '^#[0-9A-Fa-f]{6}$'),
  current_color_name varchar(80),
  current_color_hex char(7) CHECK (current_color_hex IS NULL OR current_color_hex ~ '^#[0-9A-Fa-f]{6}$'),
  color_updated_at timestamptz,
  status batch_status NOT NULL DEFAULT 'ACTIVE',
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX batches_material_code_uq ON batches(material_id, lower(batch_code)) WHERE batch_code IS NOT NULL;
CREATE INDEX batches_material_status_idx ON batches(material_id, status);
CREATE INDEX batches_source_idx ON batches(source_id);
CREATE INDEX batches_location_idx ON batches(location_id);
CREATE INDEX batches_expiry_idx ON batches(expiry_at);
CREATE INDEX batches_code_trgm_idx ON batches USING gin (lower(batch_code) gin_trgm_ops);

CREATE TABLE stock_movements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id uuid NOT NULL REFERENCES batches(id),
  type movement_type NOT NULL,
  signed_quantity numeric(18,6) NOT NULL CHECK (signed_quantity <> 0),
  stock_unit stock_unit NOT NULL,
  before_quantity numeric(18,6) NOT NULL CHECK (before_quantity >= 0),
  after_quantity numeric(18,6) NOT NULL CHECK (after_quantity >= 0),
  reference_type varchar(32),
  reference_id uuid,
  reason text,
  actor_user_id uuid NOT NULL REFERENCES users(id),
  idempotency_key varchar(100),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (round(before_quantity + signed_quantity, 6) = round(after_quantity, 6))
);
CREATE UNIQUE INDEX movements_idempotency_uq ON stock_movements(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX movements_batch_created_idx ON stock_movements(batch_id, created_at DESC);
CREATE INDEX movements_reference_idx ON stock_movements(reference_type, reference_id);

CREATE TABLE projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name varchar(120) NOT NULL,
  craft_type craft_type NOT NULL,
  status project_status NOT NULL DEFAULT 'PLANNED',
  start_date date,
  due_date date,
  completed_at timestamptz,
  description text,
  target_color_name varchar(80),
  target_color_hex char(7) CHECK (target_color_hex IS NULL OR target_color_hex ~ '^#[0-9A-Fa-f]{6}$'),
  tags text[] NOT NULL DEFAULT '{}',
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1
);
CREATE INDEX projects_status_due_idx ON projects(status, due_date);
CREATE INDEX projects_name_trgm_idx ON projects USING gin (lower(name) gin_trgm_ops);

CREATE TABLE project_requirements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  material_id uuid NOT NULL REFERENCES materials(id),
  required_quantity numeric(18,6) NOT NULL CHECK (required_quantity > 0),
  stock_unit stock_unit NOT NULL,
  purpose varchar(160),
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX requirements_project_idx ON project_requirements(project_id);
CREATE INDEX requirements_material_idx ON project_requirements(material_id);

CREATE TABLE consumptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id),
  project_requirement_id uuid REFERENCES project_requirements(id),
  batch_id uuid NOT NULL REFERENCES batches(id),
  used_quantity numeric(18,6) NOT NULL CHECK (used_quantity >= 0),
  waste_quantity numeric(18,6) NOT NULL CHECK (waste_quantity >= 0),
  total_quantity numeric(18,6) NOT NULL CHECK (total_quantity > 0),
  stock_unit stock_unit NOT NULL,
  consumed_at timestamptz NOT NULL DEFAULT now(),
  purpose varchar(160),
  notes text,
  status consumption_status NOT NULL DEFAULT 'ACTIVE',
  reversed_at timestamptz,
  reversal_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (round(used_quantity + waste_quantity, 6) = round(total_quantity, 6)),
  CHECK (status = 'ACTIVE' OR (reversed_at IS NOT NULL AND reversal_reason IS NOT NULL))
);
CREATE INDEX consumptions_project_idx ON consumptions(project_id, consumed_at DESC);
CREATE INDEX consumptions_batch_idx ON consumptions(batch_id, consumed_at DESC);
CREATE INDEX consumptions_status_idx ON consumptions(status);

CREATE TABLE color_changes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id uuid NOT NULL REFERENCES batches(id),
  project_id uuid REFERENCES projects(id),
  consumption_id uuid REFERENCES consumptions(id),
  change_type color_change_type NOT NULL,
  before_color_name varchar(80),
  before_color_hex char(7) CHECK (before_color_hex IS NULL OR before_color_hex ~ '^#[0-9A-Fa-f]{6}$'),
  after_color_name varchar(80) NOT NULL,
  after_color_hex char(7) CHECK (after_color_hex IS NULL OR after_color_hex ~ '^#[0-9A-Fa-f]{6}$'),
  affected_quantity numeric(18,6) CHECK (affected_quantity IS NULL OR affected_quantity > 0),
  stock_unit stock_unit,
  temperature_c numeric(6,2),
  humidity_percent numeric(5,2) CHECK (humidity_percent IS NULL OR (humidity_percent >= 0 AND humidity_percent <= 100)),
  ph_value numeric(4,2) CHECK (ph_value IS NULL OR (ph_value >= 0 AND ph_value <= 14)),
  environment_notes text,
  occurred_at timestamptz NOT NULL,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX color_changes_batch_idx ON color_changes(batch_id, occurred_at DESC);
CREATE INDEX color_changes_project_idx ON color_changes(project_id);

CREATE TABLE attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_type attachment_owner_type NOT NULL,
  owner_id uuid NOT NULL,
  original_name varchar(255) NOT NULL,
  storage_key varchar(255) NOT NULL UNIQUE,
  mime_type varchar(80) NOT NULL,
  byte_size bigint NOT NULL CHECK (byte_size > 0),
  sha256 char(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX attachments_owner_idx ON attachments(owner_type, owner_id);

CREATE TABLE audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id uuid NOT NULL REFERENCES users(id),
  action varchar(80) NOT NULL,
  entity_type varchar(80) NOT NULL,
  entity_id uuid,
  before_data jsonb,
  after_data jsonb,
  request_id varchar(64),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_entity_idx ON audit_logs(entity_type, entity_id, created_at DESC);
CREATE INDEX audit_created_idx ON audit_logs(created_at DESC);

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER users_updated_at BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER sources_updated_at BEFORE UPDATE ON sources FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER locations_updated_at BEFORE UPDATE ON storage_locations FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER materials_updated_at BEFORE UPDATE ON materials FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER batches_updated_at BEFORE UPDATE ON batches FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER projects_updated_at BEFORE UPDATE ON projects FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER requirements_updated_at BEFORE UPDATE ON project_requirements FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER consumptions_updated_at BEFORE UPDATE ON consumptions FOR EACH ROW EXECUTE FUNCTION set_updated_at();
