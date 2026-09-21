import crypto from 'node:crypto';
import { all, one, run, tx } from '../db/database.js';
import { loadPassportKeys } from '../config.js';
import { canonical } from '../lib/canonical.js';
import { newId } from '../lib/ids.js';
import { json } from '../lib/http.js';

const GENESIS = '0'.repeat(64);
const keys = loadPassportKeys();

/** Public verification key: anyone (a buyer, a bank, an insurer) can check a passport without trusting our server. */
export const passportPublicKey = () => ({ keyId: keys.keyId, algorithm: 'ed25519', publicKeyPem: keys.publicPem });

/**
 * Who may seal which event. The v1 API let any signed-in user append any event
 * type to any vehicle, including a police clearance. Blocks are now only
 * created by the workflow that owns them.
 */
export const EVENT_AUTHORITY = {
  GENESIS: 'system',
  OWNERSHIP_TRANSFER: 'system',
  ROUTINE_SERVICE: 'garage',
  MAJOR_REPAIR: 'garage',
  OBD_DIAGNOSTIC: 'garage',
  ROADWORTHINESS_TEST: 'garage',
  POLICE_CLEARANCE: 'police',
  STOLEN_REPORT: 'system',
  STOLEN_RECOVERED: 'system',
  CITATION_RESOLVED: 'system',
  OWNER_NOTE: 'owner',
};

function blockHash(b) {
  // Everything that gives the block meaning is inside the hash.
  return crypto.createHash('sha256').update(canonical({
    v: 2, vehicle_id: b.vehicle_id, block_index: b.block_index, event_type: b.event_type, timestamp: b.timestamp,
    mileage: b.mileage, actor_id: b.actor_id, actor_role: b.actor_role, org_id: b.org_id ?? null,
    description: b.description, payload: b.payload, prev_hash: b.prev_hash,
  })).digest('hex');
}

const sign = (hash) => crypto.sign(null, Buffer.from(hash, 'hex'), keys.privateKey).toString('base64');
const verifySig = (hash, sig) => {
  try { return crypto.verify(null, Buffer.from(hash, 'hex'), keys.publicKey, Buffer.from(sig, 'base64')); } catch { return false; }
};

export const getBlocks = (vehicleId) =>
  all('SELECT * FROM passport_blocks WHERE vehicle_id = ? ORDER BY block_index ASC', [vehicleId]).map((b) => ({ ...b, payload: json(b.payload, {}) }));

/**
 * @param {object} p
 * @param {'system'|'garage'|'police'|'owner'} p.authority  what kind of caller is sealing this
 */
/** `timestamp` exists only so demo data and future record imports can backdate. No route accepts it from a client. */
export function appendBlock({ vehicleId, eventType, mileage, actor, description, payload = {}, authority, timestamp = new Date().toISOString() }) {
  const need = EVENT_AUTHORITY[eventType];
  if (!need) throw new Error(`Unknown passport event type: ${eventType}`);
  if (need !== authority) throw new Error(`Passport event ${eventType} requires ${need} authority, got ${authority}`);
  return tx(() => {
    const last = one('SELECT block_index, hash, mileage FROM passport_blocks WHERE vehicle_id = ? ORDER BY block_index DESC LIMIT 1', [vehicleId]);
    if (last && mileage < last.mileage) throw new Error(`Odometer rollback: ${mileage} is below the sealed ${last.mileage}`);
    const block = {
      id: newId('blk'), vehicle_id: vehicleId, block_index: last ? last.block_index + 1 : 0, event_type: eventType,
      timestamp, mileage, actor_id: actor.id ?? null, actor_role: actor.role, actor_name: actor.name,
      org_id: actor.orgId ?? null, description, payload, prev_hash: last ? last.hash : GENESIS,
    };
    block.hash = blockHash(block);
    block.signature = sign(block.hash);
    block.key_id = keys.keyId;
    run(
      `INSERT INTO passport_blocks (id, vehicle_id, block_index, event_type, timestamp, mileage, actor_id, actor_role, actor_name, org_id, description, payload, prev_hash, hash, signature, key_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [block.id, block.vehicle_id, block.block_index, block.event_type, block.timestamp, block.mileage, block.actor_id, block.actor_role, block.actor_name, block.org_id, block.description, JSON.stringify(payload), block.prev_hash, block.hash, block.signature, block.key_id],
    );
    return block;
  });
}

/** Re-derive every hash and signature. Detects edits, reordering, forged writers and odometer rollback. */
export function verifyChain(vehicleId) {
  const blocks = getBlocks(vehicleId);
  if (!blocks.length) return { valid: false, blocks: 0, reason: 'No passport exists for this vehicle' };
  let prev = GENESIS;
  let prevMileage = 0;
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    const fail = (reason) => ({ valid: false, blocks: blocks.length, brokenAt: i, reason });
    if (b.block_index !== i) return fail(`Sequence broken at block ${i}`);
    if (b.prev_hash !== prev) return fail(`Block ${i} is not linked to the block before it`);
    if (blockHash(b) !== b.hash) return fail(`Block ${i} was changed after it was sealed`);
    if (b.key_id !== keys.keyId) return fail(`Block ${i} was signed with an unknown key`);
    if (!verifySig(b.hash, b.signature)) return fail(`Block ${i} has an invalid signature`);
    if (b.mileage < prevMileage) return fail(`Odometer rollback at block ${i}: ${b.mileage} after ${prevMileage}`);
    prev = b.hash; prevMileage = b.mileage;
  }
  const last = blocks[blocks.length - 1];
  return { valid: true, blocks: blocks.length, head: last.hash, latestMileage: last.mileage, sealedSince: blocks[0].timestamp, lastEvent: last.timestamp, keyId: keys.keyId };
}
