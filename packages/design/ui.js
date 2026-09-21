/**
 * Shared UI helpers for the website, the mobile app and the police console.
 * No framework, no build step. Served at /design/ui.js.
 */
import { gaugeColor } from '/core/service-engine.js';

/* ---------------------------------------------------------------------------
 * Safe templating. Every interpolated value is escaped unless wrapped in raw().
 * The apps show names, plates and free text that other people typed, so escaping
 * by default is a security feature, not a nicety.
 * ------------------------------------------------------------------------- */
class Raw { constructor(s) { this.s = s; } toString() { return this.s; } }
export const raw = (s) => new Raw(String(s ?? ''));
export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const flat = (v) => (v instanceof Raw ? v.s : Array.isArray(v) ? v.map(flat).join('') : v === false || v == null ? '' : esc(v));
export const html = (strings, ...vals) => raw(strings.reduce((out, s, i) => out + s + (i < vals.length ? flat(vals[i]) : ''), ''));

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export const icon = (name, cls = '') => raw(`<svg class="ic ${cls}" aria-hidden="true"><use href="/design/icons.svg#i-${esc(name)}"/></svg>`);

/* ---------------------------------------------------------------------------
 * Formatting
 * ------------------------------------------------------------------------- */
export const fmtNum = (n) => Number(n).toLocaleString('en-GB');
export const fmtDist = (n, unit = 'km') => `${fmtNum(Math.round(n))} ${unit === 'hours' ? 'h' : 'km'}`;
export const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '');
export const fmtDateTime = (d) => (d ? new Date(d).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');
export const fmtGmd = (minor) => `D${(Number(minor || 0) / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export function timeAgo(d) {
  const s = Math.round((Date.now() - new Date(d).getTime()) / 1000);
  const a = Math.abs(s); const fut = s < 0;
  const u = a < 60 ? [a, 's'] : a < 3600 ? [Math.round(a / 60), 'm'] : a < 86400 ? [Math.round(a / 3600), 'h'] : [Math.round(a / 86400), 'd'];
  return fut ? `in ${u[0]}${u[1]}` : a < 45 ? 'just now' : `${u[0]}${u[1]} ago`;
}
export const initials = (name = '') => name.split(/\s+/).filter(Boolean).slice(0, 2).map((s) => s[0]).join('').toUpperCase();

export const STATUS_WORDS = { good: 'On track', watch: 'Keep an eye', soon: 'Due soon', overdue: 'Overdue', critical: 'Seriously overdue', unknown: 'Not tracked' };
export const STATUS_TAG = { good: 'good', watch: '', soon: 'warn', overdue: 'bad', critical: 'bad', unknown: '' };

/* ---------------------------------------------------------------------------
 * Number plate. Passenger plates are white, commercial plates yellow.
 * ------------------------------------------------------------------------- */
export const plate = (text, { commercial = false, lg = false } = {}) =>
  html`<span class="plate ${commercial ? 'commercial' : ''} ${lg ? 'lg' : ''}"><b>GM</b><span>${text}</span></span>`;

/* ---------------------------------------------------------------------------
 * The finish line. `item` is one entry of health.items from the service engine.
 * ------------------------------------------------------------------------- */
const SEGMENTS = 28;
export function finishBar({ pct, status = 'good', thin = false } = {}) {
  const known = pct != null && status !== 'unknown';
  const on = known ? Math.round(Math.min(pct, 1) * SEGMENTS) : 0;
  const segs = Array.from({ length: SEGMENTS }, (_, i) => `<i class="fl-seg ${i < on ? 'on' : ''}" style="--i:${i};--c:${gaugeColor((i + 0.5) / SEGMENTS)}"></i>`).join('');
  return raw(`<div class="fl ${thin ? 'thin' : ''}" data-status="${esc(status)}" style="--p:${known ? Math.min(pct, 1) : 0};--c:${gaugeColor(known ? pct : 0)}">
    <div class="fl-track">${segs}
      <span class="fl-car"><svg class="ic"><use href="/design/icons.svg#i-car"/></svg></span>
      <span class="fl-flag"><svg class="ic"><use href="/design/icons.svg#i-flag"/></svg></span>
    </div></div>`);
}

/** Kick the animations once the markup is in the DOM (and again when it scrolls into view). */
export function animateIn(root = document) {
  const bars = $$('.fl:not(.go)', root);
  if (!bars.length) return;
  if (!('IntersectionObserver' in window)) return bars.forEach((b) => b.classList.add('go'));
  const io = new IntersectionObserver((entries) => entries.forEach((e) => { if (e.isIntersecting) { e.target.classList.add('go'); io.unobserve(e.target); } }), { threshold: 0.35 });
  bars.forEach((b) => io.observe(b));
}

export function odo(value, unit = 'km') {
  const digits = String(Math.max(0, Math.round(value))).padStart(6, '0').split('');
  let k = 0;
  return raw(`<span class="odo" aria-label="${fmtNum(value)} ${unit === 'hours' ? 'hours' : 'kilometres'}">${digits.map((d, i) => `${(digits.length - i) % 3 === 0 && i > 0 ? '<i class="sep">,</i>' : ''}<i><em style="--k:${k++}">${d}</em></i>`).join('')}</span>`);
}

/** The one-line sentence that goes under a bar: how far to go and where the finish is. */
export function finishSentence(item) {
  if (item.status === 'unknown') return { left: item.message, right: '' };
  const unit = item.unit;
  const left = item.status === 'overdue' || item.status === 'critical'
    ? (item.overdueDistance ? `${fmtDist(item.overdueDistance, unit)} over` : item.message)
    : item.message;
  const parts = [];
  if (item.finishLine?.odometer != null) parts.push(`at ${fmtDist(item.finishLine.odometer, unit)}`);
  if (item.finishLine?.date) parts.push(fmtDate(item.finishLine.date));
  return { left, right: parts.join(' or ') };
}

/* ---------------------------------------------------------------------------
 * Toasts and sheets
 * ------------------------------------------------------------------------- */
export function toast(message, kind = '') {
  let host = $('.toasts');
  if (!host) { host = document.createElement('div'); host.className = 'toasts'; host.setAttribute('role', 'status'); host.setAttribute('aria-live', 'polite'); document.body.append(host); }
  const t = document.createElement('div');
  t.className = `toast ${kind}`; t.textContent = message;
  host.append(t);
  setTimeout(() => { t.style.transition = 'opacity .3s'; t.style.opacity = '0'; setTimeout(() => t.remove(), 300); }, 3800);
}

let openSheets = [];
export function openSheet({ title = '', body, onMount, wide = false }) {
  const scrim = document.createElement('div'); scrim.className = 'scrim';
  const el = document.createElement('div'); el.className = 'sheet'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-modal', 'true'); el.setAttribute('aria-label', title);
  if (wide) el.style.maxWidth = '820px';
  el.innerHTML = `${title ? `<h2>${esc(title)}</h2>` : ''}<div class="sheet-body">${body instanceof Raw ? body.s : esc(body)}</div>`;
  const close = () => { scrim.remove(); el.remove(); openSheets = openSheets.filter((s) => s !== ctl); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  const ctl = { el, close };
  scrim.addEventListener('click', close); document.addEventListener('keydown', onKey);
  document.body.append(scrim, el);
  openSheets.push(ctl);
  el.querySelector('input:not([type=hidden]),select,textarea')?.focus({ preventScroll: true });
  animateIn(el);
  onMount?.(el, ctl);
  return ctl;
}
export const closeAllSheets = () => [...openSheets].forEach((s) => s.close());

/* ---------------------------------------------------------------------------
 * API client. `storageKey` keeps each app's session separate.
 * ------------------------------------------------------------------------- */
export function makeApi(storageKey, onUnauthorized) {
  const api = async (method, url, body) => {
    const token = localStorage.getItem(storageKey);
    let res;
    try {
      res = await fetch(`/api${url}`, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    } catch { const e = new Error('No connection. Check your network and try again.'); e.offline = true; throw e; }
    let data = null; try { data = await res.json(); } catch { /* empty */ }
    if (!res.ok) {
      if (res.status === 401 && token) { localStorage.removeItem(storageKey); onUnauthorized?.(); }
      const e = new Error(data?.error || `Something went wrong (${res.status}).`); e.status = res.status; e.data = data; throw e;
    }
    return data;
  };
  api.get = (u) => api('GET', u); api.post = (u, b = {}) => api('POST', u, b); api.put = (u, b = {}) => api('PUT', u, b); api.patch = (u, b = {}) => api('PATCH', u, b); api.del = (u) => api('DELETE', u);
  api.token = () => localStorage.getItem(storageKey);
  api.setToken = (t) => localStorage.setItem(storageKey, t);
  api.clear = () => localStorage.removeItem(storageKey);
  return api;
}

/** Authenticated realtime channel with automatic reconnect. */
export function connectRealtime(token, onMessage) {
  let ws; let stopped = false; let delay = 1000;
  const open = () => {
    ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
    ws.onopen = () => { ws.send(JSON.stringify({ type: 'AUTH', token })); delay = 1000; };
    ws.onmessage = (e) => { try { onMessage(JSON.parse(e.data)); } catch { /* ignore */ } };
    ws.onclose = () => { if (!stopped) setTimeout(open, (delay = Math.min(delay * 2, 30000))); };
  };
  open();
  return () => { stopped = true; ws?.close(); };
}

export function initTheme(force) {
  const set = (t) => document.documentElement.setAttribute('data-theme', t);
  if (force) return set(force);
  const mq = matchMedia('(prefers-color-scheme: dark)');
  set(mq.matches ? 'dark' : 'light');
  mq.addEventListener?.('change', (e) => set(e.matches ? 'dark' : 'light'));
}
