import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cors from 'cors';
import { WebSocketServer, WebSocket } from 'ws';
import dotenv from 'dotenv';

import { initSchema, query, run } from './db/database.js';
import authRoutes from './routes/auth.routes.js';
import vehiclesRoutes from './routes/vehicles.routes.js';
import momoRoutes from './routes/momo.routes.js';
import workshopsRoutes from './routes/workshops.routes.js';
import policeRoutes from './routes/police.routes.js';
import citationsRoutes from './routes/citations.routes.js';
import fleetRoutes from './routes/fleet.routes.js';
import auditRoutes from './routes/audit.routes.js';
import { Elm327ProtocolHandler } from './services/obd.service.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '../..');

// Initialize database schema on startup
initSchema();

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3000;

// Enable CORS and JSON parsing
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve Shared Directory
app.use('/shared', express.static(path.join(rootDir, 'shared')));

// Mount API Routes
app.use('/api/auth', authRoutes);
app.use('/api/vehicles', vehiclesRoutes);
app.use('/api/momo', momoRoutes);
app.use('/api/workshops', workshopsRoutes);
app.use('/api/police', policeRoutes);
app.use('/api/citations', citationsRoutes);
app.use('/api/fleet', fleetRoutes);
app.use('/api/audit', auditRoutes);

// Serve Frontend Portals
app.use('/civic', express.static(path.join(rootDir, 'civic')));
app.use('/mobile', express.static(path.join(rootDir, 'mobile')));
app.use('/', express.static(path.join(rootDir, 'web')));

// ==============================================================================
// REAL-TIME WEBSOCKET ENGINE
// Broadcasts: Stolen APB Alerts, Live GPS/OBD Telemetry, MoMo Escrow Changes
// ==============================================================================
const wss = new WebSocketServer({ server });
const connectedClients = new Set();

wss.on('connection', (ws, req) => {
  connectedClients.add(ws);
  console.log(`[WebSocket] New client connected (${connectedClients.size} active)`);

  // Send initial welcome & system status
  ws.send(JSON.stringify({
    type: 'CONNECTION_ESTABLISHED',
    timestamp: new Date().toISOString(),
    message: 'Connected to Street Code Real-Time Automotive Telemetry Stream'
  }));

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message.toString());
      if (data.type === 'PING') {
        ws.send(JSON.stringify({ type: 'PONG', timestamp: Date.now() }));
      }
    } catch (e) {
      // ignore malformed raw messages
    }
  });

  ws.on('close', () => {
    connectedClients.delete(ws);
    console.log(`[WebSocket] Client disconnected (${connectedClients.size} remaining)`);
  });

  ws.on('error', (err) => {
    console.error('[WebSocket] Error:', err.message);
    connectedClients.delete(ws);
  });
});

/**
 * Broadcast payload to all connected clients
 * @param {object} payload 
 */
export function broadcastToClients(payload) {
  const json = JSON.stringify(payload);
  for (const client of connectedClients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(json);
    }
  }
}

// Background Simulated Telemetry Ticker (Runs every 4 seconds to animate fleet map)
let tickCount = 0;
setInterval(() => {
  if (connectedClients.size === 0) return; // Don't churn DB if no client is listening

  try {
    const vehicles = query("SELECT * FROM vehicles WHERE status = 'active' LIMIT 4");
    const updates = [];

    for (const v of vehicles) {
      const frame = Elm327ProtocolHandler.generateSimulatedFrame({
        prevSpeed: 45 + Math.sin(tickCount + v.id.charCodeAt(v.id.length - 1)) * 15,
        prevRpm: 1800,
        prevFuel: v.fuel_level || 80
      });

      // Small jitter around Banjul / Kombo Saint Mary
      const lat = (v.last_latitude || 13.454) + (Math.sin(tickCount * 0.2 + v.year) * 0.0005);
      const lon = (v.last_longitude || -16.58) + (Math.cos(tickCount * 0.2 + v.year) * 0.0005);

      run(
        `UPDATE vehicles SET last_latitude = ?, last_longitude = ?, fuel_level = ? WHERE id = ?`,
        [lat, lon, frame.fuel_level_pct, v.id]
      );

      updates.push({
        vehicleId: v.id,
        plateNumber: v.plate_number,
        make: v.make,
        model: v.model,
        speed_kph: frame.speed_kph,
        engine_rpm: frame.engine_rpm,
        coolant_temp_c: frame.coolant_temp_c,
        fuel_level_pct: frame.fuel_level_pct,
        latitude: lat,
        longitude: lon,
        timestamp: new Date().toISOString()
      });
    }

    tickCount++;
    broadcastToClients({
      type: 'FLEET_BATCH_UPDATE',
      vehicles: updates
    });
  } catch (e) {
    console.error('[TelemetryTicker] Simulation tick error:', e.message);
  }
}, 4000);

server.listen(PORT, () => {
  console.log(`
======================================================================
  STREET CODE AUTOMOTIVE OS - PRODUCTION GRADE SERVER
======================================================================
  🚀 HTTP & WebSocket Server running at: http://localhost:${PORT}
  🌐 Web Portal:           http://localhost:${PORT}/
  🛡️ Civic Command Center:  http://localhost:${PORT}/civic/
  📱 Mobile Client PWA:     http://localhost:${PORT}/mobile/
  📡 REST API Base:         http://localhost:${PORT}/api/
======================================================================
`);
});

export default app;
