// Hotmonitor: reports, archive, topics, map, sources, the operator's swipe
// assessments and the admin/status pages. All data is rendered as text
// (textContent / createElement), never as HTML.
import {
  store, onChange, isAdmin, isGuest, loadMe, loadIndex, loadReport, loadAllReports, loadReportsRange, loadedReports, loadAssessments,
  currentByArticle, myRows, chainOf, assess, undo, AuthError, OfflineError, DeniedError, HttpError,
  loadUpdates, loadReads, loadNotices, markRead, isRead, refreshAll, adminGet, adminSend,
  reportDevice, pushKey, pushSubscribe, pushUnsubscribe, loadTrends, loadAuthorities, loadCourses, loadForces, loadStrikes,
} from './api.js';
import { gesture, verdictFor, stepFor, vibrate, isDragging } from './swipe.js';
import { FEATURES, AREAS, NEW_DAYS } from './features.js';

// ---------------------------------------------------------------- constants
const TOPICS = ['Drönare', 'Sabotage', 'IT-hot', 'Skuggflotta', 'Sanktioner', 'Diplomati', 'Arktis', 'Desinformation', 'Kinetiskt'];
const VERDICT = { 2: 'Mycket trovärdig', 1: 'Trovärdig', '-1': 'Tveksam', '-2': 'Inte trovärdig', 0: 'Återkallad', skip: 'Hoppa över' };
const STEPS = [-2, -1, 1, 2];
const TREND = { Stable: 'Stabilt', 'Trending up': 'Stigande', 'Trending down': 'Sjunkande' };
const COUNTRY = {
  NO: 'Norge', SE: 'Sverige', FI: 'Finland', DK: 'Danmark', EE: 'Estland', LV: 'Lettland', LT: 'Litauen',
  PL: 'Polen', DE: 'Tyskland', BY: 'Belarus', UA: 'Ukraina', RU: 'Ryssland', SK: 'Slovakien', RO: 'Rumänien',
  MD: 'Moldavien', US: 'USA', GB: 'Storbritannien', FR: 'Frankrike', BE: 'Belgien', NL: 'Nederländerna',
  CN: 'Kina', IN: 'Indien', AE: 'Förenade Arabemiraten', GL: 'Grönland', IS: 'Island', BG: 'Bulgarien',
  HU: 'Ungern', CZ: 'Tjeckien', AT: 'Österrike', IT: 'Italien', ES: 'Spanien', TR: 'Turkiet', GE: 'Georgien',
  IR: 'Iran', KP: 'Nordkorea', KZ: 'Kazakstan', AM: 'Armenien', AZ: 'Azerbajdzjan', GR: 'Grekland', PT: 'Portugal',
  IE: 'Irland', CH: 'Schweiz', HR: 'Kroatien', RS: 'Serbien', SI: 'Slovenien', JP: 'Japan', EU: 'EU',
};
const MAP_LAYOUT = [
  '', 'NO', 'SE', 'FI', '', '',
  '', 'DK', '', 'EE', 'RU', '',
  '', '', '', 'LV', '', '',
  '', 'DE', 'PL', 'LT', 'BY', '',
  '', '', 'SK', '', 'UA', '',
  '', '', '', 'RO', 'MD', '',
];
const MAP_CODES = new Set(MAP_LAYOUT.filter(Boolean));

// ---------------------------------------------------------------- DOM helpers
const SVG_NS = 'http://www.w3.org/2000/svg';

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'style') el.style.cssText = v;
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, String(v));
    }
  }
  append(el, kids);
  return el;
}
function append(el, kids) {
  for (const k of kids.flat(Infinity)) {
    if (k == null || k === false) continue;
    el.append(k instanceof Node ? k : String(k));
  }
}
function frag(...kids) { const f = document.createDocumentFragment(); append(f, kids); return f; }
function icon(paths, cls = 'chev', viewBox = '0 0 16 16') {
  const s = document.createElementNS(SVG_NS, 'svg');
  s.setAttribute('viewBox', viewBox);
  s.setAttribute('class', cls);
  s.setAttribute('aria-hidden', 'true');
  for (const d of paths) {
    const p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', d);
    s.appendChild(p);
  }
  return s;
}
const chevRight = () => icon(['M6 3l5 5-5 5']);
const chevDown = () => icon(['M4 6l4 4 4-4']);
const extIcon = () => icon(['M6 3h7v7', 'M13 3L4 12'], '');
const searchIcon = () => { const s = icon(['M20 20l-4.2-4.2'], '', '0 0 24 24'); const c = document.createElementNS(SVG_NS, 'circle'); c.setAttribute('cx', '11'); c.setAttribute('cy', '11'); c.setAttribute('r', '6.5'); s.prepend(c); return s; };
// ---------------------------------------------------------------- back (Version 3.20)
// The way here within the app, so the arrow goes back where you came from
// (and to the same scroll position), not to a fixed parent. A link opened
// from outside, with nothing before it, falls back to the page's parent.
const NAV_KEY = 'hm.nav';
let navStack = (() => { try { return JSON.parse(sessionStorage.getItem(NAV_KEY)) || []; } catch { return []; } })();
const scrollMemo = new Map();
let navBack = false;
const curHash = () => (location.hash && location.hash !== '#' ? location.hash : '#/');
function saveNav() { try { sessionStorage.setItem(NAV_KEY, JSON.stringify(navStack.slice(-50))); } catch { /* ignore */ } }
let lastHash = curHash();
function noteNav() {
  const now = curHash();
  const prevHash = lastHash;
  lastHash = now;
  if (prevHash) scrollMemo.set(prevHash, window.scrollY);
  navBack = navStack.length > 1 && navStack[navStack.length - 2] === now;
  if (navBack) navStack.pop();
  else if (navStack[navStack.length - 1] !== now) navStack.push(now);
  saveNav();
}
if (!navStack.length || navStack[navStack.length - 1] !== curHash()) { navStack.push(curHash()); saveNav(); }
// Filters change the address in place (history.replaceState): the way back
// follows, so the arrow returns to the page as it was left.
const replaceStateRaw = history.replaceState.bind(history);
history.replaceState = (...args) => {
  replaceStateRaw(...args);
  lastHash = curHash();
  if (navStack.length) navStack[navStack.length - 1] = lastHash; else navStack.push(lastHash);
  saveNav();
};

const ROUTE_LABEL = { '': 'Idag', rapport: 'Rapporten', handelse: 'Händelsen', arkiv: 'Arkiv', amnen: 'Ämnen', karta: 'Karta',
  narrativ: 'Narrativ', trender: 'Narrativ', myndigheter: 'Myndigheter', handlingsalternativ: 'Handlingsalternativ',
  styrkor: 'Styrkor', bedom: 'Bedöm', mina: 'Mina bedömningar', kalla: 'Källan', admin: 'Administration', om: 'Om' };
function labelOf(hash) {
  const first = hash.replace(/^#\/?/, '').split(/[/?]/)[0];
  if (first === 'styrkor' && /[?&](sys|unit)=/.test(hash)) return 'Förbandet';
  if (first === 'styrkor' && /[?&]s=anfall/.test(hash)) return 'Anfall mot Ukraina';
  return ROUTE_LABEL[first] || 'Tillbaka';
}

function goBack(fallback) {
  if (navStack.length > 1) history.back();
  else location.hash = fallback || '#/';
}

function backLink(href, label) {
  const prev = navStack.length > 1 ? navStack[navStack.length - 2] : null;
  return h('a', { class: 'back', href: prev || href, onclick: (ev) => { ev.preventDefault(); goBack(href); } },
    icon(['M12.5 4l-6 6 6 6'], '', '0 0 20 20'), prev ? labelOf(prev) : label);
}

// ---------------------------------------------------------------- formatting
const fmt1 = (v) => (v == null || Number.isNaN(Number(v)) ? '–' : Number(v).toFixed(1).replace('.', ','));
const fmtScore = (v) => (v == null ? '–' : Number.isInteger(Number(v)) ? String(v) : fmt1(v));
const signed = (v) => { const n = Number(v) || 0; return (n > 0 ? '+' : n < 0 ? '−' : '±') + fmt1(Math.abs(n)); };
const toDate = (d) => new Date(`${d}T12:00:00Z`);
const dateLong = (d) => toDate(d).toLocaleDateString('sv-SE', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
const dateShort = (d) => toDate(d).toLocaleDateString('sv-SE', { day: 'numeric', month: 'short', timeZone: 'UTC' }).replace('.', '');
const weekdayShort = (d) => toDate(d).toLocaleDateString('sv-SE', { weekday: 'short', timeZone: 'UTC' }).replace('.', '');
const addDays = (d, n) => { const x = toDate(d); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const tsFmt = (ts) => { const x = new Date(ts); return Number.isNaN(x.getTime()) ? '' : x.toLocaleString('sv-SE', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); };
const countryName = (c) => COUNTRY[c] || c;
const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const eventHref = (date, id) => `#/handelse/${encodeURIComponent(date)}/${encodeURIComponent(id)}`;

// Shared links are real paths the Worker answers with Open Graph tags:
// /h/<date>/<event id> and /d/<date>. The app itself routes on the hash.
const shareEventUrl = (date, id) => `${location.origin}/h/${encodeURIComponent(date)}/${encodeURIComponent(id)}`;
const shareDayUrl = (date) => `${location.origin}/d/${encodeURIComponent(date)}`;
function translateSharePath() {
  const m = location.pathname.match(/^\/(h|d)\/(\d{4}-\d{2}-\d{2})(?:\/([^/]+))?\/?$/);
  if (!m) return;
  let id = m[3] || '';
  try { id = decodeURIComponent(id); } catch { /* keep as is */ }
  const hash = m[1] === 'h' && id ? eventHref(m[2], id) : m[1] === 'd' ? `#/rapport/${encodeURIComponent(m[2])}` : '#/';
  history.replaceState(null, '', `/${hash}`);
}

// navigator.share where there is one (phones), otherwise copy the link.
async function shareLink({ title, text, url }) {
  if (navigator.share) {
    try { await navigator.share({ title, text, url }); return; } catch (e) {
      if (e && e.name === 'AbortError') return;   // the reader closed the share sheet
    }
  }
  try {
    await navigator.clipboard.writeText(url);
    announce('Länken är kopierad');
  } catch {
    openSheet((close) => frag(
      h('h2', { class: 'title-m' }, 'Dela'),
      h('p', { class: 'small muted' }, 'Kopiera länken:'),
      h('input', { class: 'share-url', type: 'text', readonly: true, value: url, autofocus: true, onfocus: (ev) => ev.target.select() }),
      h('div', { class: 'sheet-actions' }, h('button', { class: 'btn', type: 'button', onclick: close }, 'Stäng'))),
    { label: 'Dela' });
  }
}
function shareIcon() {
  return icon(['M12 3v12', 'M7.5 7.5L12 3l4.5 4.5', 'M5 13v6h14v-6'], '', '0 0 24 24');
}
function shareButton(info, label = 'Dela') {
  return h('button', { class: 'share-btn', type: 'button', onclick: () => shareLink(info) }, shareIcon(), label);
}
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
function scoreClass(s) { const n = Number(s); return n >= 8 ? 'score' : n >= 5 ? 'score mid' : 'score low'; }
function verdictPill(value, pending) {
  return h('span', { class: `verdict v-${value}${pending ? ' v-pending' : ''}` }, VERDICT[value], pending ? ' · väntar' : '');
}
function tierBadge(t) {
  const n = Number(t);
  return n ? h('span', { class: `badge tier-${Math.min(5, Math.max(1, n))}` }, `Nivå ${n}`) : null;
}
function firstSentence(text, max = 180) {
  const s = String(text || '').trim();
  const cut = s.search(/[.!?](\s|$)/);
  const one = cut > 0 && cut < max ? s.slice(0, cut + 1) : s;
  return one.length > max ? `${one.slice(0, max - 1).trimEnd()}…` : one;
}

// ---------------------------------------------------------------- router
let renderSeq = 0;
let currentRoute = '';
let hasNavigated = false;   // the first render keeps the browser's own focus
let assessmentsReady = Promise.resolve();

function parseHash() {
  const raw = location.hash.replace(/^#/, '') || '/';
  const [path, qs = ''] = raw.split('?');
  const parts = path.split('/').filter(Boolean).map((p) => { try { return decodeURIComponent(p); } catch { return p; } });
  return { parts, q: new URLSearchParams(qs) };
}

// Change query parameters of the current view without a new history entry.
function updateHash(mutate) {
  const { parts, q } = parseHash();
  mutate(q);
  const path = `#/${parts.map(encodeURIComponent).join('/')}`;
  const qs = q.toString();
  history.replaceState(null, '', `${path}${qs ? `?${qs}` : ''}`);
  route({ keepScroll: true });
}

function setTab(tab) {
  for (const a of document.querySelectorAll('.tabbar a')) {
    if (a.dataset.tab === tab) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
}

async function route({ keepScroll = false } = {}) {
  const seq = ++renderSeq;
  const { parts, q } = parseHash();
  const [first, ...rest] = parts;
  currentRoute = first || '';
  let tab = 'idag';
  let view;
  switch (first) {
    case undefined: view = () => viewReport(null, q); break;
    case 'rapport': tab = 'arkiv'; view = () => viewReport(rest[0], q); break;
    case 'handelse': view = () => viewEvent(rest[0], rest[1]); break;
    case 'arkiv': tab = 'arkiv'; view = () => viewArchive(q); break;
    case 'amnen': tab = 'amnen'; view = () => viewTopics(q); break;
    case 'karta': tab = 'karta'; view = () => viewMap(q); break;
    // #/trender is the tab's first name; links to it still work.
    case 'narrativ': case 'trender': tab = 'narrativ'; view = () => viewTrends(q); break;
    case 'myndigheter': view = () => viewAuthorities(q); break;
    case 'handlingsalternativ': view = () => viewCourses(); break;
    case 'styrkor': tab = 'styrkor'; view = () => (q.get('s') === 'anfall' ? viewStrikes()
      : q.get('sys') ? viewForceSystem(q.get('sys')) : q.get('unit') ? viewForceUnit(q.get('unit')) : viewForces()); break;
    case 'bedom': tab = 'bedom'; view = () => viewAssess(q); break;
    case 'mina': tab = 'bedom'; view = () => viewMine(); break;
    case 'kalla': view = () => viewSource(rest.join('/')); break;
    case 'admin': tab = ''; view = () => viewAdmin(q); break;
    case 'om': tab = ''; view = () => viewAbout(); break;
    default: view = () => viewReport(null, q);
  }
  setTab(tab);
  const main = document.getElementById('view');
  if (!main) return;
  const y = window.scrollY;
  let node;
  try { node = await view(); } catch (e) { node = errorView(e); }
  if (seq !== renderSeq) return;
  // Every page but Idag itself has the arrow back.
  if (currentRoute !== '' && node && !(node.querySelector && node.querySelector('.back'))) {
    const fallback = tab && tab !== 'idag' && currentRoute !== tab ? `#/${tab}` : '#/';
    const wrap = document.createDocumentFragment();
    wrap.append(backLink(fallback, labelOf(fallback)), node);
    node = wrap;
  }
  main.replaceChildren(node);
  const back = navBack && scrollMemo.has(curHash()) ? scrollMemo.get(curHash()) : null;
  navBack = false;
  if (back != null) {
    window.scrollTo(0, back);
    requestAnimationFrame(() => window.scrollTo(0, back));   // after late layout (maps, images)
  } else {
    window.scrollTo(0, keepScroll ? y : 0);
  }
  // A1: a new page (not a redraw of the same one) moves focus to its heading,
  // so a screen reader starts there; <main> is no longer a live region.
  if (!keepScroll && hasNavigated) {
    const h1 = main.querySelector('h1');
    if (h1) { h1.setAttribute('tabindex', '-1'); h1.focus({ preventScroll: true }); }
  }
  hasNavigated = true;
  // #/om?s=integritet and the like: open Om at that section.
  const anchor = currentRoute === 'om' && q.get('s') ? document.getElementById(`om-${q.get('s')}`) : null;
  if (anchor && !keepScroll) anchor.scrollIntoView({ block: 'start' });
}

function rerender() { if (!isDragging() && !document.querySelector('dialog[open]')) route({ keepScroll: true }); }

function errorView(e) {
  if (e instanceof DeniedError) {
    return h('div', { class: 'empty' },
      h('p', { class: 'title-m' }, 'Ingen åtkomst'),
      h('p', { class: 'muted' }, 'Din e-postadress är verifierad, men den har inte åtkomst till Hotmonitor. Kontakta en administratör om du behöver komma in.'));
  }
  if (e instanceof AuthError) {
    return h('div', { class: 'empty' },
      h('p', { class: 'title-m' }, 'Logga in igen'),
      h('p', { class: 'muted' }, 'Inloggningen saknas eller har gått ut.'),
      h('a', { class: 'btn primary', href: '/login' }, 'Logga in'));
  }
  if (e instanceof OfflineError) {
    return h('div', { class: 'empty' },
      h('p', { class: 'title-m' }, 'Ingen anslutning'),
      h('p', { class: 'muted' }, 'Det finns ingen sparad kopia av den här sidan ännu.'),
      h('button', { class: 'btn', type: 'button', onclick: () => route() }, 'Försök igen'));
  }
  console.error(e);
  const [title, text] = friendlyError(e);
  return h('div', { class: 'empty' },
    h('h1', { class: 'title-m' }, title),
    text ? h('p', { class: 'muted' }, text) : null,
    // The server's own (English, technical) words only for administrators.
    isAdmin() ? h('p', { class: 'muted small' }, `Tekniskt: ${String((e && e.message) || e)}`) : null,
    h('button', { class: 'btn', type: 'button', onclick: () => route() }, 'Försök igen'));
}

// U8: known failures in Swedish; the technical text stays out of sight.
const BUSY = 'Hotmonitor har många besökare just nu, försök igen om en stund.';
function friendlyError(e) {
  const status = e instanceof HttpError ? e.status : 0;
  if (status === 429 || /1027/.test(String(e && e.message))) return ['Många besökare just nu', BUSY];
  if (status === 404) return ['Hittades inte', 'Sidan eller uppgiften finns inte, eller har inte publicerats än.'];
  if (status === 503) return ['Tillfälligt otillgängligt', 'Tjänsten är tillfälligt otillgänglig. Försök igen om en stund.'];
  if (status >= 500) return ['Fel på servern', 'Något gick fel hos Hotmonitor. Försök igen om en stund.'];
  return ['Något gick fel', 'Sidan kunde inte visas. Försök igen.'];
}

function emptyState(text, ...extra) { return h('div', { class: 'empty' }, h('p', null, text), ...extra); }
function adminOnly() { return emptyState('Den här delen är bara för administratörer.'); }

// ---------------------------------------------------------------- sheets
// Bottom sheets are native modal <dialog>s: the rest of the page is inert,
// focus stays inside, and Esc closes them.
function openSheet(build, { label } = {}) {
  const dlg = h('dialog', { class: 'sheet', 'aria-label': label || null });
  const close = () => { if (dlg.open) dlg.close(); };
  // Changes made while the sheet was open were not painted: catch up now.
  dlg.addEventListener('close', () => { dlg.remove(); if (LIVE_ROUTES.has(currentRoute)) rerender(); });
  dlg.addEventListener('click', (ev) => { if (ev.target === dlg) close(); });
  append(dlg, [h('div', { class: 'sheet-body' }, build(close))]);
  document.body.append(dlg);
  dlg.showModal();
  const first = dlg.querySelector('[autofocus]');
  if (first) first.focus();
  return dlg;
}

function hostOf(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return u.hostname.replace(/^www\./, '');
  } catch { return null; }
}

// Every link that leaves the app goes through this warning first.
function openExternal(url, info = {}) {
  const host = hostOf(url);
  if (!host) return;
  openSheet((close) => frag(
    h('h2', { class: 'title-m', id: 'ext-title' }, 'Du lämnar Hotmonitor'),
    h('p', null, 'Du öppnar ', h('b', null, host), info.outlet ? ` (${info.outlet})` : '', '.'),
    h('p', { class: 'small muted' }, [
      info.tier ? `Källnivå ${info.tier}` : null,
      info.date ? `hämtad ${dateShort(info.date)}` : null,
    ].filter(Boolean).join(' · ')),
    h('p', { class: 'small muted' }, 'Externa sidor kan spåra dig. Det mesta av innehållet finns sammanfattat här i appen.'),
    h('div', { class: 'sheet-actions' },
      h('button', { class: 'btn', type: 'button', autofocus: true, onclick: close }, 'Stanna kvar'),
      h('a', { class: 'btn primary', href: url, target: '_blank', rel: 'noopener noreferrer', onclick: () => setTimeout(close, 0) }, 'Öppna originalet', extIcon()))),
  { label: 'Du lämnar Hotmonitor' });
}

function externalButton(url, info, label = 'Läs originalet') {
  if (!url || !hostOf(url)) return null;
  return h('button', { class: 'btn', type: 'button', onclick: (ev) => { ev.preventDefault(); ev.stopPropagation(); openExternal(url, info); } }, label, extIcon());
}


// ---------------------------------------------------------------- device: home screen, notifications
// On localhost only, ?sim=ios, ?sim=ios-standalone or ?sim=android fakes
// the device so these flows can be tried from a desktop browser.
const SIM = (() => {
  if (!/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) return '';
  try {
    const m = /[?&]sim=([a-z-]+)/.exec(location.search);
    if (m) sessionStorage.setItem('hm.sim', m[1] === 'off' ? '' : m[1]);
    return sessionStorage.getItem('hm.sim') || '';
  } catch { return ''; }
})();
const isIOS = () => (SIM ? SIM.startsWith('ios')
  : /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1));
const isAndroid = () => (SIM ? SIM === 'android' : /android/i.test(navigator.userAgent));
const isStandalone = () => (SIM ? SIM.endsWith('standalone')
  : navigator.standalone === true || matchMedia('(display-mode: standalone)').matches);
const platformOf = () => (isIOS() ? 'ios' : isAndroid() ? 'android' : 'desktop');
const PLATFORM_SV = { ios: 'iPhone/iPad', android: 'Android', desktop: 'dator' };
const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

let installPrompt = null;   // Chrome/Android: the deferred beforeinstallprompt event
window.addEventListener('beforeinstallprompt', (ev) => {
  ev.preventDefault();
  installPrompt = ev;
  if (currentRoute === '') rerender();
});
window.addEventListener('appinstalled', () => { installPrompt = null; if (currentRoute === '') rerender(); });

const SNOOZE_KEY = 'hm.installSnooze';
function installSnoozed() {
  try { return Date.now() < Number(localStorage.getItem(SNOOZE_KEY) || 0); } catch { return false; }
}
function snoozeInstall() {
  try { localStorage.setItem(SNOOZE_KEY, String(Date.now() + 7 * 86400000)); } catch { /* private mode */ }
}
// iOS never fires beforeinstallprompt; ignore one a simulated iOS page gets.
const promptReady = () => !!installPrompt && !isIOS();
const canOfferInstall = () => !isStandalone() && (isIOS() || isAndroid() || promptReady());

function installCard() {
  if (!canOfferInstall() || installSnoozed()) return null;
  return h('section', { class: 'card card-pad install', 'aria-labelledby': 'install-title' },
    h('div', { class: 'install-row' },
      h('img', { class: 'install-icon', src: '/apple-touch-icon.png', alt: '', width: 48, height: 48 }),
      h('div', null,
        h('h2', { class: 'kicker amber', id: 'install-title' }, 'Lägg till på hemskärmen'),
        h('p', { class: 'small' }, 'Öppna Hotmonitor som en app: i helskärm, snabbare, och med notiser vid allvarliga händelser.'))),
    h('div', { class: 'btn-row' },
      h('button', { class: 'btn primary', type: 'button', onclick: () => openInstall() }, promptReady() ? 'Installera' : 'Så gör du'),
      h('button', { class: 'btn', type: 'button', onclick: () => { snoozeInstall(); rerender(); } }, 'Inte nu')));
}

function figIcon(paths, cls) { return icon(paths, cls, '0 0 24 24'); }
const shareGlyph = (cls = 'fig-glyph') => figIcon(['M12 3v12', 'M8 7l4-4 4 4', 'M6 11H5v10h14V11h-1'], cls);
const addGlyph = (cls = 'fig-glyph') => figIcon(['M5 4h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z', 'M12 8v8', 'M8 12h8'], cls);

function iosSteps() {
  const step = (n, title, detail, figure) => h('li', { class: 'istep' },
    h('div', { class: 'istep-text' }, h('span', { class: 'istep-n', 'aria-hidden': 'true' }, String(n)),
      h('div', null, h('b', null, title), detail ? h('div', { class: 'small muted' }, detail) : null)),
    h('div', { class: 'fig', 'aria-hidden': 'true' }, figure));
  const toolbar = h('div', { class: 'fig-toolbar' },
    figIcon(['M15 5l-7 7 7 7'], 'fig-dim'), figIcon(['M9 5l7 7-7 7'], 'fig-dim'),
    h('span', { class: 'fig-hit' }, shareGlyph()),
    figIcon(['M6 4h12v17l-6-4-6 4z'], 'fig-dim'), figIcon(['M4 4h7v7H4z', 'M13 4h7v7h-7z', 'M4 13h7v7H4z', 'M13 13h7v7h-7z'], 'fig-dim'));
  const menu = h('div', { class: 'fig-menu' },
    h('div', { class: 'fig-mrow dim' }, h('span', null, 'Kopiera'), figIcon(['M8 8h11v12H8z', 'M5 16V4h11'], 'fig-glyph')),
    h('div', { class: 'fig-mrow hit' }, h('span', null, 'Lägg till på hemskärmen'), addGlyph()),
    h('div', { class: 'fig-mrow dim' }, h('span', null, 'Lägg till bokmärke'), figIcon(['M6 4h12v17l-6-4-6 4z'], 'fig-glyph')));
  const header = h('div', { class: 'fig-header' },
    h('span', { class: 'dim' }, 'Avbryt'), h('b', null, 'Lägg till på hemskärmen'), h('span', { class: 'fig-hit-text' }, 'Lägg till'));
  const notSafari = /crios|fxios|edgios/i.test(navigator.userAgent);
  return frag(
    notSafari ? h('p', { class: 'notice' }, 'Öppna sidan i Safari först – det är där det fungerar säkrast.') : null,
    h('ol', { class: 'isteps' },
      step(1, 'Tryck på Dela-knappen', 'Längst ned i Safari (på iPad uppe till höger).', toolbar),
      step(2, 'Välj ”Lägg till på hemskärmen”', 'Rulla ned i listan om du inte ser raden direkt.', menu),
      step(3, 'Tryck på ”Lägg till”', 'Uppe till höger.', header)),
    h('p', { class: 'small muted' }, 'Öppna sedan Hotmonitor från hemskärmen. Du behöver logga in en gång till där, med en ny engångskod.'));
}

async function openInstall() {
  if (promptReady()) {
    const ev = installPrompt;
    installPrompt = null;
    try { await ev.prompt(); await ev.userChoice; } catch { /* dismissed */ }
    rerender();
    return;
  }
  openSheet((close) => frag(
    h('h2', { class: 'title-m' }, 'Lägg till på hemskärmen'),
    isIOS() ? iosSteps()
      : isAndroid()
        ? h('ol', { class: 'bullets' },
          h('li', null, 'Öppna menyn ⋮ uppe till höger i Chrome.'),
          h('li', null, 'Välj ”Installera app” eller ”Lägg till på startskärmen”.'),
          h('li', null, 'Bekräfta med ”Installera”.'))
        : h('ol', { class: 'bullets' },
          h('li', null, 'Chrome eller Edge: klicka på installationsikonen till höger i adressfältet.'),
          h('li', null, 'Safari på Mac: menyn Arkiv → Lägg till i Dock.')),
    h('div', { class: 'sheet-actions' },
      h('button', { class: 'btn primary', type: 'button', autofocus: true, onclick: close }, 'Klart'))),
  { label: 'Lägg till på hemskärmen' });
}

function b64uToBytes(s) {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

async function currentSubscription() {
  if (!pushSupported()) return null;
  try { return await (await navigator.serviceWorker.ready).pushManager.getSubscription(); } catch { return null; }
}

// Called from the switch's change handler: the permission prompt must come
// straight from the user's tap, before any await.
async function enablePush() {
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error(perm === 'denied' ? 'blocked' : 'dismissed');
  const reg = await navigator.serviceWorker.ready;
  const key = await pushKey();
  if (!key) throw new Error('nokey');
  const old = await reg.pushManager.getSubscription();
  if (old) await old.unsubscribe().catch(() => {});
  const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uToBytes(key) });
  await pushSubscribe(sub.toJSON());
}

async function disablePush() {
  const sub = await currentSubscription();
  if (!sub) return;
  const endpoint = sub.endpoint;
  await sub.unsubscribe().catch(() => {});
  await pushUnsubscribe(endpoint).catch(() => {});
}

function openSettings() {
  openSheet((close) => {
    const status = h('p', { class: 'small muted', role: 'status', 'aria-live': 'polite' });
    const iosNeedsInstall = isIOS() && !isStandalone();
    let body;
    if (!pushSupported() || iosNeedsInstall) {
      body = iosNeedsInstall
        ? frag(
          h('p', null, 'På iPhone fungerar notiser bara när Hotmonitor är tillagd på hemskärmen och öppnad därifrån.'),
          h('button', { class: 'btn primary', type: 'button', onclick: () => { close(); openInstall(); } }, 'Så lägger du till den'))
        : h('p', null, 'Den här webbläsaren stöder inte notiser.');
    } else {
      const toggle = h('input', { type: 'checkbox', role: 'switch', id: 'push-toggle', class: 'switch', disabled: true });
      toggle.addEventListener('change', () => {
        const on = toggle.checked;
        toggle.disabled = true;
        status.textContent = on ? 'Slår på…' : 'Stänger av…';
        (on ? enablePush() : disablePush()).then(() => {
          pushState = on ? 'on' : 'off';
          status.textContent = on ? 'Notiser är på för den här enheten.' : 'Notiser är avstängda.';
        }).catch((e) => {
          toggle.checked = !on;
          const m = String((e && e.message) || e);
          status.textContent = m === 'blocked' ? 'Notiser är blockerade. Tillåt dem för Hotmonitor i enhetens inställningar.'
            : m === 'dismissed' ? 'Du valde att inte tillåta notiser.'
              : 'Det gick inte att ändra notiserna just nu. Försök igen.';
        }).finally(() => { toggle.disabled = false; });
      });
      currentSubscription().then((sub) => {
        toggle.checked = !!sub && Notification.permission === 'granted';
        toggle.disabled = false;
        if (Notification.permission === 'denied') status.textContent = 'Notiser är blockerade i enhetens inställningar.';
      });
      body = frag(
        h('div', { class: 'switch-row' },
          h('label', { for: 'push-toggle' }, h('b', null, 'Notiser vid allvarliga händelser')),
          toggle),
        h('p', { class: 'small' }, 'Du får en notis när hotindex ändras med 0,5 eller mer, eller när en ny händelse får 9–10 i trovärdighet.'),
        isAdmin() ? h('p', { class: 'small muted' }, 'Som administratör får du också ett larm om morgonrapporten uteblir.') : null,
        h('p', { class: 'small muted' }, 'Inställningen gäller den här enheten.'));
    }
    return frag(
      h('h2', { class: 'title-m' }, 'Notiser'),
      body,
      status,
      canOfferInstall() && !iosNeedsInstall ? h('div', { class: 'settings-row' },
        h('span', { class: 'small' }, 'Hotmonitor finns inte på hemskärmen ännu.'),
        h('button', { class: 'btn', type: 'button', onclick: () => { close(); openInstall(); } }, 'Lägg till på hemskärmen')) : null,
      h('div', { class: 'sheet-actions' }, h('button', { class: 'btn', type: 'button', autofocus: true, onclick: close }, 'Stäng')));
  }, { label: 'Notiser' });
}

// ---------------------------------------------------------------- notices, push nudge
const DISMISS_KEY = 'hm.dismissedNotices';
function dismissedNotices() {
  try { return new Set(JSON.parse(localStorage.getItem(DISMISS_KEY) || '[]')); } catch { return new Set(); }
}
function dismissNotice(id) {
  const ids = dismissedNotices(); ids.add(id);
  try { localStorage.setItem(DISMISS_KEY, JSON.stringify([...ids].slice(-100))); } catch { /* private mode */ }
}

function noticeCards() {
  const hidden = dismissedNotices();
  const shown = store.notices.filter((n) => n && n.id && !hidden.has(n.id));
  if (!shown.length) return null;
  return frag(...shown.map((n) => h('section', { class: 'card card-pad notice-card', 'aria-label': `Meddelande: ${n.title}` },
    h('div', { class: 'kicker amber' }, 'Meddelande'),
    h('h2', { class: 'title-m' }, n.title),
    h('p', { class: 'small' }, n.body),
    h('div', { class: 'btn-row' },
      n.url ? h('a', { class: 'btn primary', href: n.url.startsWith('#') ? n.url : n.url }, 'Öppna') : null,
      h('button', { class: 'btn', type: 'button', onclick: () => { dismissNotice(n.id); rerender(); } }, 'Stäng')))));
}

// Whether this device has a push subscription: 'unknown' until checked.
let pushState = 'unknown';
async function refreshPushState() {
  if (!pushSupported()) { pushState = 'unsupported'; return; }
  const sub = await currentSubscription();
  const next = sub && Notification.permission === 'granted' ? 'on' : 'off';
  if (next !== pushState) { pushState = next; if (currentRoute === '') rerender(); }
}
const NUDGE_KEY = 'hm.pushNudgeSnooze';
function nudgeSnoozed() {
  try { return Date.now() < Number(localStorage.getItem(NUDGE_KEY) || 0); } catch { return false; }
}
let nudgeMsg = '';
function pushNudge() {
  if (!isStandalone() || !pushSupported() || pushState !== 'off' || nudgeSnoozed()) return null;
  if (Notification.permission === 'denied') return null;
  const msg = h('p', { class: 'small muted', role: 'status', 'aria-live': 'polite' }, nudgeMsg);
  const btn = h('button', {
    class: 'btn primary', type: 'button',
    // The permission prompt must come straight from this tap: enablePush
    // asks for permission before awaiting anything else.
    onclick: () => {
      btn.disabled = true; msg.textContent = 'Slår på…';
      enablePush().then(() => { pushState = 'on'; nudgeMsg = ''; rerender(); })
        .catch((e) => {
          const m = String((e && e.message) || e);
          nudgeMsg = m === 'blocked' ? 'Notiser är blockerade. Tillåt dem för Hotmonitor i enhetens inställningar.'
            : m === 'dismissed' ? 'Du valde att inte tillåta notiser.' : 'Det gick inte att slå på notiser just nu.';
          msg.textContent = nudgeMsg; btn.disabled = false;
        });
    },
  }, 'Slå på notiser');
  return h('section', { class: 'card card-pad nudge', 'aria-labelledby': 'nudge-title' },
    h('h2', { class: 'kicker amber', id: 'nudge-title' }, 'Få notiser vid allvarliga händelser'),
    h('p', { class: 'small' }, 'En notis när hotindex rör sig mycket, när en ny händelse får 9–10 och när administratörerna skickar ett meddelande.'),
    h('div', { class: 'btn-row' }, btn,
      h('button', { class: 'btn', type: 'button', onclick: () => { try { localStorage.setItem(NUDGE_KEY, String(Date.now() + 14 * 86400000)); } catch { /* private mode */ } rerender(); } }, 'Inte nu')),
    msg);
}

function bellIcon() {
  return icon(['M6 16v-5a6 6 0 0 1 12 0v5l1.5 2h-15z', 'M10 20.5a2 2 0 0 0 4 0'], '', '0 0 24 24');
}

// ---------------------------------------------------------------- track record, outcomes
async function trackRecords() {
  const index = await loadIndex();
  if (!index.length) return {};
  const r = await loadReport(index[0].date);
  return (r && r.operator_track_record) || {};
}
function trackText(t) {
  if (!t || !Number(t.evaluated)) return null;
  const rate = t.rate != null ? Number(t.rate) : Number(t.agreed) / Number(t.evaluated);
  return `${t.agreed} av ${plural(Number(t.evaluated), 'bedömning', 'bedömningar')} stämde med utfallet (${Math.round(rate * 100)} %)`;
}
const OUTCOME = {
  CONFIRMED: ['Bekräftad senare', 'ok'],
  CONTRADICTED: ['Motsagd senare', 'no'],
  UNRESOLVED: ['Oklart', 'add'],
};
function laterOutcome(e, date, reports) {
  const later = reports.filter((x) => x.date > date).sort((a, b) => (a.date < b.date ? -1 : 1));
  for (const x of later) {
    const hit = (Array.isArray(x.self_check_results) ? x.self_check_results : []).find((c) => c && c.event_id === e.id);
    if (hit && OUTCOME[hit.outcome]) return { ...hit, checked: x.date };
  }
  return null;
}

// ---------------------------------------------------------------- new / read
// Only the last week counts as news: an account's first visit should not
// flag the whole archive as unread.
const SCOPE_DAYS = 7;
let scopeStart = '';            // first report date inside the news window
const badgeCounts = { idag: 0, arkiv: 0, bedom: 0 };

// U6: a guest's first visit draws a line at "now": everything published
// before it counts as read, so a newcomer is not met by "30 olästa".
// The badges and the "nya funktioner" chip start with the second visit.
const FLOOR_KEY = 'hm.readFloor';
let readFloor = null;          // { ts, date }: first visit and the latest report then
let firstVisitNow = false;     // the floor was drawn during this page load
try { readFloor = JSON.parse(localStorage.getItem(FLOOR_KEY) || 'null'); } catch { readFloor = null; }
function ensureReadFloor(index) {
  if (readFloor || !isGuest() || !index.length) return;
  readFloor = { ts: new Date().toISOString(), date: index[0].date };
  firstVisitNow = true;
  try { localStorage.setItem(FLOOR_KEY, JSON.stringify(readFloor)); } catch { /* private mode: this visit only */ }
}
const belowFloor = (date) => isGuest() && readFloor && date <= readFloor.date;

function updateIsNew(u) { return !isRead(u.id) && !(isGuest() && readFloor && u.ts <= readFloor.ts); }

function updatesInScope() {
  const cutoff = Date.now() - SCOPE_DAYS * 86400000;
  return store.updates.filter((u) => new Date(u.ts).getTime() >= cutoff
    && !(isGuest() && readFloor && u.ts <= readFloor.ts));
}
function unreadUpdates() { return updatesInScope().filter((u) => !isRead(u.id)); }
function eventState(date, e) {
  if (!scopeStart || date < scopeStart || belowFloor(date)) return null;
  if (!isRead(e.id)) return 'new';
  if (e.thread_id && unreadUpdates().some((u) => u.thread_id === e.thread_id)) return 'updated';
  return null;
}
function stateBadge(state) {
  if (state === 'new') return h('span', { class: 'nbadge' }, 'Ny');
  if (state === 'updated') return h('span', { class: 'nbadge upd' }, 'Uppdaterad');
  return null;
}

async function computeBadges() {
  try {
    const index = await loadIndex();
    if (!index.length) return;
    const latest = index[0].date;
    ensureScope(index);
    let idag = unreadUpdates().length;
    let arkiv = 0;
    for (const item of index) {
      if (item.date < scopeStart) break;
      // A guest's badges count what is already loaded; fetching the week
      // for them would add six requests to every first visit (review K1).
      if (isGuest() && item.date !== latest && !store.reports.has(item.date)) continue;
      const r = await loadReport(item.date);
      const n = r.events.filter((e) => eventState(r.date, e) === 'new').length;
      if (item.date === latest) idag += n; else arkiv += n;
    }
    // Bedöm counts news items in the latest report with a linked source
    // not yet assessed - the same unit the Bedöm deck shows.
    let bedom = 0;
    if (isAdmin()) {
      const cur = currentByArticle();
      const r = await loadReport(latest);
      for (const e of r.events) {
        if (linkedArticles(e).some((a) => { const c = cur.get(a.id); return !c || c.value === 0; })) bedom += 1;
      }
    }
    Object.assign(badgeCounts, { idag, arkiv, bedom });
    paintBadges();
  } catch (e) {
    if (!(e instanceof OfflineError)) console.warn('badges', e);
  }
}

function paintBadges() {
  for (const a of document.querySelectorAll('.tabbar a')) {
    const n = badgeCounts[a.dataset.tab] || 0;
    let b = a.querySelector('.tbadge');
    if (!n) { if (b) b.remove(); a.removeAttribute('aria-description'); continue; }
    if (!b) { b = h('span', { class: 'tbadge', 'aria-hidden': 'true' }); a.append(b); }
    b.textContent = n > 99 ? '99+' : String(n);
    a.setAttribute('aria-description', a.dataset.tab === 'bedom' ? `${n} att bedöma` : `${n} olästa`);
  }
}

// ---------------------------------------------------------------- filters
// Facets are the fixed topics plus every country, ranked by how many events
// mention them in the period, top 10. Several selected = all must match.
const isCountryKey = (k) => /^[A-Z]{2}$/.test(k);
const facetLabel = (k) => (isCountryKey(k) ? countryName(k) : k);

function parseFacets(q) {
  const out = (q.get('f') || '').split(',').map((s) => s.trim()).filter(Boolean);
  const t = q.get('t');
  if (t && !out.includes(t)) out.push(t); // links from before the filter bar
  return [...new Set(out)];
}

function topFacets(events, selected = []) {
  const counts = new Map();
  for (const e of events) {
    for (const t of e.topics) if (TOPICS.includes(t)) counts.set(t, (counts.get(t) || 0) + 1);
    for (const c of new Set(e.countries)) counts.set(c, (counts.get(c) || 0) + 1);
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || facetLabel(a[0]).localeCompare(facetLabel(b[0]), 'sv'));
  const top = ranked.slice(0, 10);
  for (const s of selected) if (!top.some(([k]) => k === s)) top.push([s, counts.get(s) || 0]);
  return top;
}

function matchesFacets(e, selected) {
  return selected.every((k) => (isCountryKey(k) ? e.countries.includes(k) : e.topics.includes(k)));
}

function textMatchesFacets(text, selected) {
  const t = norm(text);
  return selected.every((k) => t.includes(norm(facetLabel(k))));
}

function filterBar(facets, selected, onChange) {
  const toggle = (k) => onChange(selected.includes(k) ? selected.filter((x) => x !== k) : [...selected, k]);
  return h('div', { class: 'fbar-wrap' },
    h('div', { class: 'fbar', role: 'group', 'aria-label': 'Filtrera på ämne eller land' },
      selected.length ? h('button', { class: 'chip fchip clear', type: 'button', onclick: () => onChange([]) }, 'Rensa') : null,
      facets.map(([k, n]) => h('button', {
        class: 'chip fchip', type: 'button', 'aria-pressed': String(selected.includes(k)),
        'aria-label': `${facetLabel(k)}, ${plural(n, 'händelse', 'händelser')}`,
        onclick: () => toggle(k),
      }, facetLabel(k), h('span', { class: 'fcount', 'aria-hidden': 'true' }, String(n))))),
    selected.length ? h('p', { class: 'small muted' }, `Filter: ${selected.map(facetLabel).join(' + ')}`) : null);
}

function setFacets(sel) { updateHash((q) => { q.delete('t'); if (sel.length) q.set('f', sel.join(',')); else q.delete('f'); }); }
const facetHref = (base, k) => `${base}?f=${encodeURIComponent(k)}`;

// ---------------------------------------------------------------- Idag / rapport
const FACET_DAYS = 30;          // Bedöm's filter bar, and how far back Ämnen, Karta and Källa look first

// Review K1: a view loads the reports it shows, not the whole archive. Ämnen,
// Karta and Källa start with the last FACET_DAYS; the reader can ask for all.
let wholeArchive = false;
async function searchableReports() {
  if (wholeArchive) return loadAllReports();
  const index = await loadIndex();
  if (!index.length) return [];
  return loadReportsRange(addDays(index[0].date, -(FACET_DAYS - 1)), index[0].date);
}
function olderReportsNote() {
  if (wholeArchive) return null;
  return h('p', { class: 'small muted' }, `Visar de senaste ${FACET_DAYS} dagarna. `,
    h('button', { class: 'linkbtn', type: 'button', onclick: () => { wholeArchive = true; rerender(); } }, 'Ta med hela arkivet'));
}
const openUpdates = new Set();

function ensureScope(index) { if (index.length) scopeStart = addDays(index[0].date, -(SCOPE_DAYS - 1)); ensureReadFloor(index); }

// The live feed on Idag shows its newest few until the reader asks for all.
const FEED_PREVIEW = 3;
let showAllFeed = false;

async function viewReport(date, q) {
  const index = await loadIndex();
  if (!index.length) return emptyState('Inga rapporter ännu.');
  ensureScope(index);
  const latest = index[0].date;
  const d = date || latest;
  const archived = d !== latest;
  // Only this report: the filter bar counts the events listed below, and a
  // first visit costs a handful of requests (review K1).
  const [r, brief, courses] = await Promise.all([loadReport(d),
    archived ? null : loadAuthorities().catch(() => null), archived ? null : loadCourses().catch(() => null)]);
  const reports = loadedReports();
  const top = (r.executive_sv && r.executive_sv.top) || r.top_development;
  const selected = parseFacets(q);
  const facetEvents = r.events;
  const events = r.events.filter((e) => matchesFacets(e, selected));

  // Updates shown with this report: today's (or, for an archived report,
  // that day's); with none today, the latest few so the section is never stale.
  const dayOf = (ts) => new Date(ts).toLocaleDateString('sv-SE');
  const todayLocal = new Date().toLocaleDateString('sv-SE');
  let feedTitle = archived ? 'Löpande den dagen' : 'Löpande i dag';
  let feed = store.updates.filter((u) => (archived ? u.ts && u.ts.slice(0, 10) === d : dayOf(u.ts) === todayLocal));
  if (!archived && !feed.length && store.updates.length) { feed = store.updates.slice(0, 3); feedTitle = 'Senaste uppdateringar'; }
  if (selected.length) feed = feed.filter((u) => textMatchesFacets(`${u.title_sv || ''} ${u.summary_sv || ''} ${u.thread_label || ''}`, selected));

  const admin = isAdmin();
  return frag(
    date ? backLink('#/arkiv', 'Arkiv') : null,
    h('header', { class: 'page-head' },
      h('div', null,
        h('div', { class: 'kicker' }, dateLong(d)),
        h('div', { class: 'title-row' },
          h('h1', { class: 'title-xl' }, archived ? 'Rapport' : 'Hotläget'),
          archived ? null : featuresChip())),
      h('div', { class: 'head-actions' },
        date ? null : h('a', { class: 'head-link', href: '#/arkiv' }, 'Tidigare dagar'),
        date || isGuest() ? null : h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Notiser och hemskärm', title: 'Notiser och hemskärm', onclick: openSettings }, bellIcon()),
        date ? null : h('a', { class: 'head-link', href: '#/om' }, 'Om'),
        isGuest() && !date && !noAccount() ? h('a', { class: 'head-link', href: '/login' }, 'Logga in') : null,
        admin ? h('a', { class: 'icon-btn', href: '#/admin', 'aria-label': 'Status och administration', title: 'Status och administration' }, gearIcon()) : null)),
    archived ? null : noticeCards(),
    archived ? null : noAccountCard(),
    // The figures and the news first; what is new for me, the controls
    // and the device cards come after or fold away.
    heroCard(r),
    aiLine(),
    fallbackNote(r),
    h('div', { class: 'share-row' }, shareButton({
      title: `Hotläget ${dateLong(d)} · Hotmonitor`,
      text: `Hotindex ${fmt1(r.threat_index)} av 10. ${firstSentence(top || '', 140)} (AI-sammanfattning · Hotmonitor)`,
      url: shareDayUrl(d),
    }, archived ? 'Dela rapporten' : 'Dela dagens läge')),
    top ? h('section', { class: 'section' },
      h('div', { class: 'kicker amber' }, archived ? 'Viktigast den dagen' : 'Viktigast i dag'),
      h('p', { class: 'lead' }, top)) : null,
    archived ? null : authoritiesRow(brief),
    archived ? null : coursesRow(courses),
    archived ? null : newBox(latest, r),
    h('section', { class: 'section' },
      h('h2', { class: 'kicker' }, 'Dygnets händelser'),
      h('p', { class: 'hint' }, 'Siffran vid varje händelse är trovärdighet: hur väl uppgiften är bekräftad av källorna (1–10), inte hur allvarlig den är.'),
      // Into the Narrativ tab's Russian side, which still asks first.
      archived ? null : h('a', { class: 'ru-link', href: '#/narrativ?s=ru' },
        h('span', { class: 'ru-label' }, 'Rysk sida'), ' Visa det ryska narrativet', chevRight()),
      filterBar(topFacets(facetEvents, selected), selected, setFacets),
      events.length
        ? h('div', { class: 'card list' }, events.map((e) => eventRow(r.date, e)))
        : selected.length
          ? h('div', { class: 'card card-pad' },
            h('p', { class: 'small' }, `Inga händelser ${archived ? 'den dagen' : 'i dag'} för ${selected.map(facetLabel).join(' + ')}.`),
            h('a', { class: 'btn', href: `#/arkiv?f=${encodeURIComponent(selected.join(','))}&r=30` }, 'Visa i arkivet'))
          : h('p', { class: 'muted' }, 'Inga händelser registrerade.'),
      alsoReported(r, archived)),
    feed.length || !archived ? h('section', { class: 'section' },
      h('div', { class: 'sec-head' },
        h('h2', { class: 'kicker' }, feedTitle),
        archived ? null : h('button', { class: 'linkbtn', type: 'button', onclick: () => doRefresh() }, 'Uppdatera')),
      feed.length
        ? h('div', { class: 'card list' }, (showAllFeed ? feed : feed.slice(0, FEED_PREVIEW)).map((u) => updateRow(u, reports)))
        : h('p', { class: 'small muted' }, selected.length ? 'Inga uppdateringar för filtret.' : 'Inga uppdateringar ännu i dag.'),
      feed.length > FEED_PREVIEW
        ? h('button', { class: 'linkbtn', type: 'button', onclick: () => { showAllFeed = !showAllFeed; rerender(); } },
          showAllFeed ? 'Visa färre' : `Visa alla ${feed.length}`)
        : null) : null,
    admin ? h('div', { class: 'btn-row' },
      h('a', { class: 'btn primary', href: '#/bedom' }, 'Bedöm artiklar'),
      h('a', { class: 'btn', href: '#/mina' }, 'Mina bedömningar')) : null,
    executiveBlock(r.executive_sv),
    archived ? null : installCard(),
    archived ? null : pushNudge(),
    archived ? null : siteFooter(),
  );
}

// U7: signed in with a verified address that has no account. /api/me says
// so (verified_no_account); explain it, and offer to ask for access.
const ACCESS_KEY = 'hm.accessRequested';
const noAccount = () => !!(store.me && store.me.verified_no_account);
function noAccountCard() {
  if (!noAccount()) return null;
  let asked = false;
  try { asked = !!localStorage.getItem(ACCESS_KEY); } catch { /* private mode */ }
  const msg = h('p', { class: 'small', role: 'status' }, asked ? 'Tack! Vi har fått din förfrågan och hör av oss.' : '');
  const btn = asked ? null : h('button', {
    class: 'btn', type: 'button',
    onclick: async (ev) => {
      const b = ev.currentTarget;
      b.disabled = true;
      try {
        await adminSend('POST', '/api/access-request', null);
        try { localStorage.setItem(ACCESS_KEY, new Date().toISOString()); } catch { /* the thanks shows anyway */ }
        b.remove();
        msg.textContent = 'Tack! Vi har fått din förfrågan och hör av oss.';
      } catch (e) {
        b.disabled = false;
        msg.textContent = e instanceof OfflineError ? 'Ingen anslutning – försök igen.' : friendlyError(e)[1];
      }
    },
  }, 'Vill du hjälpa till att bedöma källor?');
  return h('section', { class: 'card card-pad nudge', 'aria-labelledby': 'noacc-title' },
    h('h2', { class: 'kicker', id: 'noacc-title' }, 'Inget konto'),
    h('p', { class: 'small' }, 'Du är inloggad men har inget konto. Du kan läsa allt som gäst.'),
    btn, msg);
}

function gearIcon() {
  const s = icon(['M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7z',
    'M19.4 13.5l1.6 1.2-2 3.4-1.9-.7a7.5 7.5 0 0 1-2 1.2l-.3 2h-4l-.3-2a7.5 7.5 0 0 1-2-1.2l-1.9.7-2-3.4 1.6-1.2a7.6 7.6 0 0 1 0-2.4L2.6 9.9l2-3.4 1.9.7a7.5 7.5 0 0 1 2-1.2l.3-2h4l.3 2a7.5 7.5 0 0 1 2 1.2l1.9-.7 2 3.4-1.6 1.2a7.6 7.6 0 0 1 0 2.4z'], '', '0 0 24 24');
  return s;
}

function newBox(latest, r) {
  const newEvents = r.events.filter((e) => eventState(latest, e) === 'new');
  const ups = unreadUpdates();
  const older = badgeCounts.arkiv;
  const total = newEvents.length + ups.length + older;
  if (!total) {
    return store.refreshedAt ? h('p', { class: 'small muted' }, `Allt är läst · uppdaterat ${tsFmt(store.refreshedAt)}`) : null;
  }
  const parts = [
    newEvents.length ? plural(newEvents.length, 'ny händelse', 'nya händelser') : null,
    ups.length ? plural(ups.length, 'uppdatering', 'uppdateringar') : null,
    older ? `${older} olästa i arkivet` : null,
  ].filter(Boolean);
  const markAll = async () => {
    const index = await loadIndex();
    const ids = [...ups.map((u) => u.id)];
    for (const item of index) {
      if (item.date < scopeStart) break;
      const rep = await loadReport(item.date);
      for (const e of rep.events) ids.push(e.id);
    }
    markRead(ids);
    computeBadges().then(rerender);
  };
  return h('div', { class: 'newline', role: 'status', 'aria-label': 'Nytt sedan senast' },
    h('span', null, h('b', null, 'Nytt: '), parts.join(' · ')),
    h('button', { class: 'linkbtn', type: 'button', onclick: markAll }, 'Markera som läst'));
}

function updateRow(u, reports) {
  const read = !updateIsNew(u);
  const open = openUpdates.has(u.id);
  const t = new Date(u.ts);
  const time = Number.isNaN(t.getTime()) ? '' : t.toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' });
  const threadEvent = u.thread_id
    ? reports.flatMap((r) => r.events.map((e) => ({ r, e }))).find(({ e }) => e.thread_id === u.thread_id)
    : null;
  const outlets = Array.isArray(u.outlets) ? u.outlets : [];
  const toggle = () => {
    if (openUpdates.has(u.id)) openUpdates.delete(u.id); else { openUpdates.add(u.id); markRead([u.id]); computeBadges(); }
    rerender();
  };
  return h('div', { class: `upd-wrap${read ? '' : ' unread'}` },
    h('button', { class: 'row rowbtn', type: 'button', 'aria-expanded': String(open), onclick: toggle },
      h('span', { class: 'upd-time' }, time),
      h('span', { class: 'row-main' },
        h('span', { class: 'row-sub' }, u.thread_label || 'Tråd'),
        h('span', { class: 'row-title' }, u.title_sv || firstSentence(u.summary_sv, 90) || 'Uppdatering')),
      read ? null : h('span', { class: 'nbadge' }, 'Ny'),
      chevDown()),
    open ? h('div', { class: 'expand' },
      u.summary_sv ? h('p', { class: 'body-sm' }, u.summary_sv) : null,
      outlets.length ? h('p', { class: 'small muted' }, 'Källor: ', outlets.map((o, i) => frag(i ? ', ' : '', h('a', { href: `#/kalla/${encodeURIComponent(o)}` }, o)))) : null,
      u.classification ? h('p', { class: 'small muted' }, classLabel(u.classification)) : null,
      threadEvent ? h('a', { class: 'btn', href: eventHref(threadEvent.r.date, threadEvent.e.id) }, 'Visa tråden') : null) : null);
}

const CLASS_SV = { NEW_DEVELOPMENT: 'Ny utveckling', CORRECTION: 'Rättelse', NARRATIVE_SHIFT: 'Ändrad berättelse', NO_CHANGE: 'Ingen förändring' };
function classLabel(c) { return CLASS_SV[c] || c; }

// EU AI Act art. 50.4: text an AI wrote to inform the public is marked
// where it is shown, not only on Om.
function aiTag() { return h('span', { class: 'ai-tag' }, 'AI-sammanfattning'); }
function aiLine() {
  return h('p', { class: 'ai-line' }, 'AI-genererad sammanställning ur öppna källor. Kan innehålla fel. ',
    h('a', { href: '#/om' }, 'Läs mer'));
}

// Marks the pipeline puts in the data (shown, never computed here).
const isUnverified = (e) => e.unverified === true;
const noLinkedSources = (e) => !e.articles.some((a) => a && a.url && hostOf(a.url));
function fallbackNote(r) {
  return r && r.generated_by && r.generated_by.fallback_used === true
    ? h('p', { class: 'mark-note' }, 'Skriven av reservmodell – lägre säkerhet') : null;
}
function markTag(text) { return h('span', { class: 'mark-tag' }, text); }
const hasCorrection = (e) => !!(e && e.correction && typeof e.correction.note_sv === 'string' && e.correction.note_sv.trim());

// How many independent origins the sources have, and why the score was
// held down (src/app_data.py credibility_cap), shown at the score.
function credibilityNote(e) {
  const n = Number.isInteger(e.independent_sources) ? e.independent_sources : null;
  let reason = typeof e.score_capped_reason === 'string' ? e.score_capped_reason.trim() : '';
  // "en oberoende källa: högst 6" reads "Högst 6: en oberoende källa".
  const m = /^(.*?):\s*(högst \d+)(.*)$/i.exec(reason);
  if (m) reason = `${m[2]}: ${m[1]}${m[3]}`;
  const text = reason ? `${reason.charAt(0).toUpperCase()}${reason.slice(1)}.`
    : n == null ? '' : n === 0 ? 'Ingen oberoende källa.' : `${plural(n, 'oberoende källa', 'oberoende källor')}.`;
  if (!text) return null;
  return h('p', { class: 'cred-note small' }, reason ? h('b', null, text) : text, ' ', h('a', { href: '#/om?s=index' }, 'Hur trovärdighet sätts'));
}

// A correction the pipeline made to an earlier version of the event.
function correctionBox(e) {
  if (!hasCorrection(e)) return null;
  const c = e.correction;
  return h('section', { class: 'correction', role: 'note', 'aria-label': 'Rättelse' },
    h('h2', { class: 'kicker' }, `Rättelse${c.date ? ` ${dateShort(c.date)}` : ''}`),
    h('p', null, c.note_sv, refLinks(c.refs, e)));
}

function heroCard(r) {
  const oi = r.operator_influence;
  const hasF = r.threat_index_30d != null;
  const pct = (v) => `${Math.max(0, Math.min(100, Number(v) * 10))}%`;
  return h('section', { class: 'hero', 'aria-label': 'Hotindex' },
    h('div', { class: 'hero-grid' },
      h('div', null,
        h('div', { class: 'hero-label' }, 'I DAG'),
        h('div', { class: 'hero-value' }, fmt1(r.threat_index), h('small', null, ' /10')),
        h('div', { class: 'hero-sub' }, [r.index_band ? `Band ${r.index_band}` : null, TREND[r.trend_label] || r.trend_label].filter(Boolean).join(' · '))),
      hasF ? h('div', null,
        h('div', { class: 'hero-label amber' }, 'OM 30 DAGAR (PROGNOS)'),
        h('div', { class: 'hero-value amber' }, fmt1(r.threat_index_30d), h('small', null, ' /10')),
        h('div', { class: 'hero-sub' }, r.index_band_30d ? `Band ${r.index_band_30d}` : '')) : null),
    h('div', { class: 'scale', role: 'img', 'aria-label': `Skala 0 till 10: i dag ${fmt1(r.threat_index)}${hasF ? `, prognos ${fmt1(r.threat_index_30d)}` : ''}` },
      h('div', { class: 'scale-fill', style: `width:${pct(r.threat_index)}` }),
      hasF ? h('div', { class: 'scale-tick', style: `left:${pct(r.threat_index_30d)}` }) : null),
    h('a', { class: 'hero-help', href: '#/om?s=index' }, 'Vad betyder siffran?'),
    heroMore(r, oi));
}

// Operator influence, the code's checks and the forecast's track record:
// folded away under the figures, open on a tap.
function heroMore(r, oi) {
  const notes = [
    oi && Number(oi.index_delta)
      ? h('div', { class: 'hero-note' },
        h('strong', null, 'Mänsklig justering: '),
        `${signed(oi.index_delta)} på index. `,
        oi.note_sv || '',
        Array.isArray(oi.trace) && oi.trace.length
          ? h('details', null, h('summary', null, 'Visa spår'), traceList(oi.trace))
          : null)
      : null,
    checksNote(r),
    forecastNote(r),
  ].filter(Boolean);
  if (!notes.length) return null;
  return h('details', { class: 'hero-more' }, h('summary', null, 'Kontroller och prognos'), ...notes);
}

// What the code changed in the model's index (index_checks). Reports
// from before the rules (no index_band) show nothing.
function checksNote(r) {
  const checks = Array.isArray(r.index_checks) ? r.index_checks : [];
  if (!checks.length && r.index_band == null) return null;
  return h('div', { class: 'hero-note' },
    h('strong', null, 'Kodens kontroller: '),
    checks.length
      ? h('ul', { class: 'hero-list' }, checks.map((c) => h('li', null, c)))
      : 'Inga ingrepp. Modellens index följde reglerna för band och placering.');
}

// The 30-day forecast scored against the general index that followed.
function forecastNote(r) {
  if (r.threat_index_30d == null || r.index_band == null) return null;
  const fa = r.forecast_accuracy;
  if (!fa) {
    return h('div', { class: 'hero-note' },
      h('strong', null, 'Prognosens träffsäkerhet: '),
      'Utvärderas när de första prognosernas 30 dagar har passerat.');
  }
  const lean = fa.bias > 0.05 ? 'högt' : fa.bias < -0.05 ? 'lågt' : null;
  return h('div', { class: 'hero-note' },
    h('strong', null, 'Prognosens träffsäkerhet: '),
    `I snitt ${fmt1(fa.mae)} fel över ${fa.evaluated} ${fa.evaluated === 1 ? 'prognos' : 'prognoser'}`,
    lean ? `, med en tendens att ligga ${lean} (${signed(fa.bias)}).` : '.',
    Array.isArray(fa.recent) && fa.recent.length
      ? h('details', null, h('summary', null, 'Visa senaste'),
        h('ul', { class: 'hero-list' }, fa.recent.slice().reverse().map((x) => h('li', null,
          `${dateShort(x.date)}: prognos ${fmt1(x.forecast)}, utfall ${fmt1(x.actual_mean)} (${signed(x.error)})`))))
      : null);
}

// Stories the model saw but did not make events of (report.also_reported).
function alsoReported(r, archived) {
  const items = Array.isArray(r.also_reported) ? r.also_reported.filter((x) => x && x.title_sv) : [];
  if (!items.length) return null;
  const pool = { articles: r.events.flatMap((e) => e.articles || []) };
  return h('details', { class: 'card also' },
    h('summary', null, h('span', { class: 'acc-h' }, `Fler händelser ${archived ? 'den dagen' : 'i dag'} (${items.length})`), chevRight()),
    h('ul', { class: 'bullets also-body' }, items.map((x) => h('li', null, x.title_sv, refLinks(x.refs, pool, false)))));
}

function eventRow(date, e) {
  const sub = [e.topics.join(' · '), e.countries.map(countryName).join(', ')].filter(Boolean).join(' · ');
  const state = eventState(date, e);
  return h('a', { class: `row${state ? ' unread' : ''}`, href: eventHref(date, e.id) },
    h('span', { class: scoreClass(e.score) }, h('span', { class: 'sr-only' }, 'Trovärdighet '), fmtScore(e.score), h('span', { class: 'sr-only' }, ' av 10')),
    h('span', { class: 'row-main' },
      h('span', { class: 'row-title' }, e.title_sv || e.title),
      sub ? h('span', { class: 'row-sub' }, sub) : null,
      isUnverified(e) ? h('span', { class: 'row-sub mark-text' }, 'Obekräftad – ingen hämtad källa') : null,
      hasCorrection(e) ? h('span', { class: 'row-sub mark-text' }, `Rättad ${e.correction.date ? dateShort(e.correction.date) : ''}`.trim()) : null),
    stateBadge(state),
    chevRight());
}

function executiveBlock(ex) {
  if (!ex || !Array.isArray(ex.sections) || !ex.sections.length) return null;
  return h('section', { class: 'section' },
    h('h2', { class: 'kicker' }, 'Kort om allt'),
    ex.index_line ? h('p', { class: 'small muted' }, ex.index_line) : null,
    h('div', { class: 'card acc' }, ex.sections.map((s, i) => h('details', i === 0 ? { open: true } : null,
      h('summary', null,
        h('span', { class: 'acc-h' }, s.heading),
        h('span', { class: 'small muted' }, String((s.items || []).length)),
        chevRight()),
      h('div', { class: 'acc-body' }, (s.items || []).map((it) => h('div', null,
        it.label ? h('b', null, `${it.label}${/[:)]$/.test(it.label) ? '' : ':'} `) : null,
        it.text)))))));
}

function traceList(trace) {
  return h('ul', { class: 'trace' }, trace.map((t) => h('li', null,
    h('div', { class: 't-top' },
      t.outlet ? h('a', { href: `#/kalla/${encodeURIComponent(t.outlet)}` }, h('b', null, t.outlet)) : h('b', null, 'Okänd källa'),
      t.value != null && VERDICT[t.value] ? verdictPill(t.value) : null,
      t.date ? h('span', { class: 'muted small' }, dateShort(t.date)) : null),
    h('div', { class: 'small' },
      h('span', { class: 'effect' }, `Effekt ${signed(t.effect)}`),
      t.weight != null ? ` · vikt ${fmt1(t.weight)}` : '',
      t.assessment_id ? h('span', { class: 'muted' }, ` · bedömning #${String(t.assessment_id).slice(0, 8)}`) : null))));
}

// ---------------------------------------------------------------- Händelse
const RELATION = { bekräftar: 'Bekräftar', motsäger: 'Motsäger', tillför: 'Tillför' };
function relationChip(rel) { return RELATION[rel] ? h('span', { class: `rel rel-${rel === 'bekräftar' ? 'ok' : rel === 'motsäger' ? 'no' : 'add'}` }, RELATION[rel]) : null; }

async function viewEvent(date, id) {
  // The event's own report and the two after it (where its re-check lands);
  // thread and related events come from what is already loaded.
  const [r, , index] = await Promise.all([loadReport(date), loadReportsRange(date, addDays(date, 2)), loadIndex(), assessmentsReady]);
  const reports = loadedReports();
  ensureScope(index);
  const e = r.events.find((x) => x.id === id);
  const isLatest = index.length && index[0].date === date;
  const back = isLatest ? backLink('#/', 'Idag') : backLink(`#/rapport/${encodeURIComponent(date)}`, dateShort(date));
  if (!e) return frag(back, emptyState('Händelsen finns inte i rapporten.'));

  const threadUpdates = e.thread_id ? store.updates.filter((u) => u.thread_id === e.thread_id) : [];
  const state = eventState(date, e);
  // Opening the event reads it, and the thread updates shown below with it.
  setTimeout(() => {
    const ids = [e.id, ...threadUpdates.map((u) => u.id)].filter((x) => !isRead(x));
    if (ids.length) { markRead(ids); computeBadges(); }
  }, 0);

  const detailP = h('p', { class: 'body-serif', hidden: !!e.summary_sv }, e.detail || '');
  const toggle = e.summary_sv && e.detail
    ? h('button', {
      class: 'btn', type: 'button', 'aria-expanded': 'false',
      onclick: (ev) => {
        detailP.hidden = !detailP.hidden;
        ev.currentTarget.setAttribute('aria-expanded', String(!detailP.hidden));
        ev.currentTarget.textContent = detailP.hidden ? 'Visa originaltext' : 'Dölj originaltext';
      },
    }, 'Visa originaltext')
    : null;

  const op = e.operator || null;
  const trace = op && Array.isArray(op.trace) ? op.trace : [];
  const changed = e.model_score != null && Number(e.model_score) !== Number(e.score);
  const known = knownItems(e);
  const unknown = Array.isArray(e.unknown_sv) ? e.unknown_sv.filter(Boolean) : [];
  const reportHref = isLatest ? '#/' : `#/rapport/${encodeURIComponent(date)}`;
  const outcome = laterOutcome(e, date, reports);

  return frag(
    back,
    correctionBox(e),
    h('div', { class: 'section' },
      h('div', { class: 'chips' },
        e.topics.map((t) => h('a', { class: 'chip', href: facetHref('#/amnen', t) }, t)),
        e.countries.map((c) => h('a', { class: 'chip', href: `#/karta?p=all&c=${encodeURIComponent(c)}` }, countryName(c)))),
      h('h1', { class: 'title-l' }, e.title_sv || e.title),
      h('div', { class: 'small muted meta-line' },
        h('span', { class: scoreClass(e.score), style: 'width:auto;height:auto;padding:3px 8px;border-radius:8px;font-size:13px' }, `Trovärdighet ${fmtScore(e.score)}/10`),
        changed ? h('span', null, `Modellens poäng ${fmtScore(e.model_score)}`) : null,
        h('a', { href: reportHref }, dateLong(date)),
        stateBadge(state),
        aiTag(),
        isUnverified(e) ? markTag('Obekräftad – ingen hämtad källa') : null),
      credibilityNote(e),
      outcome ? h('p', { class: 'outcome' },
        h('span', { class: `rel rel-${OUTCOME[outcome.outcome][1]}` }, OUTCOME[outcome.outcome][0]),
        ' ', outcome.note || '',
        h('span', { class: 'small muted' }, ` · självkontroll ${dateShort(outcome.checked)}`)) : null),
    e.summary_sv ? h('p', { class: 'body-serif' }, e.summary_sv) : null,
    detailP,
    h('div', { class: 'btn-row' }, toggle,
      shareButton({ title: e.title_sv || e.title, text: `${firstSentence(e.summary_sv || e.detail || '', 160)} (AI-sammanfattning · Hotmonitor)`, url: shareEventUrl(date, e.id) })),
    known.length || unknown.length ? h('section', { class: 'kv2' },
      known.length ? h('div', { class: 'card card-pad' },
        h('h2', { class: 'kicker' }, 'Vad vi vet'),
        h('ul', { class: 'bullets' }, known.map((k) => h('li', null, k.text, refLinks(k.refs, e))))) : null,
      unknown.length ? h('div', { class: 'card card-pad' },
        h('h2', { class: 'kicker amber' }, 'Vad vi inte vet'),
        h('ul', { class: 'bullets' }, unknown.map((k) => h('li', null, k)))) : null) : null,
    h('section', { class: 'section' },
      h('h2', { class: 'kicker' }, 'Källor och artiklar'),
      e.articles.length && noLinkedSources(e) ? h('p', { class: 'small muted' }, 'Äldre format: källor utan länk') : null,
      e.articles.length
        ? h('div', { class: 'srcp-list' }, e.articles.map((a) => articleRow({ article: a, event: e, date }, r.favicons)))
        : h('p', { class: 'muted small' }, e.sources || 'Inga källor registrerade.')),
    threadSection(e, date, reports, threadUpdates),
    h('section', { class: 'section' },
      h('h2', { class: 'kicker' }, 'Varför denna poäng?'),
      h('div', { class: 'card card-pad' },
        op && op.divergent ? h('span', { class: 'divergent' }, 'Operatören avviker') : null,
        trace.length
          ? frag(
            h('p', { class: 'small' }, changed
              ? `Modellens poäng ${fmtScore(e.model_score)} blev ${fmtScore(e.score)} efter operatörens bedömningar (${signed(op.delta)}).`
              : `Operatörens bedömningar vägdes in (${signed(op.delta)}).`),
            traceList(trace))
          : h('p', { class: 'small' }, 'Modellens bedömning utan operatörspåverkan.'),
        e.articles.length && e.sources ? h('p', { class: 'small muted' }, `Källunderlag: ${e.sources}`) : null)),
    relatedSection(e, date, reports),
  );
}

// known_sv is [{text, refs: [article id]}] since #9, or plain strings in
// older reports; both are shown, refs as small links to the event's articles.
function knownItems(e) {
  if (!Array.isArray(e.known_sv)) return [];
  return e.known_sv.map((k) => (typeof k === 'string' ? { text: k, refs: [] }
    : k && typeof k.text === 'string' ? { text: k.text, refs: Array.isArray(k.refs) ? k.refs : [] } : null))
    .filter((k) => k && k.text.trim());
}

function refLinks(refs, e, numbered = true) {
  const all = e.articles || [];
  const arts = [...new Set(refs || [])].map((id) => all.findIndex((a) => a && a.id === id)).filter((i) => i >= 0);
  if (!arts.length) return null;
  return h('span', { class: 'refs' }, arts.map((i) => {
    const a = all[i];
    const label = `${numbered ? `[${i + 1}] ` : ''}${a.outlet || hostOf(a.url) || 'källa'}`;
    return a.url && hostOf(a.url)
      ? h('button', { class: 'ref', type: 'button', 'aria-label': `Källa: ${a.outlet || hostOf(a.url)}`, onclick: () => openExternal(a.url, { outlet: a.outlet, tier: a.tier, date: a.fetched_at || a.date }) }, label)
      : h('span', { class: 'ref' }, label);
  }));
}

function threadSection(e, date, reports, threadUpdates) {
  if (!e.thread_id) return null;
  const items = [];
  for (const r of reports) {
    for (const x of r.events) {
      if (x.thread_id === e.thread_id) items.push({ key: `${r.date}T05:00`, date: r.date, event: x, self: x.id === e.id && r.date === date });
    }
  }
  for (const u of threadUpdates) items.push({ key: u.ts || '', update: u });
  if (items.length < 2) return null;
  items.sort((a, b) => (a.key < b.key ? 1 : -1));
  const label = (threadUpdates[0] && threadUpdates[0].thread_label) || 'Tråden';
  return h('section', { class: 'section' },
    h('h2', { class: 'kicker' }, `Tråden · ${label}`),
    h('ol', { class: 'timeline' }, items.slice(0, 12).map((it) => h('li', { class: it.self ? 'self' : null },
      h('span', { class: 'tl-when' }, it.update ? tsFmt(it.update.ts) : dateShort(it.date)),
      it.update
        ? h('span', { class: 'tl-what' }, it.update.title_sv || firstSentence(it.update.summary_sv, 120), updateIsNew(it.update) ? h('span', { class: 'nbadge' }, 'Ny') : null)
        : it.self
          ? h('span', { class: 'tl-what' }, h('b', null, 'Denna händelse: '), it.event.title_sv || it.event.title)
          : h('a', { class: 'tl-what', href: eventHref(it.date, it.event.id) }, it.event.title_sv || it.event.title)))));
}

function relatedSection(e, date, reports) {
  const out = [];
  for (const r of reports) {
    for (const x of r.events) {
      if (x.id === e.id) continue;
      if (e.thread_id && x.thread_id === e.thread_id) continue; // already in the thread timeline
      const topic = x.topics.some((t) => e.topics.includes(t));
      const country = x.countries.some((c) => e.countries.includes(c));
      if (topic && country) out.push({ r, x });
    }
  }
  if (!out.length) return null;
  out.sort((a, b) => (a.r.date < b.r.date ? 1 : -1));
  return h('section', { class: 'section' },
    h('h2', { class: 'kicker' }, 'Relaterat'),
    h('div', { class: 'card list' }, out.slice(0, 5).map(({ r, x }) => h('a', { class: 'row', href: eventHref(r.date, x.id) },
      h('span', { class: 'small muted date-col' }, dateShort(r.date)),
      h('span', { class: 'row-main' },
        h('span', { class: 'row-title' }, x.title_sv || x.title),
        h('span', { class: 'row-sub' }, [x.topics.join(' · '), x.countries.map(countryName).join(', ')].filter(Boolean).join(' · '))),
      chevRight()))));
}

function verdictButtons(onPick, middle) {
  const b = (cls, label, aria, fn, disabled) => h('button', { class: cls, type: 'button', 'aria-label': aria, onclick: fn, disabled: !!disabled }, label);
  return h('div', { class: 'actions' },
    b('a--2', 'Inte trovärdig', 'Inte trovärdig', () => onPick(-2)),
    b('a--1', 'Tveksam', 'Tveksam', () => onPick(-1)),
    middle,
    b('a-1', 'Trovärdig', 'Trovärdig', () => onPick(1)),
    b('a-2', 'Mycket trovärdig', 'Mycket trovärdig', () => onPick(2)));
}

function assessSheet(target) {
  const a = target.article;
  openSheet((close) => {
    const cur = currentByArticle().get(a.id);
    const apply = (v) => {
      const now = currentByArticle().get(a.id);
      if (v === 0 && (!now || now.value === 0)) { close(); return; }
      if (!(now && now.value === v)) { assess(target, v, now || null); vibrate(); }
      close();
    };
    return frag(
      h('h2', { class: 'title-m' }, `Bedöm ${a.outlet || 'källan'}`),
      h('p', { class: 'small muted' }, target.event.title_sv || target.event.title || ''),
      cur && cur.value !== 0 ? h('p', { class: 'small' }, 'Nuvarande: ', verdictPill(cur.value, cur.pending)) : null,
      verdictButtons(apply, h('button', { class: 'a-skip', type: 'button', disabled: !cur || cur.value === 0, onclick: () => apply(0) }, 'Återkalla')),
      h('div', { class: 'sheet-actions' }, h('button', { class: 'btn', type: 'button', autofocus: true, onclick: close }, 'Avbryt')));
  }, { label: `Bedöm ${a.outlet || 'källan'}` });
}

// ---------------------------------------------------------------- source previews
// One look for a source everywhere (event page and Bedöm): favicon or a
// monogram, outlet, tier, domain, date, the article's own title and summary.
// Tapping the preview always reads - through the leave-the-app warning.
const FAVICON_RE = /^data:image\/(png|x-icon|vnd\.microsoft\.icon|gif|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;
function sourceFavicon(a, favicons) {
  const host = a.url ? hostOf(a.url) : null;
  const src = host && favicons ? favicons[host] : null;
  if (typeof src === 'string' && src.length < 12000 && FAVICON_RE.test(src)) {
    return h('img', { class: 'fav', src, alt: '', width: '20', height: '20', loading: 'lazy', decoding: 'async' });
  }
  const tier = Math.min(4, Math.max(1, Number(a.tier) || 4));
  const letter = String(a.outlet || host || '?').trim().charAt(0).toUpperCase() || '?';
  return h('span', { class: `fav mono tier-bg-${tier}`, 'aria-hidden': 'true' }, letter);
}

function sourcePreview(a, { date, favicons, footer } = {}) {
  const host = a.url ? hostOf(a.url) : null;
  const meta = [host, a.published ? dateShort(a.published) : null].filter(Boolean).join(' · ');
  const inner = [
    h('span', { class: 'srcp-head' },
      sourceFavicon(a, favicons),
      h('span', { class: 'srcp-outlet' }, a.outlet || host || 'Okänd källa'),
      tierBadge(a.tier),
      relationChip(a.relation)),
    meta ? h('span', { class: 'srcp-meta' }, meta) : null,
    a.title ? h('span', { class: 'srcp-title' }, a.title) : null,
  ];
  const main = host
    ? h('button', {
      class: 'srcp-main', type: 'button', 'aria-label': `Läs ${a.outlet || host} i original`,
      onclick: (ev) => { ev.stopPropagation(); openExternal(a.url, { tier: a.tier, date, outlet: a.outlet }); },
    }, ...inner, h('span', { class: 'srcp-open' }, 'Läs originalet', extIcon()))
    : h('div', { class: 'srcp-main static' }, ...inner);
  let summary = null;
  if (a.summary_sv) {
    const text = h('p', { class: 'srcp-sum' }, a.summary_sv);
    const long = a.summary_sv.length > 150;
    const more = long ? h('button', {
      class: 'linkbtn srcp-more', type: 'button', 'aria-expanded': 'false',
      onclick: (ev) => {
        ev.stopPropagation();
        const open = text.classList.toggle('open');
        more.textContent = open ? 'Visa mindre' : 'Visa mer';
        more.setAttribute('aria-expanded', String(open));
      },
    }, 'Visa mer') : null;
    summary = h('div', { class: 'srcp-sumwrap' }, text, more);
  }
  return h('div', { class: 'srcp' }, main, summary, footer || null);
}

// Event page: the same preview, with my verdict and the per-source actions.
// Only linked articles can be assessed - without the original there is
// nothing to judge the credibility on.
function articleRow(target, favicons) {
  const a = target.article;
  const cur = currentByArticle().get(a.id);
  return sourcePreview(a, {
    date: target.date,
    favicons,
    footer: h('div', { class: 'srcp-foot' },
      cur && cur.value !== 0 ? verdictPill(cur.value, cur.pending) : null,
      a.outlet ? h('a', { class: 'linkbtn', href: `#/kalla/${encodeURIComponent(a.outlet)}` }, 'Om källan') : null,
      isAdmin() && a.url && hostOf(a.url)
        ? h('button', { class: 'linkbtn', type: 'button', onclick: () => assessSheet(target) }, cur && cur.value !== 0 ? 'Ändra bedömning' : 'Bedöm')
        : null,
      !a.url ? h('span', { class: 'small muted' }, 'Ingen länk sparad – bedöms inte') : null),
  });
}

// ---------------------------------------------------------------- Källa
function currentAllByOperator() {
  const superseded = new Set(store.assessments.map((r) => r.supersedes).filter(Boolean));
  const cur = new Map();
  for (const r of store.assessments) {
    if (superseded.has(r.id)) continue;
    const k = `${r.operator}|${r.article_id}`;
    const prev = cur.get(k);
    if (!prev || r.ts > prev.ts) cur.set(k, r);
  }
  return [...cur.values()].filter((r) => r.value !== 0);
}

async function viewSource(name) {
  const [reports] = await Promise.all([searchableReports(), assessmentsReady]);
  const key = norm(name);
  const hits = [];
  for (const r of reports) for (const e of r.events) for (const a of e.articles) if (norm(a.outlet) === key) hits.push({ r, e, a });
  const back = h('a', { class: 'back', href: '#/', onclick: (ev) => { if (history.length > 1) { ev.preventDefault(); history.back(); } } }, icon(['M12.5 4l-6 6 6 6'], '', '0 0 20 20'), 'Tillbaka');
  if (!hits.length) return frag(back, emptyState(`Ingen källa som heter ”${name}” finns i rapporterna.`), olderReportsNote());
  const tiers = new Map();
  for (const { a } of hits) if (a.tier) tiers.set(a.tier, (tiers.get(a.tier) || 0) + 1);
  const tier = [...tiers.entries()].sort((x, y) => y[1] - x[1])[0];
  const dates = hits.map((x) => x.r.date).sort();
  const ids = new Set(hits.map((x) => x.a.id));
  const mine = currentByArticle();
  const myHere = [...mine.values()].filter((v) => ids.has(v.article_id) && v.value !== 0);
  const me = store.me && store.me.email;
  const others = currentAllByOperator().filter((v) => v.operator !== me && ids.has(v.article_id));
  const countBy = (rows) => [2, 1, -1, -2].map((v) => [v, rows.filter((x) => x.value === v).length]).filter(([, n]) => n);
  const events = new Map();
  for (const x of hits) events.set(`${x.r.date}|${x.e.id}`, x);
  const displayName = hits[0].a.outlet;

  return frag(
    back,
    h('header', null,
      h('div', { class: 'kicker' }, 'Källa'),
      h('h1', { class: 'title-xl' }, displayName)),
    h('section', { class: 'stat-grid' },
      statTile('Källnivå', tier ? `Nivå ${tier[0]}` : '–'),
      statTile('Artiklar', String(hits.length)),
      statTile('Händelser', String(events.size)),
      statTile('Period', dates[0] === dates[dates.length - 1] ? dateShort(dates[0]) : `${dateShort(dates[0])} – ${dateShort(dates[dates.length - 1])}`)),
    h('section', { class: 'section' },
      h('h2', { class: 'kicker' }, 'Bedömningar av källan'),
      h('div', { class: 'card card-pad' },
        h('p', { class: 'small' }, h('b', null, 'Mina: '),
          myHere.length ? countBy(myHere).map(([v, n], i) => frag(i ? ' ' : '', verdictPill(v), ` ${n}`)) : 'inga ännu'),
        h('p', { class: 'small' }, h('b', null, 'Andra administratörer: '),
          others.length ? countBy(others).map(([v, n], i) => frag(i ? ' ' : '', verdictPill(v), ` ${n}`)) : 'inga ännu'))),
    h('section', { class: 'section' },
      h('h2', { class: 'kicker' }, 'Förekommer i'),
      olderReportsNote(),
      h('div', { class: 'card list' }, [...events.values()].sort((x, y) => (x.r.date < y.r.date ? 1 : -1)).map(({ r, e, a }) => {
        const v = mine.get(a.id);
        return h('div', { class: 'row' },
          h('span', { class: 'small muted date-col' }, dateShort(r.date)),
          h('a', { class: 'row-main plain', href: eventHref(r.date, e.id) },
            h('span', { class: 'row-title' }, e.title_sv || e.title),
            a.title ? h('span', { class: 'row-sub' }, a.title) : null),
          v && v.value !== 0 ? verdictPill(v.value, v.pending) : null,
          a.url ? h('button', { class: 'out-link', type: 'button', 'aria-label': `Läs originalet hos ${displayName}`, onclick: () => openExternal(a.url, { tier: a.tier, date: r.date, outlet: a.outlet }) }, extIcon()) : null);
      }))));
}

function statTile(label, value, cls = '') {
  return h('div', { class: `stat ${cls}` }, h('div', { class: 'stat-label' }, label), h('div', { class: 'stat-value' }, value));
}

// The label under a swiped row (Mina bedömningar).
function paintUnder(under, value, dx, text) {
  under.className = `under${value != null ? ` v-${value}` : ''}`;
  const [left, right] = under.children;
  const label = text || (value != null ? VERDICT[value] : '');
  left.textContent = dx > 0 ? label : '';
  right.textContent = dx < 0 ? label : '';
}

// ---------------------------------------------------------------- Arkiv
async function viewArchive(q) {
  const index = await loadIndex();
  if (!index.length) return emptyState('Inga rapporter ännu.');
  ensureScope(index);
  const latest = await loadReport(index[0].date);
  // The latest report carries the recalibrated history; older report files
  // may still hold the values they were first published with.
  const hist = new Map((latest.threat_index_history || []).map((x) => [x.date, x]));
  const byDate = new Map(index.map((x) => [x.date, x]));
  const valueOf = (d) => { const hh = hist.get(d); const it = byDate.get(d); return hh && hh.value != null ? hh.value : it ? it.threat_index : null; };
  const forecastOf = (d) => { const hh = hist.get(d); const it = byDate.get(d); return hh && hh.value_30d != null ? hh.value_30d : it ? it.threat_index_30d : null; };

  const range = ['7', '14', '30', 'all'].includes(q.get('r')) ? q.get('r') : '14';
  const last = index[0].date;
  const first = index[index.length - 1].date;
  const windowStart = range === 'all' ? first : addDays(last, -(Number(range) - 1));
  const start = windowStart < first ? first : windowStart;
  const days = [];
  for (let d = start; d <= last; d = addDays(d, 1)) days.push(d);

  const selected = parseFacets(q);
  const filtering = selected.length > 0;
  // The bars come from the index; reports are loaded for the period shown
  // (the filter bar), and older days are listed from the index alone until
  // the reader picks a longer period (review K1).
  await loadReportsRange(start, last);
  const reports = loadedReports();
  const byReport = new Map(reports.map((r) => [r.date, r]));
  const inRange = reports.filter((r) => r.date >= start);
  const matchesOn = (d) => { const r = byReport.get(d); return r ? r.events.filter((e) => matchesFacets(e, selected)) : []; };

  let lo; let hi; let px;
  if (filtering) {
    const maxN = Math.max(1, ...days.map((d) => matchesOn(d).length));
    lo = 0; hi = maxN;
    px = (v) => `${Math.round((v / maxN) * 110)}px`;
  } else {
    const present = days.map(valueOf).concat(days.map(forecastOf)).filter((v) => v != null);
    lo = present.length ? Math.max(0, Math.floor(Math.min(...present)) - 1) : 0;
    hi = present.length ? Math.min(10, Math.ceil(Math.max(...present)) + 1) : 10;
    if (hi - lo < 2) { lo = Math.max(0, lo - 1); hi = Math.min(10, hi + 1); }
    px = (v) => `${Math.round(((v - lo) / (hi - lo)) * 110)}px`;
  }
  const every = Math.ceil(days.length / 14);

  const seg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Period' },
    [['7', '7 dagar'], ['14', '14 dagar'], ['30', '30 dagar'], ['all', 'Allt']].map(([k, label]) => h('button', {
      type: 'button', 'aria-pressed': String(k === range),
      onclick: () => updateHash((qq) => qq.set('r', k)),
    }, label)));

  const bars = days.map((d) => {
    const hasReport = byDate.has(d);
    if (filtering) {
      const n = matchesOn(d).length;
      return h('div', { class: 'bar-slot', title: `${dateShort(d)}: ${hasReport ? plural(n, 'händelse', 'händelser') : 'ingen rapport'}` },
        !hasReport ? h('div', { class: 'bar missing', style: 'height:60px' }) : n ? h('div', { class: 'bar amberbar', style: `height:${px(n)}` }) : null);
    }
    const v = valueOf(d);
    const f = forecastOf(d);
    return h('div', { class: 'bar-slot', title: `${dateShort(d)}: ${v == null ? 'ingen rapport' : fmt1(v)}${f != null ? ` / ${fmt1(f)}` : ''}` },
      v == null ? h('div', { class: 'bar missing', style: 'height:60px' }) : h('div', { class: 'bar', style: `height:${px(v)}` }),
      f != null ? h('div', { class: 'bar-f', style: `bottom:${px(f)}` }) : null);
  });

  const chart = h('section', { class: 'card card-pad', 'aria-label': filtering ? 'Antal händelser per dag för filtret' : 'Hotindex över tid' },
    h('div', { style: 'display:flex;justify-content:space-between;align-items:baseline;gap:8px' },
      h('h2', { style: 'font-size:15px;font-weight:600' }, filtering ? `Händelser: ${selected.map(facetLabel).join(' + ')}` : 'Hotindex'),
      filtering ? null : h('div', { class: 'chart-legend' },
        h('span', null, h('i', { class: 'lg-bar' }), 'I dag'),
        h('span', null, h('i', { class: 'lg-tick' }), '30 dagar'))),
    h('div', { class: 'chart', role: 'img', 'aria-label': days.map((d) => `${dateShort(d)}: ${filtering ? matchesOn(d).length : valueOf(d) == null ? 'ingen rapport' : fmt1(valueOf(d))}`).join(', ') }, bars),
    h('div', { class: 'chart-days', 'aria-hidden': 'true' },
      days.map((d, i) => h('span', null, (days.length - 1 - i) % every === 0 ? String(toDate(d).getUTCDate()) : ''))),
    h('p', { class: 'small muted' }, filtering ? `Antal händelser per dag, 0–${hi}` : `Skala ${lo}–${hi}`,
      !filtering && days.some((d) => { const hh = hist.get(d); return hh && hh.original_value != null; })
        ? h('span', { class: 'mark-tag', title: 'Värdena räknades om med dagens metod; rapporten visade först ett annat värde.' }, 'äldre värden omräknade') : null));

  const rows = [];
  for (let d = last; d >= first; d = addDays(d, -1)) {
    if (filtering && d < start) break;
    const it = byDate.get(d);
    const dayBox = h('span', { class: 'day' }, h('b', null, String(toDate(d).getUTCDate())), h('span', null, weekdayShort(d)));
    if (!it) {
      if (!filtering) rows.push(h('div', { class: 'row', style: 'color:var(--muted)' }, dayBox, h('span', { class: 'row-main' }, h('span', { class: 'small' }, 'Ingen rapport'))));
      continue;
    }
    const r = byReport.get(d);
    const unread = r ? r.events.filter((e) => eventState(d, e) === 'new').length : 0;
    const f = forecastOf(d);
    const href = d === last ? '#/' : `#/rapport/${d}`;
    if (filtering) {
      const hits = matchesOn(d);
      if (!hits.length) continue;
      rows.push(h('a', { class: 'row', href: `${href}?f=${encodeURIComponent(selected.join(','))}` },
        dayBox,
        h('span', { class: 'row-main' },
          h('span', { class: 'row-title', style: 'font-size:14px' }, hits[0].title_sv || hits[0].title),
          hits.length > 1 ? h('span', { class: 'row-sub' }, `+ ${plural(hits.length - 1, 'händelse till', 'händelser till')}`) : null),
        h('span', { class: 'vals' }, h('b', null, String(hits.length)), h('span', null, 'träffar'))));
      continue;
    }
    rows.push(h('a', { class: `row${unread ? ' unread' : ''}`, href },
      dayBox,
      h('span', { class: 'row-main' }, h('span', { style: 'font-size:14px;line-height:1.35' }, firstSentence(it.top_sv || '', 110) || dateLong(d))),
      unread ? h('span', { class: 'nbadge' }, `${unread} nya`) : null,
      h('span', { class: 'vals' }, h('b', null, fmt1(valueOf(d))), f != null ? h('span', null, `30d ${fmt1(f)}`) : null)));
  }

  return frag(
    h('header', null, h('div', { class: 'kicker' }, `${dateShort(first)} – ${dateShort(last)}`), h('h1', { class: 'title-xl' }, 'Arkiv')),
    seg,
    filterBar(topFacets(inRange.flatMap((r) => r.events), selected), selected, setFacets),
    chart,
    h('section', { class: 'section' },
      h('h2', { class: 'kicker' }, filtering ? 'Dagar med träffar' : 'Rapporter'),
      rows.length ? h('div', { class: 'card list' }, rows) : h('p', { class: 'muted' }, 'Inga träffar i perioden.')));
}

// ---------------------------------------------------------------- Ämnen
function highlight(text, terms) {
  const s = String(text || '');
  const lower = s.toLowerCase();
  const hits = [];
  for (const t of terms) {
    const tl = t.toLowerCase();
    if (!tl) continue;
    let i = lower.indexOf(tl);
    while (i >= 0) { hits.push([i, i + tl.length]); i = lower.indexOf(tl, i + tl.length); }
  }
  if (!hits.length) return s;
  hits.sort((a, b) => a[0] - b[0]);
  const out = [];
  let pos = 0;
  for (const [a, b] of hits) {
    if (a < pos) continue;
    out.push(s.slice(pos, a), h('mark', null, s.slice(a, b)));
    pos = b;
  }
  out.push(s.slice(pos));
  return out;
}

async function viewTopics(q) {
  const [reports, index] = await Promise.all([searchableReports(), loadIndex()]);
  ensureScope(index);
  let query = q.get('q') || '';
  let selected = parseFacets(q);

  const all = [];
  for (const r of reports) {
    for (const e of r.events) {
      const outlets = e.articles.map((a) => a.outlet).filter(Boolean);
      all.push({
        r, e, outlets,
        hay: norm([e.title_sv, e.summary_sv, e.title, e.detail, outlets.join(' '), e.sources, e.countries.map(countryName).join(' '),
          e.articles.map((a) => `${a.title || ''} ${a.summary_sv || ''}`).join(' ')].join(' ')),
      });
    }
  }
  const facets = () => topFacets(all.map((x) => x.e), selected);

  const input = h('input', { id: 'sok', type: 'search', value: query, placeholder: 't.ex. Milrem, Rumänien, skuggflotta', autocomplete: 'off', enterkeyhint: 'search' });
  const results = h('section', { class: 'section', 'aria-live': 'polite' });
  const barHolder = h('div');

  // Filters and search update in place, so the search field keeps focus.
  function setSelected(sel) { selected = sel; update(); }

  function update() {
    barHolder.replaceChildren(filterBar(facets(), selected, setSelected));
    const qs = new URLSearchParams();
    if (query) qs.set('q', query);
    if (selected.length) qs.set('f', selected.join(','));
    // Only while this view is still the one on screen: a slow first render
    // must not rewrite the address after the user has moved on.
    if (currentRoute === 'amnen' && parseHash().parts[0] === 'amnen') {
      history.replaceState(null, '', `#/amnen${qs.toString() ? `?${qs}` : ''}`);
    }
    const terms = query.trim().split(/\s+/).filter(Boolean);
    if (!terms.length && !selected.length) {
      results.replaceChildren(h('p', { class: 'hint' }, 'Välj ett eller flera områden ovan, eller sök i rapporterna.'), olderReportsNote() || '');
      return;
    }
    const nterms = terms.map(norm);
    const hits = all.filter((x) => matchesFacets(x.e, selected) && nterms.every((t) => x.hay.includes(t)));
    results.replaceChildren(frag(
      h('div', { style: 'display:flex;justify-content:space-between;align-items:baseline;gap:8px' },
        h('h2', { class: 'title-m' }, selected.length ? selected.map(facetLabel).join(' + ') : 'Sökträffar'),
        h('span', { class: 'small muted' }, plural(hits.length, 'träff', 'träffar'))),
      olderReportsNote(),
      hits.length ? null : h('p', { class: 'muted' }, 'Inga träffar.'),
      hits.slice(0, 100).map(({ r, e, outlets }) => {
        const state = eventState(r.date, e);
        return h('a', { class: `card result${state ? ' unread' : ''}`, href: eventHref(r.date, e.id) },
          h('span', { class: 'result-top' }, h('b', null, dateShort(r.date)), stateBadge(state), h('span', { class: 'grow-right' }, e.countries.map(countryName).join(', '))),
          h('span', { class: 'result-title' }, highlight(e.title_sv || e.title, terms)),
          h('span', { class: 'result-text' }, highlight(firstSentence(e.summary_sv || e.detail), terms)),
          outlets.length || e.sources ? h('span', { class: 'result-src' }, firstSentence(outlets.join(', ') || e.sources, 90)) : null);
      })));
  }

  let timer = 0;
  input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => { query = input.value; update(); }, 150); });
  input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { query = input.value; update(); input.blur(); } });
  update();

  return frag(
    h('header', null, h('div', { class: 'kicker' }, 'Alla rapporter'), h('h1', { class: 'title-xl' }, 'Ämnen')),
    h('div', { class: 'section', style: 'gap:4px' },
      h('label', { class: 'search-label', for: 'sok' }, 'Sök i alla rapporter'),
      h('div', { class: 'search' }, searchIcon(), input)),
    barHolder,
    results);
}

// ---------------------------------------------------------------- courses of action (Version 3.11)
// Russia's most likely, possible and most dangerous course of action, with
// a schematic map, signs to watch and the likelihood over time. Written by
// src/courses.py after the 04:00 report, from the report, the thread checks
// and the authorities' and NATO brief - never from the Russian side.
const COA_TILES = {
  // col, row, width, height on a 6 x 7 grid; sea areas drawn lighter.
  NO: [0, 0, 1, 1, 'Norge'], SE: [1, 0, 1, 1, 'Sverige'], FI: [2, 0, 1, 1, 'Finland'], RU: [3, 0, 3, 3, 'Ryssland', 'ru'],
  DK: [0, 1, 1, 1, 'Danmark'], BALT: [1, 1, 1, 2, 'Östersjön', 'sea'], EE: [2, 1, 1, 1, 'Estland'],
  LV: [2, 2, 1, 1, 'Lettland'], DE: [0, 3, 1, 1, 'Tyskland'], KG: [1, 3, 1, 1, 'Kaliningrad', 'ru'],
  LT: [2, 3, 1, 1, 'Litauen'], BY: [3, 3, 1, 2, 'Belarus', 'ru'], PL: [1, 4, 2, 1, 'Polen'],
  MD: [2, 5, 1, 1, 'Moldavien'], UA: [3, 5, 2, 1, 'Ukraina'], RO: [2, 6, 1, 1, 'Rumänien'],
  BLACK: [3, 6, 2, 1, 'Svarta havet', 'sea'],
};
// Map symbols, drawn as text in a small circle.
const COA_SYMBOLS = { military: '▲', naval: '⚓', drone: '✈', sabotage: '✕', info: '!', proxy: '◆', nuclear: '☢', cable: '≈' };
const COA_SYMBOL_SV = {
  military: 'Militär styrka', naval: 'Örlogs- eller fartygsrörelse', drone: 'Drönare', sabotage: 'Sabotage',
  info: 'Påverkan och desinformation', proxy: 'Marionett eller ombud', nuclear: 'Kärnvapensignalering', cable: 'Kablar och infrastruktur',
};
const COA_ARROW_SV = { military: 'Militärt', hybrid: 'Hybrid', political: 'Politiskt' };

// The courses come from src/courses.py (GET /api/courses), updated after
// the 04:00 report; these are only their colours and the likelihood scale.
const COA_TONE = { troligast: 'likely', mojligt: 'possible', farligast: 'dangerous' };
const COA_LEVELS = ['låg', 'måttlig', 'hög'];
const COA_STATUS = { observerat: 'obs', delvis: 'part', 'inte observerat': 'none' };

function svgEl(tag, attrs, text) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, v);
  if (text != null) el.textContent = text;
  return el;
}

function coaMap(c) {
  const U = 52, PAD = 4;
  const centre = (code) => { const [x, y, w, hh] = COA_TILES[code]; return [(x + w / 2) * U, (y + hh / 2) * U]; };
  const svg = svgEl('svg', { viewBox: `0 0 ${6 * U} ${7 * U}`, class: 'coa-map', role: 'img',
    'aria-label': `Karta: ${c.title}` });
  const defs = svgEl('defs');
  for (const kind of Object.keys(COA_ARROW_SV)) {
    const m = svgEl('marker', { id: `coa-head-${kind}`, viewBox: '0 0 10 10', refX: '8', refY: '5', markerWidth: '5', markerHeight: '5', orient: 'auto-start-reverse' });
    m.appendChild(svgEl('path', { d: 'M0 0L10 5L0 10z', class: `coa-head ${kind}` }));
    defs.appendChild(m);
  }
  svg.appendChild(defs);
  const hit = new Set([...c.arrows.flatMap(([a, b]) => [a, b]), ...c.marks.map(([t]) => t)]);
  for (const [code, [x, y, w, hh, name, kind]] of Object.entries(COA_TILES)) {
    svg.appendChild(svgEl('rect', { x: x * U + PAD / 2, y: y * U + PAD / 2, width: w * U - PAD, height: hh * U - PAD, rx: 7,
      class: `coa-tile ${kind || ''} ${hit.has(code) ? 'hit' : ''}` }));
    svg.appendChild(svgEl('text', { x: (x + w / 2) * U, y: y * U + 13, class: 'coa-name' }, name));
  }
  for (const [from, to, kind] of c.arrows) {
    const [x1, y1] = centre(from); const [x2, y2] = centre(to);
    const len = Math.hypot(x2 - x1, y2 - y1) || 1; const sh = 16 / len;
    // A slight curve, so arrows between neighbours do not hide the labels.
    const mx = (x1 + x2) / 2 - (y2 - y1) * 0.18; const my = (y1 + y2) / 2 + (x2 - x1) * 0.18;
    svg.appendChild(svgEl('path', { d: `M${x1 + (x2 - x1) * sh} ${y1 + (y2 - y1) * sh} Q${mx} ${my} ${x2 - (x2 - x1) * sh} ${y2 - (y2 - y1) * sh}`,
      class: `coa-arrow ${kind}`, 'marker-end': `url(#coa-head-${kind})` }));
  }
  const used = {};
  for (const [code, sym] of c.marks) {
    const [cx, cy] = centre(code); const n = used[code] = (used[code] || 0) + 1;
    const x = cx + (n - 1) * 20 - 6; const y = cy + 8;
    svg.appendChild(svgEl('circle', { cx: x, cy: y, r: 9, class: `coa-sym ${sym}` }));
    svg.appendChild(svgEl('text', { x, y: y + 4, class: 'coa-sym-t' }, COA_SYMBOLS[sym]));
  }
  return svg;
}

function coaLegend(c) {
  const kinds = [...new Set(c.arrows.map((a) => a[2]))];
  const syms = [...new Set(c.marks.map((m) => m[1]))];
  return h('div', { class: 'coa-legend' },
    kinds.map((k) => h('span', null, h('i', { class: `coa-line ${k}` }), COA_ARROW_SV[k])),
    syms.map((sname) => h('span', null, h('b', { class: `coa-dot ${sname}` }, COA_SYMBOLS[sname]), COA_SYMBOL_SV[sname])));
}

function coursesRow(a) {
  if (!a || !Array.isArray(a.courses)) return null;
  const moved = a.courses.filter((c) => c.previous_likelihood && c.previous_likelihood !== c.likelihood).length;
  return h('a', { class: 'menurow coa-row', href: '#/handlingsalternativ' },
    h('span', { class: 'coa-row-icon', 'aria-hidden': 'true' }, '▲'),
    h('span', { class: 'row-main' },
      h('span', { class: 'row-title' }, 'Rysslands handlingsalternativ'),
      h('span', { class: 'row-sub' }, a.courses.map((c) => `${c.label} ${c.likelihood}`).join(' · '))),
    moved ? h('span', { class: 'nbadge' }, `${moved} ändrad${moved === 1 ? '' : 'e'}`) : null,
    chevRight());
}

function coaLevel(c) {
  const up = c.previous_likelihood && COA_LEVELS.indexOf(c.likelihood) > COA_LEVELS.indexOf(c.previous_likelihood);
  const down = c.previous_likelihood && COA_LEVELS.indexOf(c.likelihood) < COA_LEVELS.indexOf(c.previous_likelihood);
  return h('span', { class: `coa-level l${COA_LEVELS.indexOf(c.likelihood)}` },
    `Sannolikhet: ${c.likelihood}`, up ? ' ↑' : down ? ' ↓' : '',
    up || down ? h('span', { class: 'coa-was' }, ` (${c.previous_likelihood} i går)`) : null);
}

// The last 30 days' likelihood of one course, as small bars.
function coaHistory(history, id) {
  const days = history.slice(-30);
  if (days.length < 2) return null;
  return h('div', { class: 'coa-hist', role: 'img', 'aria-label': `Sannolikheten de senaste ${days.length} dagarna` },
    days.map((d) => h('i', { class: `l${COA_LEVELS.indexOf(d.likelihood[id])}`, title: `${dateShort(d.date)}: ${d.likelihood[id]}` })));
}

function coaSign(s) {
  const ev = (s.refs || []).find((r) => r.kind === 'event');
  return h('li', { class: `coa-sign ${COA_STATUS[s.status] || 'none'}` },
    h('i', { 'aria-hidden': 'true' }),
    h('span', null, s.text,
      h('span', { class: 'coa-sign-sub' }, ` · ${s.status}${s.first_seen ? `, först ${dateShort(s.first_seen)}` : ''}`),
      ev ? frag(' ', h('a', { href: eventHref(ev.date, ev.id) }, 'händelsen')) : null));
}

function coaSection(c, i, history) {
  const tone = COA_TONE[c.id];
  return h('section', { class: `card card-pad coa-card ${tone}`, id: `coa-${c.id}` },
    h('div', { class: 'coa-head-row' },
      h('span', { class: `coa-badge ${tone}` }, `${i + 1}. ${c.label}`), coaLevel(c)),
    h('h2', { class: 'coa-title' }, c.title),
    c.likelihood_reason_sv ? h('p', { class: 'small muted' }, c.likelihood_reason_sv) : null,
    coaHistory(history, c.id),
    coaMap(c),
    coaLegend(c),
    h('p', { class: 'body-sm' }, c.text.join(' ')),
    h('div', { class: 'kicker' }, 'Tecken att bevaka'),
    h('ul', { class: 'coa-signs' }, c.signs.map(coaSign)));
}

async function viewCourses() {
  const a = await loadCourses();
  const back = backLink('#/', 'Idag');
  if (!a) return frag(back, emptyState('Ingen bedömning ännu. Den görs efter morgonrapporten kl. 04.'));
  const jump = (id) => (ev) => { ev.preventDefault(); document.getElementById(`coa-${id}`).scrollIntoView({ behavior: 'smooth', block: 'start' }); };
  return frag(back,
    h('header', { class: 'page-head' }, h('div', null,
      h('div', { class: 'kicker' }, `Bedömt ${dateShort(a.date)} `, aiTag()),
      h('h1', { class: 'title-l' }, 'Rysslands handlingsalternativ'))),
    h('p', { class: 'hint' }, 'Hur Ryssland kan flytta fram sina positioner, splittra Europa och skapa buffertzoner – med våld, hot eller ombud.'),
    a.changed_sv ? h('p', { class: 'newline' }, h('span', null, h('b', null, 'Sedan i går: '), a.changed_sv)) : null,
    h('nav', { class: 'card list coa-toc', 'aria-label': 'Alternativen' }, a.courses.map((c, i) =>
      h('a', { class: 'row', href: `#coa-${c.id}`, onclick: jump(c.id) },
        h('span', { class: `coa-badge ${COA_TONE[c.id]}` }, `${i + 1}. ${c.label}`),
        h('span', { class: 'row-main' }, h('span', { class: 'row-title' }, c.title),
          h('span', { class: 'row-sub' }, `Sannolikhet: ${c.likelihood}`)),
        chevDown()))),
    a.courses.map((c, i) => coaSection(c, i, a.history || [])),
    h('p', { class: 'notice' }, 'AI-bedömning som uppdateras varje dag efter morgonrapporten, utifrån rapporten, trådbevakningen och sammanställningen Sverige och Nato. Den ryska sidan i Narrativ används inte. Sannolikheten ändras högst ett steg per dygn. Påverkar inte index. Kartan är schematisk.'));
}

// ---------------------------------------------------------------- authorities (Version 3.10)
// What Swedish authorities say: a row on Idag and a page of its own. Read
// by nothing else; marked as an AI summary, and "via" when the word comes
// from media rather than the authority itself.
function authoritiesRow(brief) {
  if (!brief || !Array.isArray(brief.items)) return null;
  const fresh = [...brief.items, ...((brief.nato && brief.nato.items) || [])].filter((i) => i.fresh).length;
  return h('a', { class: 'menurow', href: '#/myndigheter' },
    h('span', { class: 'se-flag', 'aria-hidden': 'true' }),
    h('span', { class: 'row-main' },
      h('span', { class: 'row-title' }, 'Sverige och Nato'),
      h('span', { class: 'row-sub' }, 'Vad myndigheterna och alliansen säger · senaste dygnet')),
    fresh ? h('span', { class: 'nbadge' }, `${fresh} ${fresh === 1 ? 'ny' : 'nya'}`) : null,
    chevRight());
}

function authorityRow(it) {
  return h('div', { class: 'row auth-row' },
    h('span', { class: 'row-main' },
      h('span', { class: 'row-title' }, it.agency),
      h('span', { class: 'body-sm' }, it.text_sv),
      h('span', { class: 'row-sub' }, `${it.via ? `Via ${it.via}` : 'Egen kanal'} · ${dateShort(it.date)}`),
      it.url ? h('span', null, externalButton(it.url, { outlet: it.via || it.agency }, 'Källan')) : null),
    it.fresh ? h('span', { class: 'nbadge' }, '24 h') : null);
}

// Two tabs: the Swedish authorities, and NATO (?s=nato), from the same brief.
async function viewAuthorities(q) {
  const brief = await loadAuthorities();
  const back = backLink('#/', 'Idag');
  if (!brief) return frag(back, emptyState('Ingen sammanställning ännu. Den görs kl. 07 och 17.'));
  const isNato = q.get('s') === 'nato';
  const part = isNato ? (brief.nato || { overall_sv: null, items: [] }) : brief;
  const fresh = part.items.filter((i) => i.fresh);
  const older = part.items.filter((i) => !i.fresh);
  return frag(back,
    h('header', { class: 'page-head' }, h('div', null,
      h('div', { class: 'kicker' }, `Sammanställt ${tsFmt(new Date(brief.generated_at))} `, aiTag()),
      h('h1', { class: 'title-l' }, 'Sverige och Nato'))),
    h('div', { class: 'seg', role: 'group', 'aria-label': 'Vems uppgifter' },
      h('button', { type: 'button', 'aria-pressed': String(!isNato), onclick: () => { location.hash = '#/myndigheter'; } }, 'Svenska myndigheter'),
      h('button', { type: 'button', 'aria-pressed': String(isNato), onclick: () => { location.hash = '#/myndigheter?s=nato'; } }, 'Nato')),
    part.overall_sv ? h('section', { class: 'card card-pad' },
      h('div', { class: 'kicker amber' }, isNato ? 'Natos linje' : 'Läget överlag'),
      h('p', { class: 'body-sm' }, part.overall_sv)) : null,
    h('section', { class: 'section' },
      h('h2', { class: 'kicker' }, 'Senaste dygnet'),
      fresh.length ? h('div', { class: 'card list' }, fresh.map(authorityRow))
        : h('p', { class: 'small muted' }, isNato ? 'Inget nytt från Nato det senaste dygnet.' : 'Inget nytt från myndigheterna det senaste dygnet.')),
    older.length ? h('section', { class: 'section' },
      h('h2', { class: 'kicker' }, 'Senaste veckan'),
      h('div', { class: 'card list' }, older.map(authorityRow))) : null,
    !isNato && brief.quiet && brief.quiet.length ? h('p', { class: 'small muted' }, h('b', null, 'Inget nytt hittat: '), brief.quiet.join(', ')) : null,
    h('p', { class: 'notice' }, isNato
      ? 'AI-sammanfattning, översatt till svenska, av Natos egna kanaler och internationell rapportering. '
      : 'AI-sammanfattning av myndigheternas egna kanaler och svensk nyhetsrapportering. ',
    '"Via" betyder att uppgiften kommer från medier. Påverkar inte index eller rapportens bedömningar. Uppdateras kl. 07 och 17.'));
}

// ---------------------------------------------------------------- trends (Version 3.9)
// What spreads, apart from the analysis: open sources, and - only when the
// reader chooses to see it - the Russian side, marked on every item.
const SHOW_RU_KEY = 'hm.showRussianSide';
const TREND_SOURCE = {
  wikipedia: 'Wikipedia', google_trends: 'Google-sökningar', reddit: 'Reddit',
  mastodon: 'Mastodon', bluesky: 'Bluesky', telegram: 'Telegram',
};
const openTrends = new Set();
function showRussian() { try { return localStorage.getItem(SHOW_RU_KEY) === '1'; } catch { return false; } }
function setShowRussian(on) {
  try { if (on) localStorage.setItem(SHOW_RU_KEY, '1'); else localStorage.removeItem(SHOW_RU_KEY); } catch { /* private mode */ }
}

function russianGate() {
  return h('section', { class: 'card card-pad ru-gate' },
    h('div', { class: 'ru-label' }, 'Rysk sida · utesluten källa'),
    h('h2', { class: 'title-m' }, 'Vill du se den ryska sidan?'),
    h('p', { class: 'body-sm' }, 'Inlägg från rysk statsmedia, ryska försvarsministeriet och prokremlska krigsbloggare på Telegram. ',
      'Det är propaganda och påståenden, och i metoden en utesluten källa. Det visas för att du ska se vilka berättelser som drivs – aldrig som belägg för att något har hänt.'),
    h('div', { class: 'btn-row' },
      h('button', { class: 'btn primary', type: 'button', onclick: () => { setShowRussian(true); rerender(); } }, 'Visa rysk sida'),
      h('a', { class: 'btn', href: '#/narrativ' }, 'Tillbaka till öppna källor')));
}

function trendRow(t, ru, threadEvents) {
  const open = openTrends.has(t.id);
  const toggle = () => { if (open) openTrends.delete(t.id); else openTrends.add(t.id); rerender(); };
  const title = t.title_sv || t.title;
  const threadEvent = t.thread_id ? threadEvents.find(({ e }) => e.thread_id === t.thread_id) : null;
  return h('div', { class: `upd-wrap${ru ? ' trend-ru' : ''}` },
    h('button', { class: 'row rowbtn', type: 'button', 'aria-expanded': String(open), onclick: toggle },
      h('span', { class: 'row-main' },
        h('span', { class: 'row-sub' }, ru ? h('span', { class: 'ru-label' }, 'Rysk sida') : null, ru ? ' ' : null,
          `${TREND_SOURCE[t.source] || t.source}${t.place ? ` · ${t.place}` : ''}`),
        h('span', { class: 'row-title' }, title),
        t.metric_sv ? h('span', { class: 'row-sub' }, t.metric_sv) : null),
      t.spike && t.spike >= 2 ? h('span', { class: 'nbadge' }, `${String(t.spike).replace('.', ',')}×`) : null,
      chevDown()),
    open ? h('div', { class: 'expand' },
      t.summary_sv ? h('p', { class: 'body-sm' }, t.summary_sv) : null,
      // The original: open when there is no Swedish, folded away when there is.
      !t.title && !t.detail ? null
      : t.title_sv || t.summary_sv
        ? h('details', { class: 'small muted' }, h('summary', null, ru ? 'Originalet på ryska' : 'Originalet'),
          h('p', { lang: ru ? 'ru' : null }, t.title), t.detail ? h('p', { lang: ru ? 'ru' : null }, t.detail) : null)
        : t.detail ? h('p', { class: 'body-sm', lang: ru ? 'ru' : null }, t.detail) : null,
      ru ? h('p', { class: 'small muted' }, 'Ett påstående från den ryska sidan, inte bekräftat.') : null,
      h('p', { class: 'small muted' }, `Sågs först ${tsFmt(t.first_seen)}${t.last_seen !== t.first_seen ? `, senast ${tsFmt(t.last_seen)}` : ''}`),
      h('div', { class: 'btn-row' },
        t.url ? externalButton(t.url, { outlet: t.place }, ru ? 'Öppna på Telegram' : 'Öppna källan') : null,
        threadEvent ? h('a', { class: 'btn', href: eventHref(threadEvent.r.date, threadEvent.e.id) }, 'Bevakad tråd') : null)) : null);
}

async function viewTrends(q) {
  const ru = q.get('s') === 'ru';
  const seg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Vilken sida' },
    h('button', { type: 'button', 'aria-pressed': String(!ru), onclick: () => { location.hash = '#/narrativ'; } }, 'Öppna källor'),
    h('button', { type: 'button', 'aria-pressed': String(ru), class: 'seg-ru', onclick: () => { location.hash = '#/narrativ?s=ru'; } }, 'Rysk sida'));
  const head = frag(
    h('header', { class: 'page-head' }, h('div', null, h('div', { class: 'kicker' }, aiTag()), h('h1', { class: 'title-l' }, 'Narrativ'))),
    h('p', { class: 'hint' }, 'Det som sprids just nu. Inte bedömt och inte bekräftat – påverkar inte rapporten, trådarna eller index.'),
    seg);
  if (ru && !showRussian()) return frag(head, russianGate());

  const [data, index] = await Promise.all([loadTrends(ru ? 'ru' : 'open'), loadIndex()]);
  const latest = index.length ? await loadReport(index[0].date) : null;
  const threadEvents = latest ? latest.events.map((e) => ({ r: latest, e })) : [];
  const items = data.items || [];
  const summary = (data.summaries || [])[0];
  const dayAgo = new Date(Date.now() - 86400000).toISOString();
  const fresh = items.filter((t) => t.last_seen >= dayAgo);
  const older = items.filter((t) => t.last_seen < dayAgo);
  const status = data.sources ? Object.entries(data.sources)
    .filter(([name]) => (name === 'telegram') === ru)
    .map(([name, s]) => `${TREND_SOURCE[name] || name}${s.error ? ' (svarade inte)' : ''}`) : [];

  return frag(head,
    ru ? h('div', { class: 'notice err ru-banner', role: 'note' },
      h('b', null, 'Rysk sida · utesluten källa. '),
      'Propaganda och påståenden från rysk statsmedia och prokremlska kanaler – inte belägg. ',
      h('button', { class: 'linkbtn', type: 'button', onclick: () => { setShowRussian(false); location.hash = '#/narrativ'; } }, 'Dölj den ryska sidan')) : null,
    summary && summary.text ? h('section', { class: `card card-pad${ru ? ' trend-ru' : ''}` },
      h('div', { class: 'kicker' }, `Dygnets sammanfattning · ${dateShort(summary.date)}`),
      h('p', { class: 'body-sm' }, summary.text)) : null,
    h('section', { class: 'section' },
      h('h2', { class: 'kicker' }, 'Senaste dygnet'),
      fresh.length ? h('div', { class: 'card list' }, fresh.map((t) => trendRow(t, ru, threadEvents)))
        : emptyState(ru ? 'Inga inlägg om Nato, Europa eller grannländerna det senaste dygnet.' : 'Inget på ämnet sticker ut det senaste dygnet.')),
    older.length ? h('section', { class: 'section' },
      h('h2', { class: 'kicker' }, 'Tidigare'),
      h('div', { class: 'card list' }, older.map((t) => trendRow(t, ru, threadEvents)))) : null,
    status.length ? h('p', { class: 'small muted' }, `Källor: ${status.join(', ')}`) : null);
}

// ---------------------------------------------------------------- forces map (Version 3.12)
// Russia's (and Belarus's) known bases on a zoomable map of Europe and
// Russia, drawn here from Natural Earth outlines (no map tiles, nothing
// from other hosts). Far out the bases gather into clusters; closer in each
// base shows with its branch and status; tap one for what is there. The
// search filters as you type ("su" lists every Su type, "su34" the Su-34).
// Data: /api/forces, from src/forces.py every night after the 04:00 report
// (Wikidata + a hand-kept list, and the night's attacks and changes).
const FORCE_BRANCH = {
  flyg: ['Flyg', 'F', '#2D5B8C'], marin: ['Marin', 'M', '#1F6E7A'], 'armé': ['Armé', 'A', '#5B6B3A'],
  luftvärn: ['Luftvärn', 'L', '#6B4E8B'], robot: ['Robot', 'R', '#8A3B12'], fallskärm: ['Fallskärm', 'V', '#7A5A1F'],
};
const FORCE_STATUS = { anfallen: 'Anfallen senaste 30 dagarna', aktiv: 'Aktiv', 'okänd': 'Status okänd' };
const FORCE_CHANGE = { 'tillfört': 'Tillfört', flyttat: 'Flyttat', borta: 'Borta', 'ändrat': 'Ändrat', uppgift: 'Uppgift' };
// 'uppgift': a removal or move with one independent source, kept as a claim
// (src/forces.py); the lists stay as they were.
function forceChangeText(c) {
  if (c.kind !== 'uppgift') return `${FORCE_CHANGE[c.kind] || c.kind} ${c.what}`;
  const claimed = FORCE_CHANGE[c.claimed_kind] ? `: ${FORCE_CHANGE[c.claimed_kind].toLowerCase()}` : '';
  return `Uppgift${claimed} ${c.what} (en källa, listan oförändrad)`;
}
const FX = (lon) => (lon + 25) * 5.3;      // equirectangular, squeezed for latitude ~58
const FY = (lat) => (82 - lat) * 10;
const FULL = { x: 0, y: 0, w: FX(192), h: FY(34) };
const fnorm = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9åäöа-я]+/g, '');
let forcesLand = null;
// The view's state, kept here: the app redraws the view when fresh data
// comes in, and the search, zoom and chosen base must survive that.
const forcesUi = { vb: null, query: '', branch: null, onlyHit: false, selected: null };

async function loadForcesView() {
  const [land, data, cat] = await Promise.all([
    forcesLand || fetch('/forces/countries.json').then((r) => { if (!r.ok) throw new Error(`countries: ${r.status}`); return r.json(); }),
    loadForces(), loadForceCatalogue()]);
  forcesLand = land;
  if (!data) return null;
  for (const b of data.bases) {
    b.x = FX(b.lon); b.y = FY(b.lat);
    if (/[\u0400-\u04FF]/.test(b.name)) { b.name_ru = b.name_ru || b.name; b.name = latin(b.name); }
    const sv = b.survey || {};
    const names = [...(b.system_ids || []).map((id) => cat.systems.get(id)?.name), ...(b.unit_ids || []).map((id) => cat.units.get(id)?.name_sv)];
    b.hay = [b.name, b.name_ru, FORCE_BRANCH[b.branch]?.[0], ...b.units, ...b.equipment, ...(sv.units || []), ...(sv.equipment || []), ...names]
      .filter(Boolean).map(fnorm);
  }
  return { land: land.countries, bases: data.bases, byId: new Map(data.bases.map((b) => [b.id, b])), data, cat };
}

// ---------------------------------------------------------------- satellite fire (Version 3.18)
// NASA FIRMS's own map, opened at the place and on the attack day and the
// next, so anyone can look at the fire detections themselves.
function firmsMapUrl(lat, lon, day) {
  if (typeof lat !== 'number' || typeof lon !== 'number' || !/^\d{4}-\d{2}-\d{2}/.test(day || '')) return null;
  const start = day.slice(0, 10);
  const next = new Date(`${start}T12:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return `https://firms.modaps.eosdis.nasa.gov/map/#d:${start}..${next.toISOString().slice(0, 10)};@${lon.toFixed(3)},${lat.toFixed(3)},12z`;
}

function firmsLine(f) {
  return f ? h('span', { class: 'small' }, h('br'), h('b', null, 'Brand sedd av satellit (NASA FIRMS)'),
    `: ${plural(f.count, 'brandpunkt', 'brandpunkter')} inom ${String(f.radius_km || 3).replace('.', ',')} km från ${dateShort(f.date)}, konfidens ${f.confidence}.`,
    f.baseline && Number.isFinite(Number(f.baseline.count))
      ? ` Normalt ${plural(Number(f.baseline.count), 'brandpunkt', 'brandpunkter')} ${Number(f.baseline.days) === 7 || !f.baseline.days ? 'veckan' : `de ${f.baseline.days} dagarna`} före.` : null) : null;
}

function firmsButton(lat, lon, day) {
  return externalButton(firmsMapUrl(lat, lon, day), { outlet: 'NASA FIRMS' }, 'Satellitkarta, bränder');
}

// An attack away from the listed bases: a refinery, a depot, a port ...
function otherStrikeRow(o) {
  return h('li', { class: 'coa-sign part' }, h('i'), h('span', null,
    h('b', null, `${o.place}${o.target_sv ? ` (${o.target_sv})` : ''}${o.date ? `, ${dateShort(o.date)}` : ''}: `), o.text_sv,
    firmsLine(o.firms),
    o.lat != null && o.precision === 'town' ? h('span', { class: 'small muted' }, h('br'), 'Platsen är orten, inte själva målet.') : null,
    ' ', forceSources(o.sources), ' ', o.lat != null ? firmsButton(o.lat, o.lon, o.date) : null));
}

// ---------------------------------------------------------------- how old a status is
// Version 3.29: an attack NASA FIRMS saw as fire says so (src/forces_firms.py);
// every unit and base card says when its status was last
// updated; a status older than STALE_DAYS is toned down and marked
// "ej bekräftad sedan". Dates may be a day, a month ("2026-11") or a year.
const STALE_DAYS = 60;
function statusDate(s) {
  const m = String(s || '').match(/^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?/);
  return m ? `${m[1]}-${m[2] || '01'}-${m[3] || '01'}` : null;
}
function ageNote(asOf) {
  const d = statusDate(asOf);
  if (!d) return null;
  const stale = (Date.now() - Date.parse(`${d}T00:00:00Z`)) / 864e5 > STALE_DAYS;
  const s = String(asOf);
  const label = /^\d{4}-\d{2}-\d{2}/.test(s) ? `${dateShort(d)} ${d.slice(0, 4)}` : s;
  return { stale, text: stale ? `ej bekräftad sedan ${label}` : `uppdaterad ${label}` };
}
function statusLine(label, text, asOf, extra) {
  if (!text) return null;
  const a = ageNote(asOf);
  return h('p', { class: `small${a?.stale ? ' muted' : ''}`, style: a?.stale ? 'opacity:.6' : null },
    h('b', null, label), text, a ? h('span', { class: 'muted' }, ` · ${a.text}`) : null, extra ? [' ', extra] : null);
}

// ---------------------------------------------------------------- the forces catalogue (grunddata)
// Weapon systems and units from config/forces_db, served as static files
// (/forces/systems.json, /forces/units.json) and read once. A base's
// equipment and units are display strings; these resolve them to entries.
let forceCatalogue = null;
async function loadForceCatalogue() {
  if (forceCatalogue) return forceCatalogue;
  const get = (name) => fetch(`/forces/${name}.json`).then((r) => (r.ok ? r.json() : { [name]: [] })).catch(() => ({ [name]: [] }));
  const [sys, units] = await Promise.all([get('systems'), get('units')]);
  const systems = new Map((sys.systems || []).map((x) => [x.id, x]));
  const unitMap = new Map((units.units || []).map((x) => [x.id, x]));
  const sysByName = new Map();
  for (const x of systems.values()) {
    for (const k of [x.id, x.name, x.name.split(' ')[0], ...x.name.split(' / ')]) if (!sysByName.has(fnorm(k))) sysByName.set(fnorm(k), x.id);
  }
  const unitByName = new Map([...unitMap.values()].map((u) => [fnorm(u.name_sv), u.id]));
  const children = new Map();
  for (const u of unitMap.values()) if (u.parent) { if (!children.has(u.parent)) children.set(u.parent, []); children.get(u.parent).push(u.id); }
  forceCatalogue = { systems, units: unitMap, sysByName, unitByName, children };
  return forceCatalogue;
}
// A display string ("Su-34", "Borej-klass", "Iskander") to a system id, or null.
function systemFor(cat, text, ids = []) {
  const t = fnorm(text);
  if (cat.sysByName.has(t)) return cat.sysByName.get(t);
  const hit = ids.find((id) => { const n = fnorm(cat.systems.get(id)?.name); return n && (n.startsWith(t) || t.startsWith(n.split(/[^a-z0-9а-я]/)[0] || n)); });
  if (hit) return hit;
  for (const [k, id] of cat.sysByName) if (k.length > 2 && t.startsWith(k)) return id;
  return null;
}
function unitFor(cat, text) { return cat.unitByName.get(fnorm(text)) || null; }
const COUNTRY_FORCES = { RU: 'Ryssland', BY: 'Belarus', UA: 'Ukraina (ockuperat)', SY: 'Syrien', AM: 'Armenien', TJ: 'Tadzjikistan',
  KG: 'Kirgizistan', GE: 'Georgien (utbrytarregion)', MD: 'Moldavien (Transnistrien)' };
// Open the map at a base (by app id or database id).
function showBaseOnMap(b) {
  const w = FULL.w / 8; const hh = w * FULL.h / FULL.w;
  forcesUi.vb = { x: FX(b.lon) - w / 2, y: FY(b.lat) - hh / 2, w, h: hh };
  forcesUi.selected = b.id; forcesUi.query = ''; forcesUi.branch = null; forcesUi.onlyHit = false;
  location.hash = '#/styrkor';
}
function baseLink(b) { return h('button', { class: 'chip', type: 'button', onclick: () => showBaseOnMap(b) }, b.name); }
function sysChip(cat, id) { const x = cat.systems.get(id); return x ? h('a', { class: 'chip', href: `#/styrkor?sys=${encodeURIComponent(id)}` }, x.name) : null; }
function unitChip(cat, id) { const u = cat.units.get(id); return u ? h('a', { class: 'chip', href: `#/styrkor?unit=${encodeURIComponent(id)}` }, u.name_sv) : null; }
function catSources(list) {
  return (list || []).length ? h('div', null, h('h3', { class: 'fsub' }, 'Källor'), h('div', { class: 'chips' },
    list.map((s) => externalButton(s.url, { outlet: s.outlet, date: s.accessed }, s.outlet || 'Källa')))) : null;
}
function forceHead(kicker, title, sub) {
  return h('header', { class: 'page-head' }, h('div', null, backLink('#/styrkor', 'Styrkor'),
    h('div', { class: 'kicker' }, kicker), h('h1', { class: 'title-xl' }, title), sub ? h('p', { class: 'small muted' }, sub) : null));
}

// A weapon system: image with attribution, figures, where it is based.
async function viewForceSystem(id) {
  const [cat, data] = await Promise.all([loadForceCatalogue(), loadForces().catch(() => null)]);
  const x = cat.systems.get(id);
  if (!x) return frag(forceHead('Vapensystem', 'Okänt system'), emptyState('Systemet finns inte i grunddatabasen.'));
  const bases = (data?.bases || []).filter((b) => (b.system_ids || []).includes(id) || b.equipment.some((t) => systemFor(cat, t, b.system_ids) === id))
    .sort((a, b) => a.name.localeCompare(b.name, 'sv'));
  const units = [...cat.units.values()].filter((u) => (u.equipment || []).includes(id)).sort((a, b) => a.name_sv.localeCompare(b.name_sv, 'sv'));
  const img = x.image;
  return frag(
    forceHead(x.category_sv, x.name, [x.name_ru, x.role_sv].filter(Boolean).join(' · ')),
    h('section', { class: 'card card-pad fsys' },
      img ? h('figure', { class: 'ffig' },
        zoomableImg({ class: 'fimg', src: `/forces/img/${img.file}`, alt: x.name, loading: 'lazy' }, `${x.name} · Bild: ${latin(img.author)} · ${img.license}`),
        h('figcaption', { class: 'small muted' }, `Bild: ${latin(img.author)} · ${img.license} · `,
          externalButton(img.source_url, { outlet: 'Wikimedia Commons' }, 'Wikimedia Commons'))) : null,
      h('p', { class: 'body-sm' }, x.description_sv),
      Object.keys(x.key_figures || {}).length ? h('dl', { class: 'fkv' },
        Object.entries(x.key_figures).map(([k, v]) => [h('dt', null, k), h('dd', null, v)])) : null),
    h('section', { class: 'card card-pad' },
      h('h2', { class: 'fsub' }, bases.length ? `Finns på ${plural(bases.length, 'bas', 'baser')}` : 'Baser'),
      bases.length ? h('div', { class: 'chips' }, bases.map(baseLink)) : h('p', { class: 'small muted' }, 'Ingen bas i underlaget anger systemet.'),
      units.length ? [h('h3', { class: 'fsub' }, 'Förband'), h('div', { class: 'chips' }, units.map((u) => unitChip(cat, u.id)))] : null,
      catSources(x.sources)),
    h('p', { class: 'notice' }, 'Uppgifterna kommer från öppna källor och anges som de publicerats. Prestandauppgifter är ofta osäkra.'));
}

// A unit: status, parent, garrisons, equipment.
async function viewForceUnit(id) {
  const [cat, data] = await Promise.all([loadForceCatalogue(), loadForces().catch(() => null)]);
  const u = cat.units.get(id);
  if (!u) return frag(forceHead('Förband', 'Okänt förband'), emptyState('Förbandet finns inte i grunddatabasen.'));
  const all = data?.bases || [];
  const garrisons = all.filter((b) => (b.unit_ids || []).includes(id) || (u.garrison || []).includes(b.db_id));
  const parent = u.parent ? cat.units.get(u.parent) : null;
  const kids = (cat.children.get(id) || []).map((k) => cat.units.get(k)).filter(Boolean);
  const live = data?.units?.[id] || null;   // the nightly ISW reading (src/forces_isw.py)
  return frag(
    forceHead(`${u.type.charAt(0).toUpperCase()}${u.type.slice(1)} · ${FORCE_BRANCH[u.branch]?.[0] || u.branch}`, u.name_sv,
      [u.name_ru, u.name_en].filter(Boolean).join(' · ')),
    h('section', { class: 'card card-pad' },
      statusLine('Status: ', live?.status_sv || u.status_sv, live?.status_as_of || u.as_of,
        live?.status_source?.[0]?.url ? externalButton(live.status_source[0].url, { outlet: live.status_source[0].outlet, date: live.status_as_of }, 'ISW') : null),
      (live?.status_source || []).length > 1 ? h('details', { class: 'small muted' }, h('summary', null, 'Tidigare lägen enligt ISW'),
        h('ul', null, live.status_source.slice(1).map((p) => h('li', null, `${dateShort(p.date)} ${p.date.slice(0, 4)}: ${p.status_sv} `,
          externalButton(p.url, { outlet: p.outlet, date: p.date }, 'ISW'))))) : null,
      h('p', { class: 'body-sm' }, u.description_sv),
      parent ? h('p', { class: 'body-sm' }, h('b', null, 'Ingår i: '), unitChip(cat, parent.id)) : null,
      kids.length ? [h('h3', { class: 'fsub' }, 'Underställda förband'), h('div', { class: 'chips' }, kids.map((k) => unitChip(cat, k.id)))] : null,
      h('h3', { class: 'fsub' }, 'Garnison'),
      garrisons.length ? h('div', { class: 'chips' }, garrisons.map(baseLink)) : h('p', { class: 'small muted' }, 'Ingen bas i underlaget.'),
      (u.equipment || []).length ? [h('h3', { class: 'fsub' }, 'Materiel som nämns i källorna'), h('div', { class: 'chips' }, u.equipment.map((s) => sysChip(cat, s)))] : null,
      catSources(u.sources)),
    h('p', { class: 'notice' }, 'Uppgifterna kommer från öppna källor (främst Wikipedia) och kan vara inaktuella. Inte verifierat.'));
}

// The weekly Wikipedia survey of a base (src/forces_survey.py).
function surveyBlock(sv) {
  if (!sv || sv.none || !(sv.summary_sv || (sv.units || []).length || (sv.equipment || []).length)) return null;
  return h('div', { class: 'fsurvey' },
    h('h3', { class: 'fsub' }, 'Om basen'),
    sv.summary_sv ? h('p', { class: 'body-sm' }, sv.summary_sv) : null,
    (sv.units || []).length ? h('p', { class: 'body-sm' }, h('b', null, 'Förband enligt Wikipedia: '), sv.units.join(', ')) : null,
    (sv.equipment || []).length ? h('p', { class: 'body-sm' }, h('b', null, 'Materiel enligt Wikipedia: '), sv.equipment.join(', ')) : null,
    h('p', { class: 'small muted' }, `Veckosökning ${dateShort(sv.date)}`, sv.as_of ? `, uppgifterna avser ${sv.as_of}` : '', '. ',
      sv.source ? externalButton(sv.source.url, { outlet: sv.source.outlet }, sv.source.outlet) : null));
}

function forcesSeg(strikes) {
  return h('div', { class: 'seg', role: 'group', 'aria-label': 'Visa' },
    h('button', { type: 'button', 'aria-pressed': String(!strikes), onclick: () => { location.hash = '#/styrkor'; } }, 'Ryska baser'),
    h('button', { type: 'button', 'aria-pressed': String(strikes), onclick: () => { location.hash = '#/styrkor?s=anfall'; } }, 'Anfall mot Ukraina'));
}

// Cyrillic names (Russian or Ukrainian) in Latin letters, Swedish-style
// (Sjojgu, Tjeljabinsk), so nothing in Styrkor shows untranslated; the
// Russian original stays beside a base's name. No model call.
const CYR = { а: 'a', б: 'b', в: 'v', г: 'g', ґ: 'g', д: 'd', е: 'e', ё: 'jo', є: 'je', ж: 'zj', з: 'z', и: 'i', і: 'i', ї: 'ji', й: 'j',
  к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'ch', ц: 'ts', ч: 'tj', ш: 'sj', щ: 'sjtj',
  ъ: '', ы: 'y', ь: '', э: 'e', ю: 'ju', я: 'ja' };
const CYR_WORDS = [[/Министерство обороны Российской Федерации|Минобороны России|Минобороны РФ/gi, 'Rysslands försvarsministerium']];
function latin(t) {
  if (!t || !/[\u0400-\u04FF]/.test(t)) return t;
  let out = String(t);
  for (const [re, sv] of CYR_WORDS) out = out.replace(re, sv);
  return out.replace(/[\u0400-\u04FF]/g, (ch) => {
    const lo = ch.toLowerCase(); const l = CYR[lo] ?? ch;
    return ch === lo ? l : l.charAt(0).toUpperCase() + l.slice(1);
  });
}

function forceSources(list) {
  return (list || []).length ? h('span', { class: 'fsrc' }, list.map((s) => externalButton(s.url, { outlet: latin(s.outlet) }, latin(s.outlet) || 'Källa'))) : null;
}

// ---------------------------------------------------------------- shared map helpers (Version 3.15)
// Both maps (bases, strikes) share these: the land with a graticule, the
// names of countries and a few cities for orientation, pan and pinch,
// smooth wheel zoom, double tap to zoom in, and no stray tap on a base
// after a drag.
const MAP_PLACES = [
  ['Ryssland', 60, 61, 'land'], ['Belarus', 28, 53.6, 'land'], ['Ukraina', 31.5, 49.2, 'land'], ['Finland', 26, 63.5, 'land'],
  ['Sverige', 15.5, 62.5, 'land'], ['Norge', 9, 61.5, 'land'], ['Estland', 25.8, 58.7, 'land'], ['Lettland', 25.5, 56.9, 'land'],
  ['Litauen', 23.9, 55.3, 'land'], ['Polen', 19.5, 52, 'land'], ['Tyskland', 10.5, 51, 'land'], ['Rumänien', 25, 45.9, 'land'],
  ['Moldavien', 28.6, 47.2, 'land'], ['Georgien', 43.5, 42.2, 'land'], ['Turkiet', 35, 39, 'land'], ['Kazakstan', 67, 48, 'land'],
  ['Mongoliet', 103, 46.8, 'land'], ['Kina', 110, 38, 'land'], ['Danmark', 9.3, 56, 'land'],
  ['Moskva', 37.62, 55.75, 'city'], ['S:t Petersburg', 30.32, 59.94, 'city'], ['Kaliningrad', 20.5, 54.71, 'city'],
  ['Murmansk', 33.08, 68.97, 'city'], ['Minsk', 27.56, 53.9, 'city'], ['Kyiv', 30.52, 50.45, 'city'], ['Stockholm', 18.07, 59.33, 'city'],
  ['Helsingfors', 24.94, 60.17, 'city'], ['Sevastopol', 33.52, 44.6, 'city'], ['Vladivostok', 131.9, 43.12, 'city'],
  ['Novosibirsk', 82.92, 55.03, 'city'], ['Rostov', 39.7, 47.23, 'city'], ['Charkiv', 36.23, 49.99, 'city'], ['Riga', 24.1, 56.95, 'city'],
  ['Tallinn', 24.75, 59.44, 'city'], ['Vilnius', 25.28, 54.69, 'city'], ['Warszawa', 21.01, 52.23, 'city'], ['Odesa', 30.72, 46.48, 'city'],
];

// Fine coastlines and borders (Natural Earth 1:10m), fetched the first
// time a map is zoomed in; until then, and when zoomed out, the light
// 1:50m outlines serve.
let detailLand = null;
function loadDetailLand() {
  if (!detailLand) {
    detailLand = fetch('/forces/countries-10m.json').then((r) => (r.ok ? r.json() : null)).then((j) => j?.countries || null).catch(() => null);
  }
  return detailLand;
}

// Lakes, major rivers, and the regional borders of Russia, Belarus and
// Ukraine (Natural Earth): orientation inside the large countries.
let mapFeatures = null;
function loadMapFeatures() {
  if (!mapFeatures) mapFeatures = fetch('/forces/features.json').then((r) => (r.ok ? r.json() : null)).catch(() => null);
  return mapFeatures;
}
const linePath = (lines, close) => lines.map((l) => `M${l.map(([lon, lat]) => `${FX(lon).toFixed(2)} ${FY(lat).toFixed(2)}`).join('L')}${close ? 'Z' : ''}`).join('');

// A land layer that switches to the fine outlines when zoomed in, and
// shows only the countries in view. update(vb, px) after each draw.
function landLayers(countries, cls, onReady) {
  const coarse = mapLand(countries, cls);
  const fine = svgEl('g', { class: 'fland-fine' });
  fine.style.display = 'none';
  let paths = null; let asked = false;
  const g = svgEl('g');
  const regions = svgEl('path', { class: 'fregion' });
  const water = svgEl('g');
  g.append(coarse, fine, regions, water);
  loadMapFeatures().then((f) => {
    if (!f) return;
    regions.setAttribute('d', linePath(f.regions, false));
    water.append(svgEl('path', { class: 'flake', d: linePath(f.lakes, true) }), svgEl('path', { class: 'friver', d: linePath(f.rivers, false) }));
  });
  return {
    g,
    update(vb, px) {
      regions.style.display = px < 1.6 ? '' : 'none';
      const near = px < 1.1;
      if (near && !asked) {
        asked = true;
        loadDetailLand().then((list) => {
          if (!list) return;
          paths = list.map((c) => {
            let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
            const d = c.rings.map((r) => `M${r.map(([lon, lat]) => {
              const x = FX(lon); const y = FY(lat);
              if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
              return `${x.toFixed(2)} ${y.toFixed(2)}`;
            }).join('L')}Z`).join('');
            const el = svgEl('path', { d, class: `fland ${cls(c)}` });
            fine.appendChild(el);
            return { el, box: [x0, y0, x1, y1] };
          });
          onReady();
        });
      }
      const useFine = near && paths;
      fine.style.display = useFine ? '' : 'none';
      coarse.style.display = useFine ? 'none' : '';
      if (useFine) {
        for (const { el, box } of paths) {
          const inView = box[2] >= vb.x && box[0] <= vb.x + vb.w && box[3] >= vb.y && box[1] <= vb.y + vb.h;
          el.style.display = inView ? '' : 'none';
        }
      }
    },
  };
}

// A small overview in the corner while zoomed in: where the view is, and a
// tap moves there.
function miniMap(countries, full, onJump) {
  const svg = svgEl('svg', { class: 'fmini', viewBox: `${full.x} ${full.y} ${full.w} ${full.h}`, 'aria-hidden': 'true' });
  const g = svgEl('g');
  for (const c of countries) {
    const d = c.rings.filter((r) => r.length > 12).map((r) => `M${r.filter((_, i) => i % 3 === 0).map(([lon, lat]) => `${FX(lon).toFixed(0)} ${FY(lat).toFixed(0)}`).join('L')}Z`).join('');
    if (d) g.appendChild(svgEl('path', { d, class: `fmini-land${c.name === 'Russia' || c.name === 'Belarus' ? ' ru' : ''}` }));
  }
  const rect = svgEl('rect', { class: 'fmini-view' });
  svg.append(g, rect);
  svg.addEventListener('click', (ev) => {
    ev.stopPropagation();
    const r = svg.getBoundingClientRect();
    onJump(full.x + (ev.clientX - r.left) / r.width * full.w, full.y + (ev.clientY - r.top) / r.height * full.h);
  });
  svg.addEventListener('pointerdown', (ev) => ev.stopPropagation());
  return {
    svg,
    update(vb) {
      const show = vb.w < full.w * 0.55;
      svg.style.display = show ? '' : 'none';
      if (!show) return;
      // At least a few map units, so a deep zoom still shows a mark.
      const mw = Math.max(vb.w, full.w / 60); const mh = Math.max(vb.h, full.w / 90);
      rect.setAttribute('x', vb.x + vb.w / 2 - mw / 2); rect.setAttribute('y', vb.y + vb.h / 2 - mh / 2);
      rect.setAttribute('width', mw); rect.setAttribute('height', mh);
    },
  };
}

function mapLand(countries, cls = (c) => '') {
  const g = svgEl('g');
  const grid = [];
  for (let lon = -20; lon <= 190; lon += 10) grid.push(`M${FX(lon)} ${FY(82)}V${FY(34)}`);
  for (let lat = 35; lat <= 80; lat += 5) grid.push(`M${FX(-25)} ${FY(lat)}H${FX(192)}`);
  g.appendChild(svgEl('path', { d: grid.join(''), class: 'fgrid' }));
  for (const c of countries) {
    const d = c.rings.map((r) => `M${r.map(([lon, lat]) => `${FX(lon).toFixed(1)} ${FY(lat).toFixed(1)}`).join('L')}Z`).join('');
    g.appendChild(svgEl('path', { d, class: `fland ${cls(c)}` }));
  }
  return g;
}

// Country and city names at a constant screen size; px = map units per pixel.
function mapPlaces(g, px, vb) {
  g.replaceChildren();
  for (const [name, lon, lat, kind] of MAP_PLACES) {
    const x = FX(lon); const y = FY(lat);
    if (x < vb.x || x > vb.x + vb.w || y < vb.y || y > vb.y + vb.h) continue;
    if (kind === 'city' && px > 0.9) continue;
    if (kind === 'city') {
      g.append(svgEl('circle', { class: 'fcity', cx: x, cy: y, r: px * 2.2 }),
        svgEl('text', { class: 'fcity-l', x: x + px * 4, y: y + px * 3.5, 'font-size': px * 10, 'stroke-width': px * 2.5 }, name));
    } else g.append(svgEl('text', { class: 'fcountry', x, y, 'font-size': px * 12, 'text-anchor': 'middle' }, name.toUpperCase()));
  }
}

// The map's height over its width as shown, so the view fills the box.
const boxRatio = (svg) => (svg.clientHeight && svg.clientWidth ? svg.clientHeight / svg.clientWidth : 0.75);

// Keep the view's shape that of the box, around the same centre.
function fitView(vb, svg) {
  const want = vb.w * boxRatio(svg);
  return Math.abs(vb.h - want) < 1e-6 ? vb : { ...vb, y: vb.y + (vb.h - want) / 2, h: want };
}

function attachPanZoom(svg, opt) {
  const clampW = (w) => Math.max(opt.minW, Math.min(opt.maxW || opt.full.w, w));
  const toMap = (cx, cy) => {
    const r = svg.getBoundingClientRect(); const vb = opt.get();
    return [vb.x + (cx - r.left) / r.width * vb.w, vb.y + (cy - r.top) / r.height * vb.h];
  };
  const zoomAt = (mx, my, w) => {
    const vb = opt.get(); w = clampW(w);
    opt.set({ x: mx - (mx - vb.x) * w / vb.w, y: my - (my - vb.y) * w / vb.w, w, h: w * boxRatio(svg) });
  };
  const zoomTo = (x, y, w) => { w = clampW(w); const hh = w * boxRatio(svg); opt.set({ x: x - w / 2, y: y - hh / 2, w, h: hh }); };
  const ptrs = new Map();
  let start = null; let moved = false; let lastTap = null;
  svg.addEventListener('pointerdown', (ev) => {
    if (!ptrs.size) moved = false;
    ptrs.set(ev.pointerId, [ev.clientX, ev.clientY]);
    start = { vb: { ...opt.get() }, ptrs: new Map(ptrs) };
  });
  svg.addEventListener('pointermove', (ev) => {
    if (!ptrs.has(ev.pointerId) || !start) return;
    ptrs.set(ev.pointerId, [ev.clientX, ev.clientY]);
    const r = svg.getBoundingClientRect();
    if (ptrs.size === 1 && start.ptrs.size === 1) {
      const [sx, sy] = [...start.ptrs.values()][0];
      if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 6) return;
      if (!moved) { moved = true; svg.setPointerCapture(ev.pointerId); }
      const dx = (ev.clientX - sx) / r.width * start.vb.w; const dy = (ev.clientY - sy) / r.height * start.vb.h;
      opt.set({ ...start.vb, x: start.vb.x - dx, y: start.vb.y - dy });
    } else if (ptrs.size === 2 && start.ptrs.size === 2) {
      moved = true;
      const [a, b] = [...ptrs.values()]; const [a0, b0] = [...start.ptrs.values()];
      const k = Math.hypot(a0[0] - b0[0], a0[1] - b0[1]) / (Math.hypot(a[0] - b[0], a[1] - b[1]) || 1);
      const cx = start.vb.x + ((a0[0] + b0[0]) / 2 - r.left) / r.width * start.vb.w;
      const cy = start.vb.y + ((a0[1] + b0[1]) / 2 - r.top) / r.height * start.vb.h;
      const w = clampW(start.vb.w * k);
      // Follow the fingers' midpoint as well as their spread.
      const ratio = boxRatio(svg);
      const mx = ((a[0] + b[0]) / 2 - r.left) / r.width * w; const my = ((a[1] + b[1]) / 2 - r.top) / r.height * w * ratio;
      opt.set({ x: cx - mx, y: cy - my, w, h: w * ratio });
    }
  });
  const end = (ev) => {
    if (ev.type === 'pointerup' && ev.pointerType !== 'mouse' && !moved && ptrs.size === 1) {
      // Double tap on the map zooms in there.
      const now = Date.now();
      if (lastTap && now - lastTap.t < 320 && Math.hypot(ev.clientX - lastTap.x, ev.clientY - lastTap.y) < 30) {
        const [mx, my] = toMap(ev.clientX, ev.clientY); zoomAt(mx, my, opt.get().w / 2.5); lastTap = null;
      } else lastTap = { t: now, x: ev.clientX, y: ev.clientY };
    }
    ptrs.delete(ev.pointerId);
    start = ptrs.size ? { vb: { ...opt.get() }, ptrs: new Map(ptrs) } : null;
  };
  svg.addEventListener('pointerup', end);
  svg.addEventListener('pointercancel', end);
  // A drag that ends over a base must not select it.
  svg.addEventListener('click', (ev) => { if (moved) { ev.stopPropagation(); ev.preventDefault(); } }, true);
  svg.addEventListener('dblclick', (ev) => { ev.preventDefault(); const [mx, my] = toMap(ev.clientX, ev.clientY); zoomAt(mx, my, opt.get().w / 2.5); });
  svg.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    const [mx, my] = toMap(ev.clientX, ev.clientY);
    // Trackpad pinch comes as ctrl+wheel with small deltas; scale smoothly.
    zoomAt(mx, my, opt.get().w * Math.exp(Math.max(-0.5, Math.min(0.5, ev.deltaY * (ev.ctrlKey ? 0.012 : 0.0018)))));
  }, { passive: false });
  return { zoomAt, zoomTo };
}

// One redraw per frame, however many pointer events come in.
function frameThrottle(fn) {
  let queued = false;
  return () => { if (queued) return; queued = true; requestAnimationFrame(() => { queued = false; fn(); }); };
}

// An image that grows to full screen when held down (or tapped).
function zoomableImg(attrs, caption) {
  const img = h('img', { ...attrs, class: `${attrs.class || ''} zoomable`, draggable: 'false' });
  let timer = null;
  const open = () => {
    const close = () => { box.remove(); document.removeEventListener('keydown', onKey); };
    const onKey = (ev) => { if (ev.key === 'Escape') close(); };
    const box = h('div', { class: 'lightbox', role: 'dialog', 'aria-label': attrs.alt || 'Bild', onclick: close },
      h('img', { src: attrs.src, alt: attrs.alt || '' }),
      caption ? h('div', { class: 'lightbox-cap', onclick: (ev) => ev.stopPropagation() }, caption) : null,
      h('button', { class: 'lightbox-x', type: 'button', 'aria-label': 'Stäng', onclick: close }, '×'));
    document.body.appendChild(box);
    document.addEventListener('keydown', onKey);
  };
  img.addEventListener('pointerdown', () => { timer = setTimeout(() => { timer = null; open(); }, 380); });
  const cancel = () => { if (timer) { clearTimeout(timer); timer = null; } };
  img.addEventListener('pointerup', cancel); img.addEventListener('pointerleave', cancel); img.addEventListener('pointercancel', cancel);
  img.addEventListener('contextmenu', (ev) => ev.preventDefault());
  img.addEventListener('click', (ev) => { ev.stopPropagation(); open(); });
  return img;
}

async function viewForces() {
  const loaded = await loadForcesView();
  if (!loaded) {
    return frag(h('header', { class: 'page-head' }, h('div', null, h('h1', { class: 'title-xl' }, 'Styrkor'))),
      forcesSeg(false), emptyState('Ingen lägesbild ännu. Den görs varje natt efter morgonrapporten kl. 04.'));
  }
  const { land, bases, byId, data, cat } = loaded;
  let vb = forcesUi.vb || { ...FULL };
  let { query, branch, onlyHit } = forcesUi;
  // The chosen base by id: the bases are new objects after each load.
  let selected = forcesUi.selected ? byId.get(forcesUi.selected) || null : null;

  const svg = svgEl('svg', { class: 'fmap', role: 'img', 'aria-label': 'Karta över ryska baser' });
  const lands = landLayers(land, (c) => (c.name === 'Russia' || c.name === 'Belarus' ? 'ru' : c.name === 'Sweden' ? 'se' : ''), () => redraw());
  const landG = lands.g;
  // Names under the bases, so a name never covers a base or takes its tap.
  const placesG = svgEl('g', { class: 'fplaces' });
  const labelsG = svgEl('g', { class: 'flabels' });
  const ptsG = svgEl('g');
  svg.append(landG, placesG, labelsG, ptsG);

  const search = h('input', { type: 'search', class: 'fsearch', placeholder: 'Sök: Su, Su-34, Iskander, S-400, marin …', autocomplete: 'off', enterkeyhint: 'search' });
  const sugg = h('div', { class: 'chips fsugg' });
  const chips = h('div', { class: 'chips fchips' });
  const info = h('p', { class: 'small muted' });
  const detail = h('div');
  const list = h('div');

  const matches = () => {
    const q = fnorm(query);
    return bases.filter((b) => (!branch || b.branch === branch) && (!onlyHit || b.status === 'anfallen')
      && (!q || b.hay.some((t) => t.includes(q))));
  };

  // Equipment, units and branches that match what is typed, with counts.
  function suggestions(hit) {
    const q = fnorm(query);
    if (!q) return [];
    const count = new Map();
    for (const b of hit) for (const t of b.equipment) if (fnorm(t).includes(q)) count.set(t, (count.get(t) || 0) + 1);
    return [...count].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 12);
  }

  const MIN_W = FULL.w / 300;
  const redraw = frameThrottle(() => draw());
  const pz = attachPanZoom(svg, { get: () => vb, set: (v) => { vb = v; redraw(); }, full: FULL, minW: MIN_W });
  const zoomTo = (x, y, w) => { pz.zoomTo(x, y, w); };
  const mini = miniMap(land, FULL, (x, y) => zoomTo(x, y, vb.w));
  const EUROPE = () => zoomTo(FX(36), FY(56), FX(68) - FX(4));

  function draw() {
    vb = fitView(vb, svg);
    Object.assign(forcesUi, { vb, query, branch, onlyHit, selected: selected?.id || null });
    svg.setAttribute('viewBox', `${vb.x} ${vb.y} ${vb.w} ${vb.h}`);
    const hit = matches();
    // Sizes in screen pixels: px is map units per pixel.
    const px = vb.w / (svg.clientWidth || 360);
    lands.update(vb, px);
    mini.update(vb);
    mapPlaces(placesG, px, vb);
    ptsG.replaceChildren(); labelsG.replaceChildren();
    // Bases closer than ~30 px on screen gather into a group; the groups
    // come apart as you zoom in.
    const cell = px * 44;
    const groups = new Map();
    const pad = px * 40;
    for (const b of hit) {
      if (b.x < vb.x - pad || b.x > vb.x + vb.w + pad || b.y < vb.y - pad || b.y > vb.y + vb.h + pad) continue;
      const k = `${Math.floor(b.x / cell)}:${Math.floor(b.y / cell)}`;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(b);
    }
    const singles = []; const groupBoxes = [];
    for (const g of groups.values()) {
      if (g.length === 1 || vb.w <= MIN_W * 1.01) { singles.push(...g); continue; }
      const x = g.reduce((s2, b) => s2 + b.x, 0) / g.length; const y = g.reduce((s2, b) => s2 + b.y, 0) / g.length;
      const r = px * (9 + Math.sqrt(g.length) * 2.2);
      groupBoxes.push([x - r, y - r, x + r, y + r]);
      const node = svgEl('g', { class: `fclu${g.some((b) => b.status === 'anfallen') ? ' hit' : ''}`, tabindex: '0', role: 'button',
        'aria-label': `${g.length} baser, zooma in` });
      node.append(svgEl('circle', { cx: x, cy: y, r }), svgEl('text', { x, y: y + px * 4, 'font-size': px * 11 }, String(g.length)));
      node.addEventListener('click', () => zoomTo(x, y, Math.max(MIN_W, vb.w / 3)));
      ptsG.appendChild(node);
    }
    // Labels where they fit: the chosen base first, then attacked ones,
    // then those with known forces; never over another base or label.
    const rank = (b) => (b === selected ? 0 : b.status === 'anfallen' ? 1 : (b.curated || b.db_id) ? 2 : 3);
    const boxes = [...groupBoxes, ...singles.map((b) => [b.x - px * 7, b.y - px * 7, b.x + px * 7, b.y + px * 7])];
    const free = (bx) => !boxes.some((o) => bx[0] < o[2] && bx[2] > o[0] && bx[1] < o[3] && bx[3] > o[1]);
    const labelled = new Set();
    for (const b of [...singles].sort((a, c) => rank(a) - rank(c))) {
      if (labelled.size >= 80) break;
      const w = px * (b.name.length * 6.4 + 4); const x0 = b.x + px * 9; const y0 = b.y - px * 7;
      const bx = [x0, y0, x0 + w, y0 + px * 14];
      if (!free(bx)) continue;
      boxes.push(bx); labelled.add(b);
      labelsG.appendChild(svgEl('text', { class: 'flab', x: x0, y: b.y + px * 4, 'font-size': px * 11.5, 'stroke-width': px * 3 }, b.name));
    }
    for (const b of singles) {
      const [, letter, colour] = FORCE_BRANCH[b.branch] || ['', '?', '#555'];
      const node = svgEl('g', { class: `fpt${b.status === 'anfallen' ? ' hit' : ''}${b === selected ? ' sel' : ''}${b.curated || b.db_id ? ' cur' : ''}`,
        tabindex: '0', role: 'button', 'aria-label': b.name });
      // A larger invisible circle makes the base easy to hit with a finger.
      node.append(svgEl('circle', { class: 'fhit', cx: b.x, cy: b.y, r: px * 14 }),
        svgEl('circle', { cx: b.x, cy: b.y, r: px * (b.curated || b.db_id ? 7 : 5), fill: colour }));
      if (b.curated || b.db_id) node.append(svgEl('text', { x: b.x, y: b.y + px * 3.3, 'font-size': px * 8.5 }, letter));
      node.addEventListener('click', () => select(b));
      ptsG.appendChild(node);
    }
    info.textContent = `${hit.length} av ${bases.length} baser · tryck på en grupp eller dubbeltryck för att zooma in`;
    const sg = suggestions(hit);
    sugg.replaceChildren(...sg.map(([t, n]) => h('button', { class: 'chip', type: 'button', onclick: () => { query = t; search.value = t; draw(); } }, `${t} · ${n}`)));
    list.replaceChildren(fnorm(query) && hit.length <= 40 ? h('div', { class: 'card list' }, hit.map((b) =>
      h('button', { class: 'row rowbtn', type: 'button', onclick: () => select(b) },
        h('span', { class: `fdot ${b.status}` }),
        h('span', { class: 'row-main' }, h('span', { class: 'row-title' }, b.name),
          h('span', { class: 'row-sub' }, [FORCE_BRANCH[b.branch]?.[0], b.equipment.join(', ')].filter(Boolean).join(' · '))),
        chevRight()))) : '');
    chips.replaceChildren(
      ...Object.entries(FORCE_BRANCH).map(([k, [label]]) => h('button', { class: 'chip', type: 'button', 'aria-pressed': String(branch === k),
        onclick: () => { branch = branch === k ? null : k; draw(); } }, label)),
      h('button', { class: 'chip', type: 'button', 'aria-pressed': String(onlyHit), onclick: () => { onlyHit = !onlyHit; draw(); } }, 'Anfallna'));
  }

  function select(b, zoom = true) {
    selected = b;
    if (zoom && vb.w > FULL.w / 12) zoomTo(b.x, b.y, FULL.w / 16); else draw();
    const events = [...b.events].sort((a, c) => (a.date < c.date ? 1 : -1));
    const changes = [...b.changes].sort((a, c) => (a.date < c.date ? 1 : -1));
    const orig = b.original || { units: [], equipment: [] };
    const same = (x, y) => x.length === y.length && x.every((t) => y.includes(t));
    const changed = !same(orig.units, b.units) || !same(orig.equipment, b.equipment);
    const otherBase = (id) => byId.get(id)?.name || id;
    const age = ageNote([b.updated, statusDate(b.status_as_of)].filter(Boolean).sort().pop());
    detail.replaceChildren(h('section', { class: 'card card-pad fdetail' },
      h('div', { class: 'coa-head-row' },
        h('span', { class: `fstatus ${b.status}`, style: age?.stale ? 'opacity:.55' : null }, FORCE_STATUS[b.status]),
        age ? h('span', { class: 'small muted' }, age.text) : null),
      h('h2', { class: 'coa-title' }, b.name, b.name_ru ? h('span', { class: 'small muted' }, ` · ${b.name_ru}`) : null),
      h('p', { class: 'small muted' }, [FORCE_BRANCH[b.branch]?.[0], COUNTRY_FORCES[b.country] || countryName(b.country), b.military_district,
        `${b.lat.toFixed(2)}° N, ${b.lon.toFixed(2)}° E`].filter(Boolean).join(' · ')),
      b.image?.file ? h('figure', { class: 'ffig' }, zoomableImg({ class: 'fimg', src: `/forces/img/${b.image.file}`, alt: b.name, loading: 'lazy' },
        `${b.name} · Bild: ${latin(b.image.author) || 'okänd'} · ${b.image.license || ''}`),
        h('figcaption', { class: 'small muted' }, `Bild: ${latin(b.image.author) || 'okänd'} · ${b.image.license || ''} · `,
          b.image.source_url ? externalButton(b.image.source_url, { outlet: 'Wikimedia Commons' }, 'Wikimedia Commons') : null)) : null,
      b.description_sv ? h('p', { class: 'body-sm' }, b.description_sv) : null,
      b.units.length ? h('div', null, h('h3', { class: 'fsub' }, 'Förband nu'), h('div', { class: 'chips' }, b.units.map((t) => {
        const uid = unitFor(cat, t);
        return uid ? h('a', { class: 'chip', href: `#/styrkor?unit=${encodeURIComponent(uid)}` }, t) : h('span', { class: 'chip static' }, t);
      }))) : null,
      b.equipment.length ? h('div', null, h('h3', { class: 'fsub' }, 'Materiel'), h('div', { class: 'chips' }, b.equipment.map((t) => {
        const sid = systemFor(cat, t, b.system_ids || []);
        return sid ? h('a', { class: 'chip', href: `#/styrkor?sys=${encodeURIComponent(sid)}` }, t)
          : h('button', { class: 'chip', type: 'button', onclick: () => { query = t; search.value = t; draw(); } }, t);
      }))) : null,
      changed ? h('p', { class: 'small muted' }, h('b', null, 'Ursprungligt underlag: '),
        [orig.units.join(', '), orig.equipment.join(', ')].filter(Boolean).join(' · ') || 'inget') : null,
      changes.length ? h('div', null, h('h3', { class: 'fsub' }, 'Ändringar i styrkan'),
        h('ul', { class: 'coa-signs' }, changes.map((c) => h('li', { class: 'coa-sign part' }, h('i'),
          h('span', null, h('b', null, `${dateShort(c.date)}: ${forceChangeText(c)}`),
            c.to_base ? ` → ${otherBase(c.to_base)}` : '', c.from_base ? ` (från ${otherBase(c.from_base)})` : '',
            h('br'), c.text_sv, ' ', forceSources(c.sources)))))) : null,
      events.length ? h('div', null, h('h3', { class: 'fsub' }, 'Anfall och uppföljningar'),
        h('ul', { class: 'coa-signs' }, events.map((e) => h('li', { class: `coa-sign ${e.kind === 'anfallen' ? 'obs' : 'part'}` },
          h('i'), h('span', null, h('b', null, `${dateShort(e.date)} ${e.date.slice(0, 4)}${e.kind === 'uppföljning' ? ', uppföljning' : ''}: `), e.text_sv,
            firmsLine(e.firms),
            ' ', forceSources(e.sources), e.kind === 'anfallen' ? [' ', firmsButton(b.lat, b.lon, e.date)] : null))))) : null,
      surveyBlock(b.survey),
      !b.curated && !b.units.length && !b.equipment.length && !(b.survey && b.survey.summary_sv)
        ? h('p', { class: 'small muted' }, b.survey ? 'Bara position och typ är kända: Wikipedia har ingen artikel om basen.' : 'Bara position och typ är kända än. Veckosökningen läser basens Wikipedia-artikel inom en vecka.') : null,
      b.status_sv ? statusLine('Grunddata: ', `${b.status_sv}. Från öppna källor, inte verifierat.`, b.status_as_of) : null,
      (b.sources || []).length ? h('div', { class: 'chips' }, b.sources.map((s) => externalButton(s.url, { outlet: s.outlet, date: s.accessed }, s.outlet || 'Källa'))) : null,
      b.source ? externalButton(b.source, { outlet: 'Wikidata' }, 'Wikidata') : null));
    if (zoom) detail.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  search.value = query;
  search.addEventListener('input', () => { query = search.value; draw(); });
  const centre = () => [vb.x + vb.w / 2, vb.y + vb.h / 2];
  const tools = h('div', { class: 'fmap-tools' },
    h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Zooma in', onclick: () => zoomTo(...centre(), vb.w / 1.6) }, '+'),
    h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Zooma ut', onclick: () => zoomTo(...centre(), vb.w * 1.6) }, '−'),
    h('button', { class: 'chip', type: 'button', onclick: EUROPE }, 'Europa'),
    h('button', { class: 'chip', type: 'button', onclick: () => zoomTo(FULL.x + FULL.w / 2, FULL.y + FULL.h / 2, FULL.w) }, 'Hela kartan'));
  if (selected) select(selected, false); else draw();
  requestAnimationFrame(() => draw());

  // The latest night: what was found, each base a tap away.
  const night = (data.nights || []).at(-1);
  const baseBtn = (id) => { const b = byId.get(id); return b ? h('a', { href: '#/styrkor', onclick: (ev) => { ev.preventDefault(); select(b); } }, b.name) : id; };
  const nightRows = night ? [
    ...night.attacks.map((e) => h('li', { class: 'coa-sign obs' }, h('i'), h('span', null, h('b', null, 'Anfall: '), baseBtn(e.base), ` (${dateShort(e.date)}). `, e.text_sv, ' ', forceSources(e.sources)))),
    ...night.follow_ups.map((e) => h('li', { class: 'coa-sign part' }, h('i'), h('span', null, h('b', null, 'Uppföljning: '), baseBtn(e.base), '. ', e.text_sv, ' ', forceSources(e.sources)))),
    ...night.changes.map((c) => h('li', { class: 'coa-sign part' }, h('i'), h('span', null, h('b', null, `${forceChangeText(c)}: `), baseBtn(c.base),
      c.to_base ? [' → ', baseBtn(c.to_base)] : '', '. ', c.text_sv, ' ', forceSources(c.sources)))),
    ...night.other.map(otherStrikeRow),
  ] : [];
  // The week's other strikes, the latest night's already above.
  const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  const otherWeek = (data.nights || []).slice(0, -1).filter((n) => n.date >= weekAgo).reverse().flatMap((n) => n.other || []);
  const counts = { anfallen: 0, aktiv: 0, 'okänd': 0 };
  for (const b of bases) counts[b.status] += 1;

  return frag(
    h('header', { class: 'page-head' }, h('div', null,
      h('div', { class: 'kicker' }, `Lägesbild ${dateShort(data.date)}`),
      h('h1', { class: 'title-xl' }, 'Ryska styrkor'))),
    forcesSeg(false),
    night ? h('section', { class: 'card card-pad' },
      h('h2', { class: 'fsub' }, `Senaste dygnet (natten till ${dateShort(night.date)})`),
      night.summary_sv ? h('p', { class: 'body-sm' }, night.summary_sv) : null,
      nightRows.length ? h('ul', { class: 'coa-signs' }, nightRows) : h('p', { class: 'small muted' }, 'Inget nytt rapporterat om baserna eller styrkorna.')) : null,
    otherWeek.length ? h('section', { class: 'card card-pad' },
      h('h2', { class: 'fsub' }, 'Andra anfall i Ryssland och ockuperade områden, senaste veckan'),
      h('p', { class: 'small muted' }, 'Raffinaderier, depåer, fabriker, hamnar och andra mål utanför baslistan. Satellitkartan visar NASA:s brandpunkter på platsen dagen för anfallet och dagen efter.'),
      h('ul', { class: 'coa-signs' }, otherWeek.map(otherStrikeRow))) : null,
    h('p', { class: 'small muted' }, `${bases.length} baser: ${counts.anfallen} anfallna senaste 30 dagarna, ${counts.aktiv} med kända förband, ${counts['okänd']} bara position.`),
    search, sugg, chips,
    h('div', { class: 'fmap-wrap card' }, svg, tools, mini.svg),
    h('div', { class: 'flegend small muted' },
      Object.values(FORCE_BRANCH).map(([label, letter, colour]) => h('span', null, h('b', { class: 'fdot', style: `background:${colour}` }, letter), label)),
      h('span', null, h('b', { class: 'fdot anfallen' }), 'Anfallen senaste 30 dagarna')),
    info, detail, list,
    h('p', { class: 'notice' }, 'Uppdateras varje natt efter morgonrapporten. AI läser senaste dygnets öppna rapportering (inte rysk statsmedia) och noterar anfall mot baser, uppföljningar och ändringar i förband och materiel, alltid med källa. ',
      'Baspositioner från Wikidata och grunddatabasen; förband och materiel utgår från öppna källor (Wikipedia, ukrainska och västliga medier). Tryck på ett förband eller ett system för mer. Bilder från Wikimedia Commons under fri licens. Inte verifierat. Påverkar inte index.'));
}

// ---------------------------------------------------------------- strike map (Version 3.13)
// Russia's air attacks on Ukraine, night by night, from the Kaggle dataset
// built on the Ukrainian Air Force's reports (src/strikes.py). Schematic:
// a curved trail from each launch area to each target region, coloured by
// weapon kind and as wide as the number launched. The real flight paths
// are not in the data.
const STRIKE_KIND = { 'drönare': ['Drönare', '#C2410C'], kryssningsrobot: ['Kryssningsrobotar', '#7C3AED'], 'ballistisk robot': ['Ballistiska robotar', '#B91C1C'], 'övrigt': ['Övrigt', '#6B7280'] };
const strikesUi = { date: null, kind: null, vb: null };

// The weapon catalogue (webapp/public/forces/systems.json): pictures and
// performance. Missing until the database is in; the cards then show text.
let systemsCat = null;
async function loadSystems() {
  if (!systemsCat) {
    try {
      const r = await fetch('/forces/systems.json');
      const j = r.ok ? await r.json() : [];
      systemsCat = new Map((Array.isArray(j) ? j : j.systems || []).map((x) => [x.id, x]));
    } catch { systemsCat = new Map(); }
  }
  return systemsCat;
}

function weaponCard(id, sys, rows) {
  const launched = rows.reduce((n, r) => n + (r.launched || 0), 0);
  const name = sys?.name || rows[0]?.model || id;
  const img = sys?.image?.file ? (sys.image.file.startsWith('/') ? sys.image.file : `/forces/img/${sys.image.file}`) : null;
  const figures = Object.entries(sys?.key_figures || {});
  const more = h('div', { class: 'swmore', hidden: true },
    sys?.description_sv ? h('p', { class: 'body-sm' }, sys.description_sv) : h('p', { class: 'small muted' }, 'Ingen beskrivning än.'),
    figures.length ? h('dl', { class: 'swfig' }, figures.flatMap(([k, v]) => [h('dt', null, k), h('dd', null, v)])) : null,
    sys?.image ? h('p', { class: 'small muted' }, `Bild: ${latin(sys.image.author) || 'okänd'}, ${sys.image.license || ''}. `,
      sys.image.source_url ? externalButton(sys.image.source_url, { outlet: 'Wikimedia Commons' }, 'Commons') : null) : null);
  const toggle = () => { more.hidden = !more.hidden; };
  return h('div', { class: 'swcard card', role: 'button', tabindex: '0', onclick: toggle, onkeydown: (ev) => { if (ev.key === 'Enter') toggle(); } },
    img ? zoomableImg({ src: img, alt: name, loading: 'lazy' }, sys?.image ? `${name} · Bild: ${latin(sys.image.author) || 'okänd'} · ${sys.image.license || ''}` : name) : h('div', { class: 'swnoimg' }, name.slice(0, 2)),
    h('div', { class: 'swbody' },
      h('div', { class: 'row-title' }, name),
      h('div', { class: 'small muted' }, [sys?.category_sv, launched ? `${launched} avfyrade` : null].filter(Boolean).join(' · ')),
      figures.slice(0, 2).map(([k, v]) => h('div', { class: 'small' }, h('b', null, `${k}: `), v)),
      more));
}

async function viewStrikes() {
  const [land, data, systems] = await Promise.all([
    forcesLand || fetch('/forces/countries.json').then((r) => { if (!r.ok) throw new Error(`countries: ${r.status}`); return r.json(); }),
    loadStrikes(), loadSystems()]);
  forcesLand = land;
  const head = h('header', { class: 'page-head' }, h('div', null,
    h('div', { class: 'kicker' }, data ? `Uppdaterad ${dateShort(data.date)}` : 'Anfall mot Ukraina'),
    h('h1', { class: 'title-xl' }, 'Ryska styrkor')));
  if (!data || !data.days.length) return frag(head, forcesSeg(true), emptyState('Inga anfallsdata ännu. De hämtas varje morgon efter rapporten kl. 04.'));

  let day = data.days.find((d) => d.date === strikesUi.date) || data.days[0];
  let kind = strikesUi.kind;
  const view = { x: FX(21), y: FY(57.5), w: FX(50) - FX(21), h: FY(42.5) - FY(57.5) };
  const svg = svgEl('svg', { class: 'fmap smap', role: 'img', 'aria-label': 'Karta över nattens anfall', viewBox: `${view.x} ${view.y} ${view.w} ${view.h}` });
  const lands = landLayers(land.countries, (c) => (c.name === 'Russia' || c.name === 'Belarus' ? 'ru' : c.name === 'Ukraine' ? 'ua' : ''), () => redraw());
  const landG = lands.g;
  const placesG = svgEl('g', { class: 'fplaces' });
  const trailsG = svgEl('g');
  svg.append(landG, placesG, trailsG);
  let vb = strikesUi.vb || { ...view };
  let u = vb.w / 100;
  const redraw = frameThrottle(() => draw());
  const pz = attachPanZoom(svg, { get: () => vb, set: (v) => { vb = v; redraw(); }, full: view, minW: view.w / 12, maxW: view.w * 1.6 });
  const nights = h('div', { class: 'chips seg-tight' });
  const kinds = h('div', { class: 'chips' });
  const totals = h('div', { class: 'stotals' });
  const prelim = h('div');
  const list = h('div');
  const weapons = h('div');

  function draw() {
    vb = fitView(vb, svg);
    Object.assign(strikesUi, { date: day.date, kind, vb });
    svg.setAttribute('viewBox', `${vb.x} ${vb.y} ${vb.w} ${vb.h}`);
    u = vb.w / 100;
    lands.update(vb, vb.w / (svg.clientWidth || 360));
    mapPlaces(placesG, vb.w / (svg.clientWidth || 360), vb);
    trailsG.replaceChildren();
    const rows = day.rows.filter((r) => !kind || r.kind === kind);
    const launches = new Map(); const targets = new Map();
    // The Air Force's report often splits one attack over rows: one with
    // the launch areas and target "Ukraine", regional ones with the target
    // regions and no launch area. Within a night and weapon kind, a row
    // missing one side takes the other rows' places - drawn as inferred.
    const byKind = {};
    for (const r of rows) {
      const k = byKind[r.kind] ||= { from: new Map(), to: new Map() };
      for (const a of r.from) k.from.set(a.name, a);
      for (const b of r.to) k.to.set(b.name, b);
    }
    rows.forEach((r, i) => {
      const inferred = !r.from.length || !r.to.length;
      r = { ...r, from: r.from.length ? r.from : [...byKind[r.kind].from.values()], to: r.to.length ? r.to : [...byKind[r.kind].to.values()] };
      const colour = (STRIKE_KIND[r.kind] || STRIKE_KIND['övrigt'])[1];
      const width = u * (0.15 + Math.min(0.7, Math.sqrt((r.launched || 1) / Math.max(1, r.from.length * Math.max(1, r.to.length))) * 0.06));
      for (const b of r.to) targets.set(b.name, b);
      for (const a of r.from) {
        launches.set(a.name, a);
        // No target region in the report: a short fading trail pointing
        // into Ukraine, not a line to a made-up target.
        if (!r.to.length) {
          const [x1, y1] = [FX(a.lon), FY(a.lat)];
          const [ux, uy] = [FX(31.4), FY(49.0)];
          const k = Math.min(0.55, (u * 22) / (Math.hypot(ux - x1, uy - y1) || 1));
          const d = `M${x1} ${y1}L${x1 + (ux - x1) * k} ${y1 + (uy - y1) * k}`;
          trailsG.append(svgEl('path', { d, class: 'strail open', stroke: colour, 'stroke-width': width, style: `animation-delay:${(i % 6) * 0.35}s` }));
          continue;
        }
        for (const b of r.to) {
          const [x1, y1, x2, y2] = [FX(a.lon), FY(a.lat), FX(b.lon), FY(b.lat)];
          const len = Math.hypot(x2 - x1, y2 - y1);
          const bend = (i % 2 ? 1 : -1) * len * 0.18;
          const cx = (x1 + x2) / 2 - (y2 - y1) / len * bend; const cy = (y1 + y2) / 2 + (x2 - x1) / len * bend;
          const d = `M${x1} ${y1}Q${cx} ${cy} ${x2} ${y2}`;
          trailsG.append(svgEl('path', { d, class: 'strail-bg', stroke: colour, 'stroke-width': width * 2.4 }),
            svgEl('path', { d, class: `strail${inferred ? ' inferred' : ''}`, stroke: colour, 'stroke-width': width, style: `animation-delay:${(i % 6) * 0.35}s` }));
        }
      }
    });
    for (const b of targets.values()) trailsG.append(svgEl('circle', { class: 'starget', cx: FX(b.lon), cy: FY(b.lat), r: u * 1.1 }));
    for (const a of launches.values()) {
      const [x, y] = [FX(a.lon), FY(a.lat)];
      trailsG.append(svgEl('path', { class: 'slaunch', d: `M${x} ${y - u * 1.2}L${x + u} ${y + u * 0.7}L${x - u} ${y + u * 0.7}Z` }),
        svgEl('text', { class: 'flab', x: x + u * 1.4, y: y + u * 0.4, 'font-size': u * 1.6, 'stroke-width': u * 0.4 }, a.name));
    }
    nights.replaceChildren(...data.days.map((d) => h('button', { class: 'chip', type: 'button', 'aria-pressed': String(d === day),
      title: d.preliminary ? 'Preliminär, ur nyhetsrubriker' : null,
      onclick: () => { day = d; draw(); } }, dateShort(d.date) + (d.preliminary ? '*' : ''))));
    // A night the dataset does not cover yet (it is updated about weekly):
    // read from news headlines quoting the Air Force, totals only.
    prelim.replaceChildren(day.preliminary ? h('p', { class: 'notice' },
      'Preliminär natt (*): siffrorna kommer ur nyhetsrubriker som citerar ukrainska flygvapnet och ersätts av den fullständiga rapporten när Kaggle-datasetet uppdateras. Startplatser och mål saknas ofta. ',
      ...(day.sources || []).slice(0, 4).map((src, i) => frag(i ? ', ' : 'Källor: ', externalButton(src.url, { outlet: src.outlet }, src.outlet || 'källa'))))
      : '');
    kinds.replaceChildren(...Object.entries(STRIKE_KIND).filter(([k]) => day.totals[k]).map(([k, [label, colour]]) =>
      h('button', { class: 'chip', type: 'button', 'aria-pressed': String(kind === k), onclick: () => { kind = kind === k ? null : k; draw(); } },
        h('b', { class: 'fdot', style: `background:${colour}` }), ` ${label}`)));
    totals.replaceChildren(...Object.entries(day.totals).map(([k, t]) => h('div', { class: 'stotal' },
      h('div', { class: 'stotal-n', style: `color:${(STRIKE_KIND[k] || STRIKE_KIND['övrigt'])[1]}` }, String(t.launched)),
      h('div', { class: 'small' }, (STRIKE_KIND[k] || STRIKE_KIND['övrigt'])[0]),
      h('div', { class: 'small muted' }, t.launched ? `${t.destroyed} nedskjutna (${Math.round(100 * t.destroyed / t.launched)} %)` : ''))));
    const ids = [...new Set(rows.flatMap((r) => r.systems || []))];
    weapons.replaceChildren(ids.length ? h('section', null, h('h2', { class: 'fsub' }, 'Vapnen den här natten'),
      h('div', { class: 'swgrid' }, ids.map((id) => weaponCard(id, systems.get(id), rows.filter((r) => (r.systems || []).includes(id)))))) : '');
    list.replaceChildren(h('div', { class: 'card list' }, rows.map((r) => h('div', { class: 'row' },
      h('b', { class: 'fdot', style: `background:${(STRIKE_KIND[r.kind] || STRIKE_KIND['övrigt'])[1]}` }),
      h('span', { class: 'row-main' },
        h('span', { class: 'row-title' }, `${r.launched ?? '?'} × ${r.model}`, r.destroyed != null ? h('span', { class: 'muted' }, ` · ${r.destroyed} nedskjutna`) : ''),
        h('span', { class: 'row-sub' }, `Från ${r.launch_place || 'okänt'}${r.carrier ? ` (${r.carrier})` : ''} → `
          + (r.unspecified ? 'mål ej angivet (hela Ukraina)' : (r.target_main || r.target || 'okänt'))
          + (r.hits != null ? ` · träff på ${r.hits} platser` : '') + (r.hidden ? ' · antal ej angivet' : '')))))));
  }
  draw();
  requestAnimationFrame(() => draw());

  return frag(head, forcesSeg(true),
    h('p', { class: 'hint' }, 'Natt för natt: vad Ryssland avfyrade mot Ukraina, varifrån och mot vilka regioner. Spåren är schematiska.'),
    nights, totals, prelim, kinds,
    h('div', { class: 'fmap-wrap card' }, svg, h('div', { class: 'fmap-tools' },
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Zooma in', onclick: () => pz.zoomTo(vb.x + vb.w / 2, vb.y + vb.h / 2, vb.w / 1.6) }, '+'),
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Zooma ut', onclick: () => pz.zoomTo(vb.x + vb.w / 2, vb.y + vb.h / 2, vb.w * 1.6) }, '−'),
      h('button', { class: 'chip', type: 'button', onclick: () => pz.zoomTo(view.x + view.w / 2, view.y + view.h / 2, view.w) }, 'Hela Ukraina'))),
    weapons,
    h('div', { class: 'flegend small muted' }, h('span', null, h('b', { class: 'slegend-launch' }), 'Avfyrningsområde'),
      h('span', null, h('b', { class: 'fdot starget-dot' }), 'Målregion'),
      h('span', null, h('b', { class: 'slegend-open' }), 'Mål ej angivet i rapporten'),
      h('span', null, h('b', { class: 'slegend-inf' }), 'Härlett: avfyrning och mål från olika rader i rapporten')),
    list,
    h('p', { class: 'notice' }, 'Källa: ukrainska flygvapnets dagliga rapporter, sammanställda i ', externalButton(data.source.url, { outlet: 'Kaggle' }, 'Kaggle-datasetet'),
      '. Visar de senaste 30 nätterna och uppdateras varje morgon. Siffrorna är Ukrainas egna och inte oberoende verifierade. Platserna är ungefärliga och spåren visar riktning, inte verklig flygväg. Påverkar inte index.'));
}

// ---------------------------------------------------------------- Karta
async function viewMap(q) {
  const period = ['7', '30', 'all'].includes(q.get('p')) ? q.get('p') : '7';
  const index = await loadIndex();
  ensureScope(index);
  if (!index.length) return emptyState('Inga rapporter ännu.');
  const reports = period === 'all' ? await loadAllReports()
    : await loadReportsRange(addDays(index[0].date, -(Number(period) - 1)), index[0].date);
  if (!reports.length) return emptyState('Inga rapporter ännu.');
  const ref = reports[0].date;
  const cutoff = period === 'all' ? '' : addDays(ref, -(Number(period) - 1));
  const byCountry = new Map();
  for (const r of reports) {
    if (cutoff && r.date < cutoff) continue;
    for (const e of r.events) {
      for (const c of new Set(e.countries)) {
        if (!byCountry.has(c)) byCountry.set(c, []);
        byCountry.get(c).push({ r, e });
      }
    }
  }
  const count = (c) => (byCountry.get(c) || []).length;
  // Heat is relative to the busiest country, so a long period does not
  // turn every tile the darkest shade.
  const maxCount = Math.max(1, ...[...byCountry.keys()].map(count));
  const heat = (n) => (n ? Math.max(1, Math.ceil((3 * n) / maxCount)) : 0);
  let sel = q.get('c');
  if (!sel) {
    sel = [...MAP_CODES].sort((a, b) => count(b) - count(a))[0];
  }
  const go = (p, c) => { history.replaceState(null, '', `#/karta?p=${p}&c=${encodeURIComponent(c)}`); route({ keepScroll: true }); };

  const tiles = MAP_LAYOUT.map((code) => {
    if (!code) return h('div', { 'aria-hidden': 'true' });
    const n = count(code);
    return h('button', {
      class: `tile${n ? ` h${heat(n)}` : ''}`, type: 'button', 'aria-pressed': String(code === sel),
      'aria-label': `${countryName(code)}, ${plural(n, 'händelse', 'händelser')}`,
      onclick: () => go(period, code),
    }, code, n ? h('span', { class: 'count', 'aria-hidden': 'true' }, String(n)) : null);
  });
  const outside = [...byCountry.keys()].filter((c) => !MAP_CODES.has(c)).sort((a, b) => count(b) - count(a));
  const selEvents = (byCountry.get(sel) || []).sort((a, b) => (a.r.date < b.r.date ? 1 : -1));

  return frag(
    h('header', { class: 'page-head' },
      h('div', null,
        h('div', { class: 'kicker' }, period === 'all' ? 'Alla rapporter' : `Senaste ${period} dagarna`),
        h('h1', { class: 'title-xl' }, 'Karta')),
      h('div', { class: 'heat-legend', 'aria-hidden': 'true' },
        'Få',
        h('i', { style: 'background:var(--heat-1)' }),
        h('i', { style: 'background:var(--heat-2)' }),
        h('i', { style: 'background:var(--heat-3)' }),
        'Många')),
    h('div', { class: 'seg', role: 'group', 'aria-label': 'Period' },
      [['7', '7 dagar'], ['30', '30 dagar'], ['all', 'Allt']].map(([k, label]) => h('button', {
        type: 'button', 'aria-pressed': String(k === period), onclick: () => go(k, sel),
      }, label))),
    h('section', { class: 'card card-pad', 'aria-label': 'Schematisk karta, en ruta per land' },
      h('div', { class: 'map' }, tiles),
      h('p', { class: 'small muted', style: 'margin-top:6px' }, 'Schematisk – varje ruta är ett land i ungefärligt läge. Tryck på ett land.'),
      outside.length ? h('div', { class: 'chips', style: 'margin-top:4px' },
        h('span', { class: 'small muted', style: 'align-self:center' }, 'Utanför kartan:'),
        outside.map((c) => h('button', { class: 'chip', type: 'button', 'aria-pressed': String(c === sel), onclick: () => go(period, c) }, `${countryName(c)} ${count(c)}`))) : null),
    h('section', { class: 'section' },
      h('div', { style: 'display:flex;justify-content:space-between;align-items:baseline' },
        h('h2', { class: 'title-m' }, countryName(sel)),
        h('span', { class: 'small muted' }, selEvents.length ? plural(selEvents.length, 'händelse', 'händelser') : 'Inga händelser')),
      selEvents.length ? h('div', { class: 'card list' }, selEvents.map(({ r, e }) => h('a', { class: 'row', href: eventHref(r.date, e.id) },
        h('span', { class: 'small muted', style: 'width:46px;flex-shrink:0;font-weight:600' }, dateShort(r.date)),
        h('span', { class: 'row-main' },
          h('span', { class: 'row-title' }, e.title_sv || e.title),
          e.topics.length ? h('span', { class: 'row-sub' }, e.topics.join(' · ')) : null),
        stateBadge(eventState(r.date, e)),
        chevRight()))) : null));
}

// ---------------------------------------------------------------- Bedöm
// One card per news item (event) with at least one linked article. A swipe
// is the verdict on the news; it is written as one row per linked article,
// each source taking its own value when the operator set one with "Ändra".
const SKIP_KEY = 'hm.skippedEvents';
const SKIP_DAYS = 7;
function loadSkipped() {
  try {
    const raw = JSON.parse(localStorage.getItem(SKIP_KEY) || '{}');
    const cutoff = Date.now() - SKIP_DAYS * 86400000;
    return new Map(Object.entries(raw).filter(([, t]) => typeof t === 'number' && t > cutoff));
  } catch { return new Map(); }
}
function saveSkipped(map) { try { localStorage.setItem(SKIP_KEY, JSON.stringify(Object.fromEntries(map))); } catch { /* private mode */ } }
const assessHistory = []; // this session's verdicts, newest last, for "Ångra"

function linkedArticles(e) {
  const seen = new Set();
  return e.articles.filter((a) => a.id && a.url && hostOf(a.url) && !seen.has(a.id) && seen.add(a.id));
}

async function viewAssess(q) {
  if (!isAdmin()) return adminOnly();
  await assessmentsReady;
  const reports = [...await loadAllReports()].sort((a, b) => (a.date < b.date ? 1 : -1));
  const skipped = loadSkipped();
  const selected = parseFacets(q);
  const facetStart = reports.length ? addDays(reports[0].date, -(FACET_DAYS - 1)) : '';
  const facetBar = filterBar(topFacets(reports.filter((r) => r.date >= facetStart).flatMap((r) => r.events), selected), selected, setFacets);

  const isDone = (t) => {
    const cur = currentByArticle();
    return t.linked.every((a) => { const c = cur.get(a.id); return c && c.value !== 0; });
  };
  const seenEvents = new Set();
  let targets = [];
  let unlinkedOnly = 0;
  for (const r of reports) {
    const events = [...r.events].sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0));
    for (const e of events) {
      if (seenEvents.has(e.id) || !matchesFacets(e, selected)) continue;
      seenEvents.add(e.id);
      const linked = linkedArticles(e);
      if (!linked.length) { unlinkedOnly += 1; continue; }
      const t = { event: e, date: r.date, linked, unlinked: e.articles.filter((a) => !linked.includes(a)), favicons: r.favicons || {} };
      if (skipped.has(e.id) || isDone(t)) continue;
      targets.push(t);
    }
  }

  let overrides = new Map(); // article id -> own value, for the card on top
  const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  const counter = h('span', { class: 'small muted nowrap', 'aria-live': 'polite' });
  const stack = h('div', { class: 'stack ev-stack' });
  const undoBtn = h('button', { class: 'btn', type: 'button', onclick: undoLast }, 'Ångra');
  const buttonsBox = h('div');

  function commit(value, cardEl) {
    const t = targets.shift();
    if (!t) return;
    if (value === 'skip') {
      skipped.set(t.event.id, Date.now());
      saveSkipped(skipped);
      assessHistory.push({ target: t, skip: true });
    } else {
      const cur = currentByArticle();
      const rows = [];
      for (const a of t.linked) {
        const v = overrides.has(a.id) ? overrides.get(a.id) : value;
        const now = cur.get(a.id);
        if (now && now.value === v) continue; // already my verdict
        const at = { article: a, event: t.event, date: t.date };
        rows.push({ row: assess(at, v, now || null), at });
      }
      assessHistory.push({ target: t, rows });
    }
    overrides = new Map();
    vibrate();
    if (cardEl && !reduceMotion()) {
      const dx = value === 'skip' ? 0 : value > 0 ? 1 : -1;
      cardEl.style.transform = `translate(${dx * 520}px, ${value === 'skip' ? -700 : 40}px) rotate(${dx * 18}deg)`;
      cardEl.style.opacity = '0';
      setTimeout(() => renderStack(true), 220);
    } else {
      renderStack(true);
    }
  }

  // Takes the whole news item back: unsent rows are dropped, sent ones get
  // a withdrawal (value 0) superseding them, so the history stays intact.
  function undoLast() {
    const item = assessHistory.pop();
    if (!item) return;
    if (item.skip) {
      skipped.delete(item.target.event.id);
      saveSkipped(skipped);
    } else {
      for (const { row, at } of item.rows) {
        const latest = store.assessments.find((x) => x.id === row.id)
          || store.assessments.find((x) => x.client_id && x.client_id === row.client_id)
          || row;
        undo(latest, at);
      }
    }
    targets = targets.filter((x) => x.event.id !== item.target.event.id);
    targets.unshift(item.target);
    overrides = new Map();
    renderStack(true);
  }

  function overrideControls(a) {
    const wrap = h('div', { class: 'srcp-foot' });
    let open = false;
    const previous = currentByArticle().get(a.id);
    const paint = () => {
      const v = overrides.get(a.id);
      wrap.replaceChildren(
        v != null
          ? h('span', { class: 'own' }, verdictPill(v), h('span', { class: 'small muted' }, ' egen bedömning'))
          : h('span', { class: 'small muted' }, previous && previous.value !== 0 ? `Tidigare: ${VERDICT[previous.value]}` : 'Får kortets bedömning'),
        h('button', {
          class: 'linkbtn', type: 'button', 'aria-expanded': String(open),
          onclick: (ev) => { ev.stopPropagation(); open = !open; paint(); },
        }, open ? 'Stäng' : 'Ändra'));
      if (open) {
        wrap.append(h('div', { class: 'mini-actions', role: 'group', 'aria-label': `Egen bedömning av ${a.outlet || 'källan'}` },
          ...STEPS.map((sv) => h('button', {
            class: `a-${sv}`, type: 'button', 'aria-pressed': String(overrides.get(a.id) === sv),
            onclick: (ev) => {
              ev.stopPropagation();
              if (overrides.get(a.id) === sv) overrides.delete(a.id); else overrides.set(a.id, sv);
              open = false;
              paint();
            },
          }, VERDICT[sv])),
          overrides.has(a.id) ? h('button', {
            class: 'a-skip', type: 'button',
            onclick: (ev) => { ev.stopPropagation(); overrides.delete(a.id); open = false; paint(); },
          }, 'Rensa') : null));
      }
    };
    paint();
    return wrap;
  }

  function card(t, behind, entering) {
    const e = t.event;
    const score = e.model_score != null ? e.model_score : e.score;
    const head = h('header', { class: 'ev-head' },
      h('span', { class: 'grip', 'aria-hidden': 'true' }),
      h('div', { class: 'kicker' }, [dateShort(t.date), ...e.topics].join(' · ')),
      h('h2', { class: 'sc-title' }, e.title_sv || e.title),
      h('div', { class: 'ev-meta' }, `Modellens poäng ${fmtScore(score)}/10 · ${plural(t.linked.length, 'källa', 'källor')} med länk`));
    if (behind) return h('article', { class: 'swipe-card ev-card behind', 'aria-hidden': 'true' }, head);

    const label = h('div', { class: 'drag-label', 'aria-hidden': 'true' });
    const body = h('div', { class: 'ev-body' },
      e.summary_sv || e.detail ? h('p', { class: 'ev-summary' }, e.summary_sv || e.detail) : null,
      h('h3', { class: 'kicker' }, 'Källor – tryck för att läsa originalet'),
      h('div', { class: 'srcp-list' }, t.linked.map((a) => sourcePreview(a, { date: t.date, favicons: t.favicons, footer: overrideControls(a) }))),
      t.unlinked.length ? h('div', { class: 'unlinked' },
        h('h3', { class: 'kicker' }, 'Utan länk'),
        h('p', { class: 'small muted' }, `${t.unlinked.map((a) => a.outlet).filter(Boolean).join(', ')} – bedöms inte.`)) : null,
      h('a', { class: 'linkbtn', href: eventHref(t.date, e.id) }, 'Öppna hela händelsen'));
    const el = h('article', { class: `swipe-card ev-card${entering && !reduceMotion() ? ' enter' : ''}`, 'aria-label': e.title_sv || e.title }, label, head, body);

    const handlers = {
      onDrag: (dx, dy) => {
        el.classList.add('dragging');
        el.style.transform = `translate(${dx}px, ${dy}px) rotate(${dx / 18}deg)`;
        const v = verdictFor(dx, dy, true);
        label.textContent = v != null ? VERDICT[v] : '';
        label.className = `drag-label${v != null ? ` show v-${v}` : ''}`;
      },
      onEnd: (dx, dy) => {
        el.classList.remove('dragging');
        const v = verdictFor(dx, dy, true);
        if (v == null) { el.style.transform = ''; label.className = 'drag-label'; return; }
        commit(v, el);
      },
    };
    // The header takes every direction (up = skip); the sources list only
    // horizontal drags, so scrolling it never skips the news by mistake.
    gesture(head, { mode: 'free', ...handlers });
    gesture(body, { mode: 'row', ...handlers });
    return el;
  }

  function renderStack(entering = false) {
    counter.textContent = targets.length ? plural(targets.length, 'nyhet kvar', 'nyheter kvar') : '';
    undoBtn.hidden = !assessHistory.length;
    if (!targets.length) {
      stack.replaceChildren(emptyState(selected.length ? `Allt inom ${selected.map(facetLabel).join(' + ')} är bedömt.` : 'Allt är bedömt.',
        h('a', { class: 'btn', href: '#/mina' }, 'Mina bedömningar'),
        skipped.size ? h('button', {
          class: 'btn', type: 'button',
          onclick: () => { skipped.clear(); saveSkipped(skipped); route(); },
        }, `Visa ${plural(skipped.size, 'överhoppad', 'överhoppade')} igen`) : null,
        unlinkedOnly ? h('p', { class: 'small muted' }, `${plural(unlinkedOnly, 'nyhet', 'nyheter')} saknar länk till källan och kan inte bedömas.`) : null));
      stack.style.height = 'auto';
      buttonsBox.replaceChildren();
      return;
    }
    stack.style.height = '';
    stack.replaceChildren(...(targets[1] ? [card(targets[1], true)] : []), card(targets[0], false, entering));
    buttonsBox.replaceChildren(verdictButtons((v) => commit(v, stack.lastChild),
      h('button', { class: 'a-skip', type: 'button', onclick: () => commit('skip', stack.lastChild) }, 'Hoppa över')));
  }

  renderStack();
  return frag(
    h('header', { class: 'page-head' },
      h('div', null, h('div', { class: 'kicker' }, 'Operatörsbedömning'), h('h1', { class: 'title-xl' }, 'Bedöm')),
      h('a', { class: 'head-link', href: '#/mina' }, 'Mina bedömningar')),
    facetBar,
    h('div', { style: 'display:flex;justify-content:space-between;align-items:center;gap:8px' },
      h('p', { class: 'hint' }, 'Bedöm nyheten utifrån källorna. Svep höger: trovärdig (längre: mycket). Vänster: tveksam (längre: inte trovärdig). Uppåt i rubriken: hoppa över.'),
      counter),
    stack,
    buttonsBox,
    h('div', { class: 'btn-row' }, undoBtn));
}

// ---------------------------------------------------------------- Mina bedömningar
const expanded = new Set();

function nextStep(value, dir) {
  if (!value) return dir === 'up' ? 1 : -1;
  const i = STEPS.indexOf(value);
  return STEPS[Math.max(0, Math.min(STEPS.length - 1, i + (dir === 'up' ? 1 : -1)))];
}

async function viewMine() {
  if (!isAdmin()) return adminOnly();
  await assessmentsReady;
  const reports = await loadAllReports();
  const events = new Map();
  const articles = new Map();
  for (const r of reports) {
    for (const e of r.events) {
      events.set(`${r.date}|${e.id}`, e);
      for (const a of e.articles) articles.set(a.id, a);
    }
  }
  const rows = [...currentByArticle().values()]
    .sort((a, b) => (a.report_date === b.report_date ? (a.ts < b.ts ? 1 : -1) : a.report_date < b.report_date ? 1 : -1));
  const groups = new Map();
  for (const r of rows) {
    if (!groups.has(r.report_date)) groups.set(r.report_date, []);
    groups.get(r.report_date).push(r);
  }

  const track = trackText((await trackRecords().catch(() => ({})))[store.me && store.me.email]);
  const head = frag(
    backLink('#/bedom', 'Bedöm'),
    h('header', null, h('div', { class: 'kicker' }, 'Operatörsbedömning'), h('h1', { class: 'title-xl' }, 'Mina bedömningar')),
    h('div', { class: 'card card-pad track' },
      h('p', { class: track ? 'track-main' : 'small' }, track ? `Din träffsäkerhet: ${track}` : 'Träffsäkerhet visas när utfall finns.'),
      h('p', { class: 'small muted' }, 'Jämför dina bedömningar med vad självkontrollen senare kom fram till. Visas bara – påverkar inte vikten ännu.')),
    h('p', { class: 'hint' }, 'Svep höger för att höja och vänster för att sänka ett steg. Håll kvar och svep uppåt för att återkalla. Tryck på pilen för historiken.'));
  if (!rows.length) return frag(head, emptyState('Inga bedömningar ännu.', h('a', { class: 'btn primary', href: '#/bedom' }, 'Börja bedöma')));

  return frag(head, [...groups.entries()].map(([date, list]) => h('section', { class: 'section' },
    h('h2', { class: 'kicker' }, dateLong(date)),
    h('div', { class: 'card list' }, list.map((row) => mineRow(row, events.get(`${row.report_date}|${row.event_id}`), articles.get(row.article_id)))))));
}

function mineRow(row, event, article) {
  const target = { article: { id: row.article_id, outlet: row.outlet }, event: { id: row.event_id }, date: row.report_date };
  const apply = (v) => {
    if (v === row.value) return;
    assess(target, v, row);
    vibrate();
  };
  const under = h('div', { class: 'under', 'aria-hidden': 'true' }, h('span'), h('span'));
  const isOpen = expanded.has(row.article_id);
  const toggle = h('button', {
    class: 'out-link', type: 'button', 'aria-expanded': String(isOpen), 'aria-label': 'Visa historik och knappar',
    onclick: () => { if (expanded.has(row.article_id)) expanded.delete(row.article_id); else expanded.add(row.article_id); rerender(); },
  }, chevDown());
  const rowEl = h('div', { class: 'row' },
    h('div', { class: 'row-main' },
      h('span', { class: 'row-title' }, row.outlet || (article && article.outlet) || 'Okänd källa'),
      h('span', { class: 'row-sub' }, event ? (event.title_sv || event.title) : row.event_id)),
    verdictPill(row.value, row.pending),
    toggle);
  const wrap = h('div', { class: 'swipe-row' }, under, rowEl);
  gesture(rowEl, {
    mode: 'row',
    holdForVertical: true,
    onHold: (on) => {
      wrap.classList.toggle('held', on);
      if (on) { vibrate(); paintUnder(under, 0, 1, 'Svep uppåt för att återkalla'); } else { paintUnder(under, null, 0); }
    },
    onDrag: (dx, dy, g) => {
      rowEl.classList.add('dragging');
      rowEl.style.transform = g.axis === 'v' ? `translateY(${Math.max(-24, dy / 6)}px)` : `translateX(${dx}px)`;
      const step = stepFor(dx, dy, g.held);
      if (step === 'withdraw') paintUnder(under, 0, 1, 'Återkalla');
      else if (step) { const v = nextStep(row.value, step); paintUnder(under, v, dx, v === row.value ? 'Redan högst/lägst' : `Ändra till ${VERDICT[v]}`); }
      else paintUnder(under, null, dx || 1, g.axis === 'v' ? 'Svep uppåt för att återkalla' : '');
    },
    onEnd: (dx, dy, g) => {
      rowEl.classList.remove('dragging');
      rowEl.style.transform = '';
      paintUnder(under, null, 0);
      const step = stepFor(dx, dy, g.held);
      if (step === 'withdraw') { if (row.value !== 0) apply(0); } else if (step) apply(nextStep(row.value, step));
    },
  });
  const chain = chainOf(row);
  const panel = isOpen ? h('div', { class: 'expand' },
    h('ol', { class: 'chain', 'aria-label': 'Historik, senaste först' }, chain.map((c) => h('li', null,
      h('span', { class: 'when' }, c.pending ? 'Väntar på uppladdning' : tsFmt(c.ts)),
      verdictPill(c.value, c.pending),
      c.operator && store.me && c.operator !== store.me.email ? h('span', { class: 'small muted' }, c.operator) : null,
      !c.pending ? h('span', { class: 'small muted' }, `#${String(c.id).slice(0, 8)}`) : null))),
    h('div', { class: 'btn-row' },
      h('button', { class: 'btn', type: 'button', onclick: () => apply(nextStep(row.value, 'down')) }, 'Sänk'),
      h('button', { class: 'btn', type: 'button', onclick: () => apply(nextStep(row.value, 'up')) }, 'Höj'),
      h('button', { class: 'btn', type: 'button', disabled: row.value === 0, onclick: () => apply(0) }, 'Återkalla'),
      event ? h('a', { class: 'btn', href: eventHref(row.report_date, row.event_id) }, 'Öppna händelsen') : null)) : null;
  return frag(wrap, panel);
}

// ---------------------------------------------------------------- Admin
const ADMIN_TABS = [['status', 'Status'], ['sources', 'Källor'], ['users', 'Användare'], ['notices', 'Meddelanden'], ['security', 'Säkerhet'], ['audit', 'Logg']];
const REASONS = [
  ['not_allowed', 'Ej behörig', 'Verifierad e-post som inte finns bland användarna'],
  ['invalid_jwt', 'Ogiltig inloggning', 'Förfalskad, utgången eller trasig inloggningsbiljett'],
  ['forbidden', 'Otillåten åtgärd', 'Rollen får inte göra detta, t.ex. läsare som bedömer'],
  ['bad_request', 'Felaktig data', 'Trasiga eller manipulerade anrop'],
  ['rate_limited', 'För många anrop', 'Anropsgränsen nåddes'],
  ['bad_origin', 'Fel ursprung', 'Ändring skickad från en annan webbplats'],
];
const REASON_SV = Object.fromEntries(REASONS.map(([k, l]) => [k, l]));
const ACTION_SV = {
  add_user: 'Lade till', user_add: 'Lade till', add: 'Lade till', reactivate: 'Återaktiverade', user_reactivate: 'Återaktiverade',
  role_change: 'Ändrade roll', set_role: 'Ändrade roll', user_role: 'Ändrade roll', change_role: 'Ändrade roll',
  deactivate: 'Tog bort', user_deactivate: 'Tog bort', remove_user: 'Tog bort', delete_user: 'Tog bort',
  notice: 'Skickade meddelande', notice_removed: 'Tog bort meddelande', alarm: 'Larm', alarm_cleared: 'Larm upphävt', seed: 'Startvärden',
  invite: 'Bjöd in', refresh: 'Uppdaterade alla appar', source: 'La till källa', source_removed: 'Tog bort källa',
};
const ROLE_SV = { admin: 'Administratör', reader: 'Läsare' };
const adminMsg = { text: '', error: false };

function rowsOf(body, key) { return Array.isArray(body) ? body : Array.isArray(body && body[key]) ? body[key] : Array.isArray(body && body.rows) ? body.rows : []; }
const whenFmt = (ts) => (ts ? tsFmt(ts) : '–');
const ago = (ts) => {
  if (!ts) return 'aldrig';
  const s = (Date.now() - new Date(ts).getTime()) / 1000;
  if (Number.isNaN(s)) return '–';
  if (s < 90) return 'nyss';
  if (s < 3600) return `${Math.round(s / 60)} min sedan`;
  if (s < 86400) return `${Math.round(s / 3600)} h sedan`;
  return tsFmt(ts);
};

async function viewAdmin(q) {
  if (!isAdmin()) return adminOnly();
  const tab = ADMIN_TABS.some(([k]) => k === q.get('s')) ? q.get('s') : 'status';
  let body;
  try {
    body = tab === 'users' ? await adminUsers()
      : tab === 'sources' ? await adminSources()
      : tab === 'notices' ? await adminNotices()
      : tab === 'security' ? await adminSecurity()
        : tab === 'status' ? await adminStatus()
          : await adminAudit();
  } catch (e) {
    if (e instanceof AuthError) throw e;
    body = h('div', { class: 'card card-pad' }, h('p', { class: 'small' }, `Kunde inte hämta: ${e.message || e}`),
      h('button', { class: 'btn', type: 'button', onclick: () => route({ keepScroll: true }) }, 'Försök igen'));
  }
  return frag(
    backLink('#/', 'Idag'),
    h('header', null, h('div', { class: 'kicker' }, 'Administration'), h('h1', { class: 'title-xl' }, 'Status')),
    h('div', { class: 'seg seg-tight', role: 'tablist', 'aria-label': 'Delar' },
      ADMIN_TABS.map(([k, label]) => h('button', {
        type: 'button', role: 'tab', 'aria-selected': String(k === tab), 'aria-pressed': String(k === tab),
        onclick: () => { adminMsg.text = ''; updateHash((qq) => qq.set('s', k)); },
      }, label))),
    adminMsg.text ? h('p', { class: `notice${adminMsg.error ? ' err' : ''}`, role: 'status' }, adminMsg.text) : null,
    body);
}

async function adminMutate(method, path, payload, okText) {
  try {
    await adminSend(method, path, payload);
    adminMsg.text = okText; adminMsg.error = false;
  } catch (e) {
    if (e instanceof AuthError) throw e;
    adminMsg.text = e instanceof OfflineError ? 'Ingen anslutning – ändringen gjordes inte.' : `Ändringen gjordes inte: ${e.message}`;
    adminMsg.error = true;
  }
  route({ keepScroll: true });
}

async function adminUsers() {
  const [usersBody, tracks] = await Promise.all([adminGet('/api/admin/users'), trackRecords().catch(() => ({}))]);
  const users = rowsOf(usersBody, 'users');
  const me = store.me && store.me.email;
  const isOwnerRow = (u) => u.is_owner === true || u.owner === true || (store.me && store.me.is_owner && u.email === me);
  const activeAdmins = users.filter((u) => u.active !== false && u.active !== 0 && u.role === 'admin');
  users.sort((a, b) => (Number(b.active !== false && b.active !== 0) - Number(a.active !== false && a.active !== 0))
    || (a.role === b.role ? 0 : a.role === 'admin' ? -1 : 1) || String(a.email).localeCompare(String(b.email)));

  const email = h('input', { id: 'nu-email', type: 'email', required: true, autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false', placeholder: 'namn@exempel.se', inputmode: 'email' });
  const role = h('select', { id: 'nu-role' }, h('option', { value: 'reader' }, 'Läsare – kan inte bedöma'), h('option', { value: 'admin' }, 'Administratör'));
  const invite = h('input', { id: 'nu-invite', type: 'checkbox', checked: true });
  const addForm = h('form', {
    class: 'card card-pad form',
    onsubmit: (ev) => {
      ev.preventDefault();
      const v = email.value.trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) { adminMsg.text = 'Skriv en giltig e-postadress.'; adminMsg.error = true; route({ keepScroll: true }); return; }
      adminMutate('POST', '/api/admin/users', { email: v, role: role.value, invite: invite.checked },
        `${v} har lagts till som ${ROLE_SV[role.value].toLowerCase()}.${invite.checked ? ' En inbjudan med länk och inloggning mejlas inom några minuter.' : ''}`);
    },
  },
  h('h2', { class: 'kicker' }, 'Lägg till användare'),
  h('label', { class: 'search-label', for: 'nu-email' }, 'E-postadress'), email,
  h('label', { class: 'search-label', for: 'nu-role' }, 'Roll'), role,
  h('div', { class: 'check-row' }, invite, h('label', { for: 'nu-invite' }, 'Mejla en inbjudan med länk och hur man loggar in')),
  h('button', { class: 'btn primary', type: 'submit' }, 'Lägg till'),
  h('p', { class: 'small muted' }, 'Personen loggar in med en engångskod till adressen. Inget lösenord. Inbjudan skickas från Macen, så den måste vara igång.'));

  const card = (u) => {
    const active = u.active !== false && u.active !== 0;
    const owner = isOwnerRow(u);
    const self = u.email === me;
    const lastAdmin = active && u.role === 'admin' && activeAdmins.length <= 1;
    const lockReason = owner ? 'Ägaren är alltid administratör och kan inte ändras eller tas bort.'
      : lastAdmin ? 'Sista administratören – lägg till en till innan du ändrar här.'
        : self ? 'Du kan inte ändra din egen roll eller ta bort dig själv.' : null;
    const n = u.assessments ?? u.assessment_count ?? u.assessments_count ?? u.n_assessments;
    const target = `/api/admin/users/${encodeURIComponent(u.email)}`;
    return h('div', { class: `ucard${active ? '' : ' inactive'}` },
      h('div', { class: 'ucard-top' },
        h('b', { class: 'uemail' }, u.email),
        h('span', { class: `pill ${u.role === 'admin' ? 'pill-admin' : ''}` }, ROLE_SV[u.role] || u.role),
        owner ? h('span', { class: 'pill pill-owner' }, 'Ägare') : null,
        active ? null : h('span', { class: 'pill pill-off' }, 'Borttagen')),
      h('p', { class: 'small muted' }, `Senast inne: ${ago(u.last_seen)}${n != null ? ` · ${plural(Number(n), 'bedömning', 'bedömningar')}` : ''}`),
      h('p', { class: 'small muted' },
        `Hemskärm: ${u.installed_at ? 'ja' : 'nej'}${u.platform ? ` · ${PLATFORM_SV[u.platform] || u.platform}` : ''}`,
        u.role === 'admin' ? ` · Träffsäkerhet: ${trackText(tracks[u.email]) || '–'}` : ''),
      active ? inviteLine(u) : null,
      lockReason ? h('p', { class: 'small lock' }, lockReason) : null,
      h('div', { class: 'btn-row' },
        active
          ? frag(
            u.last_seen ? null : h('button', {
              class: 'btn', type: 'button', disabled: u.invite_status === 'pending',
              onclick: () => adminMutate('POST', `${target}/invite`, {}, `En inbjudan till ${u.email} mejlas inom några minuter.`),
            }, u.invite_status ? 'Skicka inbjudan igen' : 'Skicka inbjudan'),
            h('button', {
              class: 'btn', type: 'button', disabled: !!lockReason,
              onclick: () => {
                const next = u.role === 'admin' ? 'reader' : 'admin';
                adminMutate('PATCH', target, { role: next }, `${u.email} är nu ${ROLE_SV[next].toLowerCase()}.`);
              },
            }, u.role === 'admin' ? 'Gör till läsare' : 'Gör till administratör'),
            h('button', {
              class: 'btn danger', type: 'button', disabled: !!lockReason,
              onclick: () => openSheet((close) => frag(
                h('h2', { class: 'title-m' }, `Ta bort ${u.email}?`),
                h('p', { class: 'small' }, 'Personen kommer inte längre in i appen. Historik och bedömningar sparas, och personen kan läggas till igen.'),
                h('div', { class: 'sheet-actions' },
                  h('button', { class: 'btn', type: 'button', autofocus: true, onclick: close }, 'Avbryt'),
                  h('button', { class: 'btn danger', type: 'button', onclick: () => { close(); adminMutate('DELETE', target, null, `${u.email} har tagits bort.`); } }, 'Ta bort'))),
              { label: `Ta bort ${u.email}` }),
            }, 'Ta bort'))
          : h('button', { class: 'btn', type: 'button', onclick: () => adminMutate('POST', '/api/admin/users', { email: u.email, role: u.role || 'reader' }, `${u.email} är återaktiverad.`) }, 'Återaktivera')));
  };

  return frag(
    h('section', { class: 'section' },
      h('h2', { class: 'kicker' }, `Användare · ${users.filter((u) => u.active !== false && u.active !== 0).length} aktiva`),
      h('div', { class: 'ulist' }, users.map(card))),
    addForm);
}

function inviteLine(u) {
  const st = u.invite_status;
  if (!st || st === 'cancelled') {
    return u.last_seen ? null : h('p', { class: 'small muted invite-line' }, 'Ingen inbjudan skickad från appen.');
  }
  const text = st === 'sent' ? `Inbjudan mejlad ${whenFmt(u.invite_sent_at)}`
    : st === 'pending' ? `Inbjudan väntar på att Macen skickar den (begärd ${ago(u.invite_requested_at)})${u.invite_error ? ` · senaste försöket misslyckades: ${u.invite_error}` : ''}`
      : `Inbjudan kunde inte skickas: ${u.invite_error || 'okänt fel'}`;
  return h('p', { class: `small muted invite-line${st === 'failed' ? ' warn' : ''}` }, text);
}

const SOURCE_KIND_SV = { rss: 'RSS-flöde', article: 'Artikel' };

async function adminSources() {
  const sources = rowsOf(await adminGet('/api/admin/sources'), 'sources');
  const url = h('input', {
    id: 'src-url', type: 'url', required: true, inputmode: 'url', autocomplete: 'off', autocapitalize: 'off',
    spellcheck: 'false', placeholder: 'https://…',
  });
  const kind = h('select', { id: 'src-kind' },
    h('option', { value: 'auto' }, 'Avgör automatiskt'), h('option', { value: 'article' }, 'Enskild artikel'),
    h('option', { value: 'rss' }, 'RSS-flöde (även en sajts startsida)'));
  const addBtn = h('button', { class: 'btn primary', type: 'submit' }, 'Lägg till');
  const pasteBtn = navigator.clipboard && navigator.clipboard.readText ? h('button', {
    class: 'btn', type: 'button',
    onclick: async () => {
      try { url.value = (await navigator.clipboard.readText()).trim(); } catch { url.focus(); }
    },
  }, 'Klistra in') : null;
  const form = h('form', {
    class: 'card card-pad form',
    onsubmit: async (ev) => {
      ev.preventDefault();
      const u = url.value.trim();
      if (!u) { url.focus(); return; }
      addBtn.disabled = true; addBtn.textContent = 'Kontrollerar…';
      try {
        const res = await adminSend('POST', '/api/admin/sources', { url: u, kind: kind.value });
        const src = res && res.source;
        adminMsg.text = src
          ? `${SOURCE_KIND_SV[src.kind] || 'Källa'} tillagd: ${src.title || src.url}. ${src.kind === 'rss'
            ? 'Flödet läses från nästa körning.' : 'Artikeln läses av nästa körningar (i tre dygn).'}`
          : 'Källan är tillagd.';
        adminMsg.error = false;
      } catch (e) {
        if (e instanceof AuthError) throw e;
        adminMsg.text = e instanceof OfflineError ? 'Ingen anslutning – källan lades inte till.' : `Källan lades inte till: ${e.message}`;
        adminMsg.error = true;
      }
      route({ keepScroll: true });
    },
  },
  h('h2', { class: 'kicker' }, 'Lägg till källa'),
  h('p', { class: 'small' }, 'Klistra in en länk till en artikel eller ett RSS-flöde. Appen känner själv igen vilket det är; en sajts startsida blir dess RSS-flöde om du väljer det. Telegram och rysk statsmedia tas inte emot.'),
  h('label', { class: 'search-label', for: 'src-url' }, 'Länk'), url,
  h('label', { class: 'search-label', for: 'src-kind' }, 'Typ'), kind,
  h('div', { class: 'btn-row' }, pasteBtn, addBtn));

  const row = (x) => h('div', { class: 'ucard' },
    h('div', { class: 'ucard-top' }, h('b', null, x.title || hostOf(x.url) || x.url)),
    h('p', { class: 'small muted' }, `${SOURCE_KIND_SV[x.kind] || x.kind} · ${hostOf(x.url) || ''} · ${x.added_by || ''} · ${whenFmt(x.added_at)}`),
    h('div', { class: 'btn-row' },
      h('button', {
        class: 'btn danger', type: 'button',
        onclick: () => openSheet((close) => frag(
          h('h2', { class: 'title-m' }, `Ta bort "${x.title || hostOf(x.url)}"?`),
          h('p', { class: 'small' }, 'Källan läses inte längre av körningarna. Rapporter som redan använt den påverkas inte.'),
          h('div', { class: 'sheet-actions' },
            h('button', { class: 'btn', type: 'button', autofocus: true, onclick: close }, 'Avbryt'),
            h('button', { class: 'btn danger', type: 'button', onclick: () => { close(); adminMutate('DELETE', `/api/admin/sources/${encodeURIComponent(x.id)}`, null, 'Källan är borttagen.'); } }, 'Ta bort'))),
        { label: 'Ta bort källan' }),
      }, 'Ta bort')));

  const feeds = sources.filter((x) => x.kind === 'rss');
  const articles = sources.filter((x) => x.kind === 'article');
  return frag(
    form,
    h('section', { class: 'section' },
      h('h2', { class: 'kicker' }, `Tillagda RSS-flöden · ${feeds.length}`),
      feeds.length ? h('div', { class: 'ulist' }, feeds.map(row))
        : h('p', { class: 'small muted' }, 'Inga ännu. De 21 grundflödena (SVT, DN, BBC m.fl.) läses alltid.')),
    h('section', { class: 'section' },
      h('h2', { class: 'kicker' }, `Tillagda artiklar · ${articles.length}`),
      articles.length ? h('div', { class: 'ulist' }, articles.map(row))
        : h('p', { class: 'small muted' }, 'Inga ännu.')));
}

async function adminNotices() {
  const [statusBody, notices] = await Promise.all([adminGet('/api/admin/status').catch(() => ({})), loadNotices()]);
  const devices = statusBody && statusBody.push && Number(statusBody.push.subscriptions);
  const title = h('input', { id: 'nt-title', type: 'text', required: true, maxlength: 80, autocomplete: 'off', placeholder: 'T.ex. Ny version av appen' });
  const body = h('textarea', { id: 'nt-body', required: true, maxlength: 500, rows: 4, placeholder: 'Vad vill du säga?' });
  const link = h('select', { id: 'nt-link' },
    h('option', { value: '' }, 'Ingen länk'), h('option', { value: '#/' }, 'Idag'), h('option', { value: '#/bedom' }, 'Bedöm'));
  const push = h('input', { id: 'nt-push', type: 'checkbox', checked: true });
  const expiry = h('select', { id: 'nt-exp' },
    ...[[1, '1 dag'], [3, '3 dagar'], [7, '7 dagar'], [14, '14 dagar']].map(([v, l]) => h('option', { value: String(v), selected: v === 7 }, l)));
  const sendBtn = h('button', { class: 'btn primary', type: 'submit' }, 'Skicka meddelande');
  const form = h('form', {
    class: 'card card-pad form',
    onsubmit: async (ev) => {
      ev.preventDefault();
      const t = title.value.trim(); const b = body.value.trim();
      if (!t || !b) { adminMsg.text = 'Skriv både rubrik och text.'; adminMsg.error = true; route({ keepScroll: true }); return; }
      sendBtn.disabled = true;
      try {
        const res = await adminSend('POST', '/api/admin/notices', {
          title: t, body: b, url: link.value || null, push: push.checked, expires_days: Number(expiry.value),
        });
        const n = Number(res && res.pushed) || 0;
        adminMsg.text = push.checked
          ? `Meddelandet är publicerat. Skickat som notis till ${plural(n, 'enhet', 'enheter')}${res && res.failed ? ` (${res.failed} misslyckades)` : ''}.`
          : 'Meddelandet är publicerat i appen (ingen notis).';
        adminMsg.error = false;
      } catch (e) {
        if (e instanceof AuthError) throw e;
        adminMsg.text = e instanceof OfflineError ? 'Ingen anslutning – meddelandet skickades inte.' : `Meddelandet skickades inte: ${e.message}`;
        adminMsg.error = true;
      }
      route({ keepScroll: true });
    },
  },
  h('h2', { class: 'kicker' }, 'Nytt meddelande'),
  h('label', { class: 'search-label', for: 'nt-title' }, 'Rubrik'), title,
  h('label', { class: 'search-label', for: 'nt-body' }, 'Text'), body,
  h('label', { class: 'search-label', for: 'nt-link' }, 'Länk i appen'), link,
  h('label', { class: 'search-label', for: 'nt-exp' }, 'Visas i'), expiry,
  h('div', { class: 'check-row' }, push, h('label', { for: 'nt-push' }, 'Skicka även som notis till alla som slagit på notiser')),
  h('p', { class: 'small muted' }, Number.isFinite(devices)
    ? `${plural(devices, 'enhet', 'enheter')} har notiser påslagna just nu.`
    : 'Antalet enheter med notiser kunde inte hämtas.'),
  sendBtn);

  const row = (n) => h('div', { class: 'ucard' },
    h('div', { class: 'ucard-top' }, h('b', null, n.title)),
    h('p', { class: 'small' }, n.body),
    h('p', { class: 'small muted' }, `${n.author || ''} · ${whenFmt(n.ts)} · visas till ${whenFmt(n.expires_at)}`),
    h('div', { class: 'btn-row' },
      h('button', {
        class: 'btn danger', type: 'button',
        onclick: () => openSheet((close) => frag(
          h('h2', { class: 'title-m' }, `Ta bort "${n.title}"?`),
          h('p', { class: 'small' }, 'Meddelandet försvinner från appen. Notiser som redan skickats går inte att ta tillbaka.'),
          h('div', { class: 'sheet-actions' },
            h('button', { class: 'btn', type: 'button', autofocus: true, onclick: close }, 'Avbryt'),
            h('button', { class: 'btn danger', type: 'button', onclick: () => { close(); adminMutate('DELETE', `/api/admin/notices/${encodeURIComponent(n.id)}`, null, 'Meddelandet är borttaget.').then(() => loadNotices().catch(() => {})); } }, 'Ta bort'))),
        { label: 'Ta bort meddelandet' }),
      }, 'Ta bort')));

  const last = statusBody && statusBody.refresh;
  const rMsg = h('input', { id: 'rf-msg', type: 'text', maxlength: 200, autocomplete: 'off', placeholder: 'T.ex. Rättad poäng i dagens rapport' });
  const rBtn = h('button', { class: 'btn primary', type: 'submit' }, 'Uppdatera alla appar');
  const refreshForm = h('form', {
    class: 'card card-pad form',
    onsubmit: async (ev) => {
      ev.preventDefault();
      rBtn.disabled = true;
      try {
        const res = await adminSend('POST', '/api/admin/refresh', { message: rMsg.value.trim() || null });
        const n = Number(res && res.pushed) || 0;
        // This page sent it and is current: show the line instead of reloading.
        if (res && res.refresh) markRefreshSent(res.refresh);
        adminMsg.text = `Uppdateringen är skickad. Notis till ${plural(n, 'enhet', 'enheter')}${res && res.failed ? ` (${res.failed} misslyckades)` : ''}; öppna appar laddar om, övriga nästa gång de öppnas.`;
        adminMsg.error = false;
      } catch (e) {
        if (e instanceof AuthError) throw e;
        adminMsg.text = e instanceof OfflineError ? 'Ingen anslutning – uppdateringen skickades inte.' : `Uppdateringen skickades inte: ${e.message}`;
        adminMsg.error = true;
      }
      route({ keepScroll: true });
    },
  },
  h('h2', { class: 'kicker' }, 'Uppdatera alla appar'),
  h('p', { class: 'small' }, 'Skickar en notis och får alla öppna appar att ladda om, med ny version om en finns och färska data. Överst i appen står sedan "Appen har uppdaterats".'),
  h('label', { class: 'search-label', for: 'rf-msg' }, 'Vad har ändrats? (valfritt)'), rMsg,
  last && last.at ? h('p', { class: 'small muted' }, `Senast: ${whenFmt(last.at)} av ${last.by || '–'}${last.message ? ` – ${last.message}` : ''}`) : null,
  rBtn);

  return frag(
    refreshForm,
    form,
    h('section', { class: 'section' },
      h('h2', { class: 'kicker' }, `Aktiva meddelanden · ${notices.length}`),
      notices.length ? h('div', { class: 'ulist' }, notices.map(row)) : h('p', { class: 'small muted' }, 'Inga aktiva meddelanden.')));
}

async function adminSecurity() {
  const data = await adminGet('/api/admin/security?days=7');
  const rows = rowsOf(data, 'rows').slice().sort((a, b) => (a.ts < b.ts ? 1 : -1));
  const now = Date.now();
  const fromRows = (reason, ms) => rows.filter((r) => r.reason === reason && now - new Date(r.ts).getTime() <= ms).length;
  const pick = (reason, win) => {
    const c = data && data.counts;
    const alt = data && data[`counts_${win}`];
    if (c && c[win] && c[win][reason] != null) return Number(c[win][reason]);
    if (c && c[reason] && typeof c[reason] === 'object' && c[reason][win] != null) return Number(c[reason][win]);
    if (alt && alt[reason] != null) return Number(alt[reason]);
    return fromRows(reason, win === '24h' ? 86400000 : 7 * 86400000);
  };
  const tiles = REASONS.map(([k, label, help]) => {
    const d1 = pick(k, '24h');
    const d7 = pick(k, '7d');
    const cls = d1 > 20 ? 'danger' : d1 || d7 ? 'warn' : '';
    return h('div', { class: `stat ${cls}`, title: help },
      h('div', { class: 'stat-label' }, label),
      h('div', { class: 'stat-value' }, String(d1)),
      h('div', { class: 'small' }, `senaste dygnet · ${d7} på 7 dygn`));
  });
  const total24 = REASONS.reduce((n, [k]) => n + pick(k, '24h'), 0);
  return frag(
    h('p', { class: 'small muted' }, total24 ? `${plural(total24, 'händelse', 'händelser')} det senaste dygnet.` : 'Inga misslyckade eller misstänkta försök det senaste dygnet.'),
    h('section', { class: 'stat-grid' }, tiles),
    h('section', { class: 'section' },
      h('h2', { class: 'kicker' }, 'Senaste händelser'),
      rows.length ? h('div', { class: 'card list' }, rows.slice(0, 200).map((r) => h('div', { class: 'row srow' },
        h('div', { class: 'row-main' },
          h('span', { class: 'row-title' }, h('span', { class: `pill ${r.reason === 'not_allowed' || r.reason === 'invalid_jwt' ? 'pill-warn' : ''}` }, REASON_SV[r.reason] || r.reason || 'Okänt'), ' ', r.email || 'okänd avsändare'),
          h('span', { class: 'row-sub' }, [whenFmt(r.ts), r.ip_country, [r.method, r.path].filter(Boolean).join(' ')].filter(Boolean).join(' · ')),
          r.detail ? h('span', { class: 'row-sub' }, r.detail) : null)))) : h('p', { class: 'muted small' }, 'Inga registrerade händelser de senaste 7 dygnen.')));
}

// The scheduled runs (Version 3.4): one light per job and for the Mac, the
// worst of them on top. The Worker decides the lights; see runHealth there.
const LIGHT_SV = { green: 'Grönt', yellow: 'Gult', red: 'Rött' };
const HOST_SV = { cloud: 'GitHub Actions', mac: 'Macen' };
const RUNS_HEADLINE = { green: 'Allt snurrar', yellow: 'Något att hålla koll på', red: 'Något har gått fel' };

const lightDot = (light) => h('span', { class: `dot dot-${light}`, role: 'img', 'aria-label': LIGHT_SV[light] || light });
const runMinutes = (r) => (r.finished_at
  ? `${Math.max(1, Math.round((Date.parse(r.finished_at) - Date.parse(r.started_at)) / 60000))} min` : 'pågår');
const runLight = (r) => (r.status === 'failed' ? 'red' : r.status === 'ok' && r.warnings.length ? 'yellow' : 'green');
const logLink = (r) => (r.log_url ? frag(' · ', h('a', { href: r.log_url, target: '_blank', rel: 'noopener' }, 'Logg')) : null);

function runsSection(runs) {
  if (!runs) return null;
  const lights = [...runs.jobs.map((j) => j.light), runs.mac.light];
  const worst = lights.includes('red') ? 'red' : lights.includes('yellow') ? 'yellow' : 'green';
  const labels = Object.fromEntries(runs.jobs.map((j) => [j.job, j.label]));
  return frag(
    h('section', { class: `run-hero run-${worst}` }, lightDot(worst),
      h('div', null,
        h('div', { class: 'title-m' }, RUNS_HEADLINE[worst]),
        h('div', { class: 'small' }, runs.runner ? `Jobben körs i ${HOST_SV[runs.runner] || runs.runner}` : 'Inga körningar rapporterade än'))),
    h('div', { class: 'card list' },
      runs.jobs.map((j) => h('div', { class: 'row srow' }, lightDot(j.light),
        h('div', { class: 'row-main' },
          h('span', { class: 'row-title' }, j.label, h('span', { class: 'muted' }, ` · kl. ${j.due.join(' och ')}`)),
          h('span', { class: 'row-sub run-state' }, j.text),
          j.last ? h('span', { class: 'row-sub' },
            `Senast ${tsFmt(j.last.started_at)} · ${HOST_SV[j.last.host] || j.last.host} · ${runMinutes(j.last)}`, logLink(j.last)) : null))),
      h('div', { class: 'row srow' }, lightDot(runs.mac.light),
        h('div', { class: 'row-main' },
          h('span', { class: 'row-title' }, 'Inbjudningsmejl', h('span', { class: 'muted' }, ' · var 5:e minut')),
          h('span', { class: 'row-sub run-state' }, runs.mac.text),
          runs.mac.last_seen_at ? h('span', { class: 'row-sub' }, `Hördes senast ${ago(runs.mac.last_seen_at)}`) : null))),
    runs.recent.length ? h('section', { class: 'section' },
      h('h2', { class: 'kicker' }, 'Senaste körningar'),
      h('div', { class: 'card list' }, runs.recent.slice(0, 15).map((r) => h('div', { class: 'row srow' }, lightDot(runLight(r)),
        h('div', { class: 'row-main' },
          h('span', { class: 'row-title' }, `${labels[r.job] || r.job} · ${tsFmt(r.started_at)}`),
          h('span', { class: 'row-sub' },
            [HOST_SV[r.host] || r.host, runMinutes(r),
              r.status === 'failed' ? `misslyckades, kod ${r.exit_code ?? '?'}` : null,
              r.warnings.length ? plural(r.warnings.length, 'varning', 'varningar') : null].filter(Boolean).join(' · '),
            logLink(r)),
          r.warnings.slice(0, 3).map((w) => h('span', { class: 'row-sub run-warn' }, w.replace(/^!\s*/, '')))))))) : null);
}

// What has changed, newest first. Added to by hand with each change worth
// telling the admins about.
const RELEASE_NOTES = [
  ['2026-10-15', 'RSS-förfilter i skuggläge', [
    'Timkollen hämtar nu först 21 RSS-flöden (bl.a. SVT, Ekot, DN, SvD, BBC, DW, Guardian, Kyiv Independent och Moscow Times) och ser vilka trådar som har nya artiklar sedan förra kollen.',
    'Skuggläge: alla trådar kollas fortfarande av Claude som förut. Förfiltret antecknar bara vilka anrop det skulle ha hoppat över, så att det kan prövas innan det får spara pengar.',
    'Ett flöde som slutar svara tre körningar i rad ger en varning under Körningar.',
  ]],
  ['2026-10-12', 'Körningarna i molnet', [
    'Morgonrapporten och timkollen körs i GitHub Actions i stället för på Macen.',
    'Körningarna visas här med grönt, gult och rött ljus.',
    'Den upplästa svenska sammanfattningen är borttagen.',
  ]],
  ['2026-10-10', 'Indexkontroller och prognosens träffsäkerhet', [
    'Rapporterna visar kontrollerna av hotindexet och hur väl 30-dagarsprognosen har stämt.',
    'Operatörens bedömningar påverkar indexet enligt fasta regler i koden.',
  ]],
];

function releaseNotesSection() {
  return h('section', { class: 'section' },
    h('h2', { class: 'kicker' }, 'Versionshistorik'),
    h('div', { class: 'card list' }, RELEASE_NOTES.map(([date, title, points]) => h('div', { class: 'row srow' },
      h('div', { class: 'row-main' },
        h('span', { class: 'row-title' }, title, h('span', { class: 'muted' }, ` · ${dateShort(date)}`)),
        points.map((p) => h('span', { class: 'row-sub' }, p)))))));
}

async function adminStatus() {
  const s = await adminGet('/api/admin/status');
  const c = (s && s.counts) || {};
  const tiles = [];
  // The morning report is due at about 05:05; after 05:30 today's should be in.
  const now = new Date();
  const todayLocal = now.toLocaleDateString('sv-SE');
  const up = s.last_report_uploaded_at ? new Date(s.last_report_uploaded_at) : null;
  let reportState = '';
  let reportCls = '';
  if (s.last_report_date) {
    const dueNow = now.getHours() > 5 || (now.getHours() === 5 && now.getMinutes() >= 30);
    if (s.last_report_date !== todayLocal && dueNow) { reportState = 'Dagens rapport saknas'; reportCls = 'danger'; }
    else if (up && up.toLocaleDateString('sv-SE') === s.last_report_date) {
      const onTime = up.getHours() < 5 || (up.getHours() === 5 && up.getMinutes() <= 30);
      reportState = onTime ? `I tid · ${up.toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' })}` : `Sen · ${up.toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' })}`;
      reportCls = onTime ? 'ok' : 'warn';
    } else if (up) { reportState = `Uppladdad ${tsFmt(up.toISOString())}`; }
  }
  tiles.push(h('div', { class: `stat ${reportCls}` }, h('div', { class: 'stat-label' }, 'Senaste rapport'),
    h('div', { class: 'stat-value' }, s.last_report_date ? dateShort(s.last_report_date) : '–'), reportState ? h('div', { class: 'small' }, reportState) : null));
  tiles.push(statTile('Senaste uppdatering', s.last_update_at ? ago(s.last_update_at) : '–'));
  const pullOld = s.last_machine_pull_at && Date.now() - new Date(s.last_machine_pull_at).getTime() > 36 * 3600000;
  tiles.push(h('div', { class: `stat ${pullOld ? 'warn' : ''}` }, h('div', { class: 'stat-label' }, 'Bedömningar hämtades senast'),
    h('div', { class: 'stat-value' }, s.last_machine_pull_at ? ago(s.last_machine_pull_at) : 'aldrig'),
    pullOld ? h('div', { class: 'small' }, 'Mer än ett och ett halvt dygn sedan') : null));
  const exp = s.service_token_expires ? new Date(s.service_token_expires) : null;
  const daysLeft = exp ? Math.floor((exp.getTime() - Date.now()) / 86400000) : null;
  tiles.push(h('div', { class: `stat ${daysLeft == null ? '' : daysLeft < 0 ? 'danger' : daysLeft <= 30 ? 'warn' : ''}` },
    h('div', { class: 'stat-label' }, 'Maskinnyckeln går ut'),
    h('div', { class: 'stat-value' }, exp ? exp.toLocaleDateString('sv-SE', { day: 'numeric', month: 'short', year: 'numeric' }) : '–'),
    daysLeft == null ? null : h('div', { class: 'small' }, daysLeft < 0 ? 'Har gått ut – körningarna kan inte ladda upp' : daysLeft <= 30 ? `Om ${plural(daysLeft, 'dag', 'dagar')} – förnya nyckeln` : `Om ${daysLeft} dagar`)));
  const inv = s.invites || {};
  if (inv.pending) {
    const stuck = !inv.last_pull_at || Date.now() - new Date(inv.last_pull_at).getTime() > 30 * 60000;
    tiles.push(h('div', { class: `stat ${stuck ? 'warn' : ''}` }, h('div', { class: 'stat-label' }, 'Inbjudningar som väntar'),
      h('div', { class: 'stat-value' }, String(inv.pending)),
      h('div', { class: 'small' }, `Macen hämtade senast ${inv.last_pull_at ? ago(inv.last_pull_at) : 'aldrig'}`)));
  }
  const alarm = s.alarm && s.alarm.missing_report;
  return frag(
    alarm ? h('section', { class: 'alarm-card', role: 'alert' },
      h('div', { class: 'kicker' }, 'Larm'),
      h('p', { class: 'title-m' }, `Morgonrapporten för ${dateLong(alarm)} har inte kommit`),
      h('p', { class: 'small' }, s.alarm.checked_at ? `Senast kontrollerad ${tsFmt(s.alarm.checked_at)}. ` : '',
        'Se Morgonrapport under Körningar nedan, och dess logg i GitHub Actions.')) : null,
    runsSection(s.runs),
    h('h2', { class: 'kicker' }, 'Appen'),
    h('section', { class: 'stat-grid' }, tiles),
    h('section', { class: 'section' },
      h('h2', { class: 'kicker' }, 'Innehåll'),
      h('section', { class: 'stat-grid' },
        statTile('Rapporter', String(c.reports ?? '–')),
        statTile('Händelser', String(c.events ?? '–')),
        statTile('Bedömningar', String(c.assessments ?? '–')),
        statTile('Användare', String(c.users ?? '–')))),
    releaseNotesSection());
}

async function adminAudit() {
  const rows = rowsOf(await adminGet('/api/admin/audit'), 'rows').slice().sort((a, b) => (a.ts < b.ts ? 1 : -1));
  if (!rows.length) return h('p', { class: 'muted small' }, 'Inga ändringar ännu.');
  const detailText = (d) => {
    if (d == null || d === '') return '';
    if (typeof d === 'string') { try { return detailText(JSON.parse(d)); } catch { return d; } }
    if (typeof d === 'object') return Object.entries(d).map(([k, v]) => `${k}: ${k === 'role' || k === 'from' || k === 'to' ? ROLE_SV[v] || v : v}`).join(', ');
    return String(d);
  };
  return h('div', { class: 'card list' }, rows.map((r) => h('div', { class: 'row srow' },
    h('div', { class: 'row-main' },
      h('span', { class: 'row-title' }, `${ACTION_SV[r.action] || r.action || 'Ändring'} ${r.target || ''}`.trim()),
      h('span', { class: 'row-sub' }, [whenFmt(r.ts), r.actor ? `av ${r.actor}` : null].filter(Boolean).join(' · ')),
      detailText(r.detail) ? h('span', { class: 'row-sub' }, detailText(r.detail)) : null))));
}

// ---------------------------------------------------------------- functions menu (Version 3.19)
// A small chip beside "Hotläget": what is new the last NEW_DAYS days, and
// every function in order, searchable letter by letter (features.js).
const FEATURE_ACTIONS = { settings: () => openSettings(), install: () => openInstall(), features: () => openFeatures() };

function visibleFeatures() {
  return FEATURES.filter((f) => (!f.admin || isAdmin()) && (!f.user || !isGuest()));
}

function newFeatures() {
  const since = new Date(Date.now() - NEW_DAYS * 86400000).toISOString().slice(0, 10);
  return visibleFeatures().filter((f) => f.added >= since).sort((a, b) => (a.added < b.added ? 1 : -1));
}

function featuresChip() {
  const n = firstVisitNow ? 0 : newFeatures().length;
  return h('button', { class: 'feat-chip', type: 'button', onclick: () => openFeatures(),
    'aria-label': n ? `Funktioner, ${n} nya` : 'Funktioner', title: 'Funktioner och nyheter' },
    n ? h('span', { class: 'feat-dot', 'aria-hidden': 'true' }) : null, n ? `${n} nya funktioner` : 'Funktioner');
}

function openFeatures() {
  openSheet((close) => {
    const areaName = Object.fromEntries(AREAS);
    const go = (f) => {
      close();
      if (f.action) { setTimeout(() => FEATURE_ACTIONS[f.action] && FEATURE_ACTIONS[f.action](), 0); return; }
      if (location.hash === f.href || (f.href === '#/' && !location.hash)) route(); else location.hash = f.href;
    };
    const row = (f, terms, showArea) => h('li', null, h('button', { class: 'feat-row', type: 'button', onclick: () => go(f) },
      h('span', { class: 'feat-main' },
        h('span', { class: 'feat-title' }, highlight(f.title, terms)),
        h('span', { class: 'feat-desc' }, highlight(f.desc, terms))),
      h('span', { class: 'feat-meta' }, showArea ? areaName[f.area] : null,
        f.added >= newSince ? h('span', { class: 'feat-new' }, `Ny ${dateShort(f.added)}`) : null)));
    const newSince = new Date(Date.now() - NEW_DAYS * 86400000).toISOString().slice(0, 10);
    const list = h('div', { class: 'feat-list' });
    const input = h('input', { type: 'search', class: 'feat-search', placeholder: 'Sök funktion …', 'aria-label': 'Sök funktion',
      autocomplete: 'off', spellcheck: 'false' });
    const draw = () => {
      const terms = norm(input.value).split(/\s+/).filter(Boolean);
      const all = visibleFeatures();
      if (terms.length) {
        const hits = all.filter((f) => {
          const hay = norm(`${f.title} ${f.desc} ${f.keywords || ''} ${areaName[f.area] || ''}`);
          return terms.every((t) => hay.includes(t));
        });
        list.replaceChildren(hits.length
          ? h('ul', { class: 'feat-ul' }, hits.map((f) => row(f, terms, true)))
          : h('p', { class: 'small muted' }, `Ingen funktion matchar ”${input.value}”.`));
        return;
      }
      const fresh = newFeatures();
      list.replaceChildren(
        fresh.length ? h('section', null, h('h3', { class: 'feat-h' }, `Nytt senaste ${NEW_DAYS} dagarna`),
          h('ul', { class: 'feat-ul' }, fresh.map((f) => row(f, [], true)))) : null,
        h('h3', { class: 'feat-h' }, 'Alla funktioner'),
        ...AREAS.map(([key, label]) => {
          const items = all.filter((f) => f.area === key);
          return items.length ? h('details', { class: 'feat-area', open: true },
            h('summary', null, label, h('span', { class: 'feat-count' }, String(items.length))),
            h('ul', { class: 'feat-ul' }, items.map((f) => row(f, [], false)))) : null;
        }));
    };
    input.addEventListener('input', draw);
    draw();
    return frag(
      h('h2', { class: 'title-m' }, 'Funktioner'),
      input,
      list,
      h('div', { class: 'sheet-actions' }, h('button', { class: 'btn', type: 'button', onclick: close }, 'Stäng')));
  }, { label: 'Funktioner' });
}

// ---------------------------------------------------------------- about (Version 3.17)
// What Hotmonitor is, that AI writes much of it, and what a guest leaves behind.
// The bands of the threat index in plain Swedish (config/methodology.json, index_anchors).
const INDEX_SCALE = [
  [1, 'Fred', 'Normala diplomatiska och ekonomiska förbindelser, inga påtryckningar.'],
  [2, 'Friktion', 'Fientlig retorik och vanligt spionage, men inga operationer mot Nato- eller EU-mål.'],
  [3, 'Politisk krigföring', 'Ihållande desinformation och valpåverkan, men inga fysiska följder.'],
  [4, 'Gråzon', 'Sabotage som kan förnekas, GPS-störningar, kränkningar av luftrum. Inga dödsoffer på Nato- eller EU-mark.'],
  [5, 'Aktiv hybridkonflikt', 'Statsstyrt sabotage på Nato- eller EU-mark som regeringar pekar ut Ryssland för; pågående ombudskrig.'],
  [6, 'Skärpt hybridkonflikt', 'Nato-länder svarar militärt (avvisningar, nedskjutningar), sabotage med risk för dödsoffer, ändrad styrkeplacering.'],
  [7, 'Förkris', 'Konsultationer enligt artikel 4, eller militära incidenter på Nato-territorium utan dödsoffer; synliga förstärkningar.'],
  [8, 'Kris', 'Dödsoffer på Nato- eller EU-territorium genom rysk handling, eller begränsad direkt eldväxling mellan ryska styrkor och Nato.'],
  [9, 'Randen till krig', 'Ihållande direkta strider mellan Ryssland och ett Nato-land; artikel 5 övervägs.'],
  [10, 'Krig', 'Öppet krig mellan Ryssland och Nato/EU.'],
];

const DISCLAIMER = 'Hotmonitor är ett privat projekt och ingen myndighet. Innehållet är inte råd eller officiell information. Vid kris, följ myndigheternas besked på krisinformation.se.';
const ISSUES_URL = 'https://github.com/jeaneclaude621-ui/threat_monitor/issues';
function crisisLink() {
  return h('button', { class: 'linkbtn inline', type: 'button', onclick: () => openExternal('https://www.krisinformation.se/', { outlet: 'Krisinformation.se' }) }, 'krisinformation.se');
}
function disclaimerText() {
  return frag('Hotmonitor är ett privat projekt och ingen myndighet. Innehållet är inte råd eller officiell information. Vid kris, följ myndigheternas besked på ', crisisLink(), '.');
}
function contactLink(label = 'Kontakt och rättelser') {
  return h('button', { class: 'linkbtn inline', type: 'button', onclick: () => openExternal(ISSUES_URL, { outlet: 'GitHub' }) }, label);
}
// The footer of Idag: who is behind it, what it is not, and how to reach them.
function siteFooter() {
  return h('footer', { class: 'site-foot' },
    h('p', null, disclaimerText()),
    h('p', null, contactLink(), ' · ', h('a', { href: '#/om' }, 'Om Hotmonitor')));
}

function viewAbout() {
  const guest = isGuest();
  return frag(
    backLink('#/', 'Hotläget'),
    h('header', { class: 'page-head' }, h('div', null, h('h1', { class: 'title-xl' }, 'Om Hotmonitor'))),
    h('section', { class: 'card card-pad about' },
      h('h2', { class: 'title-m' }, 'Vad det är'),
      h('p', null, 'Hotmonitor sammanställer varje dag öppna uppgifter om ryska hybridhot mot Nato, EU och Ukraina: nyheter, myndigheters lägesbilder, styrkor och anfall. Det är ett privat projekt, inte en myndighets bedömning.'),
      h('h2', { class: 'title-m' }, 'AI-genererat innehåll'),
      h('p', null, 'Sammanfattningar, översättningar, hotindex och trovärdighetsvärden tas fram automatiskt med hjälp av en AI-modell (Google Gemini) utifrån öppna källor. Texterna kan innehålla fel och ska läsas tillsammans med källorna som länkas. Bedömningar som en människa har gjort visas som bedömare utan namn.'),
      h('h2', { class: 'title-m', id: 'om-index' }, 'Vad betyder siffran?'),
      h('p', null, 'Hotindex är en AI-bedömning, varje dag, av hur spänt läget är mellan Ryssland och Nato/EU, på en skala från 1 till 10. Det mäter vad som händer Nato- och EU-länder, inte hur hårda striderna i Ukraina är. ”Om 30 dagar” är modellens prognos för läget en månad framåt. Indexet är inte Säpos, Försvarsmaktens eller någon annan myndighets bedömning.'),
      h('ol', { class: 'scale-list' }, INDEX_SCALE.map(([n, name, text]) => h('li', null, h('b', null, `${n} ${name}. `), text))),
      h('p', null, 'Inom ett band placeras värdet lågt, mitt i eller högt efter hur tydligt bandets villkor är uppfyllda.'),
      h('h3', { class: 'about-h3' }, 'Siffran vid varje händelse'),
      h('p', null, 'Den färgade rutan vid en händelse är trovärdighet, 1–10: hur väl uppgiften är bekräftad av oberoende och pålitliga källor. Den säger inget om hur allvarlig händelsen är.'),
      h('h2', { class: 'title-m', id: 'om-ansvar' }, 'Ansvar och kontakt'),
      h('p', null, disclaimerText()),
      h('p', null, 'Har du hittat ett fel, vill du att något rättas eller tas bort, eller har du en fråga? Skriv ett ärende på projektets sida på GitHub: ',
        contactLink('öppna ärenden (issues)'), '. Ärenden där är offentliga, så skriv inga personuppgifter som inte behövs.'),
      h('h2', { class: 'title-m' }, 'Källor'),
      h('p', null, 'Rysk statsmedia och Telegram används inte som nyhetskällor. Under Narrativ visas den ryska sidan bara som våra svenska sammanfattningar, utan länkar dit.'),
      h('h2', { class: 'title-m' }, 'Integritet'),
      h('p', null, guest
        ? 'Du läser utan att logga in. Vad du har läst sparas bara i den här webbläsaren.'
        : 'Du är inloggad med din e-postadress. Adressen syns bara för administratörer.'),
      h('p', null, h('a', { href: '#/om?s=integritet' }, 'Läs integritetspolicyn'), ' nedan.'),
      guest ? h('p', null, h('a', { class: 'btn primary', href: '/login' }, 'Logga in'), ' ',
        h('span', { class: 'small muted' }, 'för notiser och för att bedöma källor (kräver konto).')) : null),
    privacySection());
}

// Integritetspolicy (review G2): what is kept, why, for how long, who helps.
function privacySection() {
  const li = (...kids) => h('li', null, ...kids);
  return h('section', { class: 'card card-pad about', id: 'om-integritet', 'aria-labelledby': 'integritet-h' },
    h('h2', { class: 'title-m', id: 'integritet-h' }, 'Integritetspolicy'),
    h('p', null, 'Personuppgiftsansvarig är projektets ägare. Hotmonitor är ett privat projekt utan kommersiellt syfte.'),
    h('h3', { class: 'about-h3' }, 'Om du läser utan att logga in'),
    h('ul', { class: 'bullets' },
      li('Inga kakor, ingen analys och ingen spårning. Typsnitt och allt annat hämtas från Hotmonitor själv.'),
      li('Vad du har läst och dina inställningar sparas bara i din webbläsare (localStorage) och lämnar den inte.'),
      li('Servern ser din IP-adress när du hämtar en sida. Den hålls i minnet en kort stund för att stoppa överbelastning och sparas inte. Vid misstänkt missbruk loggas bara land, sökväg och tid.')),
    h('h3', { class: 'about-h3' }, 'Om du är inloggad'),
    h('ul', { class: 'bullets' },
      li('E-postadress och roll (läsare eller administratör), för att ge dig rätt behörighet.'),
      li('Senaste besök, för att kunna visa vad som är nytt sedan sist.'),
      li('Läsmarkeringar: vilka händelser och uppdateringar du har öppnat.'),
      li('Push-prenumerationer, om du har slagit på notiser: en adress hos din webbläsares notistjänst.'),
      li('Bedömningar av källor, om du är bedömare. Andra ser dem bara som ”Bedömare N”, utan namn eller adress.'),
      li('Enhet och plattform (t.ex. iPhone, hemskärm eller webbläsare), för att kunna ge rätt hjälp med notiser.'),
      li('Säkerhetslogg över nekade eller misstänkta inloggningsförsök (e-post, land, sökväg, tid). Den sparas i 90 dagar.')),
    h('h3', { class: 'about-h3' }, 'Ändamål och rättslig grund'),
    h('p', null, 'Uppgifterna används bara för att driva tjänsten: inloggning, behörighet, notiser, vad som är nytt och skydd mot missbruk. Den rättsliga grunden är berättigat intresse (artikel 6.1 f i dataskyddsförordningen). Inget säljs eller används för reklam.'),
    h('h3', { class: 'about-h3' }, 'Biträden'),
    h('ul', { class: 'bullets' },
      li(h('b', null, 'Cloudflare'), ': driftar appen och databasen och sköter inloggningen (Cloudflare Access loggar inloggningar, även IP-adress).'),
      li(h('b', null, 'GitHub'), ': kod och den dagliga körningen som gör rapporterna. Inga användaruppgifter skickas dit.'),
      li(h('b', null, 'Google Gemini'), ': AI-modellen får bara nyhetstext ur öppna källor, aldrig uppgifter om användare.')),
    h('h3', { class: 'about-h3' }, 'Dina rättigheter'),
    h('p', null, 'Du har rätt att få veta vilka uppgifter som finns om dig (utdrag), få dem rättade och få dem raderade, och att klaga hos Integritetsskyddsmyndigheten (IMY). Be om utdrag eller radering genom ',
      contactLink('ett ärende på GitHub'), '. Skriv inte din e-postadress i ärendet, eftersom det är offentligt. Skriv att du vill bli kontaktad, så ordnar vi en säker väg.'));
}

// ---------------------------------------------------------------- chrome
function updateChrome() {
  const alarmEl = document.getElementById('alarm');
  const alarm = store.me && store.me.alarm;
  const missing = alarm && alarm.missing_report;
  // The server clears the alarm when the report arrives; don't wait for it.
  const arrived = missing && store.index && store.index.length && store.index[0].date >= missing;
  if (alarmEl) {
    if (missing && !arrived) {
      alarmEl.replaceChildren(
        h('b', null, 'Dagens rapport har inte kommit än'),
        alarm.checked_at ? ` (senast kontrollerad ${tsFmt(alarm.checked_at)})` : '',
        isAdmin() ? frag(' · ', h('a', { href: '#/admin?s=status' }, 'Systemstatus')) : null);
      alarmEl.hidden = false;
    } else {
      alarmEl.hidden = true;
    }
  }
  const pending = document.getElementById('pending');
  const n = store.outbox.length;
  pending.hidden = !n;
  pending.textContent = n ? `${plural(n, 'bedömning', 'bedömningar')} väntar på uppladdning` : '';
  const banner = document.getElementById('banner');
  if (store.authLost || store.stale) {
    const offline = !navigator.onLine && !store.authLost;
    banner.replaceChildren(
      store.authLost ? 'Inloggningen har gått ut. '
        : offline ? 'Du är offline – visar sparad data.' : 'Ingen kontakt med servern – visar sparad data. ',
      offline ? null : h('a', { href: '/login' }, 'Logga in igen'));
    banner.hidden = false;
  } else {
    banner.hidden = true;
  }
  paintBadges();
}

// Views that show read marks or verdicts follow the data; the search view
// does not, so its field keeps focus while typing.
const LIVE_ROUTES = new Set(['', 'rapport', 'mina', 'handelse', 'kalla']);
let rerenderQueued = false;
onChange(() => {
  updateChrome();
  if (!LIVE_ROUTES.has(currentRoute) || isDragging() || rerenderQueued) return;
  rerenderQueued = true;
  Promise.resolve().then(() => { rerenderQueued = false; rerender(); });
});

// Short status messages ("Länken är kopierad") go to #ptr, a role=status
// region, instead of making the whole page a live region (review A1).
let announceTimer = 0;
function announce(text, ms = 2500) {
  const ptr = document.getElementById('ptr');
  if (!ptr || refreshing) return;
  ptr.textContent = text; ptr.hidden = false;
  clearTimeout(announceTimer);
  announceTimer = setTimeout(() => { ptr.hidden = true; }, ms);
}

// ---------------------------------------------------------------- refresh
let refreshing = null;
let lastRefresh = 0;
async function doRefresh({ quiet = false } = {}) {
  if (refreshing) return refreshing;
  const ptr = document.getElementById('ptr');
  if (!quiet) { ptr.textContent = 'Uppdaterar…'; ptr.hidden = false; ptr.classList.add('busy'); }
  refreshing = (async () => {
    try {
      await refreshAll();
      await computeBadges();
      lastRefresh = Date.now();
      if (!quiet) { ptr.textContent = `Uppdaterat ${new Date().toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' })}`; }
    } catch (e) {
      if (e instanceof DeniedError) { document.getElementById('view').replaceChildren(errorView(e)); return; }
      if (e instanceof AuthError) store.authLost = true;
      else store.stale = true;
      if (!quiet) ptr.textContent = 'Kunde inte uppdatera';
    } finally {
      updateChrome();
      if (currentRoute !== 'amnen') rerender();
      setTimeout(() => { ptr.hidden = true; ptr.classList.remove('busy'); ptr.style.transform = ''; }, quiet ? 0 : 900);
      refreshing = null;
    }
  })();
  return refreshing;
}

// Pull down at the top of Idag to refresh. Touch only; the Uppdatera
// buttons do the same for mouse and keyboard.
function installPullToRefresh() {
  const ptr = document.getElementById('ptr');
  const reduce = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  let startY = null;
  let dy = 0;
  window.addEventListener('touchstart', (ev) => {
    if (currentRoute !== '' || window.scrollY > 0 || refreshing || document.querySelector('dialog[open]') || ev.touches.length !== 1) { startY = null; return; }
    startY = ev.touches[0].clientY; dy = 0;
  }, { passive: true });
  window.addEventListener('touchmove', (ev) => {
    if (startY == null) return;
    dy = ev.touches[0].clientY - startY;
    if (dy <= 8 || window.scrollY > 0) { if (!refreshing) ptr.hidden = true; return; }
    ptr.hidden = false;
    ptr.textContent = dy > 70 ? 'Släpp för att uppdatera' : 'Dra för att uppdatera';
    ptr.style.transform = reduce() ? '' : `translate(-50%, ${Math.min(dy / 2, 48)}px)`;
  }, { passive: true });
  window.addEventListener('touchend', () => {
    if (startY == null) return;
    const pulled = dy > 70;
    startY = null;
    if (pulled) doRefresh(); else if (!refreshing) { ptr.hidden = true; ptr.style.transform = ''; }
  }, { passive: true });
}

// A new deploy installs a new service worker, which takes control at once
// (skipWaiting + clients.claim); reload then, once, so the page runs the
// new code instead of the old code it started with.
const RELOAD_FLAG = 'hm.swReloaded';
let lastSwCheck = 0;
function setupAutoUpdate() {
  if (!('serviceWorker' in navigator)) return;
  if (navigator.serviceWorker.controller) {
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      try {
        if (sessionStorage.getItem(RELOAD_FLAG)) return;
        sessionStorage.setItem(RELOAD_FLAG, '1');
      } catch { return; }
      location.reload();
    }, { once: true });
  }
  // A clean start of this page may reload again on a later deploy.
  setTimeout(() => { try { sessionStorage.removeItem(RELOAD_FLAG); } catch { /* ignore */ } }, 30000);
  checkForUpdate();
}
function checkForUpdate() {
  if (!('serviceWorker' in navigator) || Date.now() - lastSwCheck < 10 * 60000) return;
  lastSwCheck = Date.now();
  navigator.serviceWorker.getRegistration().then((reg) => reg && reg.update()).catch(() => {});
}

// An admin's "Uppdatera alla" (/api/admin/refresh) is in /api/me as
// `refresh` and arrives as a push. A page started before it reloads once
// - new code if deployed, fresh data either way - and then says so.
const REFRESH_SEEN_KEY = 'hm.refreshSeen';
const REFRESH_NOTE_KEY = 'hm.refreshNote';
const REFRESH_NOTE_DAYS = 3;
const pageStartedAt = Date.now();
let reloading = false;
let handledRefresh = null;   // in memory too, in case storage is unavailable
function checkRefresh() {
  const r = store.me && store.me.refresh;
  if (!r || !r.id || !r.at || reloading || handledRefresh === r.id) return;
  let seen;
  try { seen = localStorage.getItem(REFRESH_SEEN_KEY); } catch { seen = undefined; }
  if (seen === r.id) { handledRefresh = r.id; return; }
  // Not mid-swipe or with a sheet open; the next change tries again.
  if (isDragging() || document.querySelector('dialog[open]')) return;
  handledRefresh = r.id;
  const at = Date.parse(r.at);
  // Without storage a reload could repeat forever: just fetch new data.
  let stored = false;
  try { localStorage.setItem(REFRESH_SEEN_KEY, r.id); stored = localStorage.getItem(REFRESH_SEEN_KEY) === r.id; } catch { /* private mode */ }
  // First start on this device: it is already up to date, nothing to announce.
  if (seen === null && at < pageStartedAt) return;
  // Two minutes of slack for a phone clock that runs ahead of the server.
  if (stored && at > pageStartedAt - 120000) {
    try { sessionStorage.setItem(REFRESH_NOTE_KEY, JSON.stringify(r)); } catch { /* the note is optional */ }
    hardReload();
    return;
  }
  if (!stored && at > pageStartedAt - 120000) doRefresh({ quiet: true });
  if (Date.now() - at < REFRESH_NOTE_DAYS * 86400000) showRefreshNote(r);
}
async function hardReload() {
  reloading = true;
  // Our own reload below; the controllerchange handler must not add a second.
  try { sessionStorage.setItem(RELOAD_FLAG, '1'); } catch { /* ignore */ }
  try {
    const reg = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration() : null;
    if (reg) {
      await reg.update().catch(() => {});
      const w = reg.installing || reg.waiting;
      // A new deploy: wait for its worker so the reload runs the new code.
      if (w) {
        await new Promise((resolve) => {
          const t = setTimeout(resolve, 8000);
          w.addEventListener('statechange', () => {
            if (w.state === 'activated' || w.state === 'redundant') { clearTimeout(t); resolve(); }
          });
        });
      }
    }
  } catch { /* reload anyway */ }
  location.reload();
}
function markRefreshSent(r) {
  handledRefresh = r.id;
  try { localStorage.setItem(REFRESH_SEEN_KEY, r.id); } catch { /* in-memory guard is enough here */ }
  if (store.me) store.me.refresh = r;
  showRefreshNote(r);
}
function showRefreshNote(r) {
  const el = document.getElementById('updated');
  if (!el) return;
  const when = new Date(r.at);
  const time = Number.isNaN(when.getTime()) ? '' : ` ${tsFmt(r.at)}`;
  el.replaceChildren(
    h('span', null, h('b', null, 'Appen har uppdaterats'), time, r.message ? ` · ${r.message}` : ''),
    h('button', { type: 'button', onclick: () => { el.hidden = true; } }, 'Stäng'));
  el.hidden = false;
}
function setupRefresh() {
  let note = null;
  try {
    note = JSON.parse(sessionStorage.getItem(REFRESH_NOTE_KEY) || 'null');
    sessionStorage.removeItem(REFRESH_NOTE_KEY);
  } catch { note = null; }
  if (note && note.at) showRefreshNote(note);
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', (ev) => {
      if (ev.data && ev.data.type === 'hm-refresh') loadMe().catch(() => {});
    });
  }
  onChange(checkRefresh);
}

async function init() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  setupAutoUpdate();
  setupRefresh();
  try {
    await loadMe();
  } catch (e) {
    document.getElementById('view').replaceChildren(errorView(e));
    return;
  }
  document.querySelector('[data-tab="bedom"]').hidden = !isAdmin();
  if (!isGuest()) reportDevice({ standalone: isStandalone(), platform: platformOf() });
  assessmentsReady = loadAssessments().catch((e) => { console.warn('assessments', e); });
  const side = Promise.all([
    loadUpdates().catch((e) => { console.warn('updates', e); }),
    loadNotices().catch((e) => { console.warn('notices', e); }),
    loadReads().catch((e) => { console.warn('reads', e); }),
  ]);
  if (!isGuest()) refreshPushState().catch(() => {});
  window.addEventListener('hashchange', () => { noteNav(); route(); });
  window.addEventListener('offline', updateChrome);
  window.addEventListener('online', () => { loadMe().catch(() => {}).finally(updateChrome); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    checkForUpdate();
    if (Date.now() - lastRefresh > 60000) doRefresh({ quiet: true });
    // Cheap, and catches an admin's "Uppdatera alla" whose push came while away.
    else loadMe().catch(() => {});
  });
  installPullToRefresh();
  updateChrome();
  route();
  await Promise.all([side, assessmentsReady]);
  store.refreshedAt = new Date().toISOString();
  lastRefresh = Date.now();
  await computeBadges();
  if (currentRoute !== 'amnen') rerender();
}

translateSharePath();
init();

// Exposed for tests and debugging only.
window.__hm = { store, myRows, doRefresh, computeBadges };
