import { Router } from 'express';
import { all, one, run } from '../db/database.js';
import { authenticate } from '../middleware/auth.js';
import { config } from '../config.js';
import { h, str, num, forbidden, notFound } from '../lib/http.js';
import { newId } from '../lib/ids.js';
import { requireVehicle, accessTo } from '../services/access.js';

const r = Router();

// Telemetry is private to the vehicle's owner and current driver. It is never broadcast.
r.post('/telemetry', authenticate, h((req, res) => {
  const v = requireVehicle(str(req.body.vehicle_id, 'Vehicle'));
  const a = accessTo(req.user, v);
  if (!['manage', 'drive'].includes(a.level)) throw forbidden();
  run(`INSERT INTO telemetry (id, vehicle_id, source, speed_kph, rpm, coolant_c, fuel_pct, lat, lng, heading) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [newId('tel'), v.id, req.body.source === 'obd' ? 'obd' : 'phone', num(req.body.speed_kph ?? null, 'Speed', { optional: true, min: 0, max: 400 }), num(req.body.rpm ?? null, 'RPM', { optional: true, min: 0, max: 20000 }), num(req.body.coolant_c ?? null, 'Coolant', { optional: true, min: -40, max: 200 }),
      num(req.body.fuel_pct ?? null, 'Fuel', { optional: true, min: 0, max: 100 }), num(req.body.lat ?? null, 'Latitude', { optional: true, min: -90, max: 90 }), num(req.body.lng ?? null, 'Longitude', { optional: true, min: -180, max: 180 }), num(req.body.heading ?? null, 'Heading', { optional: true, min: 0, max: 360 })]);
  res.status(201).json({ ok: true });
}));

r.get('/vehicles/:id/telemetry', authenticate, h((req, res) => {
  const v = requireVehicle(req.params.id);
  if (accessTo(req.user, v).level !== 'manage') throw forbidden();
  res.json({ points: all('SELECT * FROM telemetry WHERE vehicle_id = ? ORDER BY ts DESC LIMIT 100', [v.id]) });
}));

r.get('/parts', authenticate, h((req, res) => {
  const q = `%${String(req.query.q || '').replace(/[%_]/g, '')}%`;
  res.json({ parts: all('SELECT * FROM parts WHERE name LIKE ? OR fits LIKE ? OR part_number LIKE ? ORDER BY name LIMIT 60', [q, q, q]).map((p) => ({ ...p, price_gmd: p.price_minor / 100 })) });
}));

// Demo sign-ins for local development only. Not mounted when NODE_ENV=production.
if (config.devFeatures) {
  r.get('/dev/accounts', h((req, res) => {
    res.json({ password: 'streetcode', accounts: [
      { phone: '+2207000001', label: 'Owner (Fatou)' }, { phone: '+2207000002', label: 'Friend with a lent car (Lamin)' }, { phone: '+2207000003', label: 'Garage owner (Ebrima)' },
      { phone: '+2207000004', label: 'Mechanic (Modou)' }, { phone: '+2207000005', label: 'Police officer (Ousman)' }, { phone: '+2207000006', label: 'Police supervisor (Isatou)' }, { phone: '+2207000007', label: 'Administrator' },
    ] });
  }));
}

export default r;
