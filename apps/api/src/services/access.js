import { all, one } from '../db/database.js';
import { forbidden, notFound } from '../lib/http.js';
import { isAdmin, isPolice, membershipIn } from '../middleware/auth.js';

export const getVehicle = (id) => one('SELECT * FROM vehicles WHERE id = ?', [id]);

export function requireVehicle(id) {
  const v = getVehicle(id);
  if (!v) throw notFound('Vehicle not found.');
  return v;
}

/** The authorization that lets this person drive this vehicle right now, if any. */
export function activeAuthorization(userId, vehicleId, now = new Date()) {
  const iso = now.toISOString();
  return one(
    `SELECT * FROM authorizations
      WHERE vehicle_id = ? AND driver_user_id = ? AND status = 'active' AND starts_at <= ? AND (ends_at IS NULL OR ends_at > ?)
      ORDER BY starts_at DESC LIMIT 1`,
    [vehicleId, userId, iso, iso],
  );
}

/** Can this person run the vehicle's records (owner, or manager of the fleet that owns it)? */
export function canManage(user, v) {
  if (!user) return false;
  if (v.owner_user_id === user.id) return true;
  if (v.owner_org_id) {
    const m = membershipIn(user, v.owner_org_id);
    return !!m && ['owner', 'manager'].includes(m.role);
  }
  return false;
}

export const isFleetDriver = (user, v) => !!(v.owner_org_id && membershipIn(user, v.owner_org_id)?.role === 'driver');

/** A garage may work on a vehicle only while an owner-approved job is open. */
export function garageJobFor(user, v) {
  const orgIds = user.memberships.filter((m) => m.org_type === 'garage' && ['owner', 'manager', 'mechanic', 'attendant'].includes(m.role)).map((m) => m.org_id);
  if (!orgIds.length) return null;
  return one(
    `SELECT * FROM jobs WHERE vehicle_id = ? AND owner_consent = 1 AND status IN ('accepted','in_progress','ready') AND org_id IN (${orgIds.map(() => '?').join(',')}) ORDER BY created_at DESC LIMIT 1`,
    [v.id, ...orgIds],
  );
}

/**
 * What can this person see and do with this vehicle?
 * Returns { level, ... } where level is 'manage' | 'drive' | 'garage' | null.
 */
export function accessTo(user, v) {
  if (canManage(user, v)) return { level: 'manage' };
  if (activeAuthorization(user.id, v.id) || isFleetDriver(user, v)) return { level: 'drive' };
  const job = garageJobFor(user, v);
  if (job) return { level: 'garage', job };
  if (isAdmin(user)) return { level: 'admin' };
  return { level: null };
}

export function requireAccess(user, v, ...levels) {
  const a = accessTo(user, v);
  if (!levels.includes(a.level)) throw forbidden('You do not have access to this vehicle.');
  return a;
}

/** Everyone who should hear about a vehicle: the owner, or the owners and managers of the fleet. */
export function vehicleStewards(v) {
  const ids = new Set();
  if (v.owner_user_id) ids.add(v.owner_user_id);
  if (v.owner_org_id) {
    for (const m of all(`SELECT user_id FROM memberships WHERE org_id = ? AND status = 'active' AND role IN ('owner','manager')`, [v.owner_org_id])) ids.add(m.user_id);
  }
  return [...ids];
}

export const vehiclesVisibleTo = (user) => {
  const orgIds = user.memberships.filter((m) => m.org_type === 'fleet').map((m) => m.org_id);
  const nowIso = new Date().toISOString();
  return all(
    `SELECT DISTINCT v.* FROM vehicles v
      WHERE v.owner_user_id = ?
         ${orgIds.length ? `OR v.owner_org_id IN (${orgIds.map(() => '?').join(',')})` : ''}
         OR v.id IN (SELECT vehicle_id FROM authorizations WHERE driver_user_id = ? AND status = 'active' AND starts_at <= ? AND (ends_at IS NULL OR ends_at > ?))
      ORDER BY v.created_at DESC`,
    [user.id, ...orgIds, user.id, nowIso, nowIso],
  );
};

export { isPolice };
