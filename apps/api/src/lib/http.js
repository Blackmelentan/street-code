export class HttpError extends Error {
  constructor(status, message, extra = {}) { super(message); this.status = status; this.extra = extra; }
}
export const bad = (m, extra) => new HttpError(400, m, extra);
export const unauthorized = (m = 'Sign in to continue.') => new HttpError(401, m);
export const forbidden = (m = 'You do not have permission to do that.') => new HttpError(403, m);
export const notFound = (m = 'Not found.') => new HttpError(404, m);
export const conflict = (m) => new HttpError(409, m);

/** Wrap a route so thrown errors (sync or async) reach the error handler. */
export const h = (fn) => (req, res, next) => {
  try {
    const r = fn(req, res, next);
    if (r && typeof r.then === 'function') r.catch(next);
  } catch (e) { next(e); }
};

/* Tiny validators, so no dependency is needed. Each returns the cleaned value or throws 400. */
export const str = (v, name, { min = 1, max = 500, optional = false } = {}) => {
  if (v === undefined || v === null || v === '') { if (optional) return null; throw bad(`${name} is required.`); }
  if (typeof v !== 'string') throw bad(`${name} must be text.`);
  const t = v.trim();
  if (t.length < min) throw bad(`${name} is too short.`);
  if (t.length > max) throw bad(`${name} is too long (max ${max} characters).`);
  return t;
};
export const num = (v, name, { min = -Infinity, max = Infinity, optional = false, int = false } = {}) => {
  if (v === undefined || v === null || v === '') { if (optional) return null; throw bad(`${name} is required.`); }
  const n = Number(v);
  if (!Number.isFinite(n)) throw bad(`${name} must be a number.`);
  if (int && !Number.isInteger(n)) throw bad(`${name} must be a whole number.`);
  if (n < min) throw bad(`${name} must be at least ${min}.`);
  if (n > max) throw bad(`${name} must be at most ${max}.`);
  return n;
};
export const oneOf = (v, name, list, { optional = false } = {}) => {
  if (v === undefined || v === null || v === '') { if (optional) return null; throw bad(`${name} is required.`); }
  if (!list.includes(v)) throw bad(`${name} must be one of: ${list.join(', ')}.`);
  return v;
};
export const isoDate = (v, name, { optional = false } = {}) => {
  if (v === undefined || v === null || v === '') { if (optional) return null; throw bad(`${name} is required.`); }
  const t = Date.parse(v);
  if (!Number.isFinite(t)) throw bad(`${name} is not a valid date.`);
  return new Date(t).toISOString();
};
export const json = (s, fallback) => { try { return s == null ? fallback : JSON.parse(s); } catch { return fallback; } };
