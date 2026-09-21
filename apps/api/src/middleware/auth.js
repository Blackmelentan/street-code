import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { all, one } from '../db/database.js';
import { ORG_ROLES } from '../../../../packages/core/src/index.js';
import { unauthorized, forbidden } from '../lib/http.js';

export const signToken = (user) => jwt.sign({ id: user.id }, config.jwtSecret, { expiresIn: '12h' });

/** Load a user with their active memberships. Called on every request, so suspensions take effect at once. */
export function loadUser(id) {
  const u = one(`SELECT id, name, phone, email, platform_role, status, created_at FROM users WHERE id = ?`, [id]);
  if (!u || u.status !== 'active') return null;
  u.memberships = all(
    `SELECT m.id, m.org_id, m.role, m.employment, m.badge_number, m.status, o.type AS org_type, o.name AS org_name, o.status AS org_status
       FROM memberships m JOIN orgs o ON o.id = m.org_id
      WHERE m.user_id = ? AND m.status = 'active' AND o.status != 'suspended'`,
    [id],
  );
  return u;
}

export function authenticate(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return next(unauthorized());
  try {
    const { id } = jwt.verify(token, config.jwtSecret);
    const user = loadUser(id);
    if (!user) return next(unauthorized('This account is no longer active.'));
    req.user = user;
    next();
  } catch {
    next(unauthorized('Your session has expired. Sign in again.'));
  }
}

/* ---- capability checks: what a person can do comes from memberships, never from a self-declared role ---- */

export const isAdmin = (u) => u?.platform_role === 'admin';

/** Active officer, supervisor or commander of a verified police station. */
export const isPolice = (u) => !!u?.memberships?.some((m) => m.org_type === 'station' && m.org_status === 'verified');
export const isSupervisor = (u) => !!u?.memberships?.some((m) => m.org_type === 'station' && m.org_status === 'verified' && ['supervisor', 'owner'].includes(m.role));
export const stationOf = (u) => u?.memberships?.find((m) => m.org_type === 'station' && m.org_status === 'verified') || null;

export const membershipIn = (u, orgId) => u?.memberships?.find((m) => m.org_id === orgId) || null;
export const rankIn = (u, orgId) => ORG_ROLES[membershipIn(u, orgId)?.role]?.rank ?? 0;
export const isOrgManager = (u, orgId) => rankIn(u, orgId) >= ORG_ROLES.manager.rank || (isSupervisor(u) && membershipIn(u, orgId));
export const garageStaffIn = (u, orgId) => {
  const m = membershipIn(u, orgId);
  return !!m && m.org_type === 'garage' && ['owner', 'manager', 'mechanic'].includes(m.role);
};

export const requireAdmin = (req, res, next) => (isAdmin(req.user) ? next() : next(forbidden('Administrators only.')));
export const requirePolice = (req, res, next) => (isPolice(req.user) ? next() : next(forbidden('Police officers only.')));
export const requireSupervisor = (req, res, next) => (isSupervisor(req.user) || isAdmin(req.user) ? next() : next(forbidden('Station supervisors only.')));
