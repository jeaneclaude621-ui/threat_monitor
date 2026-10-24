// Hotmonitor: reports, archive, topics, map, sources, the operator's swipe
// assessments and the admin/status pages. All data is rendered as text
// (textContent / createElement), never as HTML.
import {
  store, onChange, isAdmin, loadMe, loadIndex, loadReport, loadAllReports, loadAssessments,
  currentByArticle, myRows, chainOf, assess, undo, AuthError, OfflineError, DeniedError, HttpError,
  loadUpdates, loadReads, loadNotices, markRead, isRead, refreshAll, adminGet, adminSend,
  reportDevice, pushKey, pushSubscribe, pushUnsubscribe,
} from './api.js';
import { gesture, verdictFor, stepFor, vibrate, isDragging } from './swipe.js';

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
function backLink(href, label) { return h('a', { class: 'back', href }, icon(['M12.5 4l-6 6 6 6'], '', '0 0 20 20'), label); }

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
    case 'bedom': tab = 'bedom'; view = () => viewAssess(q); break;
    case 'mina': tab = 'bedom'; view = () => viewMine(); break;
    case 'kalla': view = () => viewSource(rest.join('/')); break;
    case 'admin': tab = ''; view = () => viewAdmin(q); break;
    default: view = () => viewReport(null, q);
  }
  setTab(tab);
  const main = document.getElementById('view');
  if (!main) return;
  const y = window.scrollY;
  let node;
  try { node = await view(); } catch (e) { node = errorView(e); }
  if (seq !== renderSeq) return;
  main.replaceChildren(node);
  window.scrollTo(0, keepScroll ? y : 0);
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
      h('a', { class: 'btn primary', href: '/' }, 'Logga in'));
  }
  if (e instanceof OfflineError) {
    return h('div', { class: 'empty' },
      h('p', { class: 'title-m' }, 'Ingen anslutning'),
      h('p', { class: 'muted' }, 'Det finns ingen sparad kopia av den här sidan ännu.'),
      h('button', { class: 'btn', type: 'button', onclick: () => route() }, 'Försök igen'));
  }
  console.error(e);
  return h('div', { class: 'empty' },
    h('p', { class: 'title-m' }, 'Något gick fel'),
    h('p', { class: 'muted small' }, String((e && e.message) || e)),
    h('button', { class: 'btn', type: 'button', onclick: () => route() }, 'Försök igen'));
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

function updatesInScope() {
  const cutoff = Date.now() - SCOPE_DAYS * 86400000;
  return store.updates.filter((u) => new Date(u.ts).getTime() >= cutoff);
}
function unreadUpdates() { return updatesInScope().filter((u) => !isRead(u.id)); }
function eventState(date, e) {
  if (!scopeStart || date < scopeStart) return null;
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
    scopeStart = addDays(latest, -(SCOPE_DAYS - 1));
    let idag = unreadUpdates().length;
    let arkiv = 0;
    for (const item of index) {
      if (item.date < scopeStart) break;
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
const FACET_DAYS = 30;          // the filter bar on Idag and Bedöm ranks over this window
const openUpdates = new Set();

function ensureScope(index) { if (index.length) scopeStart = addDays(index[0].date, -(SCOPE_DAYS - 1)); }

async function viewReport(date, q) {
  const index = await loadIndex();
  if (!index.length) return emptyState('Inga rapporter ännu.');
  ensureScope(index);
  const latest = index[0].date;
  const d = date || latest;
  const [r, reports] = await Promise.all([loadReport(d), loadAllReports()]);
  const archived = d !== latest;
  const top = (r.executive_sv && r.executive_sv.top) || r.top_development;
  const selected = parseFacets(q);
  const windowStart = addDays(d, -(FACET_DAYS - 1));
  const facetEvents = reports.filter((x) => x.date >= windowStart && x.date <= d).flatMap((x) => x.events);
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
        h('h1', { class: 'title-xl' }, archived ? 'Rapport' : 'Hotläget')),
      h('div', { class: 'head-actions' },
        date ? null : h('a', { class: 'head-link', href: '#/arkiv' }, 'Tidigare dagar'),
        date ? null : h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Notiser och hemskärm', title: 'Notiser och hemskärm', onclick: openSettings }, bellIcon()),
        admin ? h('a', { class: 'icon-btn', href: '#/admin', 'aria-label': 'Status och administration', title: 'Status och administration' }, gearIcon()) : null)),
    archived ? null : noticeCards(),
    archived ? null : newBox(latest, r),
    archived ? null : installCard(),
    archived ? null : pushNudge(),
    heroCard(r),
    top ? h('section', { class: 'section' },
      h('div', { class: 'kicker amber' }, archived ? 'Viktigast den dagen' : 'Viktigast i dag'),
      h('p', { class: 'lead' }, top)) : null,
    admin ? h('div', { class: 'btn-row' },
      h('a', { class: 'btn primary', href: '#/bedom' }, 'Bedöm artiklar'),
      h('a', { class: 'btn', href: '#/mina' }, 'Mina bedömningar')) : null,
    filterBar(topFacets(facetEvents, selected), selected, setFacets),
    h('section', { class: 'section' },
      h('h2', { class: 'kicker' }, 'Dygnets händelser'),
      events.length
        ? h('div', { class: 'card list' }, events.map((e) => eventRow(r.date, e)))
        : selected.length
          ? h('div', { class: 'card card-pad' },
            h('p', { class: 'small' }, `Inga händelser ${archived ? 'den dagen' : 'i dag'} för ${selected.map(facetLabel).join(' + ')}.`),
            h('a', { class: 'btn', href: `#/arkiv?f=${encodeURIComponent(selected.join(','))}&r=30` }, 'Visa i arkivet'))
          : h('p', { class: 'muted' }, 'Inga händelser registrerade.')),
    feed.length || !archived ? h('section', { class: 'section' },
      h('div', { class: 'sec-head' },
        h('h2', { class: 'kicker' }, feedTitle),
        archived ? null : h('button', { class: 'linkbtn', type: 'button', onclick: () => doRefresh() }, 'Uppdatera')),
      feed.length
        ? h('div', { class: 'card list' }, feed.map((u) => updateRow(u, reports)))
        : h('p', { class: 'small muted' }, selected.length ? 'Inga uppdateringar för filtret.' : 'Inga uppdateringar ännu i dag.')) : null,
    executiveBlock(r.executive_sv),
  );
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
  return h('section', { class: 'newbox', 'aria-label': 'Nytt sedan senast' },
    h('div', { class: 'kicker amber' }, 'Nytt sedan senast'),
    h('p', { class: 'newbox-main' }, parts.join(' · ')),
    store.lastVisit ? h('p', { class: 'small muted' }, `Ditt förra besök: ${tsFmt(store.lastVisit)}`) : null,
    h('div', { class: 'btn-row' },
      h('button', { class: 'btn', type: 'button', onclick: markAll }, 'Markera allt som läst'),
      h('button', { class: 'btn', type: 'button', onclick: () => doRefresh() }, 'Uppdatera')));
}

function updateRow(u, reports) {
  const read = isRead(u.id);
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
        h('div', { class: 'hero-label amber' }, '30 DAGAR'),
        h('div', { class: 'hero-value amber' }, fmt1(r.threat_index_30d), h('small', null, ' /10')),
        h('div', { class: 'hero-sub' }, [r.index_band_30d ? `Band ${r.index_band_30d}` : null, 'Prognos'].filter(Boolean).join(' · '))) : null),
    h('div', { class: 'scale', role: 'img', 'aria-label': `Skala 0 till 10: i dag ${fmt1(r.threat_index)}${hasF ? `, prognos ${fmt1(r.threat_index_30d)}` : ''}` },
      h('div', { class: 'scale-fill', style: `width:${pct(r.threat_index)}` }),
      hasF ? h('div', { class: 'scale-tick', style: `left:${pct(r.threat_index_30d)}` }) : null),
    oi && Number(oi.index_delta)
      ? h('div', { class: 'hero-note' },
        h('strong', null, 'Operatörens påverkan: '),
        `${signed(oi.index_delta)} på index. `,
        oi.note_sv || '',
        Array.isArray(oi.trace) && oi.trace.length
          ? h('details', null, h('summary', null, 'Visa spår'), traceList(oi.trace))
          : null)
      : null,
    checksNote(r),
    forecastNote(r));
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

function eventRow(date, e) {
  const sub = [e.topics.join(' · '), e.countries.map(countryName).join(', ')].filter(Boolean).join(' · ');
  const state = eventState(date, e);
  return h('a', { class: `row${state ? ' unread' : ''}`, href: eventHref(date, e.id) },
    h('span', { class: scoreClass(e.score), 'aria-label': `Trovärdighet ${fmtScore(e.score)} av 10` }, fmtScore(e.score)),
    h('span', { class: 'row-main' },
      h('span', { class: 'row-title' }, e.title_sv || e.title),
      sub ? h('span', { class: 'row-sub' }, sub) : null),
    stateBadge(state),
    chevRight());
}

function executiveBlock(ex) {
  if (!ex || !Array.isArray(ex.sections) || !ex.sections.length) return null;
  return h('section', { class: 'section' },
    h('h2', { class: 'kicker' }, 'Kort om allt · Svensk Super Executive'),
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
  const [r, reports, index] = await Promise.all([loadReport(date), loadAllReports(), loadIndex(), assessmentsReady]);
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
  const known = Array.isArray(e.known_sv) ? e.known_sv.filter(Boolean) : [];
  const unknown = Array.isArray(e.unknown_sv) ? e.unknown_sv.filter(Boolean) : [];
  const reportHref = isLatest ? '#/' : `#/rapport/${encodeURIComponent(date)}`;
  const outcome = laterOutcome(e, date, reports);

  return frag(
    back,
    h('div', { class: 'section' },
      h('div', { class: 'chips' },
        e.topics.map((t) => h('a', { class: 'chip', href: facetHref('#/amnen', t) }, t)),
        e.countries.map((c) => h('a', { class: 'chip', href: `#/karta?p=all&c=${encodeURIComponent(c)}` }, countryName(c)))),
      h('h1', { class: 'title-l' }, e.title_sv || e.title),
      h('div', { class: 'small muted meta-line' },
        h('span', { class: scoreClass(e.score), style: 'width:auto;height:auto;padding:3px 8px;border-radius:8px;font-size:13px' }, `${fmtScore(e.score)}/10`),
        changed ? h('span', null, `Modellens poäng ${fmtScore(e.model_score)}`) : null,
        h('a', { href: reportHref }, dateLong(date)),
        stateBadge(state)),
      outcome ? h('p', { class: 'outcome' },
        h('span', { class: `rel rel-${OUTCOME[outcome.outcome][1]}` }, OUTCOME[outcome.outcome][0]),
        ' ', outcome.note || '',
        h('span', { class: 'small muted' }, ` · självkontroll ${dateShort(outcome.checked)}`)) : null),
    e.summary_sv ? h('p', { class: 'body-serif' }, e.summary_sv) : null,
    detailP,
    toggle ? h('div', null, toggle) : null,
    known.length || unknown.length ? h('section', { class: 'kv2' },
      known.length ? h('div', { class: 'card card-pad' },
        h('h2', { class: 'kicker' }, 'Vad vi vet'),
        h('ul', { class: 'bullets' }, known.map((k) => h('li', null, k)))) : null,
      unknown.length ? h('div', { class: 'card card-pad' },
        h('h2', { class: 'kicker amber' }, 'Vad vi inte vet'),
        h('ul', { class: 'bullets' }, unknown.map((k) => h('li', null, k)))) : null) : null,
    h('section', { class: 'section' },
      h('h2', { class: 'kicker' }, 'Källor och artiklar'),
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
        ? h('span', { class: 'tl-what' }, it.update.title_sv || firstSentence(it.update.summary_sv, 120), isRead(it.update.id) ? null : h('span', { class: 'nbadge' }, 'Ny'))
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
  const [reports] = await Promise.all([loadAllReports(), assessmentsReady]);
  const key = norm(name);
  const hits = [];
  for (const r of reports) for (const e of r.events) for (const a of e.articles) if (norm(a.outlet) === key) hits.push({ r, e, a });
  const back = h('a', { class: 'back', href: '#/', onclick: (ev) => { if (history.length > 1) { ev.preventDefault(); history.back(); } } }, icon(['M12.5 4l-6 6 6 6'], '', '0 0 20 20'), 'Tillbaka');
  if (!hits.length) return frag(back, emptyState(`Ingen källa som heter ”${name}” finns i rapporterna.`));
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
  const [latest, reports] = await Promise.all([loadReport(index[0].date), loadAllReports()]);
  const byReport = new Map(reports.map((r) => [r.date, r]));
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
    h('p', { class: 'small muted' }, filtering ? `Antal händelser per dag, 0–${hi}` : `Skala ${lo}–${hi}`));

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
  const [reports, index] = await Promise.all([loadAllReports(), loadIndex()]);
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
      results.replaceChildren(h('p', { class: 'hint' }, 'Välj ett eller flera områden ovan, eller sök i alla rapporter.'));
      return;
    }
    const nterms = terms.map(norm);
    const hits = all.filter((x) => matchesFacets(x.e, selected) && nterms.every((t) => x.hay.includes(t)));
    results.replaceChildren(frag(
      h('div', { style: 'display:flex;justify-content:space-between;align-items:baseline;gap:8px' },
        h('h2', { class: 'title-m' }, selected.length ? selected.map(facetLabel).join(' + ') : 'Sökträffar'),
        h('span', { class: 'small muted' }, plural(hits.length, 'träff', 'träffar'))),
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

// ---------------------------------------------------------------- Karta
async function viewMap(q) {
  const [reports, index] = await Promise.all([loadAllReports(), loadIndex()]);
  ensureScope(index);
  if (!reports.length) return emptyState('Inga rapporter ännu.');
  const period = ['7', '30', 'all'].includes(q.get('p')) ? q.get('p') : '7';
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
  h('p', { class: 'small' }, 'Klistra in en länk till en artikel eller ett RSS-flöde. Appen känner själv igen vilket det är; en sajts startsida blir dess RSS-flöde om du väljer det.'),
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
          h('span', { class: 'row-title' }, 'Inbjudningsmejl', h('span', { class: 'muted' }, ' · varje timme')),
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
      offline ? null : h('a', { href: '/' }, 'Logga in igen'));
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
  reportDevice({ standalone: isStandalone(), platform: platformOf() });
  assessmentsReady = loadAssessments().catch((e) => { console.warn('assessments', e); });
  const side = Promise.all([
    loadUpdates().catch((e) => { console.warn('updates', e); }),
    loadNotices().catch((e) => { console.warn('notices', e); }),
    loadReads().catch((e) => { console.warn('reads', e); }),
  ]);
  refreshPushState().catch(() => {});
  window.addEventListener('hashchange', () => route());
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

init();

// Exposed for tests and debugging only.
window.__hm = { store, myRows, doRefresh, computeBadges };
