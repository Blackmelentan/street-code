import crypto from 'node:crypto';
import { query, queryOne, run } from '../db/database.js';

const SYSTEM_HMAC_SECRET = process.env.JWT_SECRET || 'streetcode_secret_hash_key_2026';
const GENESIS_PREV_HASH = '0000000000000000000000000000000000000000000000000000000000000000';

/**
 * Compute canonical SHA-256 hash for a passport block
 */
export function computeBlockHash({ vehicleId, blockIndex, timestamp, mileage, actorId, prevHash, dataPayload }) {
  // Sort keys for canonical JSON representation
  const payloadString = typeof dataPayload === 'string' ? dataPayload : JSON.stringify(dataPayload);
  const payloadCanonical = JSON.stringify(JSON.parse(payloadString), Object.keys(JSON.parse(payloadString)).sort());
  
  const rawString = `${vehicleId}:${blockIndex}:${timestamp}:${mileage}:${actorId}:${prevHash}:${payloadCanonical}`;
  return crypto.createHash('sha256').update(rawString).digest('hex');
}

/**
 * Sign hash with system HMAC (or cryptographic key)
 */
export function signHash(hash) {
  return crypto.createHmac('sha256', SYSTEM_HMAC_SECRET).update(hash).digest('hex');
}

/**
 * Get all passport blocks for a vehicle ordered by block_index
 */
export function getPassportBlocks(vehicleId) {
  return query('SELECT * FROM passport_blocks WHERE vehicle_id = ? ORDER BY block_index ASC', [vehicleId]);
}

/**
 * Append a new block to a vehicle's cryptographic passport
 */
export function appendPassportBlock({ vehicleId, eventType, mileage, actorId, actorRole, actorName, description, dataPayload = {} }) {
  // 1. Get latest block to retrieve index and prev_hash
  const latestBlock = queryOne(
    'SELECT * FROM passport_blocks WHERE vehicle_id = ? ORDER BY block_index DESC LIMIT 1',
    [vehicleId]
  );

  const blockIndex = latestBlock ? latestBlock.block_index + 1 : 0;
  const prevHash = latestBlock ? latestBlock.current_hash : GENESIS_PREV_HASH;
  const timestamp = new Date().toISOString();
  
  const stringPayload = typeof dataPayload === 'string' ? dataPayload : JSON.stringify(dataPayload);

  // 2. Compute current hash
  const currentHash = computeBlockHash({
    vehicleId,
    blockIndex,
    timestamp,
    mileage,
    actorId,
    prevHash,
    dataPayload: stringPayload
  });

  const signature = signHash(currentHash);
  const id = crypto.randomUUID();

  // 3. Insert block into database
  run(
    `INSERT INTO passport_blocks 
      (id, vehicle_id, block_index, event_type, timestamp, mileage, actor_id, actor_role, actor_name, description, data_payload, prev_hash, current_hash, signature)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, vehicleId, blockIndex, eventType, timestamp, mileage, actorId, actorRole, actorName, description, stringPayload, prevHash, currentHash, signature]
  );

  // 4. Update vehicle's current mileage if greater
  run(
    `UPDATE vehicles SET current_mileage = MAX(current_mileage, ?) WHERE id = ?`,
    [mileage, vehicleId]
  );

  return {
    id,
    vehicle_id: vehicleId,
    block_index: blockIndex,
    event_type: eventType,
    timestamp,
    mileage,
    actor_id: actorId,
    actor_role: actorRole,
    actor_name: actorName,
    description,
    data_payload: JSON.parse(stringPayload),
    prev_hash: prevHash,
    current_hash: currentHash,
    signature
  };
}

/**
 * Mathematically verify the entire integrity of a vehicle's passport chain
 * Detects odometer rollback, block tampering, or broken chain links
 */
export function verifyPassportChain(vehicleId) {
  const blocks = getPassportBlocks(vehicleId);

  if (!blocks || blocks.length === 0) {
    return {
      isValid: false,
      blocksCount: 0,
      reason: 'No passport blocks registered for vehicle',
      tamperedBlockIndex: null
    };
  }

  let expectedPrevHash = GENESIS_PREV_HASH;
  let previousMileage = 0;

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];

    // Check 1: Block index sequence
    if (block.block_index !== i) {
      return {
        isValid: false,
        blocksCount: blocks.length,
        tamperedBlockIndex: i,
        reason: `Broken sequence: expected index ${i}, found ${block.block_index}`
      };
    }

    // Check 2: Prev Hash linkage
    if (block.prev_hash !== expectedPrevHash) {
      return {
        isValid: false,
        blocksCount: blocks.length,
        tamperedBlockIndex: i,
        reason: `Hash mismatch at block ${i}: expected prev_hash ${expectedPrevHash}, found ${block.prev_hash}`
      };
    }

    // Check 3: Current Hash verification
    const recalculatedHash = computeBlockHash({
      vehicleId: block.vehicle_id,
      blockIndex: block.block_index,
      timestamp: block.timestamp,
      mileage: block.mileage,
      actorId: block.actor_id,
      prevHash: block.prev_hash,
      dataPayload: block.data_payload
    });

    if (recalculatedHash !== block.current_hash) {
      return {
        isValid: false,
        blocksCount: blocks.length,
        tamperedBlockIndex: i,
        reason: `Tampered payload or header at block ${i}: recalculated hash ${recalculatedHash} does not match recorded ${block.current_hash}`
      };
    }

    // Check 4: Signature check
    const validSignature = signHash(block.current_hash);
    if (validSignature !== block.signature) {
      return {
        isValid: false,
        blocksCount: blocks.length,
        tamperedBlockIndex: i,
        reason: `Invalid cryptographic signature at block ${i}`
      };
    }

    // Check 5: Mileage monotonicity (Anti-Odometer Rollback check)
    if (block.mileage < previousMileage) {
      return {
        isValid: false,
        blocksCount: blocks.length,
        tamperedBlockIndex: i,
        reason: `Odometer rollback detected at block ${i}: mileage ${block.mileage} is less than prior reading ${previousMileage}`
      };
    }

    previousMileage = block.mileage;
    expectedPrevHash = block.current_hash;
  }

  return {
    isValid: true,
    blocksCount: blocks.length,
    latestHash: blocks[blocks.length - 1].current_hash,
    latestMileage: blocks[blocks.length - 1].mileage,
    genesisTimestamp: blocks[0].timestamp,
    latestUpdateTimestamp: blocks[blocks.length - 1].timestamp
  };
}
