import crypto from 'node:crypto';
import { config } from '../config.js';
import { one } from '../db/database.js';

/**
 * A driver's licence "live code": licence number + a 8-character code that changes every 60 seconds.
 * A screenshot or a photo of an old code is useless, but the officer does not need the phone unlocked
 * or a network on the driver's side: the code is computed from the licence number and a server key.
 */
const WINDOW = 60_000;
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L

const codeFor = (licenceNumber, window) => {
  const mac = crypto.createHmac('sha256', config.licenceCodeKey).update(`${licenceNumber}:${window}`).digest();
  let out = '';
  for (let i = 0; i < 8; i++) out += ALPHABET[mac[i] % ALPHABET.length];
  return `${out.slice(0, 4)}-${out.slice(4)}`;
};

export function issueLicenceCode(licence, now = Date.now()) {
  const w = Math.floor(now / WINDOW);
  return { code: `${licence.licence_number}.${codeFor(licence.licence_number, w)}`, expiresAt: new Date((w + 1) * WINDOW).toISOString(), validForSeconds: Math.ceil(((w + 1) * WINDOW - now) / 1000) };
}

/** Accepts the current and the previous window (clock drift, or the driver reading it out). */
export function resolveLicenceCode(raw, now = Date.now()) {
  const text = String(raw || '').trim().toUpperCase().replace(/\s+/g, '');
  const i = text.lastIndexOf('.');
  if (i < 1) return null;
  const number = text.slice(0, i);
  const given = text.slice(i + 1);
  const licence = one('SELECT l.*, u.name AS holder_name FROM licences l JOIN users u ON u.id = l.user_id WHERE l.licence_number = ?', [number]);
  if (!licence) return null;
  const w = Math.floor(now / WINDOW);
  const ok = [w, w - 1].some((win) => {
    const a = Buffer.from(codeFor(number, win)); const b = Buffer.from(given);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  });
  return ok ? licence : null;
}
