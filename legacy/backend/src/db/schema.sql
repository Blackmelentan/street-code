-- ==============================================================================
-- STREET CODE AUTOMOTIVE OS - RELATIONAL SCHEMA
-- Platform Engine for Verified Provenance, Civic Mobility, and Marketplace Escrow
-- Target: SQLite 3 with Node:SQLite (DatabaseSync)
-- ==============================================================================

PRAGMA foreign_keys = ON;

-- 1. Users & Identities (Owners, Mechanics, Drivers, Fleet Ops, Police Officers, Admins)
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT UNIQUE NOT NULL,
  email TEXT,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('owner', 'mechanic', 'driver', 'fleet_operator', 'police', 'admin')),
  kyc_status TEXT NOT NULL DEFAULT 'verified',
  badge_number TEXT,
  organization TEXT,
  avatar_url TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 2. Vehicles Registry
CREATE TABLE IF NOT EXISTS vehicles (
  id TEXT PRIMARY KEY,
  vin TEXT UNIQUE NOT NULL,
  plate_number TEXT UNIQUE NOT NULL,
  make TEXT NOT NULL,
  model TEXT NOT NULL,
  year INTEGER NOT NULL,
  color TEXT,
  owner_id TEXT REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'in_maintenance', 'impounded', 'stolen', 'inspection_due', 'offline')),
  current_mileage INTEGER NOT NULL DEFAULT 0,
  fuel_level REAL DEFAULT 85.0,
  battery_level REAL DEFAULT 12.6,
  last_latitude REAL DEFAULT 13.4549,
  last_longitude REAL DEFAULT -16.5790,
  stolen_flag INTEGER NOT NULL DEFAULT 0,
  stolen_reported_at DATETIME,
  stolen_notes TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 3. Vehicle Passport Blocks (Cryptographically Hash-Chained Provenance)
CREATE TABLE IF NOT EXISTS passport_blocks (
  id TEXT PRIMARY KEY,
  vehicle_id TEXT NOT NULL REFERENCES vehicles(id),
  block_index INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  timestamp DATETIME NOT NULL,
  mileage INTEGER NOT NULL,
  actor_id TEXT NOT NULL REFERENCES users(id),
  actor_role TEXT NOT NULL,
  actor_name TEXT NOT NULL,
  description TEXT NOT NULL,
  data_payload TEXT NOT NULL, -- JSON string
  prev_hash TEXT NOT NULL,
  current_hash TEXT NOT NULL,
  signature TEXT NOT NULL,
  UNIQUE(vehicle_id, block_index)
);

-- 4. Workshops / Garages Directory
CREATE TABLE IF NOT EXISTS workshops (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  owner_id TEXT REFERENCES users(id),
  location TEXT NOT NULL,
  address TEXT NOT NULL,
  phone TEXT NOT NULL,
  rating REAL DEFAULT 4.9,
  active_bays INTEGER DEFAULT 4,
  occupied_bays INTEGER DEFAULT 2,
  specialties TEXT NOT NULL, -- JSON array of strings
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 5. Job Cards & Workshop Operations
CREATE TABLE IF NOT EXISTS job_cards (
  id TEXT PRIMARY KEY,
  vehicle_id TEXT NOT NULL REFERENCES vehicles(id),
  customer_id TEXT NOT NULL REFERENCES users(id),
  mechanic_id TEXT REFERENCES users(id),
  workshop_id TEXT REFERENCES workshops(id),
  status TEXT NOT NULL DEFAULT 'pending_inspection' CHECK(status IN ('pending_inspection', 'diagnosed', 'quoted', 'escrow_funded', 'in_progress', 'quality_check', 'completed', 'closed')),
  complaint TEXT NOT NULL,
  diagnostic_dtcs TEXT DEFAULT '[]', -- JSON array of DTC codes
  parts_required TEXT DEFAULT '[]', -- JSON array of parts
  labor_cost REAL DEFAULT 0,
  parts_cost REAL DEFAULT 0,
  total_cost REAL DEFAULT 0,
  escrow_tx_id TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 6. Parts Inventory Marketplace
CREATE TABLE IF NOT EXISTS parts_inventory (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  part_number TEXT NOT NULL,
  compatible_models TEXT NOT NULL,
  price_gmd REAL NOT NULL,
  stock_quantity INTEGER NOT NULL DEFAULT 10,
  supplier_name TEXT NOT NULL,
  is_oem INTEGER DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 7. African Mobile Money Escrow Transactions (Afrimoney & QMoney Direct Integration)
CREATE TABLE IF NOT EXISTS momo_escrow_transactions (
  id TEXT PRIMARY KEY,
  job_id TEXT REFERENCES job_cards(id),
  payer_id TEXT NOT NULL REFERENCES users(id),
  payee_id TEXT NOT NULL REFERENCES users(id),
  provider TEXT NOT NULL CHECK(provider IN ('afrimoney', 'qmoney')),
  phone_number TEXT NOT NULL,
  amount_gmd REAL NOT NULL,
  platform_fee_gmd REAL NOT NULL,
  net_amount_gmd REAL NOT NULL,
  reference_code TEXT UNIQUE NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending_ussd' CHECK(status IN ('pending_ussd', 'held_in_escrow', 'released', 'refunded', 'disputed')),
  ussd_prompt_status TEXT DEFAULT 'SENT',
  escrow_released_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 8. Live Fleet Telemetry
CREATE TABLE IF NOT EXISTS fleet_telemetry (
  id TEXT PRIMARY KEY,
  vehicle_id TEXT NOT NULL REFERENCES vehicles(id),
  speed_kph REAL NOT NULL,
  engine_rpm REAL NOT NULL,
  coolant_temp_c REAL NOT NULL,
  fuel_level_pct REAL NOT NULL,
  latitude REAL NOT NULL,
  longitude REAL NOT NULL,
  heading REAL NOT NULL,
  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 9. Procedural Police Search Logs (Mandatory Transparency & Chain of Custody)
CREATE TABLE IF NOT EXISTS police_search_logs (
  id TEXT PRIMARY KEY,
  officer_id TEXT NOT NULL REFERENCES users(id),
  officer_badge TEXT NOT NULL,
  vehicle_vin TEXT NOT NULL,
  vehicle_plate TEXT NOT NULL,
  location_checkpoint TEXT NOT NULL,
  search_reason TEXT NOT NULL,
  search_findings TEXT NOT NULL,
  flagged_stolen INTEGER DEFAULT 0,
  citation_issued_id TEXT,
  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 10. Traffic Citations with In-App Driver Education Waiver
CREATE TABLE IF NOT EXISTS citations (
  id TEXT PRIMARY KEY,
  citation_number TEXT UNIQUE NOT NULL,
  vehicle_id TEXT NOT NULL REFERENCES vehicles(id),
  driver_id TEXT NOT NULL REFERENCES users(id),
  officer_id TEXT NOT NULL REFERENCES users(id),
  violation_code TEXT NOT NULL,
  violation_title TEXT NOT NULL,
  fine_amount_gmd REAL NOT NULL,
  eligible_for_waiver INTEGER DEFAULT 1,
  course_completed INTEGER DEFAULT 0,
  course_completed_at DATETIME,
  status TEXT NOT NULL DEFAULT 'issued' CHECK(status IN ('issued', 'paid', 'waived_via_course', 'contested')),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 11. Stolen Vehicle Broadcast Alerts (Civic APB Network)
CREATE TABLE IF NOT EXISTS stolen_broadcasts (
  id TEXT PRIMARY KEY,
  vehicle_id TEXT NOT NULL REFERENCES vehicles(id),
  reported_by TEXT NOT NULL REFERENCES users(id),
  last_seen_location TEXT NOT NULL,
  details TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE_ALERT' CHECK(status IN ('ACTIVE_ALERT', 'RECOVERED', 'CANCELLED')),
  alert_radius_km REAL DEFAULT 50.0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 12. Immutable System Audit Logs
CREATE TABLE IF NOT EXISTS system_audit_logs (
  id TEXT PRIMARY KEY,
  actor_id TEXT,
  actor_role TEXT,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  details TEXT NOT NULL,
  ip_address TEXT DEFAULT '127.0.0.1',
  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- INDEXES for instant high-speed lookup
CREATE INDEX IF NOT EXISTS idx_vehicles_vin ON vehicles(vin);
CREATE INDEX IF NOT EXISTS idx_vehicles_plate ON vehicles(plate_number);
CREATE INDEX IF NOT EXISTS idx_passport_blocks_vid ON passport_blocks(vehicle_id, block_index);
CREATE INDEX IF NOT EXISTS idx_job_cards_status ON job_cards(status);
CREATE INDEX IF NOT EXISTS idx_police_search_plate ON police_search_logs(vehicle_plate);
CREATE INDEX IF NOT EXISTS idx_citations_driver ON citations(driver_id);
