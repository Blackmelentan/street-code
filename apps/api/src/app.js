import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { config } from './config.js';
import { securityHeaders, cors } from './lib/security.js';
import { rateLimit } from './lib/ratelimit.js';
import { HttpError } from './lib/http.js';
import authRoutes from './routes/auth.js';
import vehicleRoutes from './routes/vehicles.js';
import driverRoutes from './routes/drivers.js';
import orgRoutes from './routes/orgs.js';
import policeRoutes from './routes/police.js';
import citationRoutes from './routes/citations.js';
import moneyRoutes from './routes/money.js';
import adminRoutes from './routes/admin.js';
import publicRoutes from './routes/public.js';
import miscRoutes from './routes/misc.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  if (process.env.TRUST_PROXY) app.set('trust proxy', Number(process.env.TRUST_PROXY) || process.env.TRUST_PROXY);

  app.use(securityHeaders, cors);
  // rawBody is kept only so payment-provider webhooks can be signature-checked.
  app.use(express.json({ limit: '100kb', verify: (req, res, buf) => { req.rawBody = buf; } }));

  const apiLimiter = rateLimit({ windowMs: 60_000, max: 600, key: (req) => req.ip });
  app.get('/healthz', (req, res) => res.json({ ok: true }));
  app.use('/api', apiLimiter);
  // Order matters only for path clashes: each router guards itself.
  app.use('/api', publicRoutes, authRoutes, moneyRoutes, miscRoutes, driverRoutes, vehicleRoutes, orgRoutes, citationRoutes, policeRoutes, adminRoutes);
  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

  /* ---- front-ends: one server, four surfaces ---- */
  const serve = (mount, dir, opts = {}) => {
    if (fs.existsSync(dir)) app.use(mount, express.static(dir, { extensions: ['html'], maxAge: config.isProd ? '1h' : 0, ...opts }));
  };
  // Browsers ask for these at the site root without being told to
  const brand = path.join(config.packagesDir, 'design/brand');
  app.get('/favicon.ico', (req, res) => res.sendFile(path.join(brand, 'favicon.ico')));
  app.get('/browserconfig.xml', (req, res) => res.sendFile(path.join(brand, 'browserconfig.xml')));
  serve('/core', path.join(config.packagesDir, 'core/src'));
  serve('/design', path.join(config.packagesDir, 'design'));
  serve('/app', path.join(config.appsDir, 'mobile'), { maxAge: 0 });
  serve('/command', path.join(config.appsDir, 'command'), { maxAge: 0 });
  serve('/', path.join(config.appsDir, 'web'));
  // Old addresses from v1
  app.get('/civic*', (req, res) => res.redirect(301, '/command/'));
  app.get('/mobile*', (req, res) => res.redirect(301, '/app/'));

  app.use((err, req, res, next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, ...err.extra });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'That request was not valid JSON.' });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'That request is too large.' });
    // Constraint violations from SQLite are our fault, not the caller's, but say something useful.
    if (/UNIQUE constraint/.test(err.message || '')) return res.status(409).json({ error: 'That already exists.' });
    console.error(err);
    res.status(500).json({ error: 'Something went wrong on our side.' });
  });
  return app;
}
