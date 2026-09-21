import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { db, initSchema, run } from './database.js';
import { appendPassportBlock } from '../services/passport.service.js';

console.log('--- INITIALIZING STREET CODE DATABASE & MIGRATIONS ---');
initSchema();

// Clear existing tables in correct order
db.exec(`
  DELETE FROM system_audit_logs;
  DELETE FROM stolen_broadcasts;
  DELETE FROM citations;
  DELETE FROM police_search_logs;
  DELETE FROM fleet_telemetry;
  DELETE FROM momo_escrow_transactions;
  DELETE FROM parts_inventory;
  DELETE FROM job_cards;
  DELETE FROM workshops;
  DELETE FROM passport_blocks;
  DELETE FROM vehicles;
  DELETE FROM users;
`);

console.log('Seeding demo users across all 6 roles...');
const passwordHash = bcrypt.hashSync('streetcode123', 10);

const users = [
  {
    id: 'usr-admin-01',
    name: 'Modou Lamin Ceesay',
    phone: '+2207000001',
    email: 'admin@streetcode.gm',
    password_hash: passwordHash,
    role: 'admin',
    kyc_status: 'verified',
    organization: 'Street Code Civic Platform Authority'
  },
  {
    id: 'usr-police-01',
    name: 'Sergeant Ebrima Jallow',
    phone: '+2207111222',
    email: 'e.jallow@police.gov.gm',
    password_hash: passwordHash,
    role: 'police',
    kyc_status: 'verified',
    badge_number: 'GPF-4092',
    organization: 'Gambia Police Force - Traffic Command'
  },
  {
    id: 'usr-owner-01',
    name: 'Fatoumatta Touray',
    phone: '+2207333444',
    email: 'fatou.touray@gmail.com',
    password_hash: passwordHash,
    role: 'owner',
    kyc_status: 'verified',
    organization: 'Private Vehicle Owner'
  },
  {
    id: 'usr-fleet-01',
    name: 'Bakary Sonko',
    phone: '+2207555666',
    email: 'b.sonko@banjulexpress.gm',
    password_hash: passwordHash,
    role: 'fleet_operator',
    kyc_status: 'verified',
    organization: 'Banjul Express Logistics'
  },
  {
    id: 'usr-mech-01',
    name: 'Pa Musa Bah',
    phone: '+2207777888',
    email: 'master@kairaba-auto.gm',
    password_hash: passwordHash,
    role: 'mechanic',
    kyc_status: 'verified',
    organization: 'Kairaba Precision Auto Lab'
  },
  {
    id: 'usr-driver-01',
    name: 'Alieu Cham',
    phone: '+2207999000',
    email: 'alieu.cham@gmail.com',
    password_hash: passwordHash,
    role: 'driver',
    kyc_status: 'verified',
    organization: 'Banjul Express Transit'
  }
];

for (const u of users) {
  run(
    `INSERT INTO users (id, name, phone, email, password_hash, role, kyc_status, badge_number, organization)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [u.id, u.name, u.phone, u.email, u.password_hash, u.role, u.kyc_status, u.badge_number || null, u.organization || null]
  );
}

console.log('Seeding vehicles...');
const vehicles = [
  {
    id: 'veh-rav4-01',
    vin: 'JT3HP10V2K5019284',
    plate_number: 'BJL-4821-B',
    make: 'Toyota',
    model: 'RAV4 Limited AWD',
    year: 2018,
    color: 'Silver Metallic',
    owner_id: 'usr-owner-01',
    status: 'active',
    current_mileage: 74520,
    fuel_level: 82.5,
    last_latitude: 13.4549,
    last_longitude: -16.5790,
    stolen_flag: 0
  },
  {
    id: 'veh-sprinter-02',
    vin: 'WDB9066331P827391',
    plate_number: 'WCR-1904-C',
    make: 'Mercedes-Benz',
    model: 'Sprinter 313 CDI Commercial Van',
    year: 2017,
    color: 'Yellow / Green',
    owner_id: 'usr-fleet-01',
    status: 'active',
    current_mileage: 168400,
    fuel_level: 65.0,
    last_latitude: 13.4320,
    last_longitude: -16.6812,
    stolen_flag: 0
  },
  {
    id: 'veh-hilux-03',
    vin: 'MROFR22G500192847',
    plate_number: 'KM-7732-A',
    make: 'Toyota',
    model: 'Hilux Double Cab D-4D',
    year: 2020,
    color: 'Pure White',
    owner_id: 'usr-owner-01',
    status: 'stolen',
    current_mileage: 52100,
    fuel_level: 40.0,
    last_latitude: 13.4410,
    last_longitude: -16.7110,
    stolen_flag: 1,
    stolen_reported_at: new Date(Date.now() - 3600000 * 4).toISOString(),
    stolen_notes: 'Vehicle taken from Senegambia Craft Market parking area at 14:20 GMT. GPS tracker disrupted.'
  },
  {
    id: 'veh-peugeot-04',
    vin: 'VF38BRHYF81294812',
    plate_number: 'BJL-9912-A',
    make: 'Peugeot',
    model: '406 HDi Commercial Taxi',
    year: 2004,
    color: 'Green / Yellow',
    owner_id: 'usr-driver-01',
    status: 'inspection_due',
    current_mileage: 284000,
    fuel_level: 55.0,
    last_latitude: 13.4610,
    last_longitude: -16.5920,
    stolen_flag: 0
  }
];

for (const v of vehicles) {
  run(
    `INSERT INTO vehicles (id, vin, plate_number, make, model, year, color, owner_id, status, current_mileage, fuel_level, last_latitude, last_longitude, stolen_flag, stolen_reported_at, stolen_notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [v.id, v.vin, v.plate_number, v.make, v.model, v.year, v.color, v.owner_id, v.status, v.current_mileage, v.fuel_level, v.last_latitude, v.last_longitude, v.stolen_flag, v.stolen_reported_at || null, v.stolen_notes || null]
  );
}

console.log('Minting cryptographic hash-chained Vehicle Passport for Toyota RAV4 (BJL-4821-B)...');
// Block 0: Genesis Port Import
appendPassportBlock({
  vehicleId: 'veh-rav4-01',
  eventType: 'GENESIS',
  mileage: 42000,
  actorId: 'usr-admin-01',
  actorRole: 'admin',
  actorName: 'Gambia Revenue Authority / Port of Banjul',
  description: 'Port of Entry Customs Clearance & Initial Technical Inspection Passed',
  dataPayload: {
    importEntryNumber: 'GRA-Banjul-2022-8812',
    originCountry: 'Germany',
    chassisVerified: true,
    initialConditionScore: 94
  }
});

// Block 1: Routine Service
appendPassportBlock({
  vehicleId: 'veh-rav4-01',
  eventType: 'ROUTINE_SERVICE',
  mileage: 51200,
  actorId: 'usr-mech-01',
  actorRole: 'mechanic',
  actorName: 'Pa Musa Bah (Kairaba Precision Auto)',
  description: 'Full Synthetic 5W-30 Oil & OEM Denso Filter Replacement, Tyre Rotation',
  dataPayload: {
    oilGrade: '5W-30 Full Synthetic',
    filterBrand: 'Denso OEM',
    brakePadFrontRemainingPct: 80,
    brakePadRearRemainingPct: 85
  }
});

// Block 2: Major Service & Brake Renewal
appendPassportBlock({
  vehicleId: 'veh-rav4-01',
  eventType: 'MAJOR_REPAIR',
  mileage: 62500,
  actorId: 'usr-mech-01',
  actorRole: 'mechanic',
  actorName: 'Pa Musa Bah (Kairaba Precision Auto)',
  description: 'Replaced Front Ceramic Brake Pads (Akebono OEM), Rotor Resurfacing & Coolant Flush',
  dataPayload: {
    dtcScanResult: 'NO_CODES_DETECTED',
    partsInstalled: ['Akebono Ceramic Pad Kit #ACT1211', 'Toyota Super Long Life Coolant'],
    invoiceRef: 'INV-2024-0419',
    escrowRef: 'SC-MM-AFR-2024-9128'
  }
});

// Block 3: Police Roadside Safety Clearance
appendPassportBlock({
  vehicleId: 'veh-rav4-01',
  eventType: 'POLICE_CLEARANCE',
  mileage: 74520,
  actorId: 'usr-police-01',
  actorRole: 'police',
  actorName: 'Sgt. Ebrima Jallow (GPF-4092)',
  description: 'Routine Roadside Checkpoint Inspection: All Credentials, Fire Extinguisher & Triangle Verified Valid',
  dataPayload: {
    checkpoint: 'Denton Bridge Security Station',
    insuranceExpiry: '2027-04-15',
    roadTaxValid: true,
    breathalyzer: '0.00% BAC'
  }
});

console.log('Seeding Workshops...');
const workshops = [
  {
    id: 'ws-kairaba-01',
    name: 'Kairaba Precision Auto Lab',
    owner_id: 'usr-mech-01',
    location: 'Westfield / Kairaba Avenue',
    address: '44 Kairaba Avenue, Next to Africell HQ, Kanifing',
    phone: '+2207777888',
    rating: 4.95,
    active_bays: 5,
    occupied_bays: 2,
    specialties: JSON.stringify(['OBD-II Diagnostics', 'Hybrid & Electric', 'Japanese & German Powertrains', 'Air Conditioning'])
  },
  {
    id: 'ws-senegambia-02',
    name: 'Senegambia Modern Garage',
    owner_id: 'usr-mech-01',
    location: 'Senegambia Strip, Kololi',
    address: 'Tourism Development Area, Kololi',
    phone: '+2207654321',
    rating: 4.82,
    active_bays: 6,
    occupied_bays: 3,
    specialties: JSON.stringify(['Suspension Tuning', 'Brake Systems', 'Fleet Preventive Care', 'Bodywork'])
  },
  {
    id: 'ws-brikama-03',
    name: 'Brikama Heavy Diesel & Commercial Depot',
    owner_id: 'usr-fleet-01',
    location: 'Brikama Highway, West Coast Region',
    address: 'Mile 14 Brikama Highway',
    phone: '+2207888999',
    rating: 4.70,
    active_bays: 8,
    occupied_bays: 5,
    specialties: JSON.stringify(['Commercial Vans', 'Sprinter Diesel Injection', 'Heavy Axle Alignment', 'Truck Fleet Overhaul'])
  }
];

for (const w of workshops) {
  run(
    `INSERT INTO workshops (id, name, owner_id, location, address, phone, rating, active_bays, occupied_bays, specialties)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [w.id, w.name, w.owner_id, w.location, w.address, w.phone, w.rating, w.active_bays, w.occupied_bays, w.specialties]
  );
}

console.log('Seeding Parts Inventory...');
const parts = [
  {
    id: 'part-01',
    name: 'Toyota OEM Engine Oil Filter',
    category: 'Filters',
    part_number: '90915-YZZN1',
    compatible_models: 'Toyota RAV4, Corolla, Hilux, Camry',
    price_gmd: 450,
    stock_quantity: 45,
    supplier_name: 'Banjul Japanese Auto Spares',
    is_oem: 1
  },
  {
    id: 'part-02',
    name: 'Akebono Ceramic Front Brake Pads',
    category: 'Brakes',
    part_number: 'ACT-1211',
    compatible_models: 'Toyota RAV4 (2013-2022), Lexus NX',
    price_gmd: 1850,
    stock_quantity: 18,
    supplier_name: 'Euro-Asia Auto Parts Gambia',
    is_oem: 1
  },
  {
    id: 'part-03',
    name: 'Bosch Double Platinum Spark Plugs (Pack of 4)',
    category: 'Ignition',
    part_number: 'FR7DPP33',
    compatible_models: 'Mercedes-Benz, Peugeot, Toyota',
    price_gmd: 1200,
    stock_quantity: 24,
    supplier_name: 'Banjul Japanese Auto Spares',
    is_oem: 1
  },
  {
    id: 'part-04',
    name: 'Varta Heavy Duty 12V 75Ah Sealed Battery',
    category: 'Electrical',
    part_number: 'VARTA-E43-75AH',
    compatible_models: 'Universal / Commercial Vans & Light SUVs',
    price_gmd: 4800,
    stock_quantity: 12,
    supplier_name: 'Atlas Battery & Solar Depot',
    is_oem: 1
  },
  {
    id: 'part-05',
    name: 'Street Code ELM327 Bluetooth OBD-II Scanner',
    category: 'Diagnostics',
    part_number: 'SC-OBD-BT40',
    compatible_models: 'All OBD-II Compliant Vehicles (1996+)',
    price_gmd: 950,
    stock_quantity: 60,
    supplier_name: 'Street Code Hardware Labs',
    is_oem: 1
  }
];

for (const p of parts) {
  run(
    `INSERT INTO parts_inventory (id, name, category, part_number, compatible_models, price_gmd, stock_quantity, supplier_name, is_oem)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [p.id, p.name, p.category, p.part_number, p.compatible_models, p.price_gmd, p.stock_quantity, p.supplier_name, p.is_oem]
  );
}

console.log('Seeding Job Cards & Mobile Money Escrow...');
const jobId = 'job-card-01';
run(
  `INSERT INTO job_cards (id, vehicle_id, customer_id, mechanic_id, workshop_id, status, complaint, diagnostic_dtcs, parts_required, labor_cost, parts_cost, total_cost)
   VALUES (?, ?, ?, ?, ?, 'quoted', ?, ?, ?, ?, ?, ?)`,
  [
    jobId,
    'veh-sprinter-02',
    'usr-fleet-01',
    'usr-mech-01',
    'ws-kairaba-01',
    'Engine hesitation on incline between Westfield and Tabokoto. Check Engine Light glowing.',
    JSON.stringify(['P0300', 'P0171']),
    JSON.stringify(['Bosch Double Platinum Spark Plugs (Pack of 4)', 'Fuel Filter']),
    1500,
    2200,
    3700
  ]
);

console.log('Seeding Citations & Driver Education Waiver (Gap 6)...');
run(
  `INSERT INTO citations (id, citation_number, vehicle_id, driver_id, officer_id, violation_code, violation_title, fine_amount_gmd, eligible_for_waiver, course_completed, status)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 0, 'issued')`,
  [
    'cit-01',
    'CIT-2026-0812',
    'veh-peugeot-04',
    'usr-driver-01',
    'usr-police-01',
    'TRAF-44B',
    'Defective Rear Tail Lamp / Inoperable Brake Illumination',
    1500
  ]
);

console.log('Seeding Mandatory Police Roadside Search Log (Gap 5)...');
run(
  `INSERT INTO police_search_logs (id, officer_id, officer_badge, vehicle_vin, vehicle_plate, location_checkpoint, search_reason, search_findings, flagged_stolen, citation_issued_id)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, NULL)`,
  [
    'psl-01',
    'usr-police-01',
    'GPF-4092',
    'JT3HP10V2K5019284',
    'BJL-4821-B',
    'Denton Bridge Security Checkpoint',
    'Routine Checkpoint Inspection',
    'Driver driver license verified valid. Road tax current. Fire extinguisher certified. Vehicle clear.',
  ]
);

console.log('Seeding Stolen Vehicle APB Broadcast...');
run(
  `INSERT INTO stolen_broadcasts (id, vehicle_id, reported_by, last_seen_location, details, status, alert_radius_km)
   VALUES (?, ?, ?, ?, ?, 'ACTIVE_ALERT', 50.0)`,
  [
    'apb-01',
    'veh-hilux-03',
    'usr-owner-01',
    'Senegambia Strip Craft Market Parking, Kololi',
    'Toyota Hilux Double Cab 2020 (White, KM-7732-A). Tinted rear windows, chrome bull-bar in front. Stolen at 14:20 GMT. If spotted, report immediately to Gambia Police Force.',
  ]
);

console.log('Seeding Fleet Telemetry stream...');
const telemetry = [
  { vid: 'veh-rav4-01', spd: 48, rpm: 1850, temp: 89, fuel: 82.5, lat: 13.4549, lon: -16.5790, heading: 92 },
  { vid: 'veh-sprinter-02', spd: 62, rpm: 2200, temp: 91, fuel: 65.0, lat: 13.4320, lon: -16.6812, heading: 240 },
  { vid: 'veh-peugeot-04', spd: 34, rpm: 1550, temp: 86, fuel: 55.0, lat: 13.4610, lon: -16.5920, heading: 45 }
];

for (const t of telemetry) {
  run(
    `INSERT INTO fleet_telemetry (id, vehicle_id, speed_kph, engine_rpm, coolant_temp_c, fuel_level_pct, latitude, longitude, heading)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [crypto.randomUUID(), t.vid, t.spd, t.rpm, t.temp, t.fuel, t.lat, t.lon, t.heading]
  );
}

console.log('✅ DATABASE SEED COMPLETE!');
