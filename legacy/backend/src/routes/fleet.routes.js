import express from 'express';
import crypto from 'node:crypto';
import { query, queryOne, run } from '../db/database.js';
import { authenticateToken } from '../middleware/auth.js';
import { broadcastToClients } from '../server.js';
import { Elm327ProtocolHandler } from '../services/obd.service.js';

const router = express.Router();

/**
 * Get latest live telemetry snapshot for all fleet vehicles
 */
router.get('/telemetry', (req, res) => {
  const telemetry = query(`
    SELECT DISTINCT v.id as vehicle_id, v.vin, v.plate_number, v.make, v.model, v.status, v.stolen_flag,
           COALESCE(t.speed_kph, 42.0) as speed_kph,
           COALESCE(t.engine_rpm, 1820.0) as engine_rpm,
           COALESCE(t.coolant_temp_c, 89.0) as coolant_temp_c,
           COALESCE(t.fuel_level_pct, v.fuel_level) as fuel_level_pct,
           COALESCE(t.latitude, v.last_latitude) as latitude,
           COALESCE(t.longitude, v.last_longitude) as longitude,
           COALESCE(t.heading, 90.0) as heading,
           COALESCE(t.timestamp, v.created_at) as timestamp,
           u.name as driver_or_owner_name
    FROM vehicles v
    LEFT JOIN (
      SELECT ft.* FROM fleet_telemetry ft
      INNER JOIN (
        SELECT vehicle_id, MAX(timestamp) as max_time 
        FROM fleet_telemetry 
        GROUP BY vehicle_id
      ) latest ON ft.vehicle_id = latest.vehicle_id AND ft.timestamp = latest.max_time
    ) t ON v.id = t.vehicle_id
    LEFT JOIN users u ON v.owner_id = u.id
    ORDER BY v.plate_number ASC
  `);

  res.json({ fleet: telemetry });
});

/**
 * Post live telemetry packet (received from Mobile OBD-II BLE driver or GPS)
 */
router.post('/telemetry', (req, res) => {
  const { vehicle_id, speed_kph, engine_rpm, coolant_temp_c, fuel_level_pct, latitude, longitude, heading = 0 } = req.body;

  if (!vehicle_id) {
    return res.status(400).json({ error: 'vehicle_id is required' });
  }

  const id = crypto.randomUUID();
  const timestamp = new Date().toISOString();

  run(
    `INSERT INTO fleet_telemetry 
      (id, vehicle_id, speed_kph, engine_rpm, coolant_temp_c, fuel_level_pct, latitude, longitude, heading, timestamp)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, vehicle_id, speed_kph || 0, engine_rpm || 0, coolant_temp_c || 90, fuel_level_pct || 80, latitude || 13.4549, longitude || -16.5790, heading, timestamp]
  );

  // Update vehicle position cache
  run(
    `UPDATE vehicles 
     SET last_latitude = COALESCE(?, last_latitude),
         last_longitude = COALESCE(?, last_longitude),
         fuel_level = COALESCE(?, fuel_level)
     WHERE id = ?`,
    [latitude, longitude, fuel_level_pct, vehicle_id]
  );

  // Broadcast live telemetry update over WebSocket to Civic Command Center & Map monitors
  broadcastToClients({
    type: 'TELEMETRY_UPDATE',
    vehicleId: vehicle_id,
    speed_kph,
    engine_rpm,
    coolant_temp_c,
    fuel_level_pct,
    latitude,
    longitude,
    heading,
    timestamp
  });

  res.status(201).json({ status: 'ACK', packetId: id });
});

/**
 * Simulate live telemetry ticks for demonstration
 */
router.post('/simulate-tick', (req, res) => {
  const vehicles = query("SELECT * FROM vehicles WHERE status = 'active' LIMIT 5");
  const simulated = [];

  for (const v of vehicles) {
    const frame = Elm327ProtocolHandler.generateSimulatedFrame({
      prevSpeed: 45,
      prevRpm: 1800,
      prevFuel: v.fuel_level || 80
    });

    // small geographic jitter around Banjul/Serrekunda
    const lat = (v.last_latitude || 13.45) + (Math.random() - 0.5) * 0.003;
    const lon = (v.last_longitude || -16.58) + (Math.random() - 0.5) * 0.003;

    run(
      `INSERT INTO fleet_telemetry (id, vehicle_id, speed_kph, engine_rpm, coolant_temp_c, fuel_level_pct, latitude, longitude, heading)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [crypto.randomUUID(), v.id, frame.speed_kph, frame.engine_rpm, frame.coolant_temp_c, frame.fuel_level_pct, lat, lon, Math.floor(Math.random() * 360)]
    );

    run(
      `UPDATE vehicles SET last_latitude = ?, last_longitude = ?, fuel_level = ? WHERE id = ?`,
      [lat, lon, frame.fuel_level_pct, v.id]
    );

    simulated.push({
      vehicleId: v.id,
      plateNumber: v.plate_number,
      ...frame,
      latitude: lat,
      longitude: lon
    });
  }

  broadcastToClients({
    type: 'FLEET_BATCH_UPDATE',
    vehicles: simulated
  });

  res.json({ simulatedCount: simulated.length, vehicles: simulated });
});

export default router;
