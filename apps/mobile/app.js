import {
  html, raw, esc, $, $$, icon, plate, finishBar, finishSentence, odo, animateIn, toast, openSheet, closeAllSheets,
  fmtNum, fmtDist, fmtDate, fmtDateTime, fmtGmd, timeAgo, initials, STATUS_WORDS, STATUS_TAG, makeApi, connectRealtime, initTheme,
} from '/design/ui.js';
import { computeItemHealth, VEHICLE_CLASSES, SERVICE_ITEMS, OIL_TYPES, OIL_GRADES, LICENCE_GROUPS, AUTHORIZATION_KINDS, ORG_ROLES, DOCUMENT_KINDS, gaugeColor } from '/core/index.js';

initTheme();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/app/sw.js', { scope: '/app/' }).catch(() => {});

const app = $('#app');
const state = { user: null, cat: null, unread: 0, stopRt: null, cleanups: [] };
const api = makeApi('sc.token', () => { state.user = null; go('welcome'); });
const go = (path) => { location.hash = `#/${path}`; };
const isoLocal = (v) => (v ? new Date(v).toISOString() : null);
const nowLocal = (offsetH = 0) => { const d = new Date(Date.now() + offsetH * 3600000); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };
const run = async (fn) => { try { return await fn(); } catch (e) { toast(e.message, 'bad'); return null; } };
const reload = () => route();

/* ------------------------------------------------------------------ shell */
function shell(tab, content, { title } = {}) {
  const garage = state.user?.memberships?.some((m) => ['garage', 'carwash'].includes(m.org_type));
  const tabs = [['garage', 'Garage', 'home'], ['drive', 'Drive', 'wheel'], ['alerts', 'Alerts', 'bell'], ...(garage ? [['work', 'Work', 'wrench']] : []), ['me', 'Me', 'user']];
  return html`<main id="view">${content}</main>
    <nav class="tabbar" aria-label="Main">${tabs.map(([k, l, ic]) => html`<a class="tab" href="#/${k}" ${k === tab ? raw('aria-current="page"') : ''}>${icon(ic)}<span>${l}</span>${k === 'alerts' && state.unread ? html`<span class="badge">${state.unread > 9 ? '9+' : state.unread}</span>` : ''}</a>`)}</nav>`;
}
const F = (label, control, help) => html`<div class="field"><label>${label}</label>${control}${help ? html`<span class="help">${help}</span>` : ''}</div>`;
const input = (name, attrs = '') => raw(`<input class="input" name="${esc(name)}" ${attrs}>`);
const opts = (list, sel) => list.map(([v, l]) => `<option value="${esc(v)}" ${v === sel ? 'selected' : ''}>${esc(l)}</option>`).join('');
const formData = (form) => Object.fromEntries(new FormData(form).entries());

/* ------------------------------------------------------------------ welcome / auth */
async function welcomeView() {
  let devs = null; try { devs = await api.get('/dev/accounts'); } catch { /* production */ }
  return { bare: true, html: html`<div class="welcome">
    <img src="/design/brand/mark.svg" width="64" height="64" alt="" style="border-radius:16px">
    <h1>Your car.<br><em>Every</em> detail.</h1>
    <p style="color:#b3bec0;margin-bottom:22px">Service countdowns, lending, papers and history in one place.</p>
    <form data-form="auth" class="stack" id="authForm" style="--gap:14px">
      <div class="field reg hide"><label>Your name</label><input class="input" name="name" autocomplete="name"></div>
      ${F('Phone number', input('phone', 'type="tel" inputmode="tel" autocomplete="tel" placeholder="+220 7xx xxxx" required'))}
      ${F('Password', input('password', 'type="password" autocomplete="current-password" minlength="8" required'))}
      <button class="btn amber block" type="submit"><span class="lbl">Sign in</span></button>
      <button class="btn ghost block" type="button" data-act="toggleReg" style="color:#eceae4;border-color:#3a4143">Create an account</button>
    </form>
    ${devs ? html`<p class="tiny" style="color:#8f9c9e;margin-top:16px">Demo accounts (password “${devs.password}”):</p><div class="devs">${devs.accounts.map((a) => html`<button type="button" data-act="quick" data-phone="${a.phone}" data-pw="${devs.password}">${a.label}</button>`)}</div>` : ''}
  </div>` };
}

/* ------------------------------------------------------------------ garage */
const nextItem = (v) => v.health.next || v.health.items.find((i) => i.code === 'engine_oil') || v.health.items[0];
function ticket(v, i) {
  const it = nextItem(v);
  const lent = v.access === 'drive';
  return html`<a class="ticket rise-in" style="--n:${i}" href="#/vehicle/${v.id}">
    <div class="ticket-head" style="padding-top:6px">${plate(v.plate, { commercial: v.commercial_use })}</div>
    <div class="veh-name" style="margin-top:12px">${v.year} ${v.make} ${v.model}</div><div class="small muted">${v.class_label}${v.color ? ` · ${v.color}` : ''}</div>
    <div class="cluster" style="margin-top:10px">${v.stolen ? html`<span class="tag bad dot">On the police stolen list</span>` : ''}${lent ? html`<span class="tag warn">${icon('key', 'sm')} Lent to you</span>` : ''}</div>
    ${it ? html`<div class="next"><div class="lbl"><span>${icon(it.icon)} ${it.label}</span><span class="tag ${STATUS_TAG[it.status]}">${STATUS_WORDS[it.status]}</span></div>
      ${finishBar({ pct: it.pct, status: it.status })}
      <div class="fl-meta"><b>${finishSentence(it).left}</b><span class="mono">${finishSentence(it).right ? `finish ${finishSentence(it).right}` : ''}</span></div></div>` : ''}
    <div class="sep"></div>
    <div class="row-between"><div class="chips" style="margin:0">${v.health.items.filter((x) => x !== it).slice(0, 4).map((x) => html`<span class="mini"><i style="--c:${x.color}"></i>${x.short}</span>`)}</div><span class="muted">${icon('chev-right')}</span></div>
  </a>`;
}

async function garageView() {
  const { vehicles } = await api.get('/vehicles');
  const overdue = vehicles.filter((v) => ['overdue', 'critical'].includes(v.health.overall)).length;
  const soon = vehicles.filter((v) => v.health.overall === 'soon').length;
  return { tab: 'garage', html: html`
    <div class="topbar"><div><div class="hello">Hello, ${state.user.name.split(' ')[0]}</div><h1>My garage</h1></div><button class="btn ghost icon" data-act="themeToggle" aria-label="Toggle theme">${icon('gauge')}</button></div>
    ${vehicles.length ? html`<div class="stat-row"><div class="stat"><b>${vehicles.length}</b><span>vehicles</span></div><div class="stat warn"><b>${soon}</b><span>due soon</span></div><div class="stat hot"><b>${overdue}</b><span>overdue</span></div></div>
      <div class="veh-list">${vehicles.map(ticket)}</div>`
      : html`<div class="empty card">${icon('car')}<h3>No vehicles yet</h3><p style="margin:6px 0 16px">Add a car, bike, truck or tractor to start the countdown to its next service.</p></div>`}
    <button class="btn fab" data-act="addVehicle">${icon('plus')} Add vehicle</button>` };
}

/* ------------------------------------------------------------------ vehicle */
const oilLabel = (p) => (p ? `${OIL_TYPES[p.oil_type]?.label || p.oil_type}${p.grade ? ` ${p.grade}` : ''}${p.brand ? ` · ${p.brand}` : ''}` : '');

function svcCard(it, manage, i) {
  const s = finishSentence(it);
  return html`<div class="card svc ${it.status === 'unknown' ? 'unknown' : ''} rise-in" style="--n:${i}">
    <div class="svc-head">${icon(it.icon)}<b>${it.label}</b><span class="tag ${STATUS_TAG[it.status]}">${STATUS_WORDS[it.status]}</span></div>
    ${finishBar({ pct: it.pct, status: it.status })}
    <div class="fl-meta"><b>${s.left}</b><span class="mono">${s.right ? `finish ${s.right}` : ''}</span></div>
    <div class="svc-foot"><span>${it.product ? oilLabel(it.product) : it.lastServicedAt ? `Last done ${fmtDate(it.lastServicedAt)}` : ''}</span>
      <span class="cluster" style="--gap:8px">${it.status !== 'unknown' ? (it.verified ? html`<span class="stamp">${icon('check', 'sm')} Sealed</span>` : html`<span class="stamp self">Self-reported</span>`) : ''}
      ${manage ? html`<button class="btn ghost sm" data-act="logService" data-code="${it.code}">${it.status === 'unknown' ? 'Log' : 'Done it'}</button>` : ''}</span></div></div>`;
}

async function vehicleView(id) {
  const d = await api.get(`/vehicles/${id}`);
  const v = d.vehicle; const manage = v.access === 'manage';
  window.__veh = d; // used by the sheets below
  const docs = d.documents;
  return { tab: 'garage', html: html`
    <div class="topbar"><a class="btn ghost icon" href="#/garage" aria-label="Back">${icon('chev-left')}</a><span class="cluster">${v.stolen ? html`<span class="tag bad dot">Stolen list</span>` : ''}${d.session ? html`<span class="tag good dot">${d.session.driver_name} driving</span>` : ''}</span></div>
    <section class="vhero">${plate(v.plate, { commercial: v.commercial_use, lg: true })}<h1>${v.year} ${v.make} ${v.model}</h1><div class="sub">${v.class_label}${v.color ? ` · ${v.color}` : ''}${v.fuel_type ? ` · ${v.fuel_type}` : ''}</div>
      <div class="odo-row">${odo(v.odometer, v.unit)}${manage || v.access === 'drive' ? html`<button class="btn amber sm" data-act="odometer">Update</button>` : ''}</div>
      <p class="tiny" style="color:#8f9c9e;margin-top:10px">Learns your usage: about ${fmtNum(Math.round(d.health.usage.perDay))} ${v.unit === 'hours' ? 'h' : 'km'} a day (${d.health.usage.confidence}).</p></section>

    ${manage ? html`<div class="section-title"><h3>Quick log</h3></div><div class="quick">
      <button data-act="logService" data-code="engine_oil">${icon('oil')}Oil change</button>
      <button data-act="logService" data-code="wash">${icon('wash')}Car wash</button>
      <button data-act="logService" data-code="">${icon('wrench')}Other</button></div>` : ''}

    <div class="section-title"><h3>Service due</h3><span class="tiny muted">Most urgent first</span></div>
    <div class="stack">${d.health.items.filter((i) => i.status !== 'unknown').map((it, i) => svcCard(it, manage, i))}</div>
    ${d.health.items.some((i) => i.status === 'unknown') ? html`<div class="section-title"><h3>Not tracked yet</h3><span class="tiny muted">Log the last one to start a countdown</span></div>
      <div class="card" style="padding:4px 16px">${d.health.items.filter((i) => i.status === 'unknown').map((it) => html`<div class="li">${icon(it.icon, 'lead')}<span class="grow li-title">${it.label}</span>${manage ? html`<button class="btn ghost sm" data-act="logService" data-code="${it.code}">Start</button>` : ''}</div>`)}</div>` : ''}

    <div class="section-title"><h3>Papers</h3>${manage ? html`<button class="btn ghost sm" data-act="addDoc">${icon('plus', 'sm')} Add</button>` : ''}</div>
    <div class="card">${docs.length ? docs.map((x) => html`<div class="docrow"><div class="row-between"><b>${icon(DOCUMENT_KINDS[x.kind]?.icon || 'doc')} ${DOCUMENT_KINDS[x.kind]?.label || x.kind}</b>
        <span class="tag ${x.health.state === 'valid' ? 'good' : x.health.state === 'expiring' ? 'warn' : 'bad'}">${x.health.state === 'expired' ? `Expired ${-x.health.remainingDays}d ago` : x.health.state === 'expiring' ? `${x.health.remainingDays} days left` : 'Valid'}</span></div>
        ${finishBar({ pct: x.health.pct, status: x.health.state === 'expired' ? 'overdue' : x.health.state === 'expiring' ? 'soon' : 'good', thin: true })}
        <div class="row-between tiny muted"><span>${x.issuer || ''} ${x.number ? `· ${x.number}` : ''}</span><span>to ${fmtDate(x.valid_to)}${x.status === 'pending' ? ' · awaiting verification' : ''}</span></div></div>`) : html`<div class="empty" style="padding:14px">No papers added yet.</div>`}</div>

    ${manage ? html`<div class="section-title"><h3>Who can drive it</h3><button class="btn ghost sm" data-act="lend">${icon('key', 'sm')} Lend</button></div>
      <div class="card">${d.authorizations.length ? d.authorizations.map((a) => html`<div class="li"><div class="avatar">${initials(a.driver_name || '?')}</div><div class="grow"><div class="li-title">${a.driver_name || a.driver_phone}</div><div class="li-sub">${AUTHORIZATION_KINDS[a.kind]} · ${a.ends_at ? `until ${fmtDateTime(a.ends_at)}` : 'open-ended'}${!a.driver_user_id ? ' · no account yet' : ''}</div></div><button class="btn danger sm" data-act="revoke" data-id="${a.id}">Withdraw</button></div>`) : html`<div class="empty" style="padding:14px">Only you. Lend it to a friend, family member, renter or employee and they show up here.</div>`}
      ${d.session ? html`<div class="row-between" style="margin-top:12px"><span class="small">${d.session.driver_name} is driving now</span><button class="btn ghost sm" data-act="takeBack">Take it back</button></div>` : ''}</div>` : ''}

    <div class="section-title"><h3>History</h3></div>
    <button class="li card" style="border:1px solid var(--line)" data-act="passport">${icon('shield', 'lead')}<span class="grow"><span class="li-title">Vehicle passport</span><br><span class="li-sub">Garage-sealed and signed. Tap to verify.</span></span>${icon('chev-right', 'trail')}</button>

    ${manage ? html`<div class="section-title"><h3>More</h3></div><div class="card stack">
      <label class="row-between"><span>Severe conditions <span class="help">(dust, heat, stop-go). Oil intervals shorten by a quarter.</span></span><input type="checkbox" data-act="toggle" data-key="severe_service" ${v.severe_service ? 'checked' : ''} style="width:22px;height:22px;accent-color:var(--rust)"></label>
      <label class="row-between"><span>Commercial use <span class="help">(yellow plate, needs licence group C)</span></span><input type="checkbox" data-act="toggle" data-key="commercial_use" ${v.commercial_use ? 'checked' : ''} style="width:22px;height:22px;accent-color:var(--rust)"></label>
      ${d.flags.some((f) => f.reported_by_owner && f.status === 'reported') ? html`<button class="btn ghost" data-act="withdrawStolen">Withdraw stolen report</button>` : d.flags.length ? html`<p class="small muted">Police have this vehicle on file. Contact the station to change it.</p>` : html`<button class="btn danger" data-act="reportStolen">${icon('siren')} Report stolen</button>`}
      ${v.stolen ? '' : html`<button class="btn ghost" data-act="sell">${icon('share')} Sell or transfer</button>`}</div>` : ''}` };
}

/* --- sheets on the vehicle screen --- */
function whichItems(v) {
  const cls = VEHICLE_CLASSES[v.vehicle_class];
  return Object.entries(SERVICE_ITEMS).filter(([, d]) => d.appliesTo(cls)).map(([k, d]) => [k, d.label]);
}

function logServiceSheet(code) {
  const { vehicle: v, health } = window.__veh; const cls = VEHICLE_CLASSES[v.vehicle_class];
  const items = whichItems(v);
  const body = html`<form data-form="logService" class="stack" style="--gap:14px">
    ${F('What was done', raw(`<select class="input" name="item_code">${opts(items, code || 'engine_oil')}</select>`))}
    <div id="oilBits" class="stack" style="--gap:14px">
      <div class="field"><label>Oil you put in</label><div class="seg-pick">${Object.entries(OIL_TYPES).map(([k, o], i) => html`<label><input type="radio" name="oil_type" value="${k}" ${k === 'semi_synthetic' ? 'checked' : ''}><span>${o.label}</span></label>`)}</div></div>
      <div class="grid" style="grid-template-columns:1fr 1fr">${F('Grade', raw(`<select class="input" name="oil_grade"><option value="">Not sure</option>${opts(OIL_GRADES.map((g) => [g, g]))}</select>`))}${F('Brand', input('brand', 'placeholder="e.g. Total"'))}</div>
    </div>
    <div class="grid" style="grid-template-columns:1fr 1fr">${F('Odometer', input('odometer', `type="number" inputmode="decimal" min="0" value="${Math.round(v.odometer)}"`))}${F('Date', input('performed_at', `type="datetime-local" value="${nowLocal()}" max="${nowLocal(1)}"`))}</div>
    ${F('Notes (optional)', input('notes', 'maxlength="300"'))}
    <div class="card flat" id="preview" style="background:var(--surface-2)"></div>
    <button class="btn block" type="submit">Save</button></form>`;
  openSheet({ title: 'Log service', body, onMount(el) {
    const f = $('form', el);
    const update = () => {
      const d = formData(f); const c = d.item_code;
      $('#oilBits', el).classList.toggle('hide', c !== 'engine_oil');
      const at = new Date(d.performed_at || Date.now());
      const h = computeItemHealth({ code: c, cls, now: at, odometer: Number(d.odometer) || v.odometer, perDay: health.usage.perDay, severe: v.severe_service, last: { performed_at: at.toISOString(), odometer: Number(d.odometer) || v.odometer, product: c === 'engine_oil' ? { oil_type: d.oil_type } : null } });
      const s = finishSentence(h);
      $('#preview', el).innerHTML = html`<div class="row-between"><b>Your next finish line</b>${icon('flag')}</div><div class="mono" style="margin-top:4px">${h.finishLine.odometer != null ? fmtDist(h.finishLine.odometer, cls.unit) : ''}${h.finishLine.date ? ` ${h.finishLine.odometer != null ? 'or ' : ''}${fmtDate(h.finishLine.date)}` : ''}</div><div class="small muted">${SERVICE_ITEMS[c].label}: due every ${h.intervalDistance ? fmtDist(h.intervalDistance, cls.unit) : ''}${h.intervalDistance && h.intervalDays ? ' or ' : ''}${h.intervalDays ? `${h.intervalDays} days` : ''}, whichever comes first.</div>`.toString();
    };
    f.addEventListener('input', update); update();
  } });
}

const formsV = {
  async logService(d, form, ctl) {
    const v = window.__veh.vehicle;
    const body = { item_code: d.item_code, performed_at: isoLocal(d.performed_at), odometer: d.odometer, notes: d.notes || undefined };
    if (d.item_code === 'engine_oil') Object.assign(body, { oil_type: d.oil_type, oil_grade: d.oil_grade || undefined, brand: d.brand || undefined });
    await api.post(`/vehicles/${v.id}/services`, body);
    ctl.close(); toast('Saved. Your countdown has restarted.', 'good'); reload();
  },
  async odometer(d, form, ctl) { const v = window.__veh.vehicle; await api.post(`/vehicles/${v.id}/odometer`, { value: d.value }); ctl.close(); toast('Odometer updated', 'good'); reload(); },
  async addVehicle(d, form, ctl) {
    const r = await api.post('/vehicles', { ...d, year: Number(d.year), odometer: Number(d.odometer || 0), commercial_use: !!d.commercial_use });
    ctl.close(); toast('Vehicle added. Log its last oil change to start the countdown.', 'good'); go(`vehicle/${r.vehicle.id}`);
  },
  async lend(d, form, ctl) {
    const v = window.__veh.vehicle;
    const r = await api.post(`/vehicles/${v.id}/authorizations`, { phone: d.phone, name: d.name || undefined, kind: d.kind, starts_at: isoLocal(d.starts_at), ends_at: isoLocal(d.ends_at) || undefined, note: d.note || undefined });
    ctl.close(); toast(r.driverHasAccount ? 'Lent. They have been notified.' : 'Lent. It will apply as soon as they sign up with that number.', 'good'); reload();
  },
  async addDoc(d, form, ctl) { const v = window.__veh.vehicle; await api.post(`/vehicles/${v.id}/documents`, { ...d, valid_to: isoLocal(`${d.valid_to}T23:59`), valid_from: d.valid_from ? isoLocal(`${d.valid_from}T00:00`) : undefined }); ctl.close(); toast('Added. It shows as unverified until confirmed.'); reload(); },
  async reportStolen(d, form, ctl) { const v = window.__veh.vehicle; await api.post(`/vehicles/${v.id}/report-stolen`, { summary: d.summary, case_ref: d.case_ref || undefined }); ctl.close(); toast('Reported. Officers can see it now. Visit a station to confirm.', 'good'); reload(); },
  async sell(d, form, ctl) { const v = window.__veh.vehicle; await api.post(`/vehicles/${v.id}/transfer`, { to_phone: d.to_phone, price_gmd: d.price || undefined }); ctl.close(); toast('Offer sent. Ownership changes when they accept.', 'good'); },
  async licence(d, form, ctl) {
    const groups = $$('input[name=grp]:checked', form).map((x) => x.value);
    await api.put('/me/licence', { licence_number: d.licence_number, classes: groups, expires_at: d.expires_at });
    ctl.close(); toast('Saved. It will show as verified once the licensing authority confirms it.'); reload();
  },
  async invite(d, form, ctl) { await api.post(`/orgs/${d.org}/members`, { phone: d.phone, role: d.role, employment: d.employment }); ctl.close(); toast('Invitation sent', 'good'); reload(); },
  async newJob(d, form, ctl) { await api.post(`/orgs/${d.org}/jobs`, { plate: d.plate, complaint: d.complaint }); ctl.close(); toast('Job opened. The owner has been asked to approve it.', 'good'); reload(); },
  async quote(d, form, ctl) { await api.patch(`/jobs/${d.job}`, { labour_gmd: d.labour || 0, parts_gmd: d.parts || 0, status: 'quoted' }); ctl.close(); toast('Quote sent', 'good'); reload(); },
  async complete(d, form, ctl) {
    const items = $$('input[name=item]:checked', form).map((x) => { const code = x.value; return code === 'engine_oil' ? { item_code: code, oil_type: d.oil_type, oil_grade: d.oil_grade || undefined, brand: d.brand || undefined } : { item_code: code }; });
    const r = await api.post(`/jobs/${d.job}/complete`, { odometer: d.odometer, event: d.event, summary: d.summary, items });
    ctl.close(); toast('Sealed into the vehicle passport.', 'good'); reload();
  },
  async pay(d, form, ctl) { await api.post(`/jobs/${d.job}/pay`, { provider: d.provider, phone: d.phone }); ctl.close(); toast('Payment started. Approve it on your phone.', 'good'); reload(); },
  async waive(d, form, ctl) {
    const answers = $$('[data-q]', form).map((q) => Number($$('input', q).find((x) => x.checked)?.value ?? -1));
    try { await api.post(`/citations/${d.id}/waive`, { answers }); ctl.close(); toast('Passed. The citation is waived.', 'good'); reload(); }
    catch (e) { toast(e.message, 'bad'); }
  },
};

/* ------------------------------------------------------------------ drive */
async function driveView() {
  const [{ session }, { vehicles }, lic] = await Promise.all([api.get('/drive/current'), api.get('/vehicles'), api.get('/me/licence')]);
  const l = lic.licence;
  let inner;
  if (session) {
    inner = html`<div class="session"><span class="live">Driving now</span><div style="margin-top:16px">${plate(session.vehicle.plate, { lg: true })}</div><div class="timer" id="timer" data-since="${session.started_at}">00:00:00</div>
      <p style="color:#9aa7a9;margin-bottom:18px">A police plate check shows you as the declared driver, with the owner's authority behind you.</p><button class="btn amber block" data-act="endDrive">End drive</button></div>`;
  } else {
    const list = vehicles.filter((v) => ['manage', 'drive'].includes(v.access));
    inner = html`<div class="card" style="margin-bottom:14px"><div class="row-between"><div><b>Before you drive</b><div class="small muted">Tap Start so the vehicle shows who is at the wheel and on whose permission.</div></div>${icon('shield', 'lg')}</div></div>
      <div class="stack">${list.length ? list.map((v) => html`<div class="card row-between"><div><div class="veh-name" style="font-size:18px">${v.make} ${v.model}</div><div style="margin-top:4px">${plate(v.plate, { commercial: v.commercial_use })}</div>${v.access === 'drive' ? html`<span class="tag warn" style="margin-top:8px">Lent to you</span>` : ''}</div><button class="btn" data-act="startDrive" data-id="${v.id}">Start</button></div>`) : html`<div class="empty card">${icon('key')}<p>No vehicles to drive yet. Add one, or ask an owner to lend you theirs.</p></div>`}</div>`;
  }
  return { tab: 'drive', html: html`<div class="topbar"><h1>Drive</h1><span class="tag ${!l ? 'bad' : l.status === 'valid' ? 'good' : 'warn'}">${!l ? 'No licence added' : `Licence ${l.status}`}</span></div>${inner}`, after() {
    const t = $('#timer'); if (!t) return;
    const tick = () => { const s = Math.max(0, Math.floor((Date.now() - new Date(t.dataset.since)) / 1000)); t.textContent = [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60].map((n) => String(n).padStart(2, '0')).join(':'); };
    tick(); const id = setInterval(tick, 1000); state.cleanups.push(() => clearInterval(id));
  } };
}

const where = () => new Promise((res) => { if (!navigator.geolocation) return res({}); navigator.geolocation.getCurrentPosition((p) => res({ lat: p.coords.latitude, lng: p.coords.longitude }), () => res({}), { timeout: 2500, maximumAge: 60000 }); });

/* ------------------------------------------------------------------ alerts */
async function alertsView() {
  const { notifications, unread } = await api.get('/me/notifications');
  state.unread = unread;
  const ico = { service: 'oil', document: 'doc', odometer: 'gauge', flag: 'siren', sighting: 'eye', authorization: 'key', drive: 'wheel', citation: 'receipt', job: 'wrench', licence: 'licence', transfer: 'share', payment: 'wallet', invitation: 'users', org: 'shield' };
  return { tab: 'alerts', html: html`<div class="topbar"><h1>Alerts</h1>${unread ? html`<button class="btn ghost sm" data-act="readAll">Mark all read</button>` : ''}</div>
    ${notifications.length ? html`<div class="card" style="padding:6px 16px">${notifications.map((n) => html`<div class="notif ${n.severity} ${n.read_at ? '' : 'unread'}"><div class="dot">${icon(ico[n.kind] || 'bell')}</div><div><div class="t">${n.title}</div>${n.body ? html`<div class="small muted">${n.body}</div>` : ''}<div class="tiny muted" style="margin-top:2px">${timeAgo(n.created_at)}</div></div></div>`)}</div>`
      : html`<div class="empty card">${icon('bell')}<h3>All quiet</h3><p>We will tell you when something is coming up.</p></div>`}` };
}

/* ------------------------------------------------------------------ me */
async function meView() {
  const [lic, inv, cit, trf] = await Promise.all([api.get('/me/licence'), api.get('/me/invitations'), api.get('/me/citations'), api.get('/me/transfers')]);
  const l = lic.licence; const u = state.user;
  const days = l ? Math.ceil((Date.parse(l.expires_at) - Date.now()) / 86400000) : null;
  return { tab: 'me', html: html`
    <div class="topbar"><h1>Me</h1></div>
    <div class="card row-between" style="margin-bottom:16px"><div class="cluster" style="flex-wrap:nowrap"><div class="avatar">${initials(u.name)}</div><div><b>${u.name}</b><div class="small muted mono">${u.phone}</div></div></div><button class="btn ghost sm" data-act="logout">${icon('logout', 'sm')} Sign out</button></div>

    <div class="section-title" style="margin-top:8px"><h3>Driving licence</h3><button class="btn ghost sm" data-act="editLicence">${l ? 'Edit' : 'Add'}</button></div>
    ${l ? html`<div class="licence"><div class="row-between" style="margin-top:6px"><h3>${u.name}</h3><span class="tag ${l.status === 'valid' ? 'good' : l.status === 'pending' ? 'warn' : 'bad'}">${l.status === 'pending' ? 'Awaiting verification' : l.status}</span></div>
      <div class="no">${l.licence_number}</div>
      <div class="groups">${Object.keys(LICENCE_GROUPS).map((g) => html`<span class="grp ${l.classes.includes(g) ? '' : 'off'}" title="${LICENCE_GROUPS[g].label}">${g}</span>`)}</div>
      <div class="small">Expires ${fmtDate(l.expires_at)} ${days < 60 ? html`<b style="color:var(--bad)">(${days < 0 ? 'expired' : `${days} days`})</b>` : ''}</div>
      <div class="livecode"><div class="tiny" style="color:#9aa7a9;margin-bottom:6px">Show this to an officer. It changes every minute.</div><div class="code" id="liveCode">…</div><div class="ttl"><i id="ttl" style="width:100%"></i></div></div></div>`
      : html`<div class="empty card">${icon('licence')}<p>Add your licence so a friend's car can check you can drive it, and so police can confirm it in seconds.</p></div>`}

    ${inv.invitations.length ? html`<div class="section-title"><h3>Invitations</h3></div><div class="card">${inv.invitations.map((i) => html`<div class="li"><div class="grow"><div class="li-title">${i.org_name}</div><div class="li-sub">as ${i.role_label}</div></div><button class="btn sm" data-act="respond" data-id="${i.id}" data-accept="1">Accept</button><button class="btn ghost sm" data-act="respond" data-id="${i.id}">Decline</button></div>`)}</div>` : ''}
    ${trf.incoming.length ? html`<div class="section-title"><h3>Someone is selling you a vehicle</h3></div><div class="card">${trf.incoming.map((t) => html`<div class="li"><div class="grow"><div class="li-title">${t.make} ${t.model} ${plate(t.plate)}</div><div class="li-sub">from ${t.from_name}${t.price_minor ? ` · ${fmtGmd(t.price_minor)}` : ''}</div></div><button class="btn sm" data-act="transfer" data-id="${t.id}" data-do="accept">Accept</button><button class="btn ghost sm" data-act="transfer" data-id="${t.id}" data-do="decline">No</button></div>`)}</div>` : ''}

    <div class="section-title"><h3>Fines</h3></div>
    ${cit.citations.length ? html`<div class="card">${cit.citations.map((c) => html`<div class="li"><div class="grow"><div class="li-title">${c.title}</div><div class="li-sub">${c.number} · ${c.plate} · ${fmtGmd(c.fine_minor)}</div></div>${c.status === 'issued' ? html`${c.waivable ? html`<button class="btn sm" data-act="course" data-id="${c.id}">Waive</button>` : ''}<button class="btn ghost sm" data-act="payFine" data-id="${c.id}">Pay</button>` : html`<span class="tag ${c.status === 'issued' ? 'bad' : 'good'}">${c.status}</span>`}</div>`)}</div>` : html`<div class="card"><p class="muted small">No fines. Keep it up.</p></div>`}

    <div class="section-title"><h3>More</h3></div>
    <div class="card" style="padding:4px 16px"><a class="li" href="#/jobs">${icon('clipboard', 'lead')}<span class="grow li-title">My jobs at garages</span>${icon('chev-right', 'trail')}</a>
      <button class="li" data-act="registerGarage">${icon('wrench', 'lead')}<span class="grow li-title">Register a garage or car wash</span>${icon('chev-right', 'trail')}</button>
      <button class="li" data-act="themeToggle">${icon('gauge', 'lead')}<span class="grow li-title">Switch light and dark</span></button></div>`, after() {
    if (!l) return;
    const el = $('#liveCode'); const ttl = $('#ttl'); let exp = 0; let total = 60;
    const fetchCode = async () => { try { const c = await api.get('/me/licence/code'); el.textContent = c.code.replace('.', '\n'); el.style.whiteSpace = 'pre-line'; exp = Date.parse(c.expiresAt); total = 60; } catch { el.textContent = 'Unavailable'; } };
    fetchCode();
    const id = setInterval(() => { const left = (exp - Date.now()) / 1000; if (exp && left <= 0) fetchCode(); else if (exp) ttl.style.width = `${Math.max(0, Math.min(100, (left / total) * 100))}%`; }, 1000);
    state.cleanups.push(() => clearInterval(id));
  } };
}

/* ------------------------------------------------------------------ customer jobs */
async function jobsView() {
  const [{ jobs }, { escrow }] = await Promise.all([api.get('/me/jobs'), api.get('/momo/escrow')]);
  const byJob = Object.fromEntries(escrow.map((e) => [e.job_id, e]));
  const act = (j) => {
    const e = byJob[j.id];
    if (!j.owner_consent && j.status !== 'cancelled') return html`<button class="btn sm" data-act="consent" data-id="${j.id}" data-ok="1">Approve</button><button class="btn ghost sm" data-act="consent" data-id="${j.id}">Decline</button>`;
    if (j.status === 'quoted') return html`<button class="btn sm" data-act="acceptQuote" data-id="${j.id}">Accept ${fmtGmd(j.total_minor)}</button>`;
    if (e?.status === 'pending') return html`<button class="btn amber sm" data-act="approvePay" data-ref="${e.reference}">Approve payment</button>`;
    if (e?.status === 'held') return html`<button class="btn sm" data-act="release" data-ref="${e.reference}">Release payment</button><button class="btn ghost sm" data-act="disputePay" data-ref="${e.reference}">Dispute</button>`;
    if (!e && ['accepted', 'in_progress', 'ready'].includes(j.status) && j.total_minor) return html`<button class="btn amber sm" data-act="payJob" data-id="${j.id}" data-total="${j.total_minor}">Pay into escrow</button>`;
    if (e) return html`<span class="tag ${e.status === 'released' ? 'good' : ''}">${e.status}</span>`;
    return '';
  };
  return { tab: 'me', html: html`<div class="topbar"><a class="btn ghost icon" href="#/me" aria-label="Back">${icon('chev-left')}</a><h1>My jobs</h1><span></span></div>
    ${jobs.length ? html`<div class="stack">${jobs.map((j) => html`<div class="card"><div class="row-between"><b>${j.vehicle?.make} ${j.vehicle?.model}</b><span class="tag ${j.status === 'completed' ? 'good' : ''}">${j.status.replace('_', ' ')}</span></div>
      <div class="small muted">${j.org_name} · ${j.vehicle ? j.vehicle.plate : ''}</div><p style="margin:8px 0">“${j.complaint}”</p>${j.total_minor ? html`<div class="mono">${fmtGmd(j.total_minor)}</div>` : ''}<div class="cluster" style="margin-top:10px">${act(j)}</div></div>`)}</div>`
      : html`<div class="empty card">${icon('clipboard')}<p>No jobs yet. Open a garage from the website's directory, or a garage can open one on your behalf.</p></div>`}` };
}

/* ------------------------------------------------------------------ work (garage mode) */
const myRank = (orgId) => ORG_ROLES[state.user.memberships.find((m) => m.org_id === orgId)?.role]?.rank ?? 0;

async function workView(orgId, tab = 'jobs') {
  const orgs = state.user.memberships.filter((m) => ['garage', 'carwash'].includes(m.org_type));
  if (!orgs.length) return { tab: 'work', html: html`<div class="empty card">You are not part of a garage yet.</div>` };
  const org = orgs.find((o) => o.org_id === orgId) || orgs[0];
  const head = html`<div class="topbar"><div><div class="hello">${org.role} · ${org.employment === 'owner' ? 'owner' : 'employee'}</div><h1>${org.org_name}</h1></div>${org.org_status === 'verified' ? html`<span class="tag good">${icon('check-badge', 'sm')} Verified</span>` : html`<span class="tag warn">Awaiting verification</span>`}</div>
    ${orgs.length > 1 ? html`<div class="seg-pick" style="margin-bottom:14px">${orgs.map((o) => html`<label><input type="radio" name="orgpick" ${o.org_id === org.org_id ? 'checked' : ''} data-act="pickOrg" data-id="${o.org_id}"><span>${o.org_name}</span></label>`)}</div>` : ''}
    <div class="seg-pick" style="margin-bottom:16px"><label><input type="radio" name="wt" ${tab === 'jobs' ? 'checked' : ''} data-act="pickTab" data-org="${org.org_id}" data-tab="jobs"><span>${icon('clipboard', 'sm')} Jobs</span></label><label><input type="radio" name="wt" ${tab === 'staff' ? 'checked' : ''} data-act="pickTab" data-org="${org.org_id}" data-tab="staff"><span>${icon('users', 'sm')} Team</span></label></div>`;
  if (tab === 'staff') {
    const { members, roles, canManage } = await api.get(`/orgs/${org.org_id}/members`);
    window.__staff = { members, roles, org };
    return { tab: 'work', html: html`${head}${canManage ? html`<button class="btn block" style="margin-bottom:14px" data-act="inviteStaff" data-org="${org.org_id}">${icon('plus')} Add someone to the team</button>` : ''}
      <div class="card" style="padding:4px 16px">${members.map((m) => html`<button class="li" data-act="member" data-id="${m.id}"><div class="avatar">${initials(m.user_name || '?')}</div><div class="grow"><div class="li-title">${m.user_name || m.invited_phone}</div><div class="li-sub"><span class="role-chip">${m.role_label}</span> · ${m.employment}${m.status !== 'active' ? ` · ${m.status}` : ''}${!m.user_id ? ' · no account yet' : ''}</div></div>${canManage && m.user_id !== state.user.id ? icon('chev-right', 'trail') : ''}</button>`)}</div>` };
  }
  const { jobs } = await api.get(`/orgs/${org.org_id}/jobs`);
  window.__jobs = jobs;
  return { tab: 'work', html: html`${head}<button class="btn block" style="margin-bottom:14px" data-act="newJob" data-org="${org.org_id}">${icon('plus')} Open a job</button>
    ${jobs.length ? html`<div class="stack">${jobs.map((j) => html`<button class="card li" style="border:1px solid var(--line)" data-act="job" data-id="${j.id}"><div class="grow"><div class="row-between"><b>${j.vehicle?.make} ${j.vehicle?.model}</b><span class="tag ${j.status === 'completed' ? 'good' : j.owner_consent ? '' : 'warn'}">${j.owner_consent ? j.status.replace('_', ' ') : 'awaiting owner'}</span></div><div class="small muted">${j.vehicle?.plate} · ${j.customer_name}</div><div class="small" style="margin-top:4px">${j.complaint}</div></div></button>`)}</div>` : html`<div class="empty card">${icon('clipboard')}<p>No jobs yet.</p></div>`}` };
}

function jobSheet(j) {
  const own = state.user.memberships.find((m) => m.org_id === j.org_id);
  const staff = own && ['owner', 'manager', 'mechanic'].includes(own.role);
  let actions = '';
  if (!j.owner_consent) actions = html`<p class="small muted">Waiting for ${j.customer_name} to approve this job before anything is recorded.</p>`;
  else if (staff) {
    if (['requested', 'quoted'].includes(j.status)) actions = html`<form data-form="quote" class="stack" style="--gap:12px"><input type="hidden" name="job" value="${j.id}"><div class="grid" style="grid-template-columns:1fr 1fr">${F('Labour (D)', input('labour', `type="number" step="0.01" min="0" value="${j.labour_minor / 100 || ''}"`))}${F('Parts (D)', input('parts', `type="number" step="0.01" min="0" value="${j.parts_minor / 100 || ''}"`))}</div><button class="btn block" type="submit">${j.status === 'quoted' ? 'Update quote' : 'Send quote'}</button></form>`;
    else if (j.status === 'accepted') actions = html`<button class="btn block" data-act="jobStatus" data-id="${j.id}" data-to="in_progress">Start work</button>`;
    else if (['in_progress', 'ready'].includes(j.status)) actions = html`${j.status === 'in_progress' ? html`<button class="btn ghost block" data-act="jobStatus" data-id="${j.id}" data-to="ready">Mark ready</button>` : ''}<button class="btn amber block" style="margin-top:10px" data-act="completeJob" data-id="${j.id}">${icon('shield')} Complete and seal into passport</button>`;
  }
  openSheet({ title: `${j.vehicle?.make} ${j.vehicle?.model}`, body: html`<div class="stack"><div class="cluster">${plate(j.vehicle?.plate || '')}<span class="tag">${j.status.replace('_', ' ')}</span></div><p>“${j.complaint}”</p><div class="small muted">Customer: ${j.customer_name}${j.total_minor ? ` · Quote ${fmtGmd(j.total_minor)}` : ''}</div>${actions}</div>` });
}

function completeSheet(j) {
  const cls = VEHICLE_CLASSES[j.vehicle.vehicle_class];
  const items = Object.entries(SERVICE_ITEMS).filter(([, d]) => d.appliesTo(cls));
  openSheet({ title: 'Complete and seal', body: html`<form data-form="complete" class="stack" style="--gap:14px"><input type="hidden" name="job" value="${j.id}">
    <p class="small muted">This writes to the vehicle's passport under ${state.user.memberships.find((m) => m.org_id === j.org_id)?.org_name} and restarts the service countdowns.</p>
    ${F(`Odometer now (${cls.unit === 'hours' ? 'hours' : 'km'})`, input('odometer', `type="number" min="0" required value="${Math.round(j.vehicle.odometer)}"`))}
    ${F('Type of work', raw(`<select class="input" name="event">${opts([['ROUTINE_SERVICE', 'Routine service'], ['MAJOR_REPAIR', 'Major repair'], ['ROADWORTHINESS_TEST', 'Roadworthiness test']])}</select>`))}
    ${F('What was done', raw('<textarea class="input" name="summary" required minlength="5" maxlength="400" placeholder="e.g. Front brake pads replaced, oil and filter changed"></textarea>'))}
    <div class="field check-list"><label class="label" style="margin-bottom:4px">Restart these countdowns</label>${items.map(([k, d]) => html`<label><input type="checkbox" name="item" value="${k}" ${k === 'engine_oil' ? '' : ''}> ${d.label}</label>`)}</div>
    <div class="stack" id="oilBox" style="--gap:12px"><div class="field"><label>Oil used</label><div class="seg-pick">${Object.entries(OIL_TYPES).map(([k, o]) => html`<label><input type="radio" name="oil_type" value="${k}" ${k === 'semi_synthetic' ? 'checked' : ''}><span>${o.label}</span></label>`)}</div></div>
      <div class="grid" style="grid-template-columns:1fr 1fr">${F('Grade', raw(`<select class="input" name="oil_grade"><option value="">Not sure</option>${opts(OIL_GRADES.map((g) => [g, g]))}</select>`))}${F('Brand', input('brand'))}</div></div>
    <button class="btn amber block" type="submit">Seal it</button></form>`, onMount(el) {
    const box = $('#oilBox', el); const sync = () => box.classList.toggle('hide', !$('input[value=engine_oil]', el).checked); $('form', el).addEventListener('change', sync); sync();
  } });
}

/* ------------------------------------------------------------------ actions */
const A = {
  toggleReg(_, btn) { const f = $('#authForm'); const reg = $('.reg', f); const on = reg.classList.toggle('hide') === false; f.dataset.mode = on ? 'register' : 'login'; $('.lbl', f).textContent = on ? 'Create account' : 'Sign in'; btn.textContent = on ? 'I already have an account' : 'Create an account'; },
  quick: (d) => login(d.phone, d.pw),
  themeToggle() { const r = document.documentElement; r.setAttribute('data-theme', r.getAttribute('data-theme') === 'dark' ? 'light' : 'dark'); },
  logout() { state.stopRt?.(); api.clear(); state.user = null; navigator.serviceWorker?.controller?.postMessage('clear-api'); go('welcome'); },
  addVehicle() {
    const classes = Object.entries(VEHICLE_CLASSES).map(([k, c]) => [k, c.label]);
    openSheet({ title: 'Add a vehicle', body: html`<form data-form="addVehicle" class="stack" style="--gap:14px">
      ${F('What is it?', raw(`<select class="input" name="vehicle_class">${opts(classes, 'car')}</select>`))}
      <div class="grid" style="grid-template-columns:1fr 1fr">${F('Plate', input('plate', 'required placeholder="BJL-4821-B" autocapitalize="characters"'))}${F('Year', input('year', `type="number" required min="1950" max="${new Date().getFullYear() + 1}" placeholder="2018"`))}</div>
      <div class="grid" style="grid-template-columns:1fr 1fr">${F('Make', input('make', 'required placeholder="Toyota"'))}${F('Model', input('model', 'required placeholder="RAV4"'))}</div>
      ${F('VIN or chassis number', input('vin', 'required minlength="6" maxlength="20" autocapitalize="characters"'), 'It is on the windscreen corner or the registration book.')}
      <div class="grid" style="grid-template-columns:1fr 1fr">${F('Odometer now', input('odometer', 'type="number" min="0" required placeholder="74200"'), 'km, or hours for a tractor')}${F('Colour', input('color'))}</div>
      ${F('Fuel', raw(`<select class="input" name="fuel_type"><option value="">Not sure</option>${opts(['petrol', 'diesel', 'hybrid', 'electric', 'lpg'].map((x) => [x, x[0].toUpperCase() + x.slice(1)]))}</select>`))}
      <label class="row-between"><span>Used commercially <span class="help">(yellow plate)</span></span><input type="checkbox" name="commercial_use" style="width:22px;height:22px;accent-color:var(--rust)"></label>
      <button class="btn block" type="submit">Add vehicle</button></form>` });
  },
  logService: (d) => logServiceSheet(d.code),
  odometer() { const v = window.__veh.vehicle; openSheet({ title: 'Update odometer', body: html`<form data-form="odometer" class="stack" style="--gap:14px">${F(`Reading (${v.unit === 'hours' ? 'hours' : 'km'})`, input('value', `type="number" inputmode="decimal" min="${Math.round(v.odometer)}" required value="${Math.round(v.odometer)}"`), 'Odometers only go up. A lower number is refused and flagged to you.')}<button class="btn block" type="submit">Save</button></form>` }); },
  lend() {
    openSheet({ title: 'Lend this vehicle', body: html`<form data-form="lend" class="stack" style="--gap:14px">
      ${F('Their phone number', input('phone', 'type="tel" required placeholder="+220 7xx xxxx"'), 'They do not need an account yet.')}${F('Name (optional)', input('name'))}
      <div class="field"><label>Who are they?</label><div class="seg-pick">${Object.entries(AUTHORIZATION_KINDS).map(([k, l], i) => html`<label><input type="radio" name="kind" value="${k}" ${i === 1 ? 'checked' : ''}><span>${l}</span></label>`)}</div></div>
      <div class="grid" style="grid-template-columns:1fr 1fr">${F('From', input('starts_at', `type="datetime-local" value="${nowLocal()}"`))}${F('Until', input('ends_at', `type="datetime-local" value="${nowLocal(48)}"`), 'Clear for open-ended')}</div>
      <div class="cluster">${[['Today', 10], ['Weekend', 72], ['1 week', 168]].map(([l, h]) => html`<button type="button" class="btn ghost sm" data-act="endIn" data-h="${h}">${l}</button>`)}<button type="button" class="btn ghost sm" data-act="endIn" data-h="0">Open-ended</button></div>
      ${F('Note (optional)', input('note', 'maxlength="200"'))}<button class="btn block" type="submit">Lend it</button></form>` });
  },
  endIn(d, btn) { const el = $('[name=ends_at]', btn.closest('form')); el.value = Number(d.h) ? nowLocal(Number(d.h)) : ''; },
  revoke: (d) => run(async () => { await api.post(`/authorizations/${d.id}/revoke`); toast('Withdrawn. It takes effect immediately.', 'good'); reload(); }),
  takeBack: () => run(async () => { await api.post(`/vehicles/${window.__veh.vehicle.id}/drive/end`); toast('Done'); reload(); }),
  addDoc() { openSheet({ title: 'Add a paper', body: html`<form data-form="addDoc" class="stack" style="--gap:14px">${F('Type', raw(`<select class="input" name="kind">${opts(Object.entries(DOCUMENT_KINDS).map(([k, d]) => [k, d.label]))}</select>`))}${F('Who issued it', input('issuer', 'placeholder="e.g. Gamstar"'))}${F('Number', input('number'))}<div class="grid" style="grid-template-columns:1fr 1fr">${F('Valid from', input('valid_from', 'type="date"'))}${F('Valid until', input('valid_to', 'type="date" required'))}</div><button class="btn block" type="submit">Add</button></form>` }); },
  toggle: (d, el) => run(async () => { await api.patch(`/vehicles/${window.__veh.vehicle.id}`, { [d.key]: el.checked }); toast('Saved'); reload(); }),
  reportStolen() { openSheet({ title: 'Report stolen', body: html`<form data-form="reportStolen" class="stack" style="--gap:14px"><p class="small muted">Officers at every checkpoint can see this straight away. It becomes a full police alert when an officer confirms it, so visit a station too. False reports are recorded.</p>${F('What happened', raw('<textarea class="input" name="summary" required minlength="5" maxlength="200" placeholder="Where and when it was taken"></textarea>'))}${F('Police report number (if you have one)', input('case_ref'))}<button class="btn danger block" type="submit">Report stolen</button></form>` }); },
  withdrawStolen: () => run(async () => { await api.post(`/vehicles/${window.__veh.vehicle.id}/report-stolen/withdraw`, { reason: 'Withdrawn by owner' }); toast('Report withdrawn'); reload(); }),
  sell() { openSheet({ title: 'Sell or transfer', body: html`<form data-form="sell" class="stack" style="--gap:14px"><p class="small muted">The buyer gets an offer. Ownership only changes when they accept, and anyone you lent it to loses access.</p>${F('Buyer phone number', input('to_phone', 'type="tel" required'))}${F('Price (D, optional)', input('price', 'type="number" min="0"'))}<button class="btn block" type="submit">Send offer</button></form>` }); },
  async passport() {
    const id = window.__veh.vehicle.id; const p = await run(() => api.get(`/vehicles/${id}/passport`)); if (!p) return;
    const TYPE = { GENESIS: 'Registered', OWNER_NOTE: 'Owner note', OWNERSHIP_TRANSFER: 'Ownership changed', ROUTINE_SERVICE: 'Service', MAJOR_REPAIR: 'Major repair', ROADWORTHINESS_TEST: 'Roadworthiness test', STOLEN_REPORT: 'Reported stolen', STOLEN_RECOVERED: 'Recovered', CITATION_RESOLVED: 'Citation resolved', POLICE_CLEARANCE: 'Police clearance', OBD_DIAGNOSTIC: 'Diagnostics' };
    openSheet({ title: 'Vehicle passport', body: html`<div class="${p.verification.valid ? 'notice good' : 'notice bad'}" style="display:flex;gap:12px;padding:14px;border-radius:12px;background:${p.verification.valid ? 'color-mix(in srgb,var(--good) 15%,transparent)' : 'var(--bad)'};color:${p.verification.valid ? 'inherit' : '#fff'}">${icon(p.verification.valid ? 'check-badge' : 'alert')}<div><b>${p.verification.valid ? 'History intact' : 'Verification failed'}</b><br><span class="small">${p.verification.valid ? `${p.verification.blocks} records, signed and chained.` : p.verification.reason}</span></div></div>
      <ul class="tl2" style="margin-top:18px">${[...p.blocks].reverse().map((b) => html`<li class="${b.actor_role === 'mechanic' || b.actor_role === 'police' ? 'v' : ''}"><b>${TYPE[b.event_type] || b.event_type}</b> <span class="mono small muted">${fmtNum(b.mileage)} km</span><div class="small muted">${fmtDate(b.timestamp)} · ${b.actor_role === 'mechanic' ? `${b.actor_name}, ${b.payload?.garage || ''}` : b.actor_role}</div><div class="small">${b.description}</div></li>`)}</ul>` });
  },
  startDrive: (d) => run(async () => { const loc = await where(); const r = await api.post('/drive/start', { vehicle_id: d.id, ...loc }); if (r.warnings?.length) toast(r.warnings[0]); reload(); }),
  endDrive() { openSheet({ title: 'End drive', body: html`<form data-form="endDrive" class="stack" style="--gap:14px">${F('Odometer now (optional)', input('end_odometer', 'type="number" inputmode="decimal" min="0"'))}<button class="btn block" type="submit">End drive</button></form>` }); },
  readAll: () => run(async () => { await api.post('/me/notifications/read'); state.unread = 0; reload(); }),
  editLicence() {
    const l = window.__lic;
    api.get('/me/licence').then(({ licence }) => openSheet({ title: 'Driving licence', body: html`<form data-form="licence" class="stack" style="--gap:14px">
      <p class="small muted">Groups follow the national licence: A private car, B motorcycle, C commercial, D special type. The licensing authority verifies it. Until then it shows as awaiting verification.</p>
      ${F('Licence number', input('licence_number', `required value="${esc(licence?.licence_number || '')}" autocapitalize="characters"`))}
      <div class="field"><label>Groups you hold</label><div class="seg-pick">${Object.entries(LICENCE_GROUPS).map(([k, g]) => html`<label><input type="checkbox" name="grp" value="${k}" ${licence?.classes?.includes(k) ? 'checked' : ''}><span><b>${k}</b> ${g.label}</span></label>`)}</div></div>
      ${F('Expiry date', input('expires_at', `type="date" required value="${(licence?.expires_at || '').slice(0, 10)}"`))}<button class="btn block" type="submit">Save</button></form>` }));
  },
  respond: (d) => run(async () => { await api.post(`/memberships/${d.id}/respond`, { accept: d.accept === '1' }); toast(d.accept === '1' ? 'Welcome to the team' : 'Declined', 'good'); await loadMe(); reload(); }),
  transfer: (d) => run(async () => { await api.post(`/transfers/${d.id}/${d.do}`); toast(d.do === 'accept' ? 'It is yours. Check its history.' : 'Declined', 'good'); reload(); }),
  course: (d) => run(async () => {
    const c = await api.get(`/citations/${d.id}/course`);
    openSheet({ title: 'Defensive driving course', body: html`<form data-form="waive" class="stack" style="--gap:18px"><input type="hidden" name="id" value="${d.id}"><p class="small muted">Answer ${c.passMark} of ${c.questions.length} correctly and this fine is waived.</p>${c.questions.map((q, i) => html`<div data-q="${i}"><b>${i + 1}. ${q.q}</b><div class="stack" style="--gap:6px;margin-top:8px">${q.options.map((o, k) => html`<label class="seg-pick"><span style="display:flex;width:100%;border-radius:10px;justify-content:flex-start"><input type="radio" name="q${i}" value="${k}" style="margin-right:8px">${o}</span></label>`)}</div></div>`)}<button class="btn block" type="submit">Submit answers</button></form>` });
  }),
  payFine: (d) => run(async () => { await api.post(`/citations/${d.id}/pay`); toast('Paid (sandbox)', 'good'); reload(); }),
  registerGarage() { openSheet({ title: 'Register a business', body: html`<form data-form="registerOrg" class="stack" style="--gap:14px"><p class="small muted">Garages and car washes are verified by an administrator before they appear in the directory or can seal records into passports.</p>${F('Type', raw(`<select class="input" name="type">${opts([['garage', 'Garage or workshop'], ['carwash', 'Car wash'], ['fleet', 'Fleet (my own vehicles)']])}</select>`))}${F('Business name', input('name', 'required minlength="2"'))}${F('Area', input('location', 'placeholder="e.g. Serrekunda"'))}${F('Bays', input('bays', 'type="number" min="0" value="2"'))}<button class="btn block" type="submit">Register</button></form>` }); },
  consent: (d) => run(async () => { await api.post(`/jobs/${d.id}/consent`, { approve: d.ok === '1' }); reload(); }),
  acceptQuote: (d) => run(async () => { await api.post(`/jobs/${d.id}/accept`); toast('Quote accepted', 'good'); reload(); }),
  payJob: (d) => openSheet({ title: 'Pay into escrow', body: html`<form data-form="pay" class="stack" style="--gap:14px"><input type="hidden" name="job" value="${d.id}"><p class="small muted">${fmtGmd(d.total)} is held safely and only released to the garage when you say so.</p>${F('Mobile money', raw(`<select class="input" name="provider">${opts([['afrimoney', 'Afrimoney'], ['qmoney', 'QMoney']])}</select>`))}${F('Your number', input('phone', 'type="tel" required'))}<button class="btn block" type="submit">Start payment</button></form>` }),
  approvePay: (d) => run(async () => { await api.post(`/momo/escrow/${d.ref}/sandbox-approve`); toast('Payment held in escrow (sandbox)', 'good'); reload(); }),
  release: (d) => run(async () => { await api.post(`/momo/escrow/${d.ref}/release`); toast('Released to the garage', 'good'); reload(); }),
  disputePay: (d) => run(async () => { await api.post(`/momo/escrow/${d.ref}/dispute`); toast('Dispute opened. An administrator will decide.'); reload(); }),
  pickOrg: (d) => go(`work/${d.id}`),
  pickTab: (d) => go(`work/${d.org}/${d.tab}`),
  newJob: (d) => openSheet({ title: 'Open a job', body: html`<form data-form="newJob" class="stack" style="--gap:14px"><input type="hidden" name="org" value="${d.org}"><p class="small muted">The vehicle's owner must approve it before you can record any work.</p>${F('Plate', input('plate', 'required autocapitalize="characters"'))}${F('What needs doing', raw('<textarea class="input" name="complaint" required minlength="3" maxlength="500"></textarea>'))}<button class="btn block" type="submit">Open job</button></form>` }),
  job: (d) => jobSheet(window.__jobs.find((j) => j.id === d.id)),
  jobStatus: (d) => run(async () => { await api.patch(`/jobs/${d.id}`, { status: d.to }); closeAllSheets(); reload(); }),
  completeJob: (d) => { closeAllSheets(); completeSheet(window.__jobs.find((j) => j.id === d.id)); },
  inviteStaff(d) {
    const { roles, org } = window.__staff; const mine = myRank(d.org);
    const allowed = roles.filter((r) => ORG_ROLES[r].rank < mine).map((r) => [r, ORG_ROLES[r].label]);
    openSheet({ title: 'Add to the team', body: html`<form data-form="invite" class="stack" style="--gap:14px"><input type="hidden" name="org" value="${d.org}"><p class="small muted">They get an invitation by phone number. It attaches to their account when they sign up.</p>${F('Phone number', input('phone', 'type="tel" required'))}${F('Role', raw(`<select class="input" name="role">${opts(allowed)}</select>`), 'You can only add roles below your own.')}${F('Relationship', raw(`<select class="input" name="employment">${opts([['employee', 'Employee'], ['contractor', 'Contractor']])}</select>`))}<button class="btn block" type="submit">Send invitation</button></form>` });
  },
  member(d) {
    const { members, roles, org } = window.__staff; const m = members.find((x) => x.id === d.id); const mine = myRank(org.org_id);
    if (!m || m.user_id === state.user.id || (ORG_ROLES[m.role]?.rank ?? 0) >= mine || mine < ORG_ROLES.manager.rank) return;
    const allowed = roles.filter((r) => ORG_ROLES[r].rank < mine).map((r) => [r, ORG_ROLES[r].label]);
    openSheet({ title: m.user_name || m.invited_phone, body: html`<div class="stack" style="--gap:14px">${F('Role', raw(`<select class="input" id="roleSel">${opts(allowed, m.role)}</select>`))}
      <button class="btn block" data-act="saveRole" data-id="${m.id}">Save role</button>
      <button class="btn ghost block" data-act="setStatus" data-id="${m.id}" data-to="${m.status === 'suspended' ? 'active' : 'suspended'}">${m.status === 'suspended' ? 'Reactivate' : 'Suspend access'}</button>
      <button class="btn danger block" data-act="removeMember" data-id="${m.id}">Remove from the team</button></div>` });
  },
  saveRole: (d) => run(async () => { await api.patch(`/memberships/${d.id}`, { role: $('#roleSel').value }); closeAllSheets(); toast('Saved', 'good'); reload(); }),
  setStatus: (d) => run(async () => { await api.patch(`/memberships/${d.id}`, { status: d.to }); closeAllSheets(); reload(); }),
  removeMember: (d) => run(async () => { await api.del(`/memberships/${d.id}`); closeAllSheets(); toast('Removed'); reload(); }),
};

Object.assign(formsV, {
  async endDrive(d, f, ctl) { const r = await api.post('/drive/end', { end_odometer: d.end_odometer || undefined }); ctl.close(); toast(r.distance != null ? `Drive ended. ${fmtNum(r.distance)} km.` : 'Drive ended', 'good'); reload(); },
  async registerOrg(d, f, ctl) { await api.post('/orgs', { ...d, bays: Number(d.bays || 0) }); ctl.close(); toast('Registered. An administrator will verify it.', 'good'); await loadMe(); go('work'); },
});

/* ------------------------------------------------------------------ events */
document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-act]'); if (!t) return;
  if (t.tagName === 'INPUT' && t.type === 'checkbox') return; // handled on change
  if (t.tagName === 'INPUT' && t.type === 'radio') return;
  const fn = A[t.dataset.act]; if (!fn) return;
  if (t.tagName === 'A' || t.tagName === 'BUTTON') e.preventDefault?.();
  fn({ ...t.dataset }, t);
});
document.addEventListener('change', (e) => { const t = e.target.closest('[data-act]'); if (t && (t.type === 'checkbox' || t.type === 'radio')) A[t.dataset.act]?.({ ...t.dataset }, t); });
document.addEventListener('submit', async (e) => {
  const form = e.target.closest('form[data-form]'); if (!form) return;
  e.preventDefault();
  const btn = $('button[type=submit]', form); btn && (btn.disabled = true);
  const name = form.dataset.form; const sheet = form.closest('.sheet');
  const ctl = { close: () => { $$('.scrim').forEach((s) => s.remove()); sheet?.remove(); } };
  try {
    if (name === 'auth') { const d = formData(form); await (form.dataset.mode === 'register' ? register(d) : login(d.phone, d.password)); }
    else await formsV[name](formData(form), form, ctl);
  } catch (err) { toast(err.message, 'bad'); }
  finally { btn && (btn.disabled = false); }
});

/* ------------------------------------------------------------------ auth + boot */
async function loadMe() {
  state.user = (await api.get('/auth/me')).user;
  state.cat ||= await api.get('/public/catalog').catch(() => null);
  if (!state.stopRt) state.stopRt = connectRealtime(api.token(), (m) => {
    if (m.type === 'NOTIFICATION') { state.unread++; toast(m.notification.title, m.notification.severity === 'urgent' ? 'bad' : ''); if (location.hash.startsWith('#/alerts') || location.hash.startsWith('#/garage') || location.hash.startsWith('#/vehicle')) route(); }
  });
  try { state.unread = (await api.get('/me/notifications')).unread; } catch { /* offline */ }
}
async function login(phone, password) { const r = await api.post('/auth/login', { phone, password }); api.setToken(r.token); await loadMe(); go('garage'); }
async function register(d) { const r = await api.post('/auth/register', { name: d.name, phone: d.phone, password: d.password }); api.setToken(r.token); await loadMe(); go('garage'); }

const routes = { welcome: welcomeView, garage: garageView, vehicle: vehicleView, drive: driveView, alerts: alertsView, me: meView, jobs: jobsView, work: workView };
let seq = 0;
async function route() {
  const my = ++seq; state.cleanups.splice(0).forEach((f) => f());
  const [name = 'garage', ...args] = (location.hash.replace(/^#\/?/, '') || 'garage').split('/');
  try {
    if (!state.user && api.token()) { try { await loadMe(); } catch (e) { if (e.offline) throw e; } }
    const view = state.user ? name : 'welcome';
    if (!routes[view]) return go('garage');
    const out = await routes[view](...args);
    if (my !== seq) return; // a newer navigation won
    app.innerHTML = (out.bare ? out.html : shell(out.tab, out.html)).toString();
    window.scrollTo(0, 0); animateIn(app); out.after?.();
  } catch (e) {
    app.innerHTML = shell('garage', html`<div class="empty card" style="margin-top:40px">${icon('alert')}<h3>${e.offline ? 'You are offline' : 'That did not load'}</h3><p style="margin:8px 0 16px">${e.message}</p><button class="btn" data-act="retry">Try again</button></div>`).toString();
  }
}
A.retry = () => route();
window.addEventListener('hashchange', route);
route();
