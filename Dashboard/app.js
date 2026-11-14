'use strict';
/* =====================================================================
   PulseCare – Smart IoT Heart Monitoring & Healthcare Dashboard
   Sensor -> Firebase -> Dashboard -> Classifier -> Alerts / Emergency
   ===================================================================== */

/* ---------- 0. CONFIG ---------- */
const firebaseConfig = {
  apiKey: "AIzaSyCa0PnO-hBUtVUoBKKNCBvC59_ZDIGJIQY",
  authDomain: "sic-task1-lab-2.firebaseapp.com",
  databaseURL: "https://sic-task1-lab-2-default-rtdb.firebaseio.com",
  projectId: "sic-task1-lab-2",
  storageBucket: "sic-task1-lab-2.firebasestorage.app",
  messagingSenderId: "305141697364",
  appId: "1:305141697364:web:8c5b084e7235a39eb88034"
};
const DEFAULT_CENTER = [30.0444, 31.2357]; // map fallback if location is denied
const safeJSON = s => { try { return JSON.parse(s) || {}; } catch { return {}; } };
const settings = Object.assign({ mute: false }, safeJSON(localStorage.getItem('hm_settings')));
let MODE = localStorage.getItem('hm_mode') === 'demo' ? 'demo' : 'live';


/* ---------- 0b. DYNAMIC RULES (editable by admins, shared through the database) ---------- */
const RULE_DEFS = [
  { key: 'hrAttHi', group: 'hr', label: 'Heart rate - attention (high)', unit: 'BPM', def: 100, min: 40, max: 250, step: 1 },
  { key: 'hrAttLo', group: 'hr', label: 'Heart rate - attention (low)', unit: 'BPM', def: 50, min: 20, max: 120, step: 1 },
  { key: 'hrCritHi', group: 'hr', label: 'Heart rate - critical (high)', unit: 'BPM', def: 130, min: 40, max: 250, step: 1 },
  { key: 'hrCritLo', group: 'hr', label: 'Heart rate - critical (low)', unit: 'BPM', def: 40, min: 10, max: 120, step: 1 },
  { key: 'tempAttHi', group: 'temp', label: 'Body temperature - attention (high)', unit: '°C', def: 37.8, min: 35, max: 42, step: .1 },
  { key: 'tempCritHi', group: 'temp', label: 'Body temperature - critical (high)', unit: '°C', def: 39, min: 35, max: 43, step: .1 },
  { key: 'tempAttLo', group: 'temp', label: 'Body temperature - attention (low)', unit: '°C', def: 35.5, min: 30, max: 38, step: .1 },
  { key: 'tempCritLo', group: 'temp', label: 'Body temperature - critical (low)', unit: '°C', def: 34, min: 25, max: 38, step: .1 },
  { key: 'spo2AttLo', group: 'spo2', label: 'Blood oxygen (SpO₂) - attention (low)', unit: '%', def: 95, min: 70, max: 100, step: 1 },
  { key: 'spo2CritLo', group: 'spo2', label: 'Blood oxygen (SpO₂) - critical (low)', unit: '%', def: 90, min: 50, max: 99, step: 1 },
  { key: 'rapidWindowSec', group: 'trend', label: 'Rapid-change window', unit: 's', def: 30, min: 5, max: 600, step: 1 },
  { key: 'rapidRise', group: 'trend', label: 'Rapid rise that needs attention', unit: 'BPM', def: 30, min: 5, max: 120, step: 1 },
  { key: 'staleSec', group: 'trend', label: 'Signal timeout (signal counts as lost after)', unit: 's', def: 15, min: 5, max: 120, step: 1 },
  { key: 'lossWindow', group: 'trend', label: 'Signal-loss look-back', unit: 'readings', def: 8, min: 3, max: 30, step: 1 }
];
const RULE_BY_KEY = Object.fromEntries(RULE_DEFS.map(d => [d.key, d]));
const RULE_DEFAULTS = Object.assign(Object.fromEntries(RULE_DEFS.map(d => [d.key, d.def])), { ageAdjust: true });
const storedRules = safeJSON(localStorage.getItem('pc_rules'));
const rules = Object.assign({}, RULE_DEFAULTS, storedRules.values || {});
if (!storedRules.values && isFinite(settings.staleSec)) rules.staleSec = settings.staleSec;      // migrate old setting
if (!storedRules.values && isFinite(settings.lossWindow)) rules.lossWindow = settings.lossWindow;
let rulesMeta = storedRules.meta || {};
function applyRules(values, meta) {
  Object.assign(rules, RULE_DEFAULTS, values || {});
  rulesMeta = meta || {};
  localStorage.setItem('pc_rules', JSON.stringify({ values: { ...rules }, meta: rulesMeta }));
  state.loss = {};                       // signal-loss verdicts depend on the rules, so recompute them
  Object.keys(state.live).forEach(evaluate);
  if (state.view === 'settings' && state.stab === 'rules' && !state.rulesDirty) renderRulesForm();
  scheduleRender();
}
function validateRules(v) {
  const err = {};
  RULE_DEFS.forEach(d => {
    const x = v[d.key];
    if (typeof x !== 'number' || !isFinite(x)) err[d.key] = 'Enter a number';
    else if (x < d.min || x > d.max) err[d.key] = `Allowed range ${d.min} to ${d.max}`;
  });
  const lt = (a, b, key, msg) => { if (!err[a] && !err[b] && !(v[a] < v[b]) && !err[key]) err[key] = msg; };
  lt('hrCritLo', 'hrAttLo', 'hrCritLo', 'Must be lower than attention (low)');
  lt('hrAttLo', 'hrAttHi', 'hrAttHi', 'Must be higher than attention (low)');
  lt('hrAttHi', 'hrCritHi', 'hrCritHi', 'Must be higher than attention (high)');
  lt('tempCritLo', 'tempAttLo', 'tempCritLo', 'Must be lower than attention (low)');
  lt('tempAttLo', 'tempAttHi', 'tempAttHi', 'Must be higher than attention (low)');
  lt('tempAttHi', 'tempCritHi', 'tempCritHi', 'Must be higher than attention (high)');
  lt('spo2CritLo', 'spo2AttLo', 'spo2CritLo', 'Must be lower than attention (low)');
  return err;
}

/* ---------- 0c. ROLES, PERMISSIONS & ACCOUNTS ---------- */
const ROLES = {
  admin: { label: 'Administrator', tone: 'violet', blurb: 'Full control: rule thresholds, patients, care team, user accounts and data tools.', perms: ['*'] },
  nurse: {
    label: 'Nurse', tone: 'brand', blurb: 'Monitors patients, handles alerts and updates patient records. Cannot delete records, change rules or manage users.',
    perms: ['view.overview', 'view.focus', 'view.monitor', 'view.patients', 'view.staff', 'view.alerts', 'view.analysis', 'view.map',
      'patient.add', 'patient.edit', 'patient.link', 'alert.ack', 'alert.resolve', 'emergency', 'export.vitals']
  },
  hospital: {
    label: 'Hospital', tone: 'info', blurb: 'Read-only clinical view for a receiving hospital: patients, alerts, analysis and the emergency map.',
    perms: ['view.overview', 'view.focus', 'view.monitor', 'view.patients', 'view.alerts', 'view.analysis', 'view.map', 'alert.ack', 'emergency']
  }
};
const CAPABILITIES = [
  ['Overview, live monitor and health analysis', 'view.monitor'],
  ['Emergency map and emergency panel', 'emergency'],
  ['View patient list', 'view.patients'],
  ['Add and edit patients', 'patient.edit'],
  ['Delete patients', 'patient.delete'],
  ['Link an IoT device to a patient', 'patient.link'],
  ['View care team', 'view.staff'],
  ['Add, edit and delete staff', 'staff.manage'],
  ['Acknowledge alerts', 'alert.ack'],
  ['Resolve alerts', 'alert.resolve'],
  ['Export vitals and analysis (CSV)', 'export.vitals'],
  ['Edit rule thresholds', 'rules.edit'],
  ['Data source and database tools', 'data.tools'],
  ['Manage user accounts', 'users.manage']
];
const DEFAULT_ACCOUNTS = [
  { id: 'u_admin', name: 'Admin User', username: 'admin', role: 'admin', demo: 'admin123' },
  { id: 'u_nurse', name: 'Nurse Hany Mostafa', username: 'nurse', role: 'nurse', staffId: 'demo_s2', demo: 'nurse123' },
  { id: 'u_hospital', name: 'City Hospital', username: 'hospital', role: 'hospital', demo: 'hospital123' }
];
// Light-weight hash so passwords are not stored as plain text. This is front-end gating only.
const pwHash = s => {
  s = 'pulsecare:' + s; let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); h1 = Math.imul(h1 ^ c, 2654435761); h2 = Math.imul(h2 ^ c, 1597334677); }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
};
let users = (() => {
  try { const v = JSON.parse(localStorage.getItem('pc_users')); if (Array.isArray(v) && v.length) return v; } catch { /* first run */ }
  const seed = DEFAULT_ACCOUNTS.map(({ demo, ...u }) => ({ ...u, pass: pwHash(demo) }));
  localStorage.setItem('pc_users', JSON.stringify(seed));
  return seed;
})();
const saveUsers = () => localStorage.setItem('pc_users', JSON.stringify(users));
let session = null;
const can = perm => { const r = ROLES[session?.role]; return !!r && (r.perms.includes('*') || r.perms.includes(perm)); };

/* ---------- 1. HELPERS ---------- */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const isNum = v => typeof v === 'number' && !isNaN(v);
const fmt = (v, d = 0) => isNum(v) ? v.toFixed(d) : '--';
const initials = n => String(n || '?').replace(/^(dr|nurse|paramedic)\.?\s+/i, '').split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase();
const hhmmss = ts => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const toList = obj => obj ? Object.entries(obj).filter(([, v]) => v && typeof v === 'object').map(([id, v]) => ({ id, ...v })) : [];
const clean = o => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
function timeAgo(ts) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

const ICONS = {
  heart: '<path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>',
  grid: '<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/>',
  activity: '<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>',
  users: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  briefcase: '<rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/>',
  bell: '<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>',
  pin: '<path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/>',
  sliders: '<line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/>',
  volume: '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/>',
  'volume-x': '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/>',
  sun: '<circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>',
  moon: '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>',
  menu: '<line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="18" x2="21" y2="18"/>',
  alert: '<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  thermo: '<path d="M14 14.76V3.5a2.5 2.5 0 0 0-5 0v11.26a4.5 4.5 0 1 0 5 0z"/>',
  drop: '<path d="M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0z"/>',
  watch: '<circle cx="12" cy="12" r="7"/><polyline points="12 9 12 12 13.5 13.5"/><path d="M16.51 17.35l-.35 3.83a2 2 0 0 1-2 1.82H9.83a2 2 0 0 1-2-1.82l-.35-3.83m.01-10.7l.35-3.83A2 2 0 0 1 9.83 1h4.35a2 2 0 0 1 2 1.82l.35 3.83"/>',
  search: '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
  plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
  database: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
  edit: '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>',
  trash: '<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>',
  x: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
  phone: '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/>',
  check: '<polyline points="20 6 9 17 4 12"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
  lock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>',
  user: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  chart: '<line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/>',
  clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
  mail: '<path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/>',
  'trending-up': '<polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/>',
  'arrow-left': '<line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>',
  'arrow-right': '<line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/>',
  rotate: '<polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>',
  'check-circle': '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>',
  zap: '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>',
  eye: '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>',
  chevron: '<polyline points="6 9 12 15 18 9"/>',
  info: '<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>'
};
const ico = (n, size) => `<svg class="ico" viewBox="0 0 24 24" ${size ? `style="width:${size}px;height:${size}px"` : ''}>${ICONS[n] || ''}</svg>`;
function paintIcons(root = document) { $$('[data-icon]', root).forEach(el => { if (!el.dataset.painted) { el.insertAdjacentHTML('afterbegin', ico(el.dataset.icon)); el.dataset.painted = '1'; } }); }


function setHTML(el, html) { if (!el || el._h === html) return; el._h = html; el.innerHTML = html; }
const fmtDT = ts => { const d = new Date(ts); return `${d.getDate()} ${d.toLocaleString('en-GB', { month: 'short' })} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
function dayLabel(ts) {
  const d = new Date(ts), t = new Date(), s = x => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime(), diff = Math.round((s(t) - s(d)) / 864e5);
  return diff === 0 ? 'Today' : diff === 1 ? 'Yesterday' : d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
}

/* ---------- 2. STATE ---------- */
const DEVICE_VIEWS = {
  overview: ['Overview', 'Every monitored patient at a glance'],
  focus: ['Patient focus', 'Drill into a group of patients'],
  monitor: ['Live monitor', 'Real-time vitals, trend and classification'],
  patients: ['Patients', 'Profiles, baselines and assigned care'],
  staff: ['Care team', 'Doctors, nurses and emergency responders'],
  alerts: ['Alerts', 'Automatic notifications and their follow-up'],
  analysis: ['Health analysis', 'Trends, time in range and risk insights'],
  map: ['Emergency map', 'Nearest hospitals for critical cases'],
  settings: ['Settings & data', 'Rules, access control, data source and database tools']
};
const state = {
  patients: [], staff: [], alerts: [], linkedPatient: null, deviceRaw: null, deviceFedPid: null,
  live: {}, hist: {}, status: {}, loss: {}, lastRaw: {}, lastLog: {}, histLoaded: {},
  selected: null, view: 'overview', filter: 'all', afilter: 'all', metric: 'bpm', range: 60,
  alertsReady: false, lastAlertKey: {}, connected: false, sim: {},
  focus: 'critical', fsort: 'severity', fmode: 'cards',
  sfilter: 'all', dutyOnly: false, asev: 'all',
  asel: 'all', arange: 100, stab: 'general', rulesLog: [], rulesDirty: false
};
const patientById = id => state.patients.find(p => p.id === id);
const staffById = id => state.staff.find(s => s.id === id);
const opName = () => session?.name || 'Control room';

/* ---------- 3. BACKEND (Firebase live  |  in-memory demo) ---------- */
function createLiveBackend() {
  firebase.initializeApp(firebaseConfig);
  const db = firebase.database();
  return {
    kind: 'live',
    listen(path, cb) { const r = db.ref(path); const fn = r.on('value', s => cb(s.val()), e => console.error(path, e.message)); return () => r.off('value', fn); },
    push(path, obj) { const r = db.ref(path).push(); r.set(clean(obj)).catch(e => toast(e.message, 'critical')); return r.key; },
    set(path, obj) { return db.ref(path).set(obj).catch(e => toast(e.message, 'critical')); },
    update(path, obj) { return db.ref(path).update(clean(obj)).catch(e => toast(e.message, 'critical')); },
    remove(path) { return db.ref(path).remove().catch(e => toast(e.message, 'critical')); },
    last(path, n) { return db.ref(path).limitToLast(n).once('value').then(s => s.val()).catch(() => null); },
    onConnection(cb) { db.ref('.info/connected').on('value', s => cb(!!s.val())); }
  };
}
function createDemoBackend() {
  const tree = {}, listeners = [];
  const parts = p => p.split('/').filter(Boolean);
  const get = p => parts(p).reduce((o, k) => (o && o[k] !== undefined ? o[k] : undefined), tree);
  const put = (p, v) => {
    const ks = parts(p); let o = tree;
    ks.slice(0, -1).forEach(k => { if (!o[k] || typeof o[k] !== 'object') o[k] = {}; o = o[k]; });
    if (v === null || v === undefined) delete o[ks[ks.length - 1]]; else o[ks[ks.length - 1]] = v;
  };
  const notify = p => listeners.forEach(l => { if (l.path === p || l.path.startsWith(p + '/') || p.startsWith(l.path + '/')) l.cb(JSON.parse(JSON.stringify(get(l.path) ?? null))); });
  const key = () => 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  return {
    kind: 'demo',
    listen(path, cb) { const l = { path, cb }; listeners.push(l); setTimeout(() => cb(JSON.parse(JSON.stringify(get(path) ?? null))), 0); return () => listeners.splice(listeners.indexOf(l), 1); },
    push(path, obj) { const k = key(); put(`${path}/${k}`, clean(obj)); notify(path); return k; },
    set(path, obj) { put(path, obj); notify(path); return Promise.resolve(); },
    update(path, obj) { Object.entries(clean(obj)).forEach(([k, v]) => put(`${path}/${k}`, v)); notify(path); return Promise.resolve(); },
    remove(path) { put(path, null); notify(path); return Promise.resolve(); },
    last(path) { return Promise.resolve(get(path) ?? null); },
    onConnection(cb) { cb(true); }
  };
}
let Backend;
try { Backend = MODE === 'demo' ? createDemoBackend() : createLiveBackend(); }
catch (e) { console.error('Firebase unavailable, switching to demo', e); MODE = 'demo'; Backend = createDemoBackend(); setTimeout(() => toast('Firebase could not load, running in demo mode.', 'attention'), 600); }

/* ---------- 4. SAMPLE NORMALISATION ---------- */
const pick = (o, keys) => { for (const k of keys) { if (o[k] !== undefined && o[k] !== null && o[k] !== '') { const n = Number(o[k]); if (!isNaN(n)) return n; } } return null; };
function parseTs(v) {
  if (v === undefined || v === null || v === '') return null;
  let n = Number(v);
  if (!isNaN(n)) { if (n < 1e11) n *= 1000; return n < 1.4e12 ? null : n; }
  const d = Date.parse(v); return isNaN(d) ? null : d;
}
function normalize(raw) {
  let bpm = pick(raw, ['heart_rate', 'bpm', 'hr', 'pulse', 'heartRate']);
  let temp = pick(raw, ['temperature', 'temp']);
  let spo2 = pick(raw, ['spo2', 'SpO2', 'o2', 'oxygen']);
  if (bpm !== null && bpm <= 0) bpm = null;
  if (spo2 !== null && spo2 <= 0) spo2 = null;
  const w = raw.is_wearing ?? raw.wearing ?? raw.finger_detected;
  const wearing = w === undefined ? bpm !== null : (w === true || w === 'true' || w === 1 || w === '1');
  const tsRaw = parseTs(raw.timestamp ?? raw.time);
  const now = Date.now();
  const ts = tsRaw || now;
  return { bpm, temp, spo2, wearing, ts, rx: (tsRaw && now - tsRaw > 5 * 60 * 1000) ? tsRaw : now };
}

/* ---------- 5. CLASSIFICATION ENGINE (driven by the editable rules) ---------- */
function limitsFor(p) {
  const age = Number(p?.age) || 40;
  const bump = rules.ageAdjust ? (age < 12 ? 20 : age < 18 ? 10 : 0) : 0;
  const attHi = rules.hrAttHi + bump, critHi = Math.max(rules.hrCritHi + bump, attHi + 1);
  const attLo = rules.hrAttLo, critLo = Math.min(rules.hrCritLo, attLo - 1);
  return {
    bpm: { critLo, attLo, attHi, critHi, unit: 'BPM', normal: `${attLo}–${attHi}` },
    temp: { critLo: rules.tempCritLo, attLo: rules.tempAttLo, attHi: rules.tempAttHi, critHi: rules.tempCritHi, unit: '°C', normal: `${rules.tempAttLo.toFixed(1)}–${rules.tempAttHi.toFixed(1)}` },
    spo2: { critLo: rules.spo2CritLo, attLo: rules.spo2AttLo, attHi: 101, critHi: 102, unit: '%', normal: `${rules.spo2AttLo}–100` }
  };
}
function severity(v, r) {
  if (v >= r.attLo && v <= r.attHi) return 0;
  if (v > r.attHi) return v >= r.critHi ? 100 : 35 + 65 * (v - r.attHi) / Math.max(.1, r.critHi - r.attHi);
  return v <= r.critLo ? 100 : 35 + 65 * (r.attLo - v) / Math.max(.1, r.attLo - r.critLo);
}
const VNAME = { bpm: 'Heart rate', temp: 'Temperature', spo2: 'SpO₂' };
function classify(s, p, recent = []) {
  const LIM = limitsFor(p), reasons = [], sev = {};
  ['bpm', 'temp', 'spo2'].forEach(k => {
    sev[k] = isNum(s[k]) ? severity(s[k], LIM[k]) : null;
    if (!sev[k]) return;
    reasons.push({ level: sev[k] >= 100 ? 'critical' : 'attention', text: `${VNAME[k]} ${s[k] > LIM[k].attHi ? 'high' : 'low'}: ${fmt(s[k], k === 'temp' ? 1 : 0)} ${LIM[k].unit}` });
  });
  const vals = Object.values(sev).filter(v => v !== null);
  const maxSev = vals.length ? Math.max(...vals) : 0;
  const W = { bpm: .45, spo2: .35, temp: .2 };
  let ws = 0, wt = 0; Object.keys(W).forEach(k => { if (sev[k] !== null) { ws += sev[k] * W[k]; wt += W[k]; } });
  let score = .6 * maxSev + .4 * (wt ? ws / wt : 0);
  // rapid change: how far did the heart rate climb inside the configured time window?
  const winMs = rules.rapidWindowSec * 1000;
  const win = recent.filter(r => isNum(r.bpm) && r.ts >= s.ts - winMs && r.ts <= s.ts).map(r => r.bpm);
  const rise = isNum(s.bpm) && win.length ? s.bpm - Math.min(...win) : 0;
  const rapid = rise >= rules.rapidRise;
  if (rapid) { score += 15; reasons.push({ level: 'attention', text: `Rapid heart-rate acceleration (+${Math.round(rise)} BPM in ${rules.rapidWindowSec}s)` }); }
  const base = p?.condition || 'Normal';
  if (/crit/i.test(base)) score += 8; else if (/attent/i.test(base)) score += 4;
  score = Math.min(100, Math.round(score));
  const level = (maxSev >= 100 || score >= 75) ? 'critical' : (maxSev > 0 || score >= 20 || rapid) ? 'attention' : 'normal';
  if (!reasons.length) reasons.push({ level: 'normal', text: 'All tracked vitals are within healthy thresholds' });
  return { level, score, reasons, sev, rapid, rise, confidence: Math.min(98, 62 + vals.length * 10 + Math.min(recent.length, 10)) };
}
function analyzeSignalLoss(pid) {
  const p = patientById(pid);
  const before = (state.hist[pid] || []).filter(s => s.wearing && isNum(s.bpm)).slice(-rules.lossWindow);
  if (before.length < 2) return { level: 'attention', type: 'signal-lost', title: 'Signal lost', msg: 'No signal, and there is not enough earlier data to explain why.', before, rise: 0 };
  const bpms = before.map(s => s.bpm), last = before[before.length - 1], rise = last.bpm - Math.min(...bpms);
  const c = classify(last, p, before.slice(0, -1));
  if (rise >= rules.rapidRise) return { level: 'critical', type: 'rapid-acceleration-loss', title: 'Emergency: signal lost after rapid BPM rise', msg: `Heart rate climbed by ${Math.round(rise)} BPM just before the signal dropped. Treat as a critical case.`, before, rise };
  if (c.level === 'critical') return { level: 'critical', type: 'critical-before-loss', title: 'Emergency: signal lost while critical', msg: 'Vitals were already critical when the signal dropped.', before, rise };
  if (c.level === 'normal') return { level: 'attention', type: 'sensor-not-secure', title: 'Sensor not secure', msg: 'Vitals were normal and stable before the signal dropped, so the sensor has most likely slipped or loosened.', before, rise };
  return { level: 'attention', type: 'signal-lost-abnormal', title: 'Signal lost while vitals were abnormal', msg: 'Vitals were already outside normal range before the signal dropped.', before, rise };
}
const getStatus = pid => state.status[pid] || { level: 'none', kind: 'nodata', reasons: [{ level: 'normal', text: 'No readings received yet' }], score: 0 };
const LVL = { normal: 'Normal', attention: 'Needs attention', critical: 'Critical' };
function stLabel(st) {
  if (st.kind === 'signal-loss') return st.level === 'critical' ? 'Emergency · signal lost' : 'Signal lost';
  if (st.kind === 'offline') return 'Device offline';
  if (st.kind === 'nodata') return 'No data';
  return LVL[st.level] || 'No data';
}
const stCls = st => ['normal', 'attention', 'critical'].includes(st.level) ? st.level : 'none';
function recommendations(st) {
  if (st.kind === 'signal-loss') {
    if (st.type === 'sensor-not-secure') return ['Notify the nurse: "Sensor not secure"', 'Check the strap or finger placement', 'Confirm the patient is comfortable and well'];
    if (st.level === 'critical') return ['Treat as an emergency and send staff to the patient now', 'Call the patient or their emergency contact', 'Locate the nearest hospital on the Emergency map'];
    return ['Notify the assigned nurse', 'Re-attach the sensor and re-check vitals manually'];
  }
  if (st.level === 'critical') return ['Trigger the emergency response', 'Call the patient or their emergency contact', 'Seek medical help immediately', 'Locate the nearest hospital on the Emergency map'];
  if (st.level === 'attention') return ['Notify the assigned nurse', 'Re-check vitals manually within 15 minutes', 'Ask the patient to rest and drink water'];
  if (st.level === 'normal') return ['Continue routine monitoring', 'Keep the sensor snug on the wrist or finger'];
  return ['Check that the wearable is switched on and connected'];
}

/* ---------- 6. DATA INGESTION ---------- */
function handleSample(pid, raw, opts = {}) {
  const sig = JSON.stringify(raw);
  if (!opts.force && state.lastRaw[pid] === sig) return;
  state.lastRaw[pid] = sig;
  const s = normalize(raw);
  state.live[pid] = s;
  const h = (state.hist[pid] ||= []);
  h.push(s); if (h.length > 300) h.splice(0, h.length - 300);
  if (opts.log && Date.now() - s.rx < 60000) logSample(pid, s);
  evaluate(pid);
  scheduleRender();
}
function logSample(pid, s) {
  if (Backend.kind !== 'live' || Date.now() - (state.lastLog[pid] || 0) < 5000) return;
  state.lastLog[pid] = Date.now();
  Backend.push(`vitals/${pid}`, { bpm: s.bpm, temperature: s.temp, spo2: s.spo2, is_wearing: s.wearing, timestamp: s.ts });
}
function loadHistory(pid) {
  if (state.histLoaded[pid] || Backend.kind !== 'live') return;
  state.histLoaded[pid] = true;
  Backend.last(`vitals/${pid}`, 100).then(v => {
    if (!v) return;
    const old = Object.values(v).filter(e => e && typeof e === 'object').map(e => { const s = normalize(e); s.rx = s.ts; return s; });
    const merged = [...old, ...(state.hist[pid] || [])].sort((a, b) => a.ts - b.ts);
    state.hist[pid] = merged.filter((s, i) => i === 0 || s.ts !== merged[i - 1].ts).slice(-300);
    scheduleRender();
  });
}
function feedDevice(isNew) {
  const pid = state.linkedPatient, raw = state.deviceRaw;
  if (!pid || !raw || !patientById(pid)) return;
  if (!isNew && pid === state.deviceFedPid) return;
  state.deviceFedPid = pid;
  handleSample(pid, raw, { log: isNew, force: true });
}
function startData() {
  Backend.onConnection(ok => { state.connected = ok; scheduleRender(); });
  Backend.listen('patients', v => {
    state.patients = toList(v).sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    if (!patientById(state.selected)) state.selected = (patientById(state.linkedPatient) || state.patients[0])?.id || null;
    state.patients.forEach(p => loadHistory(p.id));
    feedDevice(false); scheduleRender();
  });
  Backend.listen('staff', v => { state.staff = toList(v).sort((a, b) => (a.name || '').localeCompare(b.name || '')); scheduleRender(); });
  Backend.listen('alerts', v => { state.alerts = toList(v).sort((a, b) => b.createdAt - a.createdAt); state.alertsReady = true; scheduleRender(); });
  Backend.listen('iot/linked_patient', v => { state.linkedPatient = typeof v === 'string' ? v : null; feedDevice(false); scheduleRender(); });
  Backend.listen('iot/current', v => { if (!v || typeof v !== 'object') return; state.deviceRaw = v; feedDevice(true); scheduleRender(); });
  Backend.listen('config/rules', v => { if (v && typeof v === 'object' && v.values) applyRules(v.values, v.meta); });
  Backend.listen('config/rules_log', v => { state.rulesLog = toList(v).sort((a, b) => b.ts - a.ts).slice(0, 8); if (state.view === 'settings' && state.stab === 'rules') renderRulesLog(); });
  Backend.listen('live', v => { Object.entries(v || {}).forEach(([pid, raw]) => { if (raw && typeof raw === 'object') handleSample(pid, raw, { log: true }); }); });
}

/* ---------- 7. STATUS EVALUATION & ALERTS ---------- */
function evaluate(pid) {
  const p = patientById(pid), s = state.live[pid];
  let st;
  if (!s) st = { level: 'none', kind: 'nodata' };
  else {
    const age = Date.now() - s.rx;
    if (age > 10 * 60 * 1000) { st = { level: 'none', kind: 'offline', reasons: [{ level: 'normal', text: 'No reading for more than 10 minutes' }], score: 0 }; delete state.loss[pid]; }
    else if (!s.wearing || age > rules.staleSec * 1000) {
      const loss = (state.loss[pid] ||= analyzeSignalLoss(pid));
      st = { kind: 'signal-loss', level: loss.level, type: loss.type, loss, title: loss.title, score: loss.level === 'critical' ? 95 : 45, reasons: [{ level: loss.level, text: loss.msg }], message: loss.msg };
    } else {
      delete state.loss[pid];
      const c = classify(s, p, (state.hist[pid] || []).slice(0, -1).filter(x => x.wearing));
      const bad = c.reasons.filter(r => r.level !== 'normal').map(r => r.text).join(' · ');
      st = { kind: 'vitals', type: 'vitals', ...c, title: c.level === 'critical' ? 'Critical vital signs detected' : 'Vitals need attention', message: bad };
    }
  }
  st.updatedAt = Date.now();
  state.status[pid] = st;
  maybeAlert(pid, st);
}
function maybeAlert(pid, st) {
  if (!state.alertsReady || !patientById(pid)) return;
  if (!['vitals', 'signal-loss'].includes(st.kind)) return;
  if (st.level === 'normal') { state.lastAlertKey[pid] = null; return; }
  const key = `${st.type}:${st.level}`;
  if (state.lastAlertKey[pid] === key) return;
  state.lastAlertKey[pid] = key;
  if (state.alerts.some(a => a.patientId === pid && a.type === st.type && a.level === st.level && a.status !== 'resolved')) return;
  createAlert(pid, st);
}
function recipientsFor(p, level) {
  const onDuty = state.staff.filter(s => s.onDuty);
  const set = new Map();
  const assigned = staffById(p.assignedStaff); if (assigned) set.set(assigned.id, assigned);
  if (level === 'critical') onDuty.filter(s => /doctor|emergency/i.test(s.role)).forEach(s => set.set(s.id, s));
  else if (!assigned) { const n = onDuty.find(s => /nurse/i.test(s.role)); if (n) set.set(n.id, n); }
  return [...set.values()].map(s => `${s.name} (${s.role})`);
}
function createAlert(pid, st) {
  const p = patientById(pid), s = state.live[pid] || {};
  Backend.push('alerts', {
    patientId: pid, patientName: p.name, level: st.level, type: st.type, title: st.title, message: st.message || '',
    vitals: clean({ bpm: s.bpm ?? null, temperature: s.temp ?? null, spo2: s.spo2 ?? null, is_wearing: !!s.wearing }),
    status: 'open', notified: recipientsFor(p, st.level), createdAt: Date.now()
  });
  toast(`${st.level === 'critical' ? 'Critical alert' : 'Alert'}: ${p.name} – ${st.title}`, st.level);
  if (st.level === 'critical') beep();
}
let audioCtx;
function beep() {
  if (settings.mute) return;
  try {
    audioCtx ||= new (window.AudioContext || window.webkitAudioContext)();
    [0, .28, .56].forEach(t => { const o = audioCtx.createOscillator(), g = audioCtx.createGain(); o.frequency.value = 880; o.connect(g); g.connect(audioCtx.destination); g.gain.setValueAtTime(.12, audioCtx.currentTime + t); g.gain.exponentialRampToValueAtTime(.001, audioCtx.currentTime + t + .22); o.start(audioCtx.currentTime + t); o.stop(audioCtx.currentTime + t + .24); });
  } catch { /* audio blocked until the first click */ }
}
function toast(msg, level = 'info') {
  const el = document.createElement('div'); el.className = `toast ${level}`; el.textContent = msg;
  $('#toasts').appendChild(el); setTimeout(() => el.remove(), 5500);
}

/* ---------- 8. RENDER SCHEDULER ---------- */
let rq = false;
function scheduleRender() { if (rq) return; rq = true; requestAnimationFrame(() => { rq = false; render(); }); }
function render() {
  if (!session) return;
  renderChrome();
  const fn = { overview: renderOverview, focus: renderFocus, monitor: renderMonitor, patients: renderPatients, staff: renderStaff, alerts: renderAlerts, analysis: renderAnalysis, map: renderMapSide, settings: () => { } }[state.view];
  if (fn) fn();
}

function renderChrome() {
  const crit = state.patients.filter(p => getStatus(p.id).level === 'critical');
  $('#emergency-banner').classList.toggle('hidden', !crit.length);
  if (crit.length) $('#emergency-text').textContent = `Critical: ${crit.map(p => p.name).join(', ')} needs immediate attention`;
  $('#emergency-banner [data-act="emergency"]').classList.toggle('hidden', !can('emergency'));
  const open = state.alerts.filter(a => a.status === 'open').length;
  const nb = $('#nav-alert-badge'); nb.textContent = open; nb.classList.toggle('hidden', !open);
  const bc = $('#bell-count'); bc.textContent = open > 9 ? '9+' : open; bc.classList.toggle('hidden', !open);
  const conn = $('#chip-conn');
  conn.className = `chip ${Backend.kind === 'demo' ? 'info' : state.connected ? 'normal' : 'critical'}`;
  conn.textContent = Backend.kind === 'demo' ? 'Demo mode' : state.connected ? 'Database connected' : 'Database offline';
  const anyFresh = Object.values(state.live).some(s => Date.now() - s.rx < rules.staleSec * 1000);
  const dev = $('#chip-device');
  dev.className = `chip ${anyFresh ? 'normal' : Object.keys(state.live).length ? 'critical' : 'none'}`;
  dev.textContent = anyFresh ? 'Device: online' : Object.keys(state.live).length ? 'Device: offline' : 'Device: no data';
  $('#mode-pill').textContent = Backend.kind === 'demo' ? 'Demo data (simulated)' : 'Live Firebase data';
  if (!$('#bell-panel').classList.contains('hidden')) renderBell();
}

/* notification bell */
function renderBell() {
  const open = state.alerts.filter(a => a.status === 'open').slice(0, 6);
  setHTML($('#bell-list'), open.length
    ? open.map(a => alertCard(a, true)).join('')
    : `<div class="empty inline">${ico('check-circle', 28)}<span>No open alerts. Everything is calm.</span></div>`);
}
/* global patient search (name, record number, room, phone) */
function renderSearchResults() {
  const q = $('#global-search').value.trim().toLowerCase(), box = $('#search-results');
  if (!q) { box.classList.add('hidden'); return; }
  const hits = state.patients.filter(p => `${p.name} ${p.mrn || ''} ${p.room || ''} ${p.phone || ''}`.toLowerCase().includes(q)).slice(0, 7);
  box.classList.remove('hidden');
  box.innerHTML = hits.length
    ? hits.map(p => { const st = getStatus(p.id); return `<button class="dd-item" data-act="view" data-id="${p.id}"><span class="avatar sm">${esc(initials(p.name))}</span><span class="dd-main"><strong>${esc(p.name)}</strong><small>${esc(p.mrn || 'No record no.')} · ${esc(p.room || 'No room')}</small></span><span class="chip ${stCls(st)}">${stLabel(st)}</span></button>`; }).join('')
    : '<div class="empty inline">No patient matches your search.</div>';
}
function hideDropdowns(except) {
  [['#search-results', '.gsearch'], ['#bell-panel', '.bellwrap'], ['#user-panel', '.usermenu']].forEach(([sel, wrap]) => { if (wrap !== except) $(sel).classList.add('hidden'); });
}

/* ---------- 9. OVERVIEW ---------- */
function sparkline(vals) {
  if (vals.length < 2) return '<svg class="spark" viewBox="0 0 110 28"></svg>';
  const min = Math.min(...vals), max = Math.max(...vals), span = max - min || 1;
  const pts = vals.map((v, i) => `${(i / (vals.length - 1) * 106 + 2).toFixed(1)},${(25 - (v - min) / span * 22).toFixed(1)}`).join(' ');
  return `<svg class="spark" viewBox="0 0 110 28"><polyline points="${pts}"/></svg>`;
}
const vcls = (st, k) => { const v = st.sev?.[k]; return v >= 100 ? 'critical' : v > 0 ? 'attention' : ''; };
const freshLive = pid => { const s = state.live[pid]; return s && s.wearing && Date.now() - s.rx < rules.staleSec * 1000 ? s : null; };
function patientCard(p) {
  const st = getStatus(p.id), cls = stCls(st), s = freshLive(p.id), staff = staffById(p.assignedStaff);
  const series = (state.hist[p.id] || []).filter(x => isNum(x.bpm)).slice(-24).map(x => x.bpm);
  return `<article class="pcard lvl-${cls}" data-pid="${p.id}" tabindex="0">
    <div class="pcard-head"><div class="avatar">${esc(initials(p.name))}</div>
      <div class="pcard-id"><strong>${esc(p.name)}</strong><span>${esc(p.age)} yrs · ${esc(p.gender || '—')} · ${esc(p.room || 'No room')}</span></div>
      <span class="chip ${cls}">${stLabel(st)}</span></div>
    <div class="pcard-vitals">
      <div><span class="k">${ico('heart', 12)}Heart rate</span><b class="${vcls(st, 'bpm')}">${s ? fmt(s.bpm) : '--'}<small>BPM</small></b></div>
      <div><span class="k">${ico('thermo', 12)}Temp</span><b class="${vcls(st, 'temp')}">${s ? fmt(s.temp, 1) : '--'}<small>°C</small></b></div>
      <div><span class="k">${ico('drop', 12)}SpO₂</span><b class="${vcls(st, 'spo2')}">${s ? fmt(s.spo2) : '--'}<small>%</small></b></div>
    </div>
    <div class="pcard-foot"><span>${staff ? `Care: ${esc(staff.name)}` : 'Not assigned'}</span>${sparkline(series)}</div>
  </article>`;
}
function renderOverview() {
  const pts = state.patients, cls = p => stCls(getStatus(p.id));
  const count = l => pts.filter(p => cls(p) === l).length;
  const online = pts.filter(p => freshLive(p.id)).length;
  const openN = state.alerts.filter(a => a.status === 'open').length;
  const onDuty = state.staff.filter(s => s.onDuty).length;
  const nCrit = count('critical'), nAtt = count('attention');
  const staffLink = can('view.staff');
  const K = [
    { attr: 'data-focus="all"', label: 'Patients', val: pts.length, icon: 'users', tone: 'brand', hint: 'View all patients' },
    { attr: 'data-focus="streaming"', label: 'Streaming now', val: online, icon: 'activity', tone: 'ok', hint: pts.length ? `${online} of ${pts.length} sending data` : 'No patients yet' },
    { attr: 'data-focus="critical"', label: 'Critical', val: nCrit, icon: 'alert', tone: nCrit ? 'bad' : 'muted', hint: nCrit ? 'Review now' : 'Nobody is critical', pulse: nCrit > 0 },
    { attr: 'data-focus="attention"', label: 'Needs attention', val: nAtt, icon: 'bell', tone: nAtt ? 'warn' : 'muted', hint: nAtt ? 'Check on them soon' : 'All calm' },
    { attr: 'data-go="alerts"', label: 'Open alerts', val: openN, icon: 'bell', tone: openN ? 'info' : 'muted', hint: openN ? 'Open the alert centre' : 'Nothing waiting' },
    { attr: staffLink ? 'data-go="staff"' : '', label: 'Staff on duty', val: onDuty, icon: 'briefcase', tone: 'violet', hint: staffLink ? 'See the care team' : 'Available now' }
  ];
  setHTML($('#kpi-grid'), K.map(k => `<button class="kpi tone-${k.tone} ${k.pulse ? 'pulse' : ''} ${k.attr ? '' : 'static'}" ${k.attr}>
      <span class="kpi-ico">${ico(k.icon, 20)}</span><span class="kpi-label">${k.label}</span><b>${k.val}</b>
      <small>${k.hint}${k.attr ? ' <span class="arrow">→</span>' : ''}</small></button>`).join(''));

  /* ward status bar */
  const segs = [['normal', 'Normal'], ['attention', 'Needs attention'], ['critical', 'Critical'], ['none', 'No signal']].map(([k, l]) => [k, l, count(k)]);
  setHTML($('#ward-status'), pts.length ? `<div class="wardbar-track">${segs.filter(s => s[2]).map(([k, l, n]) => `<button class="wb ${k}" style="flex:${n}" data-focus="${k}" title="${l}: ${n}">${n}</button>`).join('')}</div>
    <div class="wardbar-legend">${segs.map(([k, l, n]) => `<button data-focus="${k}"><i class="dot ${k}"></i>${l}<b>${n}</b></button>`).join('')}</div>` : '');

  /* priority queue */
  const rank = ['critical', 'attention'];
  const prio = pts.filter(p => rank.includes(cls(p))).sort((a, b) => rank.indexOf(cls(a)) - rank.indexOf(cls(b)) || (getStatus(b.id).score || 0) - (getStatus(a.id).score || 0)).slice(0, 4);
  $('#priority-card').classList.toggle('hidden', !prio.length);
  setHTML($('#priority-list'), prio.map(p => {
    const st = getStatus(p.id), c = cls(p), why = (st.reasons || []).filter(r => r.level !== 'normal')[0]?.text || st.message || '';
    return `<div class="prio lvl-${c}"><div class="avatar">${esc(initials(p.name))}</div>
      <div class="prio-main"><strong>${esc(p.name)}</strong><span>${esc(p.room || 'No room')} · ${esc(why)}</span></div>
      <span class="chip ${c}">${stLabel(st)}</span>
      <div class="row-actions"><button class="btn ghost sm" data-act="view" data-id="${p.id}">Monitor</button>${c === 'critical' && can('emergency') ? `<button class="btn danger sm" data-act="emergency" data-id="${p.id}">Emergency</button>` : ''}</div></div>`;
  }).join(''));

  $$('#overview-filters .fchip').forEach(b => b.classList.toggle('active', b.dataset.filter === state.filter));
  const order = ['critical', 'attention', 'none', 'normal'];
  const list = pts.filter(p => state.filter === 'all' || cls(p) === state.filter).sort((a, b) => order.indexOf(cls(a)) - order.indexOf(cls(b)));
  setHTML($('#patient-grid'), list.length ? list.map(patientCard).join('') :
    `<div class="empty" style="grid-column:1/-1">${ico('users', 36)}<h3>${pts.length ? 'No patients in this state' : 'No patients yet'}</h3><p>${pts.length ? 'Try another filter.' : Backend.kind === 'live' ? 'Add a patient profile, or load sample records from Settings & data.' : 'Add a patient profile to begin.'}</p>${can('patient.add') ? '<button class="btn primary" data-act="add-patient">Add patient</button>' : ''}</div>`);
  const openA = state.alerts.filter(a => a.status === 'open').slice(0, 4);
  setHTML($('#overview-alerts'), openA.length ? openA.map(a => alertCard(a, true)).join('') : '<div class="empty inline">No open alerts. Everything is calm.</div>');
  const duty = state.staff.filter(s => s.onDuty);
  setHTML($('#overview-staff'), duty.length ? `<div class="mini-list">${duty.map(s => `<div class="mini-row"><div class="avatar staff sm">${esc(initials(s.name))}</div><div><strong>${esc(s.name)}</strong><span class="sub">${esc(s.role)} · ${esc(s.department || '')}</span></div><span class="chip role">${esc(s.shift || '')}</span></div>`).join('')}</div>` : '<div class="empty inline">Nobody is marked on duty.</div>');
  renderLinkBanner();
}
function renderLinkBanner() {
  const b = $('#link-banner');
  const need = Backend.kind === 'live' && state.deviceRaw && !state.linkedPatient && can('patient.link');
  const sig = need + state.patients.map(p => p.id).join();
  if (b.dataset.sig === sig) return; b.dataset.sig = sig;
  b.classList.toggle('hidden', !need);
  if (!need) return;
  b.innerHTML = state.patients.length
    ? `${ico('link')}<span><strong>Your wearable is sending data</strong> but is not linked to a patient.</span><select id="link-select">${state.patients.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select><button class="btn primary sm" data-act="link-confirm">Link device</button>`
    : `${ico('link')}<span><strong>Your wearable is sending data.</strong> Add a patient profile first, then link the device to that patient.</span><button class="btn primary sm" data-act="add-patient">Add patient</button>`;
}

/* ---------- 10. LIVE MONITOR ---------- */
const METRICS = {
  bpm: { label: 'Heart rate (BPM)', color: '#ff4d6a', fill: 'rgba(255,77,106,.14)', d: 0 },
  temp: { label: 'Temperature (°C)', color: '#ffb454', fill: 'rgba(255,180,84,.14)', d: 1 },
  spo2: { label: 'SpO₂ (%)', color: '#6aa8ff', fill: 'rgba(106,168,255,.14)', d: 0 }
};
let chart;
function cssVar(n) { return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); }
function buildChart() {
  if (chart) chart.destroy();
  const grid = cssVar('--line'), tick = cssVar('--muted');
  chart = new Chart($('#telemetryChart').getContext('2d'), {
    type: 'line',
    data: { labels: [], datasets: [
      { label: '', data: [], borderWidth: 2.5, fill: true, tension: .35, pointRadius: 2.5, pointHoverRadius: 5 },
      { label: 'Upper limit', data: [], borderColor: 'rgba(255,77,106,.55)', borderDash: [6, 5], borderWidth: 1.5, pointRadius: 0, fill: false },
      { label: 'Lower limit', data: [], borderColor: 'rgba(255,180,84,.55)', borderDash: [6, 5], borderWidth: 1.5, pointRadius: 0, fill: false }
    ] },
    options: { responsive: true, maintainAspectRatio: false, animation: false, interaction: { mode: 'index', intersect: false },
      scales: { x: { ticks: { color: tick, maxTicksLimit: 8 }, grid: { color: grid } }, y: { ticks: { color: tick }, grid: { color: grid } } },
      plugins: { legend: { labels: { color: cssVar('--text'), usePointStyle: true, boxWidth: 8 } } } }
  });
}
function syncMonitorSelect() {
  const sel = $('#monitor-select'), sig = state.patients.map(p => p.id + p.name).join();
  if (sel.dataset.sig !== sig) { sel.dataset.sig = sig; sel.innerHTML = state.patients.map(p => `<option value="${p.id}">${esc(p.name)} (${esc(p.age)} yrs)</option>`).join(''); }
  if (state.selected) sel.value = state.selected;
}
function trendText(pid, key) {
  const v = (state.hist[pid] || []).filter(s => s.wearing && isNum(s[key])).slice(-8).map(s => s[key]);
  if (v.length < 4) return '';
  const d = v[v.length - 1] - v[0], th = key === 'temp' ? .2 : key === 'spo2' ? 1 : 4;
  return d > th ? '▲ rising' : d < -th ? '▼ falling' : '● steady';
}
function setVital(prefix, key, d, p, st, s) {
  const LIM = limitsFor(p)[key];
  $(`#${prefix}-val`).textContent = s ? fmt(s[key], d) : '--';
  $(`#${prefix}-range`).textContent = `Normal range ${LIM.normal} ${LIM.unit}`;
  $(`#${prefix}-trend`).textContent = s ? trendText(p.id, key) : '';
  $(`#${prefix}-card`).className = `card vital ${s && vcls(st, key) ? 'lvl-' + vcls(st, key) : ''}`;
}
function renderMonitor() {
  syncMonitorSelect();
  const p = patientById(state.selected);
  $('#monitor-empty').classList.toggle('hidden', !!p);
  $('#monitor-content').classList.toggle('hidden', !p);
  $('#btn-link-device').classList.toggle('hidden', !p || Backend.kind !== 'live' || !can('patient.link'));
  if (!p) { $('#monitor-meta').textContent = ''; return; }
  const raw = state.live[p.id], st = getStatus(p.id), cls = stCls(st), s = freshLive(p.id);
  $('#monitor-meta').textContent = `${p.gender || ''} · ${p.room || 'No room'} · baseline ${p.condition || 'Normal'}`;
  setVital('hr', 'bpm', 0, p, st, s); setVital('temp', 'temp', 1, p, st, s); setVital('spo2', 'spo2', 0, p, st, s);
  const wearing = !!(raw && raw.wearing && Date.now() - raw.rx < rules.staleSec * 1000);
  const wb = $('#wear-badge'); wb.className = `wear-badge ${wearing ? 'on' : 'off'}`; wb.textContent = wearing ? 'Wearing' : 'Not wearing';
  $('#wear-desc').textContent = wearing ? 'Sensor is attached and picking up a pulse signal.' : raw ? 'Sensor detached, or no finger/wrist contact detected.' : 'Waiting for the first reading.';
  $('#last-sync').textContent = raw ? `Last reading: ${hhmmss(raw.ts)}` : 'Last reading: --';
  $('#ecg-label').textContent = wearing ? `${fmt(raw.bpm)} BPM · signal good` : 'No pulse signal';
  const sc = $('#state-card'); sc.className = `card state-card span-2 lvl-${cls}`;
  const sb = $('#state-badge'); sb.className = `chip ${cls}`; sb.textContent = stLabel(st);
  $('#state-score-num').textContent = st.kind === 'nodata' || st.kind === 'offline' ? '--' : `${st.score}/100`;
  const bar = $('#state-score-bar'); bar.style.width = `${st.score || 0}%`; bar.style.background = `var(--${cls === 'none' ? 'none' : cls === 'normal' ? 'ok' : cls === 'attention' ? 'warn' : 'bad'})`;
  $('#state-conf').textContent = st.confidence ? `Classifier confidence ${st.confidence}%` : '';
  $('#state-reasons').innerHTML = (st.reasons || []).map(r => `<li class="${r.level}">${esc(r.text)}</li>`).join('');
  $('#state-recs').innerHTML = recommendations(st).map(r => `<li>${esc(r)}</li>`).join('');
  const base = p.condition || 'Normal';
  $('#state-baseline').textContent = `Registered baseline: ${base}. A higher baseline raises the risk score slightly so known-risk patients are flagged earlier.`;
  renderLoss(p, st);
  renderInfo(p, st);
  updateChart(p);
}
function renderLoss(p, st) {
  const lb = $('#loss-badge'), body = $('#loss-body');
  const lost = st.kind === 'signal-loss';
  lb.className = `chip ${lost ? stCls(st) : st.kind === 'offline' ? 'none' : 'normal'}`;
  lb.textContent = lost ? st.title : st.kind === 'offline' ? 'Device offline' : 'Signal OK';
  const lossRules = [
    ['sensor-not-secure', 'Stable before loss', `Vitals normal in the last ${rules.lossWindow} readings → "Sensor not secure", notify the nurse.`],
    ['rapid-acceleration-loss', 'Rapid BPM rise before loss', `Heart rate jumped by ${rules.rapidRise} BPM or more, or was already critical → emergency alert.`]
  ];
  const hitType = lost ? st.type : '';
  const hit = r => (r[0] === hitType) || (r[0] === 'rapid-acceleration-loss' && hitType === 'critical-before-loss');
  const beats = lost && st.loss.before.length ? `<p class="muted small">Readings before the signal dropped (BPM):</p><div class="beats">${st.loss.before.map(x => `<span>${fmt(x.bpm)}</span>`).join('')}</div>` : '';
  body.innerHTML = `${lost ? `<p>${esc(st.loss.msg)}</p>${beats}` : '<p class="muted">The signal is healthy. If it drops, the last readings before the loss decide how serious it is:</p>'}
    <div class="loss-flow" style="margin-top:.6rem">${lossRules.map(r => `<div class="rule ${hit(r) ? 'hit ' + (r[0] === 'rapid-acceleration-loss' ? 'critical' : '') : ''}"><div><strong>${r[1]}</strong><br><span class="muted">${r[2]}</span></div></div>`).join('')}</div>`;
}
function renderInfo(p, st) {
  const staff = staffById(p.assignedStaff);
  const tel = n => n ? `<a href="tel:${esc(n)}">${esc(n)}</a>` : '—';
  $('#info-body').innerHTML = `<dl class="info-list">
    <div><dt>Age / gender</dt><dd>${esc(p.age)} · ${esc(p.gender || '—')}</dd></div>
    <div><dt>Room / ward</dt><dd>${esc(p.room || '—')}</dd></div>
    <div><dt>Patient phone</dt><dd>${tel(p.phone)}</dd></div>
    <div><dt>Device ID</dt><dd>${esc(p.deviceId || '—')}${state.linkedPatient === p.id ? ' (linked)' : ''}</dd></div>
    <div><dt>Emergency contact</dt><dd>${esc(p.contactName || '—')} ${p.contactPhone ? '· ' + tel(p.contactPhone) : ''}</dd></div>
    <div><dt>Assigned staff</dt><dd>${staff ? `${esc(staff.name)} (${esc(staff.role)})${staff.phone ? ' · ' + tel(staff.phone) : ''}` : 'Not assigned'}</dd></div>
    <div class="full"><dt>Medical notes</dt><dd>${esc(p.notes || 'None recorded')}</dd></div>
  </dl>
  <div class="toolbar" style="margin:1rem 0 0">${can('patient.edit') ? `<button class="btn ghost sm" data-act="edit-patient" data-id="${p.id}">${ico('edit')}Edit profile</button>` : ''}
  ${st.level === 'critical' && can('emergency') ? `<button class="btn danger sm" data-act="emergency" data-id="${p.id}">${ico('alert')}Emergency panel</button>` : ''}</div>`;
}
function updateChart(p) {
  if (!chart) return;
  const key = state.metric, cfg = METRICS[key], LIM = limitsFor(p)[key];
  const rows = (state.hist[p.id] || []).filter(r => isNum(r[key])).slice(-state.range);
  const ds = chart.data.datasets;
  chart.data.labels = rows.map(r => hhmmss(r.ts));
  Object.assign(ds[0], { label: cfg.label, data: rows.map(r => r[key]), borderColor: cfg.color, backgroundColor: cfg.fill, pointBackgroundColor: cfg.color });
  ds[1].data = key === 'spo2' ? [] : rows.map(() => LIM.attHi);
  ds[2].data = rows.map(() => LIM.attLo);
  chart.update('none');
  $('#chart-title').textContent = `${p.name} · ${cfg.label} over time`;
  $('#stats-name').textContent = p.name;
  const v = rows.map(r => r[key]);
  if (!v.length) { ['avg', 'std', 'min', 'max'].forEach(k => $(`#stat-${k}`).textContent = '--'); $('#stat-count').textContent = 'No readings yet.'; return; }
  const mean = v.reduce((a, b) => a + b, 0) / v.length, sd = Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / v.length), u = LIM.unit;
  $('#stat-avg').textContent = `${mean.toFixed(cfg.d + 1)} ${u}`; $('#stat-std').textContent = `±${sd.toFixed(cfg.d + 1)}`;
  $('#stat-min').textContent = `${Math.min(...v).toFixed(cfg.d)} ${u}`; $('#stat-max').textContent = `${Math.max(...v).toFixed(cfg.d)} ${u}`;
  $('#stat-count').textContent = `Based on ${v.length} readings.`;
}
/* ECG-style animated trace */
const ecg = { buf: [], phase: 0, last: 0, acc: 0 };
const gauss = (x, mu, s, a) => a * Math.exp(-((x - mu) ** 2) / (2 * s * s));
const ecgShape = t => gauss(t, .15, .025, .12) + gauss(t, .28, .008, -.15) + gauss(t, .30, .010, 1) + gauss(t, .32, .010, -.25) + gauss(t, .55, .05, .25);
function ecgLoop(t) {
  requestAnimationFrame(ecgLoop);
  const dt = Math.min(.05, (t - ecg.last) / 1000); ecg.last = t;
  if (state.view !== 'monitor') return;
  const cv = $('#ecg'); if (!cv) return;
  const dpr = window.devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight;
  if (!w) return;
  if (cv.width !== Math.round(w * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
  const raw = state.live[state.selected], on = raw && raw.wearing && isNum(raw.bpm) && Date.now() - raw.rx < rules.staleSec * 1000;
  ecg.acc += dt * 100; const n = Math.floor(ecg.acc); ecg.acc -= n;
  for (let i = 0; i < n; i++) {
    if (on) { ecg.phase = (ecg.phase + .01 * raw.bpm / 60) % 1; ecg.buf.push(ecgShape(ecg.phase) + (Math.random() - .5) * .02); }
    else ecg.buf.push((Math.random() - .5) * .015);
  }
  while (ecg.buf.length > w) ecg.buf.shift();
  const c = cv.getContext('2d'); c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, w, h);
  c.strokeStyle = 'rgba(63,208,196,.08)'; c.lineWidth = 1;
  for (let x = 0; x < w; x += 24) { c.beginPath(); c.moveTo(x, 0); c.lineTo(x, h); c.stroke(); }
  for (let y = 0; y < h; y += 24) { c.beginPath(); c.moveTo(0, y); c.lineTo(w, y); c.stroke(); }
  c.strokeStyle = on ? '#3fd0c4' : '#ff4d6a'; c.lineWidth = 2; c.lineJoin = 'round'; c.shadowColor = c.strokeStyle; c.shadowBlur = 8;
  c.beginPath(); ecg.buf.forEach((v, i) => { const x = w - ecg.buf.length + i, y = h * .72 - v * h * .6; i ? c.lineTo(x, y) : c.moveTo(x, y); }); c.stroke();
}

/* ---------- 11. PATIENTS ---------- */
function renderPatients() {
  const q = $('#patient-search').value.trim().toLowerCase(), f = $('#patient-filter').value;
  const rows = state.patients.filter(p => (!q || `${p.name} ${p.mrn || ''} ${p.room || ''} ${p.notes || ''}`.toLowerCase().includes(q)) && (f === 'all' || stCls(getStatus(p.id)) === f));
  setHTML($('#patient-rows'), rows.length ? rows.map(p => {
    const st = getStatus(p.id), s = freshLive(p.id), staff = staffById(p.assignedStaff);
    return `<tr><td><div class="cell-user"><div class="avatar">${esc(initials(p.name))}</div><div><strong>${esc(p.name)}</strong><span>${esc(p.mrn || '—')} · ${esc(p.age)} yrs · ${esc(p.gender || '—')}</span></div></div></td>
      <td>${esc(p.room || '—')}</td><td><span class="chip ${/crit/i.test(p.condition) ? 'critical' : /attent/i.test(p.condition) ? 'attention' : 'normal'}">${esc(p.condition || 'Normal')}</span></td>
      <td><span class="chip ${stCls(st)}">${stLabel(st)}</span></td>
      <td class="vitals-inline">${s ? `${fmt(s.bpm)} BPM · ${fmt(s.temp, 1)} °C · ${fmt(s.spo2)}%` : '—'}</td>
      <td>${staff ? esc(staff.name) : '<span class="muted">Unassigned</span>'}</td>
      <td><div class="row-actions"><button class="btn ghost sm" data-act="view" data-id="${p.id}">Monitor</button>
      ${can('patient.edit') ? `<button class="icon-btn sm" data-act="edit-patient" data-id="${p.id}" aria-label="Edit">${ico('edit', 15)}</button>` : ''}
      ${can('patient.delete') ? `<button class="icon-btn sm danger" data-act="delete-patient" data-id="${p.id}" aria-label="Delete">${ico('trash', 15)}</button>` : ''}</div></td></tr>`;
  }).join('') : `<tr><td colspan="7"><div class="empty inline">No patients match. ${can('patient.add') ? '<button class="link" data-act="add-patient">Add a patient</button>' : ''}</div></td></tr>`);
}

const f = (label, name, val, attrs = '') => `<label>${label}<input name="${name}" value="${esc(val)}" ${/type=/.test(attrs) ? '' : 'type="text"'} ${attrs}></label>`;
function nextMrn() { let n = 1001 + state.patients.length; while (state.patients.some(p => p.mrn === `PC-${n}`)) n++; return `PC-${n}`; }
function openPatientForm(id) {
  const p = id ? patientById(id) : {};
  const staffOpts = state.staff.map(s => `<option value="${s.id}" ${p.assignedStaff === s.id ? 'selected' : ''}>${esc(s.name)} · ${esc(s.role)}</option>`).join('');
  openModal({
    title: id ? 'Edit patient' : 'Add patient', submit: id ? 'Save changes' : 'Add patient', wide: true,
    body: `<div class="form-grid">
      ${f('Full name', 'name', p.name, 'required')}${f('Record number (MRN)', 'mrn', p.mrn, 'placeholder="Created automatically if empty"')}
      ${f('Age', 'age', p.age, 'type="number" min="0" max="120" required')}
      <label>Gender<select name="gender">${['Male', 'Female', 'Other'].map(g => `<option ${p.gender === g ? 'selected' : ''}>${g}</option>`).join('')}</select></label>
      ${f('Room or ward', 'room', p.room)}${f('Device ID', 'deviceId', p.deviceId)}
      ${f('Patient phone', 'phone', p.phone, 'type="tel"')}${f('Emergency contact name', 'contactName', p.contactName)}
      ${f('Emergency contact phone', 'contactPhone', p.contactPhone, 'type="tel"')}
      <label>Baseline condition<select name="condition">${['Normal', 'Needs Attention', 'Critical'].map(c => `<option ${p.condition === c ? 'selected' : ''}>${c}</option>`).join('')}</select></label>
      <label class="full">Assigned staff<select name="assignedStaff"><option value="">Unassigned</option>${staffOpts}</select></label>
      <label class="full">Medical notes<textarea name="notes" rows="3" placeholder="Diagnoses, allergies, medication…">${esc(p.notes)}</textarea></label></div>`,
    onSubmit: d => {
      d.age = Number(d.age); d.name = d.name.trim(); d.mrn = (d.mrn || '').trim();
      if (!d.name || isNaN(d.age)) { toast('Name and age are required.', 'attention'); return false; }
      if (d.mrn && state.patients.some(x => x.mrn === d.mrn && x.id !== id)) { toast('That record number is already used.', 'attention'); return false; }
      if (!d.mrn) d.mrn = (id && p.mrn) || nextMrn();
      if (id) Backend.update(`patients/${id}`, d);
      else { const nid = Backend.push('patients', { ...d, createdAt: Date.now() }); state.selected = state.selected || nid; }
      toast(id ? 'Patient updated.' : 'Patient added.');
    }
  });
}

/* ---------- 12. STAFF / CARE TEAM ---------- */
const ROLE_TONE = r => /doctor/i.test(r) ? 'doctor' : /nurse/i.test(r) ? 'nurse' : /emergency/i.test(r) ? 'responder' : 'admin';
const ROLE_CAP = { Doctor: 8, Nurse: 6, 'Emergency responder': 4 };
const SHIFTS = ['Morning', 'Evening', 'Night', 'On call'];
const STAFF_ROLES = ['Doctor', 'Nurse', 'Emergency responder', 'Administrator'];
function renderStaff() {
  const q = $('#staff-search').value.trim().toLowerCase(), all = state.staff;
  const manage = can('staff.manage');
  $('#duty-only').classList.toggle('on', state.dutyOnly);
  /* summary tiles */
  const tiles = [
    ['Team members', all.length, 'briefcase', 'brand'],
    ['On duty now', all.filter(s => s.onDuty).length, 'check-circle', 'ok'],
    ['Doctors', all.filter(s => s.role === 'Doctor').length, 'heart', 'info'],
    ['Nurses', all.filter(s => s.role === 'Nurse').length, 'users', 'violet'],
    ['Responders', all.filter(s => s.role === 'Emergency responder').length, 'zap', 'warn']
  ];
  setHTML($('#staff-stats'), tiles.map(([l, v, i, t]) => `<div class="stat tone-${t}"><span class="stat-ico">${ico(i, 18)}</span><div><b>${v}</b><span>${l}</span></div></div>`).join(''));
  /* shift coverage + unassigned patients */
  const cover = SHIFTS.map(sh => { const m = all.filter(s => s.shift === sh && s.onDuty); return `<div class="cover ${m.length ? 'ok' : 'empty'}"><span class="cover-name">${sh}</span><div class="avstack">${m.slice(0, 4).map(s => `<span class="avatar staff sm" title="${esc(s.name)}">${esc(initials(s.name))}</span>`).join('') || '<span class="muted small">Nobody on duty</span>'}${m.length > 4 ? `<span class="avatar sm more">+${m.length - 4}</span>` : ''}</div></div>`; }).join('');
  const orphans = state.patients.filter(p => !staffById(p.assignedStaff));
  setHTML($('#staff-coverage'), `<div class="card coverage"><div class="section-head tight"><h3>Shift coverage</h3><span class="muted small">Who is on duty right now</span></div><div class="cover-grid">${cover}</div></div>
    ${orphans.length ? `<div class="notice warn">${ico('alert')}<span><strong>${orphans.length} patient${orphans.length === 1 ? ' has' : 's have'} no assigned staff:</strong> ${orphans.slice(0, 4).map(p => esc(p.name)).join(', ')}${orphans.length > 4 ? '…' : ''}</span>${can('patient.edit') ? `<button class="btn ghost sm" data-act="edit-patient" data-id="${orphans[0].id}">Assign now</button>` : ''}</div>` : ''}`);
  /* role chips with counts */
  const chips = [['all', 'Everyone', all.length], ...STAFF_ROLES.map(r => [r, r === 'Emergency responder' ? 'Responders' : r + 's', all.filter(s => s.role === r).length])];
  setHTML($('#staff-chips'), chips.map(([k, l, n]) => `<button class="fchip ${state.sfilter === k ? 'active' : ''}" data-sfilter="${k}">${l}<b class="cnt">${n}</b></button>`).join(''));
  /* cards */
  const rows = all.filter(s => (!q || `${s.name} ${s.role} ${s.department}`.toLowerCase().includes(q)) && (state.sfilter === 'all' || s.role === state.sfilter) && (!state.dutyOnly || s.onDuty));
  setHTML($('#staff-grid'), rows.length ? rows.map(s => {
    const mine = state.patients.filter(p => p.assignedStaff === s.id), cap = ROLE_CAP[s.role] || 0, tone = ROLE_TONE(s.role);
    const load = cap ? Math.min(100, Math.round(mine.length / cap * 100)) : 0, lc = load >= 100 ? 'bad' : load >= 70 ? 'warn' : 'ok';
    const urgent = mine.filter(p => ['critical', 'attention'].includes(stCls(getStatus(p.id)))).length;
    return `<article class="card tcard tone-${tone} ${s.onDuty ? 'duty' : 'off'}">
      <header class="tcard-head"><div class="av-wrap"><div class="avatar staff lg">${esc(initials(s.name))}</div><i class="presence ${s.onDuty ? 'on' : ''}"></i></div>
        <div class="tcard-id"><strong>${esc(s.name)}</strong><span class="chip role tone-${tone}">${esc(s.role)}</span><small>${esc(s.department || 'No department')}</small></div>
        ${manage ? `<div class="row-actions"><button class="icon-btn sm" data-act="edit-staff" data-id="${s.id}" aria-label="Edit">${ico('edit', 15)}</button><button class="icon-btn sm danger" data-act="delete-staff" data-id="${s.id}" aria-label="Delete">${ico('trash', 15)}</button></div>` : ''}</header>
      <div class="tcard-meta"><span>${ico('clock', 14)}${esc(s.shift || 'No shift')}</span>
        ${s.phone ? `<a href="tel:${esc(s.phone)}">${ico('phone', 14)}${esc(s.phone)}</a>` : ''}
        ${s.email ? `<a href="mailto:${esc(s.email)}">${ico('mail', 14)}${esc(s.email)}</a>` : ''}</div>
      ${cap ? `<div class="workload"><div class="workload-top"><span>Workload</span><b>${mine.length}/${cap} patients${urgent ? ` · <em class="warn">${urgent} need${urgent === 1 ? 's' : ''} care</em>` : ''}</b></div><div class="bar"><i style="width:${load}%;background:var(--${lc})"></i></div></div>` : ''}
      <div class="tcard-patients">${mine.length ? mine.map(p => `<button class="pchip" data-pid="${p.id}" title="Open ${esc(p.name)}"><i class="dot ${stCls(getStatus(p.id))}"></i>${esc(p.name)}</button>`).join('') : '<span class="muted small">No patients assigned</span>'}</div>
      <footer class="tcard-foot">${manage ? `<button class="switch ${s.onDuty ? 'on' : ''}" data-act="toggle-duty" data-id="${s.id}"><i></i>${s.onDuty ? 'On duty' : 'Off duty'}</button>` : `<span class="chip ${s.onDuty ? 'normal' : 'none'}">${s.onDuty ? 'On duty' : 'Off duty'}</span>`}
        <div class="row-actions">${s.phone ? `<a class="btn ghost sm" href="tel:${esc(s.phone)}">${ico('phone', 14)}Call</a>` : ''}${s.email ? `<a class="btn ghost sm" href="mailto:${esc(s.email)}">${ico('mail', 14)}Email</a>` : ''}</div></footer></article>`;
  }).join('') : `<div class="empty" style="grid-column:1/-1">${ico('briefcase', 36)}<h3>No staff found</h3><p>${all.length ? 'Try another filter or search.' : 'Add doctors, nurses and responders so alerts reach the right people.'}</p>${manage ? '<button class="btn primary" data-act="add-staff">Add staff member</button>' : ''}</div>`);
}

function openStaffForm(id) {
  const s = id ? staffById(id) : { onDuty: true };
  const opt = (arr, v) => arr.map(x => `<option ${v === x ? 'selected' : ''}>${x}</option>`).join('');
  openModal({
    title: id ? 'Edit staff member' : 'Add staff member', submit: id ? 'Save changes' : 'Add staff member',
    body: `<div class="form-grid">${f('Full name', 'name', s.name, 'required')}
      <label>Role<select name="role">${opt(['Doctor', 'Nurse', 'Emergency responder', 'Administrator'], s.role)}</select></label>
      ${f('Department', 'department', s.department)}<label>Shift<select name="shift">${opt(['Morning', 'Evening', 'Night', 'On call'], s.shift)}</select></label>
      ${f('Phone', 'phone', s.phone, 'type="tel"')}${f('Email', 'email', s.email, 'type="email"')}
      <label class="full" style="flex-direction:row;align-items:center;gap:.6rem"><input type="checkbox" name="onDuty" style="width:auto" ${s.onDuty ? 'checked' : ''}>On duty now (receives alerts)</label></div>`,
    onSubmit: d => {
      d.onDuty = !!d.onDuty; d.name = d.name.trim();
      if (!d.name) { toast('Name is required.', 'attention'); return false; }
      if (id) Backend.update(`staff/${id}`, d); else Backend.push('staff', { ...d, createdAt: Date.now() });
      toast(id ? 'Staff member updated.' : 'Staff member added.');
    }
  });
}

/* ---------- 13. ALERTS ---------- */
const hm = ts => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
function alertVitals(a) {
  const v = a.vitals || {};
  return [
    isNum(v.bpm) && v.bpm > 0 ? `<span class="vpill">${ico('heart', 12)}${Math.round(v.bpm)} BPM</span>` : '',
    isNum(v.temperature) ? `<span class="vpill">${ico('thermo', 12)}${v.temperature.toFixed(1)} °C</span>` : '',
    isNum(v.spo2) && v.spo2 > 0 ? `<span class="vpill">${ico('drop', 12)}${Math.round(v.spo2)}% SpO₂</span>` : ''
  ].join('');
}
function alertCard(a, mini = false) {
  const lvl = a.level === 'critical' ? 'critical' : 'attention';
  const statusChip = `<span class="chip ${a.status === 'open' ? lvl : a.status === 'acknowledged' ? 'info' : 'normal'}">${a.status}</span>`;
  if (mini) {
    return `<article class="acard mini ${lvl} ${a.status === 'resolved' ? 'resolved' : ''}"><div class="acard-ico">${ico(lvl === 'critical' ? 'alert' : 'bell')}</div>
      <div class="acard-body"><h4>${esc(a.title)}</h4><div class="acard-meta"><a class="link" data-act="view" data-id="${esc(a.patientId)}">${esc(a.patientName)}</a><span>${timeAgo(a.createdAt)}</span>${statusChip}</div>
      ${a.status === 'open' && can('alert.ack') ? `<div class="acard-actions"><button class="btn ghost sm" data-act="ack" data-id="${a.id}">${ico('check', 14)}Acknowledge</button></div>` : ''}</div></article>`;
  }
  const p = patientById(a.patientId), notified = a.notified || [];
  const resp = a.ackAt ? Math.max(0, Math.round((a.ackAt - a.createdAt) / 60000)) : null;
  const step = (done, title, who, ts) => `<li class="${done ? 'done' : ''}"><i></i><b>${title}</b><span>${done ? `${who ? esc(who) + ' · ' : ''}${ts ? hm(ts) : ''}` : 'Waiting'}</span></li>`;
  return `<article class="alert2 ${lvl} ${a.status}">
    <div class="alert2-stripe"></div>
    <div class="alert2-main">
      <header class="alert2-head"><div class="acard-ico">${ico(lvl === 'critical' ? 'alert' : 'bell', 20)}</div>
        <div class="alert2-title"><h4>${esc(a.title)}</h4>
          <div class="acard-meta"><a class="who" data-act="view" data-id="${esc(a.patientId)}"><span class="avatar sm">${esc(initials(a.patientName))}</span>${esc(a.patientName)}</a>${p?.room ? `<span>${esc(p.room)}</span>` : ''}<span title="${fmtDT(a.createdAt)}">${ico('clock', 13)}${timeAgo(a.createdAt)}</span></div></div>
        <div class="alert2-badges"><span class="chip ${lvl}">${lvl === 'critical' ? 'Critical' : 'Attention'}</span>${statusChip}</div></header>
      ${a.message ? `<p class="alert2-msg">${esc(a.message)}</p>` : ''}
      <div class="vpills">${alertVitals(a)}</div>
      <div class="alert2-grid">
        <ol class="atl">${step(true, 'Detected', 'System', a.createdAt)}${step(!!(a.ackAt || a.ackBy), 'Acknowledged', a.ackBy, a.ackAt)}${step(a.status === 'resolved', 'Resolved', a.resolvedBy, a.resolvedAt)}</ol>
        <div class="alert2-side"><span class="muted small">Notified</span>
          <div class="notified">${notified.length ? notified.map(n => `<span class="chip role">${esc(n)}</span>`).join('') : '<span class="muted small">No on-duty staff were available.</span>'}</div>
          ${resp !== null ? `<span class="resp ${resp > 10 ? 'slow' : ''}">${ico('clock', 13)}Response time ${resp < 1 ? 'under 1 min' : resp + ' min'}</span>` : ''}</div></div>
      ${a.status !== 'resolved' ? `<footer class="acard-actions">
        ${a.status === 'open' && can('alert.ack') ? `<button class="btn ghost sm" data-act="ack" data-id="${a.id}">${ico('check', 14)}Acknowledge</button>` : ''}
        ${can('alert.resolve') ? `<button class="btn ghost sm" data-act="resolve" data-id="${a.id}">${ico('check-circle', 14)}Mark resolved</button>` : ''}
        <button class="btn ghost sm" data-act="view" data-id="${esc(a.patientId)}">Open monitor</button>
        ${lvl === 'critical' && can('emergency') ? `<button class="btn danger sm" data-act="emergency" data-id="${esc(a.patientId)}">Emergency panel</button>` : ''}</footer>` : ''}
    </div></article>`;
}
function weekChart() {
  const days = [...Array(7)].map((_, i) => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - (6 - i)); return d; });
  const data = days.map(d => { const t0 = d.getTime(), t1 = t0 + 864e5, inDay = state.alerts.filter(a => a.createdAt >= t0 && a.createdAt < t1); return { d, crit: inDay.filter(a => a.level === 'critical').length, att: inDay.filter(a => a.level !== 'critical').length }; });
  const max = Math.max(3, ...data.map(x => x.crit + x.att)), H = 92;
  return `<svg class="weekchart" viewBox="0 0 280 130" role="img" aria-label="Alerts in the last 7 days">${data.map((x, i) => {
    const hc = x.crit / max * H, ha = x.att / max * H, bx = 12 + i * 38;
    return `<g><rect class="b-att" x="${bx}" y="${104 - ha - hc}" width="22" height="${ha}" rx="3"/><rect class="b-crit" x="${bx}" y="${104 - hc}" width="22" height="${hc}" rx="3"/>
      ${x.crit + x.att ? `<text x="${bx + 11}" y="${98 - ha - hc}" text-anchor="middle" class="b-num">${x.crit + x.att}</text>` : ''}
      <text x="${bx + 11}" y="121" text-anchor="middle" class="b-day">${x.d.toLocaleDateString('en-GB', { weekday: 'short' })}</text></g>`;
  }).join('')}<line x1="6" y1="104" x2="274" y2="104" class="b-axis"/></svg>`;
}
function renderAlerts() {
  const all = state.alerts, q = $('#alert-search').value.trim().toLowerCase();
  const n = s => all.filter(a => a.status === s).length;
  const critOpen = all.filter(a => a.status === 'open' && a.level === 'critical').length;
  const acked = all.filter(a => a.ackAt && a.createdAt);
  const avg = acked.length ? Math.round(acked.reduce((t, a) => t + (a.ackAt - a.createdAt), 0) / acked.length / 60000) : null;
  setHTML($('#alert-stats'), [
    ['Open', n('open'), 'bell', n('open') ? 'bad' : 'muted'], ['Critical open', critOpen, 'alert', critOpen ? 'bad' : 'muted'],
    ['Acknowledged', n('acknowledged'), 'eye', 'info'], ['Resolved', n('resolved'), 'check-circle', 'ok'],
    ['Avg response', avg === null ? '--' : (avg < 1 ? '<1' : avg) + ' min', 'clock', 'violet']
  ].map(([l, v, i, t]) => `<div class="stat tone-${t}"><span class="stat-ico">${ico(i, 18)}</span><div><b>${v}</b><span>${l}</span></div></div>`).join(''));
  setHTML($('#alert-week'), weekChart());
  const chips = [['all', 'All', all.length], ['open', 'Open', n('open')], ['acknowledged', 'Acknowledged', n('acknowledged')], ['resolved', 'Resolved', n('resolved')]];
  setHTML($('#alert-filters'), chips.map(([k, l, c]) => `<button class="fchip ${state.afilter === k ? 'active' : ''}" data-afilter="${k}">${l}<b class="cnt">${c}</b></button>`).join(''));
  $('#alert-sev').value = state.asev;
  $('#alert-ack-all').classList.toggle('hidden', !can('alert.ack') || !n('open'));
  const list = all.filter(a => (state.afilter === 'all' || a.status === state.afilter) && (state.asev === 'all' || (state.asev === 'critical') === (a.level === 'critical')) && (!q || `${a.patientName} ${a.title} ${a.message}`.toLowerCase().includes(q)));
  let html = '', last = '';
  list.forEach(a => { const d = dayLabel(a.createdAt); if (d !== last) { html += `<h3 class="day-head">${d}</h3>`; last = d; } html += alertCard(a); });
  setHTML($('#alert-list'), html || '<div class="empty">' + ico('check-circle', 40) + '<h3>No alerts here</h3><p>Alerts are created automatically when a patient needs attention or becomes critical.</p></div>');
}

/* ---------- 14. EMERGENCY PANEL & MAP ---------- */
function openEmergency(pid) {
  const crit = state.patients.filter(p => getStatus(p.id).level === 'critical');
  const p = patientById(pid) || crit[0]; if (!p) { toast('No critical patients right now.'); return; }
  const st = getStatus(p.id), s = state.live[p.id] || {}, staff = recipientsFor(p, 'critical');
  const tel = (l, n) => n ? `<a class="btn ghost sm" href="tel:${esc(n)}">${ico('phone')}${l}</a>` : '';
  openModal({
    title: 'Emergency panel', wide: true,
    body: `<div class="emg-hero"><div class="avatar">${esc(initials(p.name))}</div><div><strong style="font-size:1.1rem">${esc(p.name)}</strong><br><span class="muted">${esc(p.age)} yrs · ${esc(p.room || 'No room')} · ${esc(st.title || stLabel(st))}</span></div></div>
      <p><strong>Last vitals:</strong> ${isNum(s.bpm) ? Math.round(s.bpm) + ' BPM' : '--'} · ${isNum(s.temp) ? s.temp.toFixed(1) + ' °C' : '--'} · ${isNum(s.spo2) ? Math.round(s.spo2) + '%' : '--'}</p>
      <p class="muted" style="margin:.4rem 0 .8rem">${esc(st.message || '')}</p>
      <h4>Do this now</h4><ul class="recs" style="border:none;padding:0;margin:.3rem 0 1rem"><li style="list-style:none">${recommendations(st).map(esc).join('</li><li style="list-style:none">')}</li></ul>
      <p class="small muted">Care team alerted: ${staff.length ? staff.map(esc).join(', ') : 'nobody on duty'}.</p>
      <div class="toolbar" style="margin:1rem 0 0">${tel('Call patient', p.phone)}${tel('Call ' + (p.contactName || 'emergency contact'), p.contactPhone)}
      <button class="btn primary sm" data-act="map-for" data-id="${p.id}">${ico('pin')}Nearest hospitals</button><button class="btn ghost sm" data-act="view" data-id="${p.id}">Open live monitor</button></div>`
  });
}
let map, mapMarkers, mapReady = false;
function initMap() {
  if (map) { setTimeout(() => map.invalidateSize(), 60); return; }
  if (typeof L === 'undefined') { $('#map').innerHTML = '<p class="muted" style="padding:1rem">The map library could not load. Check your connection.</p>'; return; }
  map = L.map('map').setView(DEFAULT_CENTER, 12);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap contributors' }).addTo(map);
  mapMarkers = L.layerGroup().addTo(map); mapReady = true;
  locate();
}
function locate() {
  if (!mapReady) return;
  $('#facility-list').innerHTML = '<p class="muted">Finding your location…</p>';
  const go = (lat, lon) => { map.setView([lat, lon], 13); mapMarkers.clearLayers(); L.circleMarker([lat, lon], { radius: 9, color: '#3fd0c4', fillColor: '#3fd0c4', fillOpacity: .9 }).addTo(mapMarkers).bindPopup('Your location'); findHospitals(lat, lon); };
  if (navigator.geolocation) navigator.geolocation.getCurrentPosition(pos => go(pos.coords.latitude, pos.coords.longitude), () => go(...DEFAULT_CENTER), { timeout: 8000 });
  else go(...DEFAULT_CENTER);
}
const km = (a, b, c, d) => { const r = x => x * Math.PI / 180, dl = r(c - a), dn = r(d - b), h = Math.sin(dl / 2) ** 2 + Math.cos(r(a)) * Math.cos(r(c)) * Math.sin(dn / 2) ** 2; return 12742 * Math.asin(Math.sqrt(h)); };
async function findHospitals(lat, lon) {
  const fallback = `<p class="muted">Could not load hospital data.</p><a class="link" target="_blank" rel="noopener" href="https://www.google.com/maps/search/hospitals+near+${lat},${lon}">Search hospitals in Google Maps</a>`;
  try {
    const q = `[out:json][timeout:15];(node["amenity"="hospital"](around:8000,${lat},${lon});way["amenity"="hospital"](around:8000,${lat},${lon}););out center 20;`;
    const r = await fetch('https://overpass-api.de/api/interpreter', { method: 'POST', body: 'data=' + encodeURIComponent(q) });
    const data = await r.json();
    const list = data.elements.map(e => ({ name: e.tags?.name || e.tags?.['name:en'] || 'Hospital', lat: e.lat ?? e.center?.lat, lon: e.lon ?? e.center?.lon })).filter(h => h.lat)
      .map(h => ({ ...h, d: km(lat, lon, h.lat, h.lon) })).sort((a, b) => a.d - b.d).slice(0, 8);
    if (!list.length) { $('#facility-list').innerHTML = fallback; return; }
    list.forEach(h => L.marker([h.lat, h.lon]).addTo(mapMarkers).bindPopup(esc(h.name)));
    $('#facility-list').innerHTML = list.map(h => `<div class="fac"><div><strong>${esc(h.name)}</strong><span class="muted small">${h.d.toFixed(1)} km away</span></div><a target="_blank" rel="noopener" href="https://www.google.com/maps/dir/?api=1&destination=${h.lat},${h.lon}">Directions</a></div>`).join('');
  } catch { $('#facility-list').innerHTML = fallback; }
}
function renderMapSide() {
  const crit = state.patients.filter(p => getStatus(p.id).level === 'critical');
  $('#map-patient').innerHTML = crit.length ? crit.map(p => `<div class="emg-hero" style="margin-top:.8rem"><div><strong>${esc(p.name)}</strong><br><span class="muted small">${esc(p.room || '')} · ${p.contactPhone ? `<a style="color:var(--brand)" href="tel:${esc(p.contactPhone)}">${esc(p.contactName || 'Contact')} ${esc(p.contactPhone)}</a>` : 'No emergency contact'}</span></div></div>`).join('') : '<p class="muted small">No patient is critical right now.</p>';
}

/* ---------- 15. SETTINGS (tabs) ---------- */
function openSettings() {
  $('#mode-live').classList.toggle('active', Backend.kind === 'live'); $('#mode-demo').classList.toggle('active', Backend.kind === 'demo');
  const sp = $('#sim-patient'); sp.innerHTML = state.patients.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
  $('#sim-card').classList.toggle('hidden', Backend.kind !== 'demo');
  paintSettingsPrefs();
  showSettingsTab(state.stab);
}
function paintSettingsPrefs() {
  const dark = document.documentElement.dataset.theme !== 'light';
  $$('#pref-theme button').forEach(b => b.classList.toggle('active', (b.dataset.theme === 'dark') === dark));
  $$('#pref-sound button').forEach(b => b.classList.toggle('active', (b.dataset.sound === 'off') === !!settings.mute));
  $('#session-name').textContent = session.name; $('#session-role').textContent = ROLES[session.role].label;
}
function showSettingsTab(tab) {
  state.stab = ['general', 'rules', 'access', 'data'].includes(tab) ? tab : 'general';
  $$('#settings-tabs button').forEach(b => b.classList.toggle('active', b.dataset.stab === state.stab));
  $$('.stab-panel').forEach(p => p.classList.toggle('hidden', p.id !== `stab-${state.stab}`));
  if (state.stab === 'rules') { renderRulesForm(); renderRulesLog(); }
  if (state.stab === 'access') renderAccess();
}

/* ----- dynamic rule thresholds ----- */
const ruleMetaText = (d, val) => {
  const m = rulesMeta[d.key];
  return `Default ${d.def}` + (m ? ` · changed ${fmtDT(m.ts)}${m.by ? ' by ' + esc(m.by) : ''}` : val !== d.def ? ' · customised' : ' · using default');
};
function ruleField(d) {
  const val = rules[d.key];
  return `<label class="rfield" data-key="${d.key}"><span class="rlabel">${d.label} (${d.unit})</span>
    <div class="rinput"><input type="number" data-rule="${d.key}" value="${val}" min="${d.min}" max="${d.max}" step="${d.step}" inputmode="decimal">
    <button type="button" class="rreset" data-act="reset-rule" data-key="${d.key}" title="Reset to default (${d.def})" aria-label="Reset ${esc(d.label)} to default">${ico('rotate', 14)}</button></div>
    <small class="rmeta">${ruleMetaText(d, val)}</small><small class="rerr"></small></label>`;
}
function renderRulesForm() {
  const g = k => RULE_BY_KEY[k];
  const row = keys => keys.map(k => ruleField(g(k))).join('');
  $('#rules-root').innerHTML = `
    <div class="rules-bar"><div><h3>Rule thresholds</h3><p class="muted">Changes apply to every patient and every connected dashboard as soon as you save.</p></div>
      <div class="rules-actions"><span class="chip attention hidden" id="rules-dirty">Unsaved changes</span>
        <button class="btn ghost" data-act="rules-discard">Discard</button>
        <button class="btn ghost" data-act="rules-defaults">${ico('rotate', 15)}Reset all to defaults</button>
        <button class="btn primary" data-act="rules-save" id="rules-save">${ico('check', 15)}Save changes</button></div></div>
    <section class="card zones-card"><div class="section-head tight"><h3>Live preview of the zones</h3><span class="muted small">Updates while you type</span></div><div id="zones"></div>
      <div class="zone-legend"><span><i class="dot critical"></i>Critical</span><span><i class="dot attention"></i>Needs attention</span><span><i class="dot normal"></i>Normal</span></div></section>
    <section class="card"><h3>Rule thresholds</h3>
      <div class="rgrid">${row(['hrAttHi', 'hrAttLo', 'hrCritHi', 'hrCritLo', 'tempAttHi', 'tempCritHi', 'tempAttLo', 'tempCritLo', 'spo2AttLo', 'spo2CritLo'])}</div>
      <label class="rswitch"><input type="checkbox" id="rule-age" ${rules.ageAdjust ? 'checked' : ''}><span><b>Adjust heart-rate limits for children</b><small>Under 12 years: +20 BPM · under 18 years: +10 BPM on the high limits.</small></span></label></section>
    <section class="card"><h3>Trend and signal-loss rules</h3>
      <div class="rgrid">${row(['rapidWindowSec', 'rapidRise', 'staleSec', 'lossWindow'])}</div></section>`;
  onRuleInput();
}
function readRuleInputs() {
  const v = {};
  $$('#rules-root input[data-rule]').forEach(i => { v[i.dataset.rule] = i.value === '' ? NaN : Number(i.value); });
  v.ageAdjust = !!$('#rule-age')?.checked;
  return v;
}
function zoneBarHTML(title, unit, lo, hi, cuts, mode) {
  const [cl, al, ah, ch] = cuts, pos = x => Math.max(0, Math.min(100, (x - lo) / (hi - lo) * 100));
  if (cuts.some(x => !isFinite(x))) return `<div class="zone"><div class="zone-top"><b>${title}</b></div><p class="muted small">Fix the highlighted values to preview this range.</p></div>`;
  const seg = (a, b, c) => `<i class="${c}" style="left:${pos(a)}%;width:${Math.max(0, pos(b) - pos(a))}%"></i>`;
  const marks = (mode === 'low' ? [cl, al] : [cl, al, ah, ch]).map(x => `<span style="left:${pos(x)}%">${+x.toFixed(1)}</span>`).join('');
  const segs = mode === 'low' ? seg(lo, cl, 'critical') + seg(cl, al, 'attention') + seg(al, hi, 'normal')
    : seg(lo, cl, 'critical') + seg(cl, al, 'attention') + seg(al, ah, 'normal') + seg(ah, ch, 'attention') + seg(ch, hi, 'critical');
  return `<div class="zone"><div class="zone-top"><b>${title}</b><span class="muted small">${unit}</span></div><div class="zone-track">${segs}</div><div class="zone-marks">${marks}</div></div>`;
}
function onRuleInput() {
  const v = readRuleInputs(), err = validateRules(v);
  let dirty = v.ageAdjust !== rules.ageAdjust;
  $$('#rules-root .rfield').forEach(el => {
    const k = el.dataset.key, d = RULE_BY_KEY[k], changed = v[k] !== rules[k];
    dirty = dirty || changed;
    el.classList.toggle('modified', changed); el.classList.toggle('invalid', !!err[k]);
    $('.rerr', el).textContent = err[k] || '';
    $('.rreset', el).classList.toggle('hidden', v[k] === d.def);
  });
  state.rulesDirty = dirty;
  $('#rules-dirty').classList.toggle('hidden', !dirty);
  $('#rules-save').disabled = !dirty || !!Object.keys(err).length;
  $('#zones').innerHTML =
    zoneBarHTML('Heart rate', 'BPM', 20, 200, [v.hrCritLo, v.hrAttLo, v.hrAttHi, v.hrCritHi]) +
    zoneBarHTML('Body temperature', '°C', 32, 42, [v.tempCritLo, v.tempAttLo, v.tempAttHi, v.tempCritHi]) +
    zoneBarHTML('Blood oxygen (SpO₂)', '%', 80, 100, [v.spo2CritLo, v.spo2AttLo, 100, 100], 'low');
}
function saveRules() {
  if (!can('rules.edit')) return toast('Only administrators can change the rules.', 'attention');
  const v = readRuleInputs(), err = validateRules(v), bad = Object.keys(err)[0];
  if (bad) { toast(`${RULE_BY_KEY[bad].label}: ${err[bad]}`, 'attention'); $(`#rules-root [data-rule="${bad}"]`)?.focus(); return; }
  const old = { ...rules }, keys = Object.keys(RULE_DEFAULTS).filter(k => v[k] !== old[k]);
  if (!keys.length) return toast('No changes to save.');
  const meta = { ...rulesMeta }, now = Date.now(), by = opName();
  keys.forEach(k => { if (k !== 'ageAdjust' && v[k] === RULE_DEFAULTS[k]) delete meta[k]; else meta[k] = { ts: now, by }; });
  state.rulesDirty = false;
  applyRules(v, meta);
  Backend.set('config/rules', { values: { ...rules }, meta });
  keys.forEach(k => Backend.push('config/rules_log', { key: k, label: RULE_BY_KEY[k]?.label || 'Child age adjustment', unit: RULE_BY_KEY[k]?.unit || '', from: old[k], to: v[k], by, ts: now }));
  renderRulesForm();
  toast(`Saved ${keys.length} rule${keys.length === 1 ? '' : 's'}. All patients were re-evaluated.`);
}
function renderRulesLog() {
  const fmtV = (x, u) => typeof x === 'boolean' ? (x ? 'on' : 'off') : `${x}${u ? ' ' + u : ''}`;
  setHTML($('#rules-log'), state.rulesLog.length
    ? state.rulesLog.map(e => `<div class="log-row"><span class="log-ico">${ico('edit', 14)}</span><div><b>${esc(e.by || 'Someone')}</b> changed <b>${esc(e.label)}</b> from <code>${esc(fmtV(e.from, e.unit))}</code> to <code>${esc(fmtV(e.to, e.unit))}</code><small>${fmtDT(e.ts)}</small></div></div>`).join('')
    : '<div class="empty inline">No changes yet. Edit a threshold above and save to start the history.</div>');
}

/* ----- access control ----- */
const roleHas = (role, perm) => ROLES[role].perms.includes('*') || ROLES[role].perms.includes(perm);
function renderAccess() {
  const mark = ok => ok ? `<span class="yes">${ico('check', 15)}</span>` : '<span class="no">—</span>';
  $('#access-root').innerHTML = `
    <div class="role-cards">${Object.entries(ROLES).map(([k, r]) => `<article class="card rolecard tone-${r.tone}"><div class="rolecard-top"><span class="role-badge tone-${r.tone}">${ico(k === 'admin' ? 'shield' : k === 'nurse' ? 'heart' : 'pin', 16)}${r.label}</span><b>${users.filter(u => u.role === k).length} account${users.filter(u => u.role === k).length === 1 ? '' : 's'}</b></div><p class="muted">${r.blurb}</p></article>`).join('')}</div>
    <section class="card"><div class="section-head tight"><h3>User accounts</h3><button class="btn primary sm" data-act="add-user">${ico('plus', 15)}Add account</button></div>
      <div class="table-wrap"><table class="table"><thead><tr><th>Name</th><th>Username</th><th>Role</th><th>Linked staff</th><th></th></tr></thead><tbody>
      ${users.map(u => { const st = staffById(u.staffId), r = ROLES[u.role] || ROLES.hospital; return `<tr><td><div class="cell-user"><div class="avatar sm">${esc(initials(u.name))}</div><div><strong>${esc(u.name)}</strong>${u.id === session.id ? '<span>You are signed in</span>' : ''}</div></div></td><td><code>${esc(u.username)}</code></td><td><span class="role-badge tone-${r.tone}">${r.label}</span></td><td>${st ? esc(st.name) : '<span class="muted">None</span>'}</td>
        <td><div class="row-actions"><button class="icon-btn sm" data-act="edit-user" data-id="${u.id}" aria-label="Edit">${ico('edit', 15)}</button>${u.id === session.id ? '' : `<button class="icon-btn sm danger" data-act="delete-user" data-id="${u.id}" aria-label="Delete">${ico('trash', 15)}</button>`}</div></td></tr>`; }).join('')}
      </tbody></table></div></section>
    <section class="card"><h3>What each role can do</h3><div class="table-wrap"><table class="table compact matrix"><thead><tr><th>Capability</th>${Object.values(ROLES).map(r => `<th class="c">${r.label}</th>`).join('')}</tr></thead><tbody>
      ${CAPABILITIES.map(([l, perm]) => `<tr><td>${l}</td>${Object.keys(ROLES).map(k => `<td class="c">${mark(roleHas(k, perm))}</td>`).join('')}</tr>`).join('')}</tbody></table></div>
      <p class="muted small" style="margin-top:.8rem">Accounts are checked in the browser. For a production deployment, protect the database with Firebase Authentication and security rules as well.</p></section>`;
}
function openUserForm(id) {
  const u = id ? users.find(x => x.id === id) : { role: 'nurse' };
  openModal({
    title: id ? 'Edit account' : 'Add account', submit: id ? 'Save changes' : 'Create account', wide: true,
    body: `<div class="form-grid">${f('Full name', 'name', u.name, 'required')}${f('Username', 'username', u.username, 'required autocomplete="off"')}
      <label>Role<select name="role">${Object.entries(ROLES).map(([k, r]) => `<option value="${k}" ${u.role === k ? 'selected' : ''}>${r.label}</option>`).join('')}</select></label>
      <label>Linked staff profile<select name="staffId"><option value="">None</option>${state.staff.map(s => `<option value="${s.id}" ${u.staffId === s.id ? 'selected' : ''}>${esc(s.name)} · ${esc(s.role)}</option>`).join('')}</select></label>
      <label class="full">${id ? 'New password (leave empty to keep the current one)' : 'Password (at least 6 characters)'}<input name="password" type="password" autocomplete="new-password" ${id ? '' : 'required'}></label></div>`,
    onSubmit: d => {
      const name = d.name.trim(), username = d.username.trim().toLowerCase();
      if (!name || !/^[a-z0-9._-]{3,}$/.test(username)) { toast('Use a name and a username of 3+ letters, numbers, dots or dashes.', 'attention'); return false; }
      if (users.some(x => x.username === username && x.id !== id)) { toast('That username is already taken.', 'attention'); return false; }
      if (!id && d.password.length < 6) { toast('The password needs at least 6 characters.', 'attention'); return false; }
      if (d.password && d.password.length < 6) { toast('The new password needs at least 6 characters.', 'attention'); return false; }
      if (id && u.role === 'admin' && d.role !== 'admin' && users.filter(x => x.role === 'admin').length < 2) { toast('There must be at least one administrator.', 'attention'); return false; }
      if (id) { Object.assign(u, { name, username, role: d.role, staffId: d.staffId || '' }); if (d.password) u.pass = pwHash(d.password); }
      else users.push({ id: 'u_' + Date.now().toString(36), name, username, role: d.role, staffId: d.staffId || '', pass: pwHash(d.password) });
      saveUsers();
      if (id && u.id === session.id) { session = u; applyPermissions(); if (!can(`view.${state.view}`)) go('overview'); }
      renderAccess(); toast(id ? 'Account updated.' : 'Account created.');
    }
  });
}

/* ----- data tools ----- */

function download(name, text) { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv' })); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000); }
const csv = (cols, rows) => [cols.join(','), ...rows.map(r => cols.map(c => `"${String(r[c] ?? '').replace(/"/g, '""')}"`).join(','))].join('\n');
const SEED = {
  staff: {
    demo_s1: { name: 'Dr. Sara Nabil', role: 'Doctor', department: 'Cardiology', phone: '+20 100 000 0001', email: 'sara.nabil@clinic.example', shift: 'Morning', onDuty: true },
    demo_s2: { name: 'Hany Mostafa', role: 'Nurse', department: 'Ward A', phone: '+20 100 000 0002', email: 'hany.m@clinic.example', shift: 'Morning', onDuty: true },
    demo_s3: { name: 'Dina Samir', role: 'Nurse', department: 'Ward B', phone: '+20 100 000 0003', email: 'dina.s@clinic.example', shift: 'Evening', onDuty: true },
    demo_s4: { name: 'Dr. Karim Fouad', role: 'Doctor', department: 'Emergency', phone: '+20 100 000 0004', email: 'karim.f@clinic.example', shift: 'On call', onDuty: true },
    demo_s5: { name: 'Tamer Ezzat', role: 'Emergency responder', department: 'Ambulance unit 2', phone: '+20 100 000 0005', email: 'tamer.e@clinic.example', shift: 'On call', onDuty: true }
  },
  patients: {
    demo_p1: { mrn: 'PC-1001', name: 'Ahmed Hassan', age: 68, gender: 'Male', room: 'Room 101', condition: 'Normal', assignedStaff: 'demo_s2', deviceId: 'ESP32-A1', phone: '+20 111 000 0001', contactName: 'Mahmoud Hassan', contactPhone: '+20 111 000 1001', notes: 'Hypertension, takes beta-blockers.' },
    demo_p2: { mrn: 'PC-1002', name: 'Fatma Ali', age: 74, gender: 'Female', room: 'Room 102', condition: 'Needs Attention', assignedStaff: 'demo_s2', deviceId: 'ESP32-A2', phone: '+20 111 000 0002', contactName: 'Heba Ali', contactPhone: '+20 111 000 1002', notes: 'Type 2 diabetes. Monitor temperature.' },
    demo_p3: { mrn: 'PC-1003', name: 'Omar Khaled', age: 59, gender: 'Male', room: 'Room 205', condition: 'Critical', assignedStaff: 'demo_s1', deviceId: 'ESP32-B1', phone: '+20 111 000 0003', contactName: 'Nour Khaled', contactPhone: '+20 111 000 1003', notes: 'Recovering from cardiac surgery.' },
    demo_p4: { mrn: 'PC-1004', name: 'Mona Ibrahim', age: 82, gender: 'Female', room: 'Home care', condition: 'Normal', assignedStaff: 'demo_s3', deviceId: 'ESP32-C1', phone: '+20 111 000 0004', contactName: 'Tarek Ibrahim', contactPhone: '+20 111 000 1004', notes: 'Lives alone. Remote follow-up.' },
    demo_p5: { mrn: 'PC-1005', name: 'Youssef Adel', age: 45, gender: 'Male', room: 'Room 210', condition: 'Needs Attention', assignedStaff: 'demo_s3', deviceId: 'ESP32-B2', phone: '+20 111 000 0005', contactName: 'Rania Adel', contactPhone: '+20 111 000 1005', notes: 'Post-procedure observation.' },
    demo_p6: { mrn: 'PC-1006', name: 'Salma Mahmoud', age: 71, gender: 'Female', room: 'Home care', condition: 'Normal', assignedStaff: 'demo_s2', deviceId: 'ESP32-C2', phone: '+20 111 000 0006', contactName: 'Amr Mahmoud', contactPhone: '+20 111 000 1006', notes: 'Atrial fibrillation history.' }
  }
};
const SIM_BASE = { demo_p1: [72, 36.7, 98], demo_p2: [84, 37.7, 96], demo_p3: [78, 36.9, 97], demo_p4: [66, 36.5, 97], demo_p5: [88, 37.0, 96], demo_p6: [74, 36.6, 98] };

/* ---------- 16. DEMO SIMULATOR ---------- */
const rnd = (a, b) => a + Math.random() * (b - a);
function simSample(pid) {
  const sim = state.sim[pid]; sim.t++;
  const b = sim.base, cur = sim.cur, m = sim.mode;
  let tgt = { bpm: b[0], temp: b[1], spo2: b[2] }, wearing = true;
  if (m === 'fever') tgt = { bpm: 112, temp: 39.4, spo2: 94 };
  if (m === 'tachy') tgt = { bpm: 130, temp: b[1], spo2: 95 };
  if (m === 'hypoxia') tgt = { bpm: 104, temp: b[1], spo2: 86 };
  if (m === 'loose') wearing = false;
  if (m === 'spike') { sim.spikeTicks++; if (sim.spikeTicks <= 6) cur.bpm += rnd(8, 11); else wearing = false; }
  else sim.spikeTicks = 0;
  if (m !== 'spike') { cur.bpm += (tgt.bpm - cur.bpm) * .3 + rnd(-1.5, 1.5); }
  cur.temp += (tgt.temp - cur.temp) * .25 + rnd(-.04, .04);
  cur.spo2 += (tgt.spo2 - cur.spo2) * .3 + rnd(-.35, .35);
  return { heart_rate: wearing ? Math.round(cur.bpm) : 0, temperature: +cur.temp.toFixed(1), spo2: wearing ? Math.round(Math.min(100, cur.spo2)) : 0, is_wearing: wearing, timestamp: Date.now() };
}
function startSimulator() {
  state.patients.forEach(() => { });
  Object.keys(SEED.patients).forEach(pid => {
    const b = SIM_BASE[pid]; state.sim[pid] = { mode: 'normal', base: b, cur: { bpm: b[0], temp: b[1], spo2: b[2] }, t: 0, spikeTicks: 0 };
    const h = (state.hist[pid] = []);
    for (let i = 40; i > 0; i--) { const raw = simSample(pid); raw.timestamp = Date.now() - i * 2000; const s = normalize(raw); s.rx = s.ts; h.push(s); }
  });
  const tick = () => Object.keys(state.sim).forEach(pid => { if (patientById(pid)) handleSample(pid, simSample(pid), { force: true }); });
  setTimeout(tick, 400); setInterval(tick, 2000);
}
function seedDemoData() {
  Object.entries(SEED.staff).forEach(([id, v]) => Backend.set(`staff/${id}`, { ...v, createdAt: Date.now() }));
  Object.entries(SEED.patients).forEach(([id, v]) => Backend.set(`patients/${id}`, { ...v, createdAt: Date.now() }));
  const now = Date.now();
  Backend.set('alerts/demo_a1', { patientId: 'demo_p4', patientName: 'Mona Ibrahim', level: 'attention', type: 'sensor-not-secure', title: 'Sensor not secure', message: 'Vitals were normal and stable before the signal dropped.', vitals: { bpm: 0, is_wearing: false }, status: 'resolved', notified: ['Dina Samir (Nurse)'], createdAt: now - 7200e3, ackBy: 'Dina Samir', resolvedBy: 'Dina Samir', resolvedAt: now - 6900e3 });
  Backend.set('alerts/demo_a2', { patientId: 'demo_p3', patientName: 'Omar Khaled', level: 'critical', type: 'vitals', title: 'Critical vital signs detected', message: 'SpO₂ low: 88 % · Heart rate high: 124 BPM', vitals: { bpm: 124, temperature: 37.2, spo2: 88, is_wearing: true }, status: 'acknowledged', notified: ['Dr. Sara Nabil (Doctor)', 'Dr. Karim Fouad (Doctor)', 'Tamer Ezzat (Emergency responder)'], createdAt: now - 86400e3, ackBy: 'Dr. Sara Nabil', ackAt: now - 86300e3 });
}

/* ---------- FOCUS VIEW (opened from the Overview cards) ---------- */
const FOCUS = {
  all: { title: 'All patients', sub: 'Everyone currently under monitoring', icon: 'users', tone: 'brand', test: () => true, empty: ['No patients yet', 'Add a patient profile to start monitoring.'] },
  streaming: { title: 'Streaming now', sub: 'Wearables that are sending live readings right now', icon: 'activity', tone: 'ok', test: p => !!freshLive(p.id), empty: ['Nobody is streaming', 'Check that the wearables are switched on and connected.'] },
  critical: { title: 'Critical', sub: 'Patients who need immediate medical attention', icon: 'alert', tone: 'bad', test: p => stCls(getStatus(p.id)) === 'critical', empty: ['No critical patients', 'Great news. Nobody needs emergency care right now.'] },
  attention: { title: 'Needs attention', sub: 'Vitals outside the normal range. Check on them soon', icon: 'bell', tone: 'warn', test: p => stCls(getStatus(p.id)) === 'attention', empty: ['Nobody needs attention', 'All monitored patients are either stable or silent.'] },
  normal: { title: 'Stable', sub: 'All tracked vitals are within healthy thresholds', icon: 'check-circle', tone: 'ok', test: p => stCls(getStatus(p.id)) === 'normal', empty: ['No stable patients right now', 'Patients appear here when their vitals are in range.'] },
  none: { title: 'No signal', sub: 'No fresh data: sensor off, detached or offline', icon: 'zap', tone: 'none', test: p => stCls(getStatus(p.id)) === 'none', empty: ['Every patient has a signal', 'No device is offline or silent.'] }
};
function openFocus(kind) {
  state.focus = FOCUS[kind] ? kind : 'all';
  const q = $('#focus-search'); if (q) q.value = '';
  go('focus');
}
const sevRank = p => ['critical', 'attention', 'none', 'normal'].indexOf(stCls(getStatus(p.id)));
const riskOf = p => getStatus(p.id).score || 0;
function focusSorted(list) {
  const by = {
    severity: (a, b) => sevRank(a) - sevRank(b) || riskOf(b) - riskOf(a),
    risk: (a, b) => riskOf(b) - riskOf(a),
    hr: (a, b) => (freshLive(b.id)?.bpm ?? -1) - (freshLive(a.id)?.bpm ?? -1),
    name: (a, b) => (a.name || '').localeCompare(b.name || ''),
    recent: (a, b) => (state.live[b.id]?.rx || 0) - (state.live[a.id]?.rx || 0)
  };
  return [...list].sort(by[state.fsort] || by.severity);
}
function focusCard(p) {
  const st = getStatus(p.id), cls = stCls(st), s = freshLive(p.id), raw = state.live[p.id], staff = staffById(p.assignedStaff);
  const LIM = limitsFor(p);
  const tile = (k, label, icon, d) => `<div class="ftile ${vcls(st, k)}"><span class="k">${ico(icon, 13)}${label}</span><b>${s ? fmt(s[k], d) : '--'}<small>${LIM[k].unit}</small></b><i>Normal ${LIM[k].normal}</i></div>`;
  const series = (state.hist[p.id] || []).filter(x => isNum(x.bpm)).slice(-40).map(x => x.bpm);
  const bad = (st.reasons || []).filter(r => r.level !== 'normal').slice(0, 3);
  const why = (bad.length ? bad : (st.reasons || []).slice(0, 1)).map(r => `<li class="${r.level}">${esc(r.text)}</li>`).join('');
  const openAlert = state.alerts.find(a => a.patientId === p.id && a.status === 'open');
  const risk = st.kind === 'nodata' || st.kind === 'offline' ? null : st.score;
  const barCol = cls === 'critical' ? 'bad' : cls === 'attention' ? 'warn' : cls === 'normal' ? 'ok' : 'none';
  return `<article class="fcard lvl-${cls}">
    <header class="fcard-head"><div class="avatar">${esc(initials(p.name))}</div>
      <div class="fcard-id"><strong>${esc(p.name)}</strong><span>${esc(p.mrn || '')}${p.mrn ? ' · ' : ''}${esc(p.age)} yrs · ${esc(p.gender || '—')} · ${esc(p.room || 'No room')}</span></div>
      <span class="chip ${cls}">${stLabel(st)}</span></header>
    <div class="ftiles">${tile('bpm', 'Heart rate', 'heart', 0)}${tile('temp', 'Temperature', 'thermo', 1)}${tile('spo2', 'SpO₂', 'drop', 0)}</div>
    <div class="frisk"><div class="frisk-top"><span>Risk score</span><b>${risk === null ? '--' : risk + '/100'}</b></div><div class="bar"><i style="width:${risk || 0}%;background:var(--${barCol})"></i></div></div>
    <ul class="reasons">${why}</ul>
    <div class="fnext">${ico('check', 14)}<span><b>Next step:</b> ${esc(recommendations(st)[0])}</span></div>
    <div class="fspark">${sparkline(series)}<span class="muted small">Last 40 heart-rate readings</span></div>
    <footer class="fcard-foot"><span class="muted small">${staff ? `${ico('briefcase', 13)} ${esc(staff.name)}` : 'Not assigned'} · ${raw ? timeAgo(raw.rx) : 'no reading'}</span>
      <div class="row-actions">
        ${openAlert && can('alert.ack') ? `<button class="btn ghost sm" data-act="ack" data-id="${openAlert.id}">${ico('check', 14)}Acknowledge</button>` : ''}
        ${p.contactPhone ? `<a class="btn ghost sm" href="tel:${esc(p.contactPhone)}">${ico('phone', 14)}Call</a>` : ''}
        ${cls === 'critical' && can('emergency') ? `<button class="btn danger sm" data-act="emergency" data-id="${p.id}">${ico('alert', 14)}Emergency</button>` : ''}
        <button class="btn primary sm" data-act="view" data-id="${p.id}">Monitor</button>
      </div></footer></article>`;
}
function focusRow(p) {
  const st = getStatus(p.id), cls = stCls(st), s = freshLive(p.id), raw = state.live[p.id], staff = staffById(p.assignedStaff);
  return `<tr class="lvl-${cls}"><td><div class="cell-user"><div class="avatar">${esc(initials(p.name))}</div><div><strong>${esc(p.name)}</strong><span>${esc(p.mrn || '')}${p.mrn ? ' · ' : ''}${esc(p.room || 'No room')}</span></div></div></td>
    <td><span class="chip ${cls}">${stLabel(st)}</span></td>
    <td class="num ${vcls(st, 'bpm')}">${s ? fmt(s.bpm) : '--'}</td><td class="num ${vcls(st, 'temp')}">${s ? fmt(s.temp, 1) : '--'}</td><td class="num ${vcls(st, 'spo2')}">${s ? fmt(s.spo2) : '--'}</td>
    <td><div class="minibar"><i style="width:${st.score || 0}%"></i></div><span class="muted small">${st.score ?? '--'}</span></td>
    <td>${staff ? esc(staff.name) : '<span class="muted">Unassigned</span>'}</td><td class="muted small">${raw ? timeAgo(raw.rx) : '—'}</td>
    <td><div class="row-actions"><button class="btn primary sm" data-act="view" data-id="${p.id}">Monitor</button></div></td></tr>`;
}
function renderFocus() {
  const kind = FOCUS[state.focus] ? state.focus : 'all', cfg = FOCUS[kind];
  const all = state.patients, group = all.filter(cfg.test), ids = new Set(group.map(p => p.id));
  $('#page-title').textContent = cfg.title; $('#page-sub').textContent = cfg.sub;
  /* hero */
  const live = group.map(p => freshLive(p.id)).filter(Boolean);
  const avg = (arr, d = 0) => arr.length ? (arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(d) : '--';
  const hr = avg(live.map(s => s.bpm).filter(isNum)), o2 = avg(live.map(s => s.spo2).filter(isNum));
  const risk = avg(group.map(riskOf).filter((v, i) => group[i] && getStatus(group[i].id).kind !== 'nodata'));
  const openAlerts = state.alerts.filter(a => a.status === 'open' && ids.has(a.patientId));
  const firstCrit = group.find(p => stCls(getStatus(p.id)) === 'critical');
  setHTML($('#focus-hero'), `<div class="fhero tone-${cfg.tone}">
    <button class="fback" data-go="overview">${ico('arrow-left', 16)}Overview</button>
    <div class="fhero-main"><span class="fhero-ico">${ico(cfg.icon, 30)}</span>
      <div class="fhero-text"><h2>${cfg.title}</h2><p>${cfg.sub}</p></div>
      <div class="fhero-count"><b>${group.length}</b><span>of ${all.length} patient${all.length === 1 ? '' : 's'}</span></div></div>
    <div class="fhero-stats">
      <div><span>Avg heart rate</span><b>${hr}<small>BPM</small></b></div>
      <div><span>Avg SpO₂</span><b>${o2}<small>%</small></b></div>
      <div><span>Avg risk score</span><b>${risk}<small>/100</small></b></div>
      <div><span>Open alerts</span><b>${openAlerts.length}</b></div></div>
    <div class="fhero-actions">
      ${openAlerts.length && can('alert.ack') ? `<button class="btn light" data-act="ack-group">${ico('check', 16)}Acknowledge ${openAlerts.length} alert${openAlerts.length === 1 ? '' : 's'}</button>` : ''}
      ${firstCrit && can('emergency') ? `<button class="btn light danger-text" data-act="emergency" data-id="${firstCrit.id}">${ico('alert', 16)}Open emergency panel</button>` : ''}
    </div></div>`);
  /* tabs with live counts */
  setHTML($('#focus-tabs'), Object.entries(FOCUS).map(([k, c]) => `<button class="ftab tone-${c.tone} ${k === kind ? 'active' : ''}" data-focus="${k}">${ico(c.icon, 15)}${c.title}<b>${all.filter(c.test).length}</b></button>`).join(''));
  /* toolbar sync */
  $$('#focus-mode button').forEach(b => b.classList.toggle('active', b.dataset.fmode === state.fmode));
  if ($('#focus-sort').value !== state.fsort) $('#focus-sort').value = state.fsort;
  /* body */
  const q = $('#focus-search').value.trim().toLowerCase();
  const list = focusSorted(group.filter(p => !q || `${p.name} ${p.mrn || ''} ${p.room || ''}`.toLowerCase().includes(q)));
  let body;
  if (!list.length) {
    const [h, t] = q ? ['No match', 'Try a different name, record number or room.'] : cfg.empty;
    body = `<div class="empty fempty tone-${cfg.tone}">${ico(q ? 'search' : cfg.icon, 40)}<h3>${h}</h3><p>${t}</p></div>`;
  } else if (state.fmode === 'table') {
    body = `<div class="card flush"><div class="table-wrap"><table class="table"><thead><tr><th>Patient</th><th>Status</th><th>HR</th><th>Temp °C</th><th>SpO₂ %</th><th>Risk</th><th>Care</th><th>Updated</th><th></th></tr></thead><tbody>${list.map(focusRow).join('')}</tbody></table></div></div>`;
  } else body = `<div class="fgrid">${list.map(focusCard).join('')}</div>`;
  setHTML($('#focus-body'), body);
}

/* ---------- HEALTH ANALYSIS ---------- */
const acharts = {};
let anaStamp = 0;
const PALETTE = ['#3fd0c4', '#6aa8ff', '#ffb454', '#a78bfa', '#ff7aa8', '#7ee081', '#f2d35e', '#5ec8f2'];
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const meanOf = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
const sdOf = a => { const m = meanOf(a); return m === null ? null : Math.sqrt(a.reduce((t, x) => t + (x - m) ** 2, 0) / a.length); };
function destroyAnalysisCharts() { Object.values(acharts).forEach(c => c.destroy()); Object.keys(acharts).forEach(k => delete acharts[k]); anaStamp = 0; }

/* statistics for one patient over the last n readings */
function analysisFor(pid, n) {
  const p = patientById(pid), all = (state.hist[pid] || []).slice(-n);
  const wear = all.filter(s => s.wearing && isNum(s.bpm));
  const base = { pid, p, total: all.length, count: wear.length, empty: wear.length < 3 };
  if (base.empty) return base;
  const lv = { normal: 0, attention: 0, critical: 0 };
  let riskSum = 0, rapidEvents = 0, prevRapid = false;
  wear.forEach((s, i) => {
    const c = classify(s, p, wear.slice(Math.max(0, i - 25), i));
    lv[c.level]++; riskSum += c.score;
    if (c.rapid && !prevRapid) rapidEvents++;
    prevRapid = c.rapid;
  });
  const bpm = wear.map(s => s.bpm), temp = wear.map(s => s.temp).filter(isNum), spo2 = wear.map(s => s.spo2).filter(isNum);
  const third = Math.max(1, Math.floor(bpm.length / 3)), delta = meanOf(bpm.slice(-third)) - meanOf(bpm.slice(0, third));
  const avgRisk = riskSum / wear.length;
  return {
    ...base, lv, pct: { normal: lv.normal / wear.length * 100, attention: lv.attention / wear.length * 100, critical: lv.critical / wear.length * 100 },
    hr: { mean: meanOf(bpm), sd: sdOf(bpm), min: Math.min(...bpm), max: Math.max(...bpm) },
    temp: temp.length ? { mean: meanOf(temp), sd: sdOf(temp) } : null, spo2: spo2.length ? { mean: meanOf(spo2), min: Math.min(...spo2) } : null,
    score: clamp(Math.round(100 - avgRisk), 0, 100), rapidEvents, uptime: wear.length / all.length * 100, delta,
    trend: delta > 6 ? 'rising' : delta < -6 ? 'falling' : 'steady', bpm
  };
}
const scoreTone = s => s >= 85 ? 'normal' : s >= 65 ? 'attention' : 'critical';
const scoreLabel = s => s >= 85 ? 'Excellent' : s >= 65 ? 'Fair' : 'Poor';

function chartBase(extra = {}) {
  const tick = cssVar('--muted'), grid = cssVar('--line'), text = cssVar('--text');
  return {
    responsive: true, maintainAspectRatio: false, animation: false, interaction: { mode: 'index', intersect: false },
    plugins: { legend: { labels: { color: text, usePointStyle: true, boxWidth: 8 } } },
    scales: { x: { ticks: { color: tick, maxTicksLimit: 8 }, grid: { color: grid } }, y: { ticks: { color: tick }, grid: { color: grid } } }, ...extra
  };
}
function upsertChart(id, type, data, options) {
  const cv = $('#' + id); if (!cv || typeof Chart === 'undefined') return;
  let c = acharts[id];
  if (c && c.canvas !== cv) { c.destroy(); c = null; }
  if (!c) { acharts[id] = new Chart(cv.getContext('2d'), { type, data, options }); return; }
  c.data = data; c.options = options; c.update('none');
}
function dropChart(id) { if (acharts[id]) { acharts[id].destroy(); delete acharts[id]; } }

function renderAnalysis() {
  if (Date.now() - anaStamp < 4000) return;
  anaStamp = Date.now();
  /* controls */
  const sel = $('#analysis-select'), sig = state.patients.map(p => p.id + p.name).join();
  if (sel.dataset.sig !== sig) { sel.dataset.sig = sig; sel.innerHTML = '<option value="all">All patients</option>' + state.patients.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join(''); }
  if (state.asel !== 'all' && !patientById(state.asel)) state.asel = 'all';
  sel.value = state.asel; $('#analysis-range').value = String(state.arange);
  const n = state.arange, single = state.asel !== 'all';
  const stats = state.patients.map(p => analysisFor(p.id, n)), ok = stats.filter(s => !s.empty);
  const focus = single ? stats.filter(s => s.pid === state.asel) : ok;
  const focusOk = focus.filter(s => !s.empty);
  $('#analysis-empty').classList.toggle('hidden', !!state.patients.length);
  $('#analysis-content').classList.toggle('hidden', !state.patients.length);
  if (!state.patients.length) return;

  /* KPIs */
  const avg = (fn, d = 0) => { const a = focusOk.map(fn).filter(v => v !== null && isFinite(v)); return a.length ? (a.reduce((x, y) => x + y, 0) / a.length).toFixed(d) : '--'; };
  const score = avg(s => s.score), sc = score === '--' ? null : +score;
  const openN = state.alerts.filter(a => a.status === 'open' && (!single || a.patientId === state.asel)).length;
  setHTML($('#analysis-kpis'), [
    ['Health score', sc === null ? '--' : sc, sc === null ? 'No data yet' : scoreLabel(sc), 'activity', sc === null ? 'muted' : scoreTone(sc) === 'normal' ? 'ok' : scoreTone(sc) === 'attention' ? 'warn' : 'bad'],
    ['Average heart rate', avg(s => s.hr.mean), 'BPM', 'heart', 'bad'],
    ['Time in normal range', avg(s => s.pct.normal), '% of readings', 'check-circle', 'ok'],
    ['Rapid-change events', focusOk.reduce((t, s) => t + s.rapidEvents, 0), `rise of ${rules.rapidRise}+ BPM in ${rules.rapidWindowSec}s`, 'trending-up', 'warn'],
    ['Signal uptime', avg(s => s.uptime), '% wearing', 'zap', 'info'],
    ['Open alerts', openN, openN ? 'waiting for action' : 'all clear', 'bell', openN ? 'bad' : 'muted']
  ].map(([l, v, sub, i, t]) => `<div class="akpi tone-${t}"><span class="kpi-ico">${ico(i, 18)}</span><span class="kpi-label">${l}</span><b>${v}</b><small>${sub}</small></div>`).join(''));

  /* chart 1: heart-rate trend */
  const hasData = ok.length > 0;
  $('#chart-trend-empty').classList.toggle('hidden', hasData);
  if (!hasData) { ['ch-trend', 'ch-zones', 'ch-hist', 'ch-vitals'].forEach(dropChart); }
  if (hasData) {
    if (single) {
      const p = patientById(state.asel), rows = (state.hist[p.id] || []).slice(-n).filter(s => s.wearing && isNum(s.bpm)), L = limitsFor(p).bpm;
      const ma = rows.map((_, i) => meanOf(rows.slice(Math.max(0, i - 4), i + 1).map(r => r.bpm)));
      upsertChart('ch-trend', 'line', {
        labels: rows.map(r => hhmmss(r.ts)), datasets: [
          { label: 'Heart rate', data: rows.map(r => r.bpm), borderColor: cssVar('--bad'), backgroundColor: 'rgba(255,77,106,.12)', fill: true, tension: .3, borderWidth: 2, pointRadius: 0 },
          { label: 'Moving average', data: ma, borderColor: cssVar('--brand'), borderWidth: 2, pointRadius: 0, tension: .4, fill: false },
          { label: 'Upper limit', data: rows.map(() => L.attHi), borderColor: 'rgba(255,180,84,.7)', borderDash: [6, 5], borderWidth: 1.5, pointRadius: 0, fill: false },
          { label: 'Critical limit', data: rows.map(() => L.critHi), borderColor: 'rgba(255,77,106,.7)', borderDash: [2, 4], borderWidth: 1.5, pointRadius: 0, fill: false },
          { label: 'Lower limit', data: rows.map(() => L.attLo), borderColor: 'rgba(106,168,255,.7)', borderDash: [6, 5], borderWidth: 1.5, pointRadius: 0, fill: false }]
      }, chartBase());
    } else {
      const series = ok.map(s => ({ p: s.p, v: (state.hist[s.pid] || []).slice(-n).filter(x => x.wearing && isNum(x.bpm)).map(x => x.bpm) }));
      const len = Math.max(...series.map(s => s.v.length));
      upsertChart('ch-trend', 'line', {
        labels: Array.from({ length: len }, (_, i) => `${len - i - 1} readings ago`),
        datasets: series.map((s, i) => ({ label: s.p.name, data: [...Array(len - s.v.length).fill(null), ...s.v], borderColor: PALETTE[i % PALETTE.length], borderWidth: 2, pointRadius: 0, tension: .3, fill: false, spanGaps: false }))
      }, chartBase({ scales: { x: { ticks: { display: false }, grid: { display: false } }, y: { ticks: { color: cssVar('--muted') }, grid: { color: cssVar('--line') } } } }));
    }
    $('#chart-trend-title').textContent = single ? `${patientById(state.asel).name} · heart rate with limits` : 'Heart rate · all patients';

    /* chart 2: time in each zone */
    const z = ok.slice().sort((a, b) => b.pct.critical + b.pct.attention - (a.pct.critical + a.pct.attention));
    upsertChart('ch-zones', 'bar', {
      labels: z.map(s => s.p.name), datasets: [
        { label: 'Normal', data: z.map(s => +s.pct.normal.toFixed(1)), backgroundColor: cssVar('--ok') },
        { label: 'Needs attention', data: z.map(s => +s.pct.attention.toFixed(1)), backgroundColor: cssVar('--warn') },
        { label: 'Critical', data: z.map(s => +s.pct.critical.toFixed(1)), backgroundColor: cssVar('--bad') }]
    }, chartBase({ indexAxis: 'y', scales: { x: { stacked: true, max: 100, ticks: { color: cssVar('--muted'), callback: v => v + '%' }, grid: { color: cssVar('--line') } }, y: { stacked: true, ticks: { color: cssVar('--muted') }, grid: { display: false } } } }));

    /* chart 3: heart-rate distribution */
    const pool = (single ? focusOk : ok).flatMap(s => s.bpm), lo = 40, step = 10, bins = 13;
    const counts = Array(bins).fill(0); pool.forEach(v => { counts[clamp(Math.floor((v - lo) / step), 0, bins - 1)]++; });
    const L0 = limitsFor(single ? patientById(state.asel) : { age: 40 }).bpm;
    const binCol = i => { const mid = lo + i * step + step / 2; return mid >= L0.critHi || mid <= L0.critLo ? cssVar('--bad') : mid > L0.attHi || mid < L0.attLo ? cssVar('--warn') : cssVar('--ok'); };
    upsertChart('ch-hist', 'bar', { labels: counts.map((_, i) => `${lo + i * step}${i === bins - 1 ? '+' : '–' + (lo + (i + 1) * step - 1)}`), datasets: [{ label: 'Readings', data: counts, backgroundColor: counts.map((_, i) => binCol(i)), borderRadius: 4 }] },
      chartBase({ plugins: { legend: { display: false } } }));

    /* chart 4: temperature and SpO2 (selected patient only) */
    $('#vitals-pick').classList.toggle('hidden', single);
    $('#ch-vitals-wrap').classList.toggle('hidden', !single);
    if (single) {
      const rows = (state.hist[state.asel] || []).slice(-n).filter(s => s.wearing);
      upsertChart('ch-vitals', 'line', {
        labels: rows.map(r => hhmmss(r.ts)), datasets: [
          { label: 'Temperature (°C)', data: rows.map(r => r.temp), borderColor: cssVar('--warn'), yAxisID: 'y', borderWidth: 2, pointRadius: 0, tension: .3 },
          { label: 'SpO₂ (%)', data: rows.map(r => r.spo2), borderColor: cssVar('--info'), yAxisID: 'y1', borderWidth: 2, pointRadius: 0, tension: .3 }]
      }, chartBase({ scales: { x: { ticks: { color: cssVar('--muted'), maxTicksLimit: 6 }, grid: { color: cssVar('--line') } }, y: { position: 'left', ticks: { color: cssVar('--warn') }, grid: { color: cssVar('--line') } }, y1: { position: 'right', ticks: { color: cssVar('--info') }, grid: { display: false } } } }));
    } else dropChart('ch-vitals');
  }

  /* chart 5: alerts by type (last 7 days) */
  const since = Date.now() - 7 * 864e5, byType = {};
  state.alerts.filter(a => a.createdAt >= since && (!single || a.patientId === state.asel)).forEach(a => { byType[a.title] = (byType[a.title] || 0) + 1; });
  const types = Object.entries(byType).sort((a, b) => b[1] - a[1]);
  $('#ch-alerts-empty').classList.toggle('hidden', !!types.length);
  $('#ch-alerts-wrap').classList.toggle('hidden', !types.length);
  if (types.length) upsertChart('ch-alerts', 'doughnut', { labels: types.map(t => t[0]), datasets: [{ data: types.map(t => t[1]), backgroundColor: types.map((_, i) => PALETTE[i % PALETTE.length]), borderColor: cssVar('--panel'), borderWidth: 2 }] },
    { responsive: true, maintainAspectRatio: false, animation: false, cutout: '62%', plugins: { legend: { position: 'bottom', labels: { color: cssVar('--text'), usePointStyle: true, boxWidth: 8 } } } });
  else dropChart('ch-alerts');

  /* insights */
  const ins = [];
  ok.forEach(s => {
    const nm = esc(s.p.name), at = `data-pid="${s.pid}"`;
    if (s.pct.critical >= 10) ins.push({ w: 3, t: 'critical', pid: s.pid, html: `<b>${nm}</b> spent ${s.pct.critical.toFixed(0)}% of the period in the critical zone.` });
    else if (s.pct.attention + s.pct.critical >= 25) ins.push({ w: 2, t: 'attention', pid: s.pid, html: `<b>${nm}</b> was outside the normal range ${(s.pct.attention + s.pct.critical).toFixed(0)}% of the time.` });
    if (s.trend !== 'steady' && Math.abs(s.delta) >= 8) ins.push({ w: 2, t: 'attention', pid: s.pid, html: `<b>${nm}</b>'s heart rate is ${s.trend} (${s.delta > 0 ? '+' : ''}${s.delta.toFixed(0)} BPM from start to end).` });
    if (s.hr.sd >= 12) ins.push({ w: 1, t: 'attention', pid: s.pid, html: `<b>${nm}</b> has an unstable heart rate (±${s.hr.sd.toFixed(0)} BPM spread).` });
    if (s.rapidEvents) ins.push({ w: 2, t: 'attention', pid: s.pid, html: `<b>${nm}</b> had ${s.rapidEvents} rapid heart-rate rise${s.rapidEvents === 1 ? '' : 's'} (+${rules.rapidRise} BPM within ${rules.rapidWindowSec}s).` });
    if (s.spo2 && s.spo2.mean < rules.spo2AttLo) ins.push({ w: 3, t: 'critical', pid: s.pid, html: `<b>${nm}</b>'s average SpO₂ is ${s.spo2.mean.toFixed(1)}%, below the ${rules.spo2AttLo}% target.` });
    if (s.uptime < 80) ins.push({ w: 1, t: 'info', pid: s.pid, html: `<b>${nm}</b>'s sensor was only worn ${s.uptime.toFixed(0)}% of the time. Check the strap or finger fit.` });
  });
  stats.filter(s => s.empty && s.total).forEach(s => ins.push({ w: 0, t: 'none', pid: s.pid, html: `<b>${esc(s.p.name)}</b> has too few valid readings to analyse yet.` }));
  const shown = (single ? ins.filter(i => i.pid === state.asel) : ins).sort((a, b) => b.w - a.w).slice(0, 8);
  setHTML($('#analysis-insights'), shown.length ? shown.map(i => `<button class="insight ${i.t}" data-pid="${i.pid}"><i class="dot ${i.t}"></i><span>${i.html}</span>${ico('arrow-right', 14)}</button>`).join('')
    : `<div class="insight-ok">${ico('check-circle', 28)}<div><b>${ok.length ? 'Everything looks stable' : 'Waiting for data'}</b><span>${ok.length ? 'No concerning patterns were found in the selected period.' : 'Insights appear as soon as patients send readings.'}</span></div></div>`);

  /* ranking table */
  const rank = ok.slice().sort((a, b) => a.score - b.score);
  setHTML($('#analysis-rank'), rank.length ? rank.map(s => `<tr data-pid="${s.pid}" class="clickable ${state.asel === s.pid ? 'sel' : ''}">
    <td><div class="cell-user"><div class="avatar sm">${esc(initials(s.p.name))}</div><div><strong>${esc(s.p.name)}</strong><span>${esc(s.p.room || '')}</span></div></div></td>
    <td><div class="scorecell"><span class="chip ${scoreTone(s.score)}">${s.score} · ${scoreLabel(s.score)}</span><div class="minibar ${scoreTone(s.score)}"><i style="width:${s.score}%"></i></div></div></td>
    <td class="num">${s.hr.mean.toFixed(0)} <small class="muted">±${s.hr.sd.toFixed(0)}</small></td><td class="num">${s.temp ? s.temp.mean.toFixed(1) : '--'}</td><td class="num">${s.spo2 ? s.spo2.mean.toFixed(0) : '--'}</td>
    <td class="num">${s.pct.normal.toFixed(0)}%</td><td class="num">${s.rapidEvents}</td><td class="num">${s.uptime.toFixed(0)}%</td>
    <td><span class="trendtag ${s.trend}">${s.trend === 'rising' ? '▲ Rising' : s.trend === 'falling' ? '▼ Falling' : '● Steady'}</span></td></tr>`).join('')
    : '<tr><td colspan="9"><div class="empty inline">Not enough readings yet. Let the wearables stream for a minute.</div></td></tr>');
  window.__analysisRows = rank;
}
function exportAnalysis() {
  const rows = (window.__analysisRows || []).map(s => ({ patient: s.p.name, room: s.p.room || '', health_score: s.score, avg_hr: s.hr.mean.toFixed(1), hr_sd: s.hr.sd.toFixed(1), avg_temp: s.temp ? s.temp.mean.toFixed(2) : '', avg_spo2: s.spo2 ? s.spo2.mean.toFixed(1) : '', pct_normal: s.pct.normal.toFixed(1), pct_attention: s.pct.attention.toFixed(1), pct_critical: s.pct.critical.toFixed(1), rapid_events: s.rapidEvents, uptime_pct: s.uptime.toFixed(1), trend: s.trend }));
  if (!rows.length) return toast('Nothing to export yet.', 'attention');
  download('health-analysis.csv', csv(Object.keys(rows[0]), rows));
}

/* ---------- 17. MODALS & NAVIGATION ---------- */
function openModal({ title, body, submit = 'Save', onSubmit, wide = false, danger = false }) {
  const root = $('#modal-root');
  root.innerHTML = `<div class="overlay"><form class="modal ${wide ? 'wide' : ''}"><header><h3>${title}</h3><button type="button" class="icon-btn sm" data-close aria-label="Close">${ico('x')}</button></header>
    <div class="modal-body">${body}</div><footer>${onSubmit ? `<button type="button" class="btn ghost" data-close>Cancel</button><button class="btn ${danger ? 'danger' : 'primary'}" type="submit">${submit}</button>` : '<button type="button" class="btn ghost" data-close>Close</button>'}</footer></form></div>`;
  const form = $('form', root);
  form.addEventListener('submit', e => { e.preventDefault(); if (!onSubmit || onSubmit(Object.fromEntries(new FormData(form))) !== false) closeModal(); });
  const first = $('input,select', form); if (first && onSubmit) first.focus();
}
const closeModal = () => { $('#modal-root').innerHTML = ''; };
function confirmDelete(what, fn) { openModal({ title: `Delete ${what}?`, body: '<p>This cannot be undone.</p>', submit: 'Delete', danger: true, onSubmit: () => { fn(); } }); }
const need = perm => can(perm) || (toast('Your role does not have permission to do that.', 'attention'), false);

/* ----- sign in / sign out / permissions ----- */
function showLogin() {
  $('#login').classList.remove('hidden'); $('.app').classList.add('locked');
  const hints = DEFAULT_ACCOUNTS.filter(a => { const u = users.find(x => x.id === a.id); return u && u.pass === pwHash(a.demo); });
  $('#login-hints').innerHTML = hints.map(a => `<button type="button" class="hint tone-${ROLES[a.role].tone}" data-login="${a.id}"><span class="role-badge tone-${ROLES[a.role].tone}">${ROLES[a.role].label}</span><code>${a.username} / ${a.demo}</code></button>`).join('');
  $('#login-user').focus();
}
function doLogin(e) {
  e.preventDefault();
  const name = $('#login-user').value.trim().toLowerCase(), pw = $('#login-pass').value;
  const u = users.find(x => x.username === name && x.pass === pwHash(pw));
  const err = $('#login-err');
  if (!u) { err.textContent = 'Wrong username or password.'; err.classList.remove('hidden'); $('#login-card').classList.remove('shake'); void $('#login-card').offsetWidth; $('#login-card').classList.add('shake'); return; }
  sessionStorage.setItem('pc_session', u.id);
  location.reload();
}
function signOut() { sessionStorage.removeItem('pc_session'); location.reload(); }
function applyPermissions() {
  $$('[data-perm]').forEach(el => el.classList.toggle('hidden', !can(el.dataset.perm)));
  $$('.two-col').forEach(c => c.classList.toggle('single', [...c.children].filter(x => !x.classList.contains('hidden')).length < 2));
  const r = ROLES[session.role];
  $('#user-name').textContent = session.name; $('#user-role').textContent = r.label; $('#user-avatar').textContent = initials(session.name);
  $('#user-panel-name').textContent = session.name; $('#user-panel-role').className = `role-badge tone-${r.tone}`; $('#user-panel-role').textContent = r.label;
  $('#user-avatar').className = `avatar sm tone-${r.tone}`;
}

function go(view) {
  if (!DEVICE_VIEWS[view] || !can(`view.${view}`)) { if (DEVICE_VIEWS[view]) toast('Your role does not have access to that page.', 'attention'); view = 'overview'; }
  state.view = view;
  $$('.view').forEach(v => v.classList.toggle('active', v.id === `view-${view}`));
  const navView = view === 'focus' ? 'overview' : view;
  $$('.nav-item').forEach(n => n.classList.toggle('active', n.dataset.view === navView));
  const [t, sub] = DEVICE_VIEWS[view]; $('#page-title').textContent = t; $('#page-sub').textContent = sub;
  $('#sidebar').classList.remove('open'); $('#scrim').classList.remove('show');
  hideDropdowns();
  anaStamp = 0;
  if (view === 'map') initMap();
  if (view === 'settings') openSettings();
  if (view === 'monitor' && chart) setTimeout(() => chart.resize(), 30);
  history.replaceState(null, '', `#${view}${view === 'focus' ? '/' + state.focus : ''}`);
  window.scrollTo({ top: 0 });
  scheduleRender();
}
function openPatient(pid) { if (patientById(pid)) state.selected = pid; go('monitor'); }

document.addEventListener('click', e => {
  /* close floating panels when clicking elsewhere */
  [['.gsearch', '#search-results'], ['.bellwrap', '#bell-panel'], ['.usermenu', '#user-panel']].forEach(([wrap, panel]) => { if (!e.target.closest(wrap)) $(panel).classList.add('hidden'); });
  const t = e.target.closest('[data-act],[data-go],[data-close],[data-pid],[data-filter],[data-afilter],[data-sfilter],[data-focus],[data-fmode],[data-metric],[data-view],[data-stab],[data-login]');
  if (!t) { if (e.target.classList?.contains('overlay')) closeModal(); return; }
  const d = t.dataset;
  if ('close' in d) return closeModal();
  if (d.login) { const a = DEFAULT_ACCOUNTS.find(x => x.id === d.login); $('#login-user').value = a.username; $('#login-pass').value = a.demo; return $('#login-form').requestSubmit(); }
  if (d.view) return go(d.view);
  if (d.go) return go(d.go);
  if (d.focus) return openFocus(d.focus);
  if (d.fmode) { state.fmode = d.fmode; return scheduleRender(); }
  if (d.filter) { state.filter = d.filter; return scheduleRender(); }
  if (d.afilter) { state.afilter = d.afilter; return scheduleRender(); }
  if (d.sfilter) { state.sfilter = d.sfilter; return scheduleRender(); }
  if (d.stab) return showSettingsTab(d.stab);
  if (d.metric) { state.metric = d.metric; $$('.chart-tab').forEach(b => b.classList.toggle('active', b === t)); return scheduleRender(); }
  if (d.pid && !d.act) { hideDropdowns(); return openPatient(d.pid); }
  const id = d.id;
  switch (d.act) {
    case 'view': closeModal(); hideDropdowns(); $('#global-search').value = ''; return openPatient(id);
    case 'add-patient': return need('patient.add') && openPatientForm();
    case 'edit-patient': return need('patient.edit') && openPatientForm(id);
    case 'delete-patient': return need('patient.delete') && confirmDelete('patient', () => { Backend.remove(`patients/${id}`); Backend.remove(`vitals/${id}`); delete state.status[id]; toast('Patient deleted.'); });
    case 'add-staff': return need('staff.manage') && openStaffForm();
    case 'edit-staff': return need('staff.manage') && openStaffForm(id);
    case 'delete-staff': return need('staff.manage') && confirmDelete('staff member', () => { state.patients.filter(p => p.assignedStaff === id).forEach(p => Backend.update(`patients/${p.id}`, { assignedStaff: '' })); Backend.remove(`staff/${id}`); toast('Staff member deleted.'); });
    case 'toggle-duty': { if (!need('staff.manage')) return; const s = staffById(id); return Backend.update(`staff/${id}`, { onDuty: !s.onDuty }); }
    case 'duty-only': state.dutyOnly = !state.dutyOnly; return scheduleRender();
    case 'ack': return need('alert.ack') && Backend.update(`alerts/${id}`, { status: 'acknowledged', ackBy: opName(), ackAt: Date.now() });
    case 'resolve': return need('alert.resolve') && Backend.update(`alerts/${id}`, { status: 'resolved', resolvedBy: opName(), resolvedAt: Date.now() });
    case 'ack-all': case 'ack-group': {
      if (!need('alert.ack')) return;
      const ids = d.act === 'ack-group' ? new Set(state.patients.filter(FOCUS[state.focus].test).map(p => p.id)) : null;
      const open = state.alerts.filter(a => a.status === 'open' && (!ids || ids.has(a.patientId)));
      open.forEach(a => Backend.update(`alerts/${a.id}`, { status: 'acknowledged', ackBy: opName(), ackAt: Date.now() }));
      return toast(open.length ? `${open.length} alert${open.length === 1 ? '' : 's'} acknowledged.` : 'No open alerts.');
    }
    case 'emergency': return need('emergency') && openEmergency(id);
    case 'map-for': closeModal(); return go('map');
    case 'locate': return locate();
    case 'link-device': if (need('patient.link') && state.selected) { Backend.set('iot/linked_patient', state.selected); toast('Wearable linked to this patient.'); } return;
    case 'link-confirm': { if (!need('patient.link')) return; const v = $('#link-select')?.value; if (v) { Backend.set('iot/linked_patient', v); state.selected = v; toast('Wearable linked.'); } return; }
    case 'set-mode': if (!need('data.tools')) return; localStorage.setItem('hm_mode', d.mode); return location.reload();
    case 'set-theme': if (document.documentElement.dataset.theme !== d.theme) $('#btn-theme').click(); return paintSettingsPrefs();
    case 'set-sound': settings.mute = d.sound === 'off'; localStorage.setItem('hm_settings', JSON.stringify(settings)); paintToggles(); return paintSettingsPrefs();
    case 'signout': return signOut();
    case 'rules-save': return saveRules();
    case 'rules-discard': state.rulesDirty = false; return renderRulesForm();
    case 'rules-defaults': $$('#rules-root input[data-rule]').forEach(i => { i.value = RULE_DEFAULTS[i.dataset.rule]; }); $('#rule-age').checked = RULE_DEFAULTS.ageAdjust; onRuleInput(); return toast('Defaults loaded. Click "Save changes" to apply them.');
    case 'reset-rule': { const i = $(`#rules-root [data-rule="${d.key}"]`); i.value = RULE_BY_KEY[d.key].def; return onRuleInput(); }
    case 'add-user': return need('users.manage') && openUserForm();
    case 'edit-user': return need('users.manage') && openUserForm(id);
    case 'delete-user': {
      if (!need('users.manage')) return; const u = users.find(x => x.id === id);
      if (!u || u.id === session.id) return toast('You cannot delete the account you are using.', 'attention');
      if (u.role === 'admin' && users.filter(x => x.role === 'admin').length < 2) return toast('There must be at least one administrator.', 'attention');
      return confirmDelete('account', () => { users = users.filter(x => x.id !== id); saveUsers(); renderAccess(); toast('Account deleted.'); });
    }
    case 'sim': { const pid = $('#sim-patient').value; if (state.sim[pid]) { state.sim[pid].mode = d.mode; toast(`Simulating "${t.textContent.trim()}" for ${patientById(pid)?.name}.`); } return; }
    case 'seed-db': return need('data.tools') && openModal({ title: 'Add sample records?', body: `<p>This writes ${Object.keys(SEED.patients).length} sample patients, ${Object.keys(SEED.staff).length} staff members and 2 alerts to ${Backend.kind === 'live' ? 'your Firebase database' : 'the demo data'}. Existing records are not touched.</p>`, submit: 'Add sample records', onSubmit: () => { seedDemoData(); toast('Sample records added.'); } });
    case 'export-patients': return need('data.tools') && download('patients.csv', csv(['id', 'mrn', 'name', 'age', 'gender', 'room', 'condition', 'phone', 'contactName', 'contactPhone', 'deviceId', 'notes'], state.patients));
    case 'export-staff': return need('data.tools') && download('staff.csv', csv(['id', 'name', 'role', 'department', 'shift', 'onDuty', 'phone', 'email'], state.staff));
    case 'export-vitals': { if (!need('export.vitals')) return; const p = patientById(state.selected); if (!p) return toast('Select a patient first.'); return download(`vitals-${p.name.replace(/\s+/g, '_')}.csv`, csv(['time', 'bpm', 'temperature', 'spo2', 'wearing'], (state.hist[p.id] || []).map(s => ({ time: new Date(s.ts).toISOString(), bpm: s.bpm, temperature: s.temp, spo2: s.spo2, wearing: s.wearing })))); }
    case 'export-analysis': return need('export.vitals') && exportAnalysis();
  }
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { closeModal(); hideDropdowns(); }
  if (e.key === 'Enter' && e.target.matches?.('.pcard')) openPatient(e.target.dataset.pid);
  if (e.key === '/' && session && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || '') && !$('#modal-root').firstChild) { e.preventDefault(); $('#global-search').focus(); }
});
document.addEventListener('input', e => { if (e.target.matches?.('#rules-root input')) onRuleInput(); });
$('#monitor-select').addEventListener('change', e => { state.selected = e.target.value; ecg.buf = []; scheduleRender(); });
$('#chart-range').addEventListener('change', e => { state.range = +e.target.value; scheduleRender(); });
['#patient-search', '#patient-filter', '#staff-search', '#alert-search', '#focus-search'].forEach(s => $(s).addEventListener('input', scheduleRender));
$('#focus-sort').addEventListener('change', e => { state.fsort = e.target.value; scheduleRender(); });
$('#alert-sev').addEventListener('change', e => { state.asev = e.target.value; scheduleRender(); });
$('#analysis-select').addEventListener('change', e => { state.asel = e.target.value; anaStamp = 0; scheduleRender(); });
$('#analysis-range').addEventListener('change', e => { state.arange = +e.target.value; anaStamp = 0; scheduleRender(); });
$('#global-search').addEventListener('input', () => { hideDropdowns('.gsearch'); renderSearchResults(); });
$('#global-search').addEventListener('focus', renderSearchResults);
$('#global-search').addEventListener('keydown', e => { if (e.key === 'Enter') { const first = $('#search-results .dd-item'); if (first) first.click(); } });
$('#btn-bell').addEventListener('click', () => { const p = $('#bell-panel'); hideDropdowns('.bellwrap'); p.classList.toggle('hidden'); if (!p.classList.contains('hidden')) renderBell(); });
$('#user-chip').addEventListener('click', () => { hideDropdowns('.usermenu'); $('#user-panel').classList.toggle('hidden'); });
$('#login-form').addEventListener('submit', doLogin);
$('#btn-menu').addEventListener('click', () => { $('#sidebar').classList.add('open'); $('#scrim').classList.add('show'); });
$('#scrim').addEventListener('click', () => { $('#sidebar').classList.remove('open'); $('#scrim').classList.remove('show'); });
function paintToggles() {
  const dark = document.documentElement.dataset.theme !== 'light';
  const th = $('#btn-theme'); th.innerHTML = ico(dark ? 'sun' : 'moon');
  const mu = $('#btn-mute'); mu.innerHTML = ico(settings.mute ? 'volume-x' : 'volume');
}
$('#btn-theme').addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
  document.documentElement.dataset.theme = next; localStorage.setItem('hm_theme', next);
  paintToggles(); buildChart(); destroyAnalysisCharts(); scheduleRender();
});
$('#btn-mute').addEventListener('click', () => { settings.mute = !settings.mute; localStorage.setItem('hm_settings', JSON.stringify(settings)); paintToggles(); });

/* ---------- 18. BOOT ---------- */
paintIcons();
paintToggles();
function startApp() {
  $('#login').classList.add('hidden'); $('.app').classList.remove('locked');
  applyPermissions();
  buildChart();
  requestAnimationFrame(ecgLoop);
  if (Backend.kind === 'demo') { seedDemoData(); }
  startData();
  if (Backend.kind === 'demo') setTimeout(startSimulator, 50);
  setInterval(() => {
    $('#clock').textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    Object.keys(state.live).forEach(evaluate);
    scheduleRender();
  }, 1000);
  const [startView, startFocus] = location.hash.slice(1).split('/');
  if (startView === 'focus' && FOCUS[startFocus]) state.focus = startFocus;
  go(DEVICE_VIEWS[startView] ? startView : 'overview');
}
const savedUser = users.find(u => u.id === sessionStorage.getItem('pc_session'));
if (savedUser) { session = savedUser; startApp(); } else showLogin();

function connectMQTT() {
  const client = new Paho.Client("broker.hivemq.com", 8884, "web_" + Math.random().toString(16).substr(2, 8));
  client.onMessageArrived = (message) => {
    try {
      const raw = JSON.parse(message.payloadString);
      // Feeds the reading directly into PulseCare's telemetry pipeline
      state.deviceRaw = raw;
      feedDevice(true);
      scheduleRender();
    } catch (err) {
      console.error("MQTT parsing error:", err);
    }
  };
  client.connect({
    useSSL: true,
    onSuccess: () => {
      console.log("MQTT connected over WSS");
      client.subscribe("pulsecare/iot/current");
    },
    onFailure: (e) => {
      console.warn("MQTT WSS connection failed, retrying...", e);
      setTimeout(connectMQTT, 4000);
    }
  });
}
connectMQTT();
