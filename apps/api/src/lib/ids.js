import crypto from 'node:crypto';
export const newId = (prefix) => `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
/** Uppercase alphanumerics only, so "bjl 4821-b" and "BJL-4821-B" are the same plate. */
export const plateKey = (p) => String(p || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
export const normPhone = (p) => {
  const d = String(p || '').replace(/[^\d+]/g, '');
  if (!d) return '';
  if (d.startsWith('+')) return d;
  if (d.startsWith('220') && d.length >= 10) return `+${d}`;
  return `+220${d}`;
};
