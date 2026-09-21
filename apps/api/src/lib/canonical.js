/**
 * Canonical JSON: keys sorted at EVERY depth, no whitespace.
 *
 * v1 used JSON.stringify(obj, Object.keys(obj).sort()). That array is a
 * whitelist applied at every level, so any key that only appeared in a nested
 * object was dropped from the hash, and nested values (an invoice total, say)
 * could be changed without breaking the chain.
 */
export function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value === undefined ? null : value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
}
