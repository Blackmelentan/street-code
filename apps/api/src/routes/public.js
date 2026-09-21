import { Router } from 'express';
import { all, one } from '../db/database.js';
import { h, str, json } from '../lib/http.js';
import { plateKey } from '../lib/ids.js';
import { rateLimit } from '../lib/ratelimit.js';
import { getBlocks, verifyChain, passportPublicKey, EVENT_AUTHORITY } from '../services/passport.js';
import { openFlagsOn } from '../services/vehicles.js';
import { VEHICLE_CLASSES, SERVICE_ITEMS, OIL_TYPES, OIL_GRADES, LICENCE_GROUPS, DOCUMENT_KINDS, AUTHORIZATION_KINDS, WASH_KINDS, FLAG_KINDS, ORG_ROLES, ROLES_BY_ORG, FUEL_TYPES } from '../../../../packages/core/src/index.js';

const r = Router();

/**
 * What a stranger may read in a passport. Block descriptions can contain names and police case
 * numbers (they are signed, so we cannot edit them), so publicly only garage-sealed work shows its
 * own description. Everything else gets a fixed label.
 */
const PUBLIC_LABEL = {
  GENESIS: 'Registered (self-reported)', OWNER_NOTE: 'Owner note (self-reported)', OWNERSHIP_TRANSFER: 'Ownership changed',
  STOLEN_REPORT: 'Reported stolen', STOLEN_RECOVERED: 'Recovered', POLICE_CLEARANCE: 'Police clearance', CITATION_RESOLVED: 'Traffic citation resolved',
};
const limiter = rateLimit({ windowMs: 60_000, max: 30, message: 'Too many lookups. Try again in a minute.' });

/**
 * A buyer checking a car. Deliberately contains no personal data: no owner name, phone, or drivers.
 * What it does show is what a buyer needs: is it flagged, is the history intact, is the mileage credible.
 */
r.get('/public/vehicle', limiter, h((req, res) => {
  const q = plateKey(str(req.query.q, 'Plate or VIN', { min: 3, max: 20 }));
  const v = one('SELECT * FROM vehicles WHERE plate_key = ? OR vin = ?', [q, q]);
  if (!v) return res.json({ found: false });
  const blocks = getBlocks(v.id);
  const verification = verifyChain(v.id);
  const cls = VEHICLE_CLASSES[v.vehicle_class] || VEHICLE_CLASSES.car;
  const open = openFlagsOn('vehicle', v.id);
  const flagged = open.some((f) => f.status === 'active');
  const ownerReported = !flagged && open.some((f) => f.reported_by_owner);
  const sealedByGarage = blocks.filter((b) => b.actor_role === 'mechanic');
  res.json({
    found: true,
    vehicle: { plate: v.plate, make: v.make, model: v.model, year: v.year, color: v.color, class_label: cls.label, commercial: !!v.commercial_use },
    // We tell a buyer a flag exists (so they walk away or ask police) but never why.
    police_flag: flagged,
    owner_reported_stolen: ownerReported, // reported by the owner, not yet confirmed by police
    odometer: { current: v.odometer, unit: cls.unit, last_sealed: verification.latestMileage ?? null },
    passport: { valid: verification.valid, reason: verification.reason ?? null, blocks: verification.blocks, sealed_since: verification.sealedSince ?? null, garage_sealed_events: sealedByGarage.length, key_id: verification.keyId ?? null },
    history: blocks.map((b) => ({ index: b.block_index, type: b.event_type, at: b.timestamp, mileage: b.mileage, by: b.actor_role === 'mechanic' ? (b.payload?.garage || 'Verified garage') : b.actor_role === 'police' ? 'Police' : b.actor_role === 'owner' ? 'Owner' : 'System', verified: b.actor_role === 'mechanic' || b.actor_role === 'police', description: b.actor_role === 'mechanic' ? b.description : PUBLIC_LABEL[b.event_type] || 'Recorded' })).reverse(),
  });
}));

r.get('/public/garages', h((req, res) => {
  res.json({ garages: all(`SELECT id, name, location, address, phone, rating, bays, occupied_bays, specialties FROM orgs WHERE type IN ('garage','carwash') AND status = 'verified' ORDER BY rating DESC NULLS LAST`).map((g) => ({ ...g, specialties: json(g.specialties, []), open_bays: Math.max(0, g.bays - g.occupied_bays) })) });
}));

r.get('/public/stats', h((req, res) => {
  const n = (sql) => one(sql).n;
  res.json({
    vehicles: n('SELECT COUNT(*) AS n FROM vehicles'), sealed_records: n('SELECT COUNT(*) AS n FROM passport_blocks'),
    garages: n(`SELECT COUNT(*) AS n FROM orgs WHERE type = 'garage' AND status = 'verified'`), odometer_fraud_blocked: n(`SELECT COUNT(*) AS n FROM odometer_readings WHERE status = 'anomaly'`),
    recovered: n(`SELECT COUNT(*) AS n FROM flags WHERE kind = 'stolen' AND status = 'cleared'`),
  });
}));

// Anyone can verify a passport without trusting us: this is the public half of the signing key.
r.get('/public/keys', h((req, res) => res.json({ passport: passportPublicKey(), how: 'Each passport block is hashed (SHA-256 over canonical JSON) and signed with Ed25519. Verify the signature over the block hash with this key.' })));

r.get('/public/catalog', h((req, res) => res.json({
  vehicleClasses: VEHICLE_CLASSES, serviceItems: Object.fromEntries(Object.entries(SERVICE_ITEMS).map(([k, v]) => [k, { label: v.label, short: v.short, icon: v.icon, critical: !!v.critical, needsProduct: !!v.needsProduct }])),
  oilTypes: OIL_TYPES, oilGrades: OIL_GRADES, licenceGroups: LICENCE_GROUPS, documentKinds: DOCUMENT_KINDS, authorizationKinds: AUTHORIZATION_KINDS, washKinds: WASH_KINDS, fuelTypes: FUEL_TYPES,
  flagKinds: FLAG_KINDS, orgRoles: Object.fromEntries(Object.entries(ORG_ROLES).map(([k, v]) => [k, v.label])), rolesByOrg: ROLES_BY_ORG,
})));

export default r;
