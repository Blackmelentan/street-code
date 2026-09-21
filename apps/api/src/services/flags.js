import { all, one, run, tx } from '../db/database.js';
import { FLAG_KINDS, FLAG_INSTRUCTIONS } from '../../../../packages/core/src/index.js';
import { newId } from '../lib/ids.js';
import { HttpError, forbidden, notFound, bad } from '../lib/http.js';
import { isPolice, isSupervisor, isAdmin } from '../middleware/auth.js';
import { audit } from './audit.js';
import { sendToPolice } from './hub.js';
import { notify } from './notify.js';
import { appendBlock } from './passport.js';
import { vehicleStewards } from './access.js';

const DAY = 86400000;
const ownerOfVehicle = (v, user) => v.owner_user_id === user.id || vehicleStewards(v).includes(user.id);

export const getFlag = (id) => one('SELECT * FROM flags WHERE id = ?', [id]);

/** What an officer sees: the summary and instruction, not the restricted detail. */
export function flagForOfficer(f, user) {
  const canSeeDetail = f.created_by === user.id || isSupervisor(user) || isAdmin(user);
  const { detail, ...rest } = f;
  return canSeeDetail ? f : rest;
}

const stolenBlock = (v, type, actor, description) => {
  try {
    appendBlock({ vehicleId: v.id, eventType: type, mileage: v.odometer, authority: 'system', actor: { id: actor.id, role: 'system', name: 'Street Code' }, description, payload: { flag: true } });
  } catch { /* passport may not exist for very new vehicles; the flag itself is the source of truth */ }
};

/**
 * Create a flag.
 *  - Owners can only report their own vehicle stolen. It starts as "reported" until an officer confirms it.
 *  - Officers create vehicle flags directly (active). Person flags and amber alerts need a second
 *    person, a supervisor, to approve them: nobody can put a person on a list alone.
 */
export function createFlag({ user, subjectType, subjectId, kind, summary, detail = null, instruction, caseRef = null, expiresAt = null, ownerReport = false, ip }) {
  const def = FLAG_KINDS[kind];
  if (!def) throw bad('Unknown flag type.');
  if (def.subject !== subjectType) throw bad(`A "${def.label}" flag applies to a ${def.subject}.`);
  if (!summary || summary.length < 5) throw bad('Give a short summary an officer can act on.');
  if (instruction && !FLAG_INSTRUCTIONS[instruction]) throw bad('Unknown instruction.');

  return tx(() => {
    let vehicle = null;
    if (subjectType === 'vehicle') {
      vehicle = one('SELECT * FROM vehicles WHERE id = ?', [subjectId]);
      if (!vehicle) throw notFound('Vehicle not found.');
    } else if (!one('SELECT id FROM users WHERE id = ?', [subjectId])) throw notFound('Person not found.');

    if (ownerReport) {
      if (kind !== 'stolen') throw forbidden('Owners can only report a vehicle stolen.');
      if (!vehicle || !ownerOfVehicle(vehicle, user)) throw forbidden('You can only report your own vehicle.');
    } else if (!isPolice(user)) throw forbidden('Police officers only.');

    const dup = all(`SELECT id FROM flags WHERE subject_type = ? AND subject_id = ? AND kind = ? AND status IN ('reported','active')`, [subjectType, subjectId, kind]);
    if (dup.length) throw new HttpError(409, 'There is already an open flag of this type on this subject.');

    if (kind === 'stolen' && !ownerReport && !caseRef) throw bad('A case reference is required to mark a vehicle stolen.');
    if (subjectType === 'person') {
      if (!detail || detail.length < 10) throw bad('Person flags need a recorded reason.');
      if (kind === 'person_of_interest') {
        const max = Date.now() + 90 * DAY;
        const wanted = expiresAt ? Date.parse(expiresAt) : Date.now() + 30 * DAY;
        if (!(wanted > Date.now())) throw bad('Expiry must be in the future.');
        expiresAt = new Date(Math.min(wanted, max)).toISOString(); // persons of interest lapse unless renewed
      }
    }

    const status = ownerReport || def.needsApproval ? 'reported' : 'active';
    const id = newId('flg');
    run(
      `INSERT INTO flags (id, subject_type, subject_id, kind, level, status, summary, detail, instruction, case_ref, created_by, reported_by_owner, expires_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, subjectType, subjectId, kind, def.defaultLevel, status, summary, detail, instruction || (ownerReport ? 'verify_owner' : 'call_dispatch'), caseRef, user.id, ownerReport ? 1 : 0, expiresAt],
    );
    audit({ actor: { id: user.id, label: user.name }, action: `flag.create`, targetType: subjectType, targetId: subjectId, details: { flag: id, kind, status, ownerReport }, ip });
    const flag = getFlag(id);
    if (vehicle && kind === 'stolen' && status === 'active') stolenBlock(vehicle, 'STOLEN_REPORT', user, `Reported stolen. Case ${caseRef}.`);
    sendToPolice({ type: 'FLAG', event: status === 'active' ? 'activated' : 'pending', flag: publicFlag(flag) });
    return flag;
  });
}

/** Approve: owner reports by any officer; person flags and amber alerts by a supervisor who did not create them. */
export function approveFlag({ user, id, ip }) {
  if (!isPolice(user)) throw forbidden('Police officers only.');
  return tx(() => {
    const f = getFlag(id);
    if (!f) throw notFound('Flag not found.');
    if (f.status !== 'reported') throw new HttpError(409, 'This flag is not waiting for approval.');
    if (!f.reported_by_owner) {
      if (!isSupervisor(user)) throw forbidden('A supervisor must approve this.');
      if (f.created_by === user.id) throw forbidden('Someone else must approve a flag you created.');
    }
    run(`UPDATE flags SET status = 'active', approved_by = ?, approved_at = ? WHERE id = ?`, [user.id, new Date().toISOString(), id]);
    audit({ actor: { id: user.id, label: user.name }, action: 'flag.approve', targetType: f.subject_type, targetId: f.subject_id, details: { flag: id }, ip });
    const flag = getFlag(id);
    if (f.subject_type === 'vehicle' && f.kind === 'stolen') {
      const v = one('SELECT * FROM vehicles WHERE id = ?', [f.subject_id]);
      stolenBlock(v, 'STOLEN_REPORT', user, 'Stolen report confirmed by police.');
      for (const uid of vehicleStewards(v)) notify({ userId: uid, kind: 'flag', severity: 'urgent', title: `${v.plate} is now on the police stolen list`, body: 'An officer confirmed your report. Every checkpoint will see it.', vehicleId: v.id, dedupeKey: `flag:${id}:active` });
    }
    sendToPolice({ type: 'FLAG', event: 'activated', flag: publicFlag(flag) });
    return flag;
  });
}

export function rejectFlag({ user, id, reason, ip }) {
  if (!isPolice(user)) throw forbidden('Police officers only.');
  const f = getFlag(id);
  if (!f) throw notFound('Flag not found.');
  if (f.status !== 'reported') throw new HttpError(409, 'This flag is not waiting for approval.');
  if (!f.reported_by_owner && !isSupervisor(user)) throw forbidden('A supervisor must decide this.');
  run(`UPDATE flags SET status = 'rejected', cleared_by = ?, cleared_at = ?, clear_reason = ? WHERE id = ?`, [user.id, new Date().toISOString(), reason || 'Rejected', id]);
  audit({ actor: { id: user.id, label: user.name }, action: 'flag.reject', targetType: f.subject_type, targetId: f.subject_id, details: { flag: id, reason }, ip });
  return getFlag(id);
}

/** Clear a flag. Owners may withdraw their own report only while it is unconfirmed. */
export function clearFlag({ user, id, reason, ip }) {
  return tx(() => {
    const f = getFlag(id);
    if (!f) throw notFound('Flag not found.');
    if (!['reported', 'active'].includes(f.status)) throw new HttpError(409, 'This flag is already closed.');
    let allowed = false;
    if (isPolice(user)) allowed = f.created_by === user.id || isSupervisor(user) || f.reported_by_owner === 1;
    else if (f.reported_by_owner && f.status === 'reported' && f.created_by === user.id) allowed = true;
    if (!allowed) throw forbidden('You cannot clear this flag.');
    if (!reason || reason.length < 3) throw bad('Say why it is being cleared.');
    run(`UPDATE flags SET status = 'cleared', cleared_by = ?, cleared_at = ?, clear_reason = ? WHERE id = ?`, [user.id, new Date().toISOString(), reason, id]);
    audit({ actor: { id: user.id, label: user.name }, action: 'flag.clear', targetType: f.subject_type, targetId: f.subject_id, details: { flag: id, reason }, ip });
    if (f.subject_type === 'vehicle' && f.kind === 'stolen' && f.status === 'active') {
      const v = one('SELECT * FROM vehicles WHERE id = ?', [f.subject_id]);
      stolenBlock(v, 'STOLEN_RECOVERED', user, `Recovered. ${reason}`);
      for (const uid of vehicleStewards(v)) notify({ userId: uid, kind: 'flag', severity: 'info', title: `${v.plate} is off the stolen list`, body: reason, vehicleId: v.id, dedupeKey: `flag:${id}:cleared` });
    }
    sendToPolice({ type: 'FLAG', event: 'cleared', flag: publicFlag(getFlag(id)) });
    return getFlag(id);
  });
}

/** A flagged subject was seen. Silent: nothing is shown to the person being checked. */
export function recordSighting({ flag, vehicle = null, officerId = null, source, lat = null, lng = null, label = null }) {
  run(`INSERT INTO sightings (id, flag_id, vehicle_id, officer_id, source, lat, lng, label) VALUES (?,?,?,?,?,?,?,?)`, [newId('sig'), flag.id, vehicle?.id ?? null, officerId, source, lat, lng, label]);
  if (label) run('UPDATE flags SET last_seen_label = ? WHERE id = ?', [label, flag.id]);
  sendToPolice({ type: 'SIGHTING', flagId: flag.id, kind: flag.kind, level: flag.level, plate: vehicle?.plate ?? null, label, at: new Date().toISOString() });
  if (vehicle && flag.kind === 'stolen') {
    for (const uid of vehicleStewards(vehicle)) {
      notify({ userId: uid, kind: 'sighting', severity: 'urgent', title: `${vehicle.plate} was seen`, body: label ? `Near ${label}. Police have been alerted.` : 'Police have been alerted.', vehicleId: vehicle.id, dedupeKey: `sig:${flag.id}:${Math.floor(Date.now() / 600000)}` });
    }
  }
}

export const publicFlag = (f) => ({ id: f.id, subject_type: f.subject_type, subject_id: f.subject_id, kind: f.kind, level: f.level, status: f.status, summary: f.summary, instruction: f.instruction, case_ref: f.case_ref, expires_at: f.expires_at, created_at: f.created_at, last_seen_label: f.last_seen_label, reported_by_owner: !!f.reported_by_owner });
