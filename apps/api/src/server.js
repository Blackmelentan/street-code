import http from 'node:http';
import { config } from './config.js';
import { openDb } from './db/database.js';
import { createApp } from './app.js';
import { attachHub } from './services/hub.js';
import { startScheduler } from './services/scheduler.js';

openDb();
const app = createApp();
const server = http.createServer(app);
attachHub(server);
startScheduler();

server.listen(config.port, () => {
  const b = `http://localhost:${config.port}`;
  console.log(`\n  STREET CODE ${config.isProd ? '(production)' : '(development)'}\n  ─────────────────────────────────────────────\n  Website          ${b}/\n  Mobile app       ${b}/app/\n  Police command   ${b}/command/\n  API              ${b}/api/\n  Database         ${config.dbFile}\n${config.devFeatures ? '\n  Demo accounts: run "npm run seed", then GET /api/dev/accounts (password: streetcode)\n' : ''}`);
});

const stop = () => server.close(() => process.exit(0));
process.on('SIGINT', stop); process.on('SIGTERM', stop);
