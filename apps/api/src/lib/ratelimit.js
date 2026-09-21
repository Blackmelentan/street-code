import { HttpError } from './http.js';

/**
 * Small in-memory sliding-window limiter. Fine for one process; put a shared
 * store (Redis) behind it when the API runs on more than one instance.
 */
export function rateLimit({ windowMs, max, key = (req) => req.ip, message = 'Too many requests. Wait a moment and try again.' }) {
  const hits = new Map();
  const timer = setInterval(() => {
    const cutoff = Date.now() - windowMs;
    for (const [k, arr] of hits) { const keep = arr.filter((t) => t > cutoff); keep.length ? hits.set(k, keep) : hits.delete(k); }
  }, Math.max(windowMs, 30000));
  timer.unref?.();
  const mw = (req, res, next) => {
    const k = key(req);
    const now = Date.now();
    const arr = (hits.get(k) || []).filter((t) => t > now - windowMs);
    if (arr.length >= max) {
      res.set('Retry-After', String(Math.ceil(windowMs / 1000)));
      return next(new HttpError(429, message));
    }
    arr.push(now); hits.set(k, arr);
    next();
  };
  mw.reset = () => hits.clear();
  return mw;
}
