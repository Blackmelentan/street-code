-- Street Code schema v2
-- One person = one users row. What they can do comes from memberships (garage,
-- fleet, station), from vehicle ownership, and from authorizations. Nothing is
-- decided by a "role" column on the user, which is what let anyone register as
-- police or admin in v1.

CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  phone         TEXT NOT NULL UNIQUE,
  email         TEXT,
  password_hash TEXT NOT NULL,
  platform_role TEXT NOT NULL DEFAULT 'user' CHECK (platform_role IN ('user','admin')),
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  failed_logins INTEGER NOT NULL DEFAULT 0,
  locked_until  TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Garages, fleets, police stations, car washes
CREATE TABLE orgs (
  id            TEXT PRIMARY KEY,
  type          TEXT NOT NULL CHECK (type IN ('garage','fleet','station','carwash')),
  name          TEXT NOT NULL,
  location      TEXT,
  address       TEXT,
  phone         TEXT,
  lat           REAL,
  lng           REAL,
  rating        REAL,
  bays          INTEGER NOT NULL DEFAULT 0,
  occupied_bays INTEGER NOT NULL DEFAULT 0,
  specialties   TEXT NOT NULL DEFAULT '[]',
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','verified','suspended')),
  verified_by   TEXT REFERENCES users(id),
  created_by    TEXT REFERENCES users(id),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- A person's place in an organisation: by ownership, employment or contract.
CREATE TABLE memberships (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES orgs(id),
  user_id       TEXT REFERENCES users(id),
  invited_phone TEXT,
  role          TEXT NOT NULL,
  employment    TEXT NOT NULL DEFAULT 'employee' CHECK (employment IN ('owner','employee','contractor')),
  badge_number  TEXT,
  status        TEXT NOT NULL DEFAULT 'invited' CHECK (status IN ('invited','active','suspended','ended')),
  invited_by    TEXT REFERENCES users(id),
  started_at    TEXT,
  ended_at      TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (user_id IS NOT NULL OR invited_phone IS NOT NULL)
);
CREATE INDEX idx_memberships_user ON memberships(user_id, status);
CREATE INDEX idx_memberships_org ON memberships(org_id, status);
CREATE INDEX idx_memberships_phone ON memberships(invited_phone);

CREATE TABLE vehicles (
  id                  TEXT PRIMARY KEY,
  vin                 TEXT NOT NULL UNIQUE,
  plate               TEXT NOT NULL,
  plate_key           TEXT NOT NULL UNIQUE,
  make                TEXT NOT NULL,
  model               TEXT NOT NULL,
  year                INTEGER NOT NULL,
  color               TEXT,
  vehicle_class       TEXT NOT NULL DEFAULT 'car',
  fuel_type           TEXT,
  severe_service      INTEGER NOT NULL DEFAULT 0,
  commercial_use      INTEGER NOT NULL DEFAULT 0,   -- yellow plate: needs licence group C
  owner_user_id       TEXT REFERENCES users(id),
  owner_org_id        TEXT REFERENCES orgs(id),
  status              TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','in_garage','impounded','off_road')),
  odometer            REAL NOT NULL DEFAULT 0,
  odometer_updated_at TEXT,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (owner_user_id IS NOT NULL OR owner_org_id IS NOT NULL)
);
CREATE INDEX idx_vehicles_owner ON vehicles(owner_user_id);
CREATE INDEX idx_vehicles_org ON vehicles(owner_org_id);

CREATE TABLE odometer_readings (
  id          TEXT PRIMARY KEY,
  vehicle_id  TEXT NOT NULL REFERENCES vehicles(id),
  value       REAL NOT NULL,
  source      TEXT NOT NULL CHECK (source IN ('owner','driver','garage','obd','import','police')),
  recorded_by TEXT REFERENCES users(id),
  recorded_at TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'accepted' CHECK (status IN ('accepted','anomaly')),
  note        TEXT
);
CREATE INDEX idx_odo_vehicle ON odometer_readings(vehicle_id, recorded_at);

-- Every oil change, wash, brake job... one table, one engine.
CREATE TABLE service_records (
  id                TEXT PRIMARY KEY,
  vehicle_id        TEXT NOT NULL REFERENCES vehicles(id),
  item_code         TEXT NOT NULL,
  performed_at      TEXT NOT NULL,
  odometer          REAL,
  performed_by      TEXT REFERENCES users(id),
  org_id            TEXT REFERENCES orgs(id),
  product           TEXT,                 -- JSON: { oil_type, grade, brand, filter }
  interval_distance REAL,
  interval_days     REAL,
  notes             TEXT,
  price_minor       INTEGER,              -- butut (1/100 dalasi)
  job_id            TEXT,
  passport_block_id TEXT,
  verified          INTEGER NOT NULL DEFAULT 0,  -- 1 only when sealed by a verified garage
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_service_vehicle ON service_records(vehicle_id, item_code, performed_at);

CREATE TABLE vehicle_service_settings (
  vehicle_id        TEXT NOT NULL REFERENCES vehicles(id),
  item_code         TEXT NOT NULL,
  interval_distance REAL,
  interval_days     REAL,
  enabled           INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (vehicle_id, item_code)
);

CREATE TABLE vehicle_documents (
  id          TEXT PRIMARY KEY,
  vehicle_id  TEXT NOT NULL REFERENCES vehicles(id),
  kind        TEXT NOT NULL CHECK (kind IN ('registration','insurance','road_tax','roadworthiness')),
  number      TEXT,
  issuer      TEXT,
  valid_from  TEXT,
  valid_to    TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','verified','rejected')),
  verified_by TEXT REFERENCES users(id),
  created_by  TEXT REFERENCES users(id),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_docs_vehicle ON vehicle_documents(vehicle_id, kind);

CREATE TABLE licences (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL UNIQUE REFERENCES users(id),
  licence_number TEXT NOT NULL UNIQUE,
  classes        TEXT NOT NULL DEFAULT '[]',
  issued_at      TEXT,
  expires_at     TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','valid','suspended','revoked')),
  points         INTEGER NOT NULL DEFAULT 0,
  restrictions   TEXT NOT NULL DEFAULT '[]',
  commercial_clearance_until TEXT,   -- resident permit holders: yearly IGP clearance for group C
  verified_by    TEXT REFERENCES users(id),
  verified_at    TEXT,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- "Fatou may drive my Corolla from Friday to Sunday."
CREATE TABLE authorizations (
  id             TEXT PRIMARY KEY,
  vehicle_id     TEXT NOT NULL REFERENCES vehicles(id),
  driver_user_id TEXT REFERENCES users(id),
  driver_phone   TEXT NOT NULL,
  driver_name    TEXT,
  granted_by     TEXT NOT NULL REFERENCES users(id),
  kind           TEXT NOT NULL CHECK (kind IN ('family','friend','rental','employee','garage')),
  starts_at      TEXT NOT NULL,
  ends_at        TEXT,
  status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked','expired')),
  note           TEXT,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  revoked_at     TEXT,
  revoked_by     TEXT REFERENCES users(id)
);
CREATE INDEX idx_auth_vehicle ON authorizations(vehicle_id, status);
CREATE INDEX idx_auth_driver ON authorizations(driver_user_id, status);

-- A driver declares "I am driving this vehicle now". This is how a plate check
-- can tell an officer who is behind the wheel without stopping anyone.
CREATE TABLE drive_sessions (
  id               TEXT PRIMARY KEY,
  vehicle_id       TEXT NOT NULL REFERENCES vehicles(id),
  driver_user_id   TEXT NOT NULL REFERENCES users(id),
  authorization_id TEXT REFERENCES authorizations(id),
  basis            TEXT NOT NULL CHECK (basis IN ('owner','authorization','fleet')),
  started_at       TEXT NOT NULL,
  ended_at         TEXT,
  end_reason       TEXT,
  start_odometer   REAL,
  end_odometer     REAL,
  start_lat        REAL,
  start_lng        REAL,
  status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','ended'))
);
CREATE UNIQUE INDEX idx_one_active_session ON drive_sessions(vehicle_id) WHERE status = 'active';
CREATE INDEX idx_session_driver ON drive_sessions(driver_user_id, status);

-- Police flags on vehicles and people
CREATE TABLE flags (
  id                TEXT PRIMARY KEY,
  subject_type      TEXT NOT NULL CHECK (subject_type IN ('vehicle','person')),
  subject_id        TEXT NOT NULL,
  kind              TEXT NOT NULL,
  level             TEXT NOT NULL CHECK (level IN ('red','amber','watch')),
  status            TEXT NOT NULL DEFAULT 'reported' CHECK (status IN ('reported','active','cleared','expired','rejected')),
  summary           TEXT NOT NULL,     -- shown to any officer on a hit
  detail            TEXT,              -- restricted: creator, supervisors, admin
  instruction       TEXT NOT NULL DEFAULT 'call_dispatch',
  case_ref          TEXT,
  created_by        TEXT NOT NULL REFERENCES users(id),
  reported_by_owner INTEGER NOT NULL DEFAULT 0,
  approved_by       TEXT REFERENCES users(id),
  approved_at       TEXT,
  expires_at        TEXT,
  cleared_by        TEXT REFERENCES users(id),
  cleared_at        TEXT,
  clear_reason      TEXT,
  last_seen_label   TEXT,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_flags_subject ON flags(subject_type, subject_id, status);
CREATE INDEX idx_flags_status ON flags(status, level);

-- Every time a flagged subject is seen.
CREATE TABLE sightings (
  id          TEXT PRIMARY KEY,
  flag_id     TEXT NOT NULL REFERENCES flags(id),
  vehicle_id  TEXT REFERENCES vehicles(id),
  officer_id  TEXT REFERENCES users(id),
  source      TEXT NOT NULL CHECK (source IN ('police_check','drive_session','telemetry')),
  lat         REAL,
  lng         REAL,
  label       TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_sightings_flag ON sightings(flag_id, created_at);

-- Server-written record of every roadside lookup. Officers cannot skip or edit it.
CREATE TABLE police_checks (
  id             TEXT PRIMARY KEY,
  officer_id     TEXT NOT NULL REFERENCES users(id),
  org_id         TEXT REFERENCES orgs(id),
  badge          TEXT,
  subject_kind   TEXT NOT NULL CHECK (subject_kind IN ('vehicle','licence')),
  query          TEXT NOT NULL,
  vehicle_id     TEXT REFERENCES vehicles(id),
  licence_id     TEXT REFERENCES licences(id),
  reason         TEXT NOT NULL,
  case_ref       TEXT,
  lat            REAL,
  lng            REAL,
  location_label TEXT,
  outcome        TEXT NOT NULL,
  verdict        TEXT NOT NULL,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_checks_officer ON police_checks(officer_id, created_at);
CREATE INDEX idx_checks_vehicle ON police_checks(vehicle_id, created_at);

CREATE TABLE police_check_notes (
  id         TEXT PRIMARY KEY,
  check_id   TEXT NOT NULL REFERENCES police_checks(id),
  officer_id TEXT NOT NULL REFERENCES users(id),
  note       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE jobs (
  id               TEXT PRIMARY KEY,
  org_id           TEXT NOT NULL REFERENCES orgs(id),
  vehicle_id       TEXT NOT NULL REFERENCES vehicles(id),
  customer_id      TEXT NOT NULL REFERENCES users(id),
  mechanic_id      TEXT REFERENCES users(id),
  opened_by        TEXT NOT NULL REFERENCES users(id),
  status           TEXT NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','quoted','accepted','in_progress','ready','completed','cancelled')),
  owner_consent    INTEGER NOT NULL DEFAULT 0,
  complaint        TEXT NOT NULL,
  dtcs             TEXT NOT NULL DEFAULT '[]',
  parts            TEXT NOT NULL DEFAULT '[]',
  labour_minor     INTEGER NOT NULL DEFAULT 0,
  parts_minor      INTEGER NOT NULL DEFAULT 0,
  total_minor      INTEGER NOT NULL DEFAULT 0,
  odometer_in      REAL,
  work_done        TEXT,
  escrow_id        TEXT,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  completed_at     TEXT
);
CREATE INDEX idx_jobs_org ON jobs(org_id, status);
CREATE INDEX idx_jobs_vehicle ON jobs(vehicle_id);

CREATE TABLE parts (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  category    TEXT NOT NULL,
  part_number TEXT NOT NULL,
  fits        TEXT NOT NULL,
  price_minor INTEGER NOT NULL,
  stock       INTEGER NOT NULL DEFAULT 0,
  supplier    TEXT NOT NULL,
  is_oem      INTEGER NOT NULL DEFAULT 1
);

-- Mobile money escrow. Amounts are integer butut, never floats.
CREATE TABLE escrow (
  id             TEXT PRIMARY KEY,
  job_id         TEXT REFERENCES jobs(id),
  payer_id       TEXT NOT NULL REFERENCES users(id),
  payee_org_id   TEXT NOT NULL REFERENCES orgs(id),
  provider       TEXT NOT NULL CHECK (provider IN ('afrimoney','qmoney')),
  phone          TEXT NOT NULL,
  amount_minor   INTEGER NOT NULL CHECK (amount_minor > 0),
  fee_minor      INTEGER NOT NULL,
  net_minor      INTEGER NOT NULL,
  reference      TEXT NOT NULL UNIQUE,
  status         TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','held','released','refunded','disputed')),
  provider_txn   TEXT UNIQUE,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE citations (
  id            TEXT PRIMARY KEY,
  number        TEXT NOT NULL UNIQUE,
  vehicle_id    TEXT NOT NULL REFERENCES vehicles(id),
  driver_id     TEXT REFERENCES users(id),
  officer_id    TEXT NOT NULL REFERENCES users(id),
  check_id      TEXT REFERENCES police_checks(id),
  code          TEXT NOT NULL,
  title         TEXT NOT NULL,
  fine_minor    INTEGER NOT NULL,
  waivable      INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'issued' CHECK (status IN ('issued','paid','waived','contested')),
  resolved_at   TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_citations_vehicle ON citations(vehicle_id, status);

-- Provenance chain (Ed25519-signed, canonical-JSON hashed)
CREATE TABLE passport_blocks (
  id           TEXT PRIMARY KEY,
  vehicle_id   TEXT NOT NULL REFERENCES vehicles(id),
  block_index  INTEGER NOT NULL,
  event_type   TEXT NOT NULL,
  timestamp    TEXT NOT NULL,
  mileage      REAL NOT NULL,
  actor_id     TEXT,
  actor_role   TEXT NOT NULL,
  actor_name   TEXT NOT NULL,
  org_id       TEXT,
  description  TEXT NOT NULL,
  payload      TEXT NOT NULL,
  prev_hash    TEXT NOT NULL,
  hash         TEXT NOT NULL,
  signature    TEXT NOT NULL,
  key_id       TEXT NOT NULL,
  UNIQUE (vehicle_id, block_index)
);

-- Tamper-evident audit trail: each row's hash covers the previous row's hash.
CREATE TABLE audit_logs (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,
  id          TEXT NOT NULL UNIQUE,
  ts          TEXT NOT NULL,
  actor_id    TEXT,
  actor_label TEXT,
  action      TEXT NOT NULL,
  target_type TEXT,
  target_id   TEXT,
  details     TEXT NOT NULL DEFAULT '{}',
  ip          TEXT,
  prev_hash   TEXT NOT NULL,
  hash        TEXT NOT NULL
);
CREATE INDEX idx_audit_action ON audit_logs(action, ts);

CREATE TABLE notifications (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id),
  kind       TEXT NOT NULL,
  severity   TEXT NOT NULL DEFAULT 'info' CHECK (severity IN ('info','warn','urgent')),
  title      TEXT NOT NULL,
  body       TEXT,
  vehicle_id TEXT REFERENCES vehicles(id),
  dedupe_key TEXT UNIQUE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  read_at    TEXT
);
CREATE INDEX idx_notif_user ON notifications(user_id, created_at);

CREATE TABLE telemetry (
  id          TEXT PRIMARY KEY,
  vehicle_id  TEXT NOT NULL REFERENCES vehicles(id),
  source      TEXT NOT NULL DEFAULT 'obd' CHECK (source IN ('obd','phone','sim')),
  speed_kph   REAL,
  rpm         REAL,
  coolant_c   REAL,
  fuel_pct    REAL,
  lat         REAL,
  lng         REAL,
  heading     REAL,
  ts          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_telemetry_vehicle ON telemetry(vehicle_id, ts);

CREATE TABLE ownership_transfers (
  id           TEXT PRIMARY KEY,
  vehicle_id   TEXT NOT NULL REFERENCES vehicles(id),
  from_user_id TEXT NOT NULL REFERENCES users(id),
  to_user_id   TEXT REFERENCES users(id),
  to_phone     TEXT NOT NULL,
  odometer     REAL,
  price_minor  INTEGER,
  status       TEXT NOT NULL DEFAULT 'offered' CHECK (status IN ('offered','completed','declined','cancelled')),
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  completed_at TEXT
);

-- ---------------------------------------------------------------------------
-- Append-only guards. Even a bug or a stolen DB credential in the app layer
-- cannot rewrite history through normal statements.
-- ---------------------------------------------------------------------------
CREATE TRIGGER passport_no_update BEFORE UPDATE ON passport_blocks BEGIN SELECT RAISE(ABORT, 'passport_blocks is append-only'); END;
CREATE TRIGGER passport_no_delete BEFORE DELETE ON passport_blocks BEGIN SELECT RAISE(ABORT, 'passport_blocks is append-only'); END;
CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit_logs BEGIN SELECT RAISE(ABORT, 'audit_logs is append-only'); END;
CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit_logs BEGIN SELECT RAISE(ABORT, 'audit_logs is append-only'); END;
CREATE TRIGGER checks_no_update BEFORE UPDATE ON police_checks BEGIN SELECT RAISE(ABORT, 'police_checks is append-only'); END;
CREATE TRIGGER checks_no_delete BEFORE DELETE ON police_checks BEGIN SELECT RAISE(ABORT, 'police_checks is append-only'); END;
CREATE TRIGGER sightings_no_update BEFORE UPDATE ON sightings BEGIN SELECT RAISE(ABORT, 'sightings is append-only'); END;
CREATE TRIGGER sightings_no_delete BEFORE DELETE ON sightings BEGIN SELECT RAISE(ABORT, 'sightings is append-only'); END;
