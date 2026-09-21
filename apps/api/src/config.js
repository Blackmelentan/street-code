/**
 * Configuration.
 *
 * The original project loaded .env relative to the current working directory,
 * so `npm start` from the repo root and from backend/ used different secrets and
 * every passport looked tampered with. Here everything resolves from this file's
 * location, never from process.cwd().
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '../../..');

function loadDotenv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    v = v.replace(/\\n/g, '\n');
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}
loadDotenv(path.join(ROOT, '.env'));

const env = process.env;
const isProd = env.NODE_ENV === 'production';
const resolveFromRoot = (p) => (path.isAbsolute(p) ? p : path.join(ROOT, p));

const DEV_DEFAULTS = {
  JWT_SECRET: 'dev-only-jwt-secret-change-me',
  LICENCE_CODE_KEY: 'dev-only-licence-code-key-change-me',
  MOMO_WEBHOOK_SECRET: 'dev-only-momo-webhook-secret-change-me',
};

const secret = (name) => {
  const v = env[name];
  if (isProd) {
    if (!v || v === DEV_DEFAULTS[name] || v.length < 24) {
      throw new Error(`Refusing to start in production: ${name} must be set to a strong value (24+ characters).`);
    }
    return v;
  }
  return v || DEV_DEFAULTS[name];
};

const dataDir = resolveFromRoot(env.DATA_DIR || 'apps/api/data');
fs.mkdirSync(dataDir, { recursive: true });

export const config = {
  isProd,
  port: Number(env.PORT || 3000),
  dataDir,
  dbFile: env.DATABASE_PATH ? resolveFromRoot(env.DATABASE_PATH) : path.join(dataDir, 'streetcode.sqlite'),
  jwtSecret: secret('JWT_SECRET'),
  licenceCodeKey: secret('LICENCE_CODE_KEY'),
  momoWebhookSecret: secret('MOMO_WEBHOOK_SECRET'),
  momoMode: env.MOMO_MODE || (isProd ? 'live' : 'sandbox'),
  corsOrigins: (env.CORS_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),
  devFeatures: !isProd && env.DEV_FEATURES !== '0',
  passportKeyPem: env.PASSPORT_PRIVATE_KEY_PEM || null,
  appsDir: path.join(ROOT, 'apps'),
  packagesDir: path.join(ROOT, 'packages'),
  platformFeeRate: 0.025,
};

if (isProd && config.momoMode !== 'live') {
  throw new Error('Refusing to start in production with MOMO_MODE other than "live".');
}

/** Ed25519 signing key for passport blocks. Generated once in dev, must be supplied in production. */
export function loadPassportKeys() {
  let pem = config.passportKeyPem;
  const keyFile = path.join(dataDir, 'passport-ed25519.pem');
  if (!pem) {
    if (isProd) throw new Error('Refusing to start in production: PASSPORT_PRIVATE_KEY_PEM is not set.');
    if (fs.existsSync(keyFile)) pem = fs.readFileSync(keyFile, 'utf8');
    else {
      const { privateKey } = crypto.generateKeyPairSync('ed25519');
      pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
      fs.writeFileSync(keyFile, pem, { mode: 0o600 });
    }
  }
  const privateKey = crypto.createPrivateKey(pem);
  const publicKey = crypto.createPublicKey(privateKey);
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' });
  const keyId = crypto.createHash('sha256').update(publicPem).digest('hex').slice(0, 16);
  return { privateKey, publicKey, publicPem, keyId };
}
