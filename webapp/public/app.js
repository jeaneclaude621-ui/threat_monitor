// Hotmonitor: reports, archive, topics, map and the operator's swipe
// assessments. All data is rendered as text (textContent / createElement),
// never as HTML.
import {
  store, onChange, isAdmin, loadMe, loadIndex, loadReport, loadAllReports, loadAssessments,
  currentByArticle, myRows, chainOf, assess, undo, AuthError, OfflineError,
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
    case undefined: view = () => viewReport(null); break;
    case 'rapport': tab = 'arkiv'; view = () => viewReport(rest[0]); break;
    case 'handelse': view = () => viewEvent(rest[0], rest[1]); break;
    case 'arkiv': tab = 'arkiv'; view = () => viewArchive(q); break;
    case 'amnen': tab = 'amnen'; view = () => viewTopics(q); break;
    case 'karta': tab = 'karta'; view = () => viewMap(q); break;
    case 'bedom': tab = 'bedom'; view = () => viewAssess(); break;
    case 'mina': tab = 'bedom'; view = () => viewMine(); break;
    default: view = () => viewReport(null);
  }
  setTab(tab);
  const main = document.getElementById('view');
  const y = window.scrollY;
  let node;
  try { node = await view(); } catch (e) { node = errorView(e); }
  if (seq !== renderSeq) return;
  main.replaceChildren(node);
  window.scrollTo(0, keepScroll ? y : 0);
}

function rerender() { if (!isDragging()) route({ keepScroll: true }); }

function errorView(e) {
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

// ---------------------------------------------------------------- Idag / rapport
async function viewReport(date) {
  const index = await loadIndex();
  if (!index.length) return emptyState('Inga rapporter ännu.');
  const latest = index[0].date;
  const d = date || latest;
  const r = await loadReport(d);
  const archived = d !== latest;
  const top = (r.executive_sv && r.executive_sv.top) || r.top_development;

  return frag(
    date ? backLink('#/arkiv', 'Arkiv') : null,
    h('header', { class: 'page-head' },
      h('div', null,
        h('div', { class: 'kicker' }, dateLong(d)),
        h('h1', { class: 'title-xl' }, archived ? 'Rapport' : 'Hotläget')),
      date ? null : h('a', { class: 'head-link', href: '#/arkiv' }, 'Tidigare dagar')),
    heroCard(r),
    top ? h('section', { class: 'section' },
      h('div', { class: 'kicker amber' }, archived ? 'Viktigast den dagen' : 'Viktigast i dag'),
      h('p', { class: 'lead' }, top)) : null,
    isAdmin() ? h('div', { class: 'btn-row' },
      h('a', { class: 'btn primary', href: '#/bedom' }, 'Bedöm artiklar'),
      h('a', { class: 'btn', href: '#/mina' }, 'Mina bedömningar')) : null,
    h('section', { class: 'section' },
      h('h2', { class: 'kicker' }, 'Dygnets händelser'),
      r.events.length
        ? h('div', { class: 'card list' }, r.events.map((e) => eventRow(r.date, e)))
        : h('p', { class: 'muted' }, 'Inga händelser registrerade.')),
    executiveBlock(r.executive_sv),
  );
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
        h('div', { class: 'hero-sub' }, TREND[r.trend_label] || r.trend_label || '')),
      hasF ? h('div', null,
        h('div', { class: 'hero-label amber' }, '30 DAGAR'),
        h('div', { class: 'hero-value amber' }, fmt1(r.threat_index_30d), h('small', null, ' /10')),
        h('div', { class: 'hero-sub' }, 'Prognos')) : null),
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
      : null);
}

function eventRow(date, e) {
  const sub = [e.topics.join(' · '), e.countries.map(countryName).join(', ')].filter(Boolean).join(' · ');
  return h('a', { class: 'row', href: eventHref(date, e.id) },
    h('span', { class: scoreClass(e.score), 'aria-label': `Trovärdighet ${fmtScore(e.score)} av 10` }, fmtScore(e.score)),
    h('span', { class: 'row-main' },
      h('span', { class: 'row-title' }, e.title_sv || e.title),
      sub ? h('span', { class: 'row-sub' }, sub) : null),
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
      h('b', null, t.outlet || 'Okänd källa'),
      t.value != null && VERDICT[t.value] ? verdictPill(t.value) : null,
      t.date ? h('span', { class: 'muted small' }, dateShort(t.date)) : null),
    h('div', { class: 'small' },
      h('span', { class: 'effect' }, `Effekt ${signed(t.effect)}`),
      t.weight != null ? ` · vikt ${fmt1(t.weight)}` : '',
      t.assessment_id ? h('span', { class: 'muted' }, ` · bedömning #${String(t.assessment_id).slice(0, 8)}`) : null))));
}

// ---------------------------------------------------------------- Händelse
async function viewEvent(date, id) {
  const [r] = await Promise.all([loadReport(date), assessmentsReady]);
  const index = await loadIndex();
  const e = r.events.find((x) => x.id === id);
  const isLatest = index.length && index[0].date === date;
  const back = isLatest ? backLink('#/', 'Idag') : backLink(`#/rapport/${encodeURIComponent(date)}`, dateShort(date));
  if (!e) return frag(back, emptyState('Händelsen finns inte i rapporten.'));

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

  return frag(
    back,
    h('div', { class: 'section' },
      h('div', { class: 'chips' },
        e.topics.map((t) => h('a', { class: 'chip', href: `#/amnen?t=${encodeURIComponent(t)}` }, t)),
        e.countries.map((c) => h('a', { class: 'chip', href: `#/karta?p=all&c=${encodeURIComponent(c)}` }, countryName(c)))),
      h('h1', { class: 'title-l' }, e.title_sv || e.title),
      h('div', { class: 'small muted', style: 'display:flex;gap:10px;align-items:center;flex-wrap:wrap' },
        h('span', { class: scoreClass(e.score), style: 'width:auto;height:auto;padding:3px 8px;border-radius:8px;font-size:13px' }, `${fmtScore(e.score)}/10`),
        changed ? h('span', null, `Modellens poäng ${fmtScore(e.model_score)}`) : null,
        h('span', null, dateLong(date)))),
    e.summary_sv ? h('p', { class: 'body-serif' }, e.summary_sv) : null,
    detailP,
    toggle ? h('div', null, toggle) : null,
    h('section', { class: 'section' },
      h('h2', { class: 'kicker' }, 'Källor och artiklar'),
      isAdmin() && e.articles.length
        ? h('p', { class: 'hint' }, 'Svep en källa åt höger (trovärdig) eller vänster (tveksam) – längre svep ger starkare bedömning. Tryck på bedömningen för knappar.')
        : null,
      e.articles.length
        ? h('div', { class: 'card list' }, e.articles.map((a) => articleRow({ article: a, event: e, date })))
        : h('p', { class: 'muted small' }, e.sources || 'Inga källor registrerade.')),
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
  );
}

function paintUnder(under, value, dx, text) {
  under.className = `under${value != null ? ` v-${value}` : ''}`;
  const [left, right] = under.children;
  const label = text || (value != null ? VERDICT[value] : '');
  left.textContent = dx > 0 ? label : '';
  right.textContent = dx < 0 ? label : '';
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

function articleRow(target) {
  const a = target.article;
  const cur = currentByArticle().get(a.id);
  const admin = isAdmin();
  const under = h('div', { class: 'under', 'aria-hidden': 'true' }, h('span'), h('span'));
  const apply = (v) => {
    const now = currentByArticle().get(a.id);
    if (v === 0 && (!now || now.value === 0)) return;
    if (now && now.value === v) return;
    assess(target, v, now || null);
    vibrate();
  };
  const panel = admin ? h('div', { class: 'expand', hidden: true },
    verdictButtons(apply, h('button', { class: 'a-skip', type: 'button', disabled: !cur || cur.value === 0, onclick: () => apply(0) }, 'Återkalla'))) : null;
  const pill = admin
    ? h('button', {
      class: `verdict v-${cur ? cur.value : 'skip'}${cur && cur.pending ? ' v-pending' : ''}`,
      type: 'button', 'aria-expanded': 'false',
      style: 'border:none;cursor:pointer;min-height:32px',
      onclick: (ev) => { panel.hidden = !panel.hidden; ev.currentTarget.setAttribute('aria-expanded', String(!panel.hidden)); },
    }, cur ? VERDICT[cur.value] : 'Bedöm')
    : (cur && cur.value !== 0 ? verdictPill(cur.value, cur.pending) : null);
  const row = h('div', { class: 'row' },
    h('div', { class: 'row-main' },
      h('span', { class: 'row-title' }, a.outlet || 'Okänd källa'),
      a.title ? h('span', { class: 'row-sub' }, a.title) : null),
    tierBadge(a.tier),
    pill,
    a.url ? h('a', { class: 'out-link', href: a.url, target: '_blank', rel: 'noopener noreferrer', 'aria-label': `Öppna artikeln hos ${a.outlet || 'källan'}` }, extIcon()) : null);
  const wrap = h('div', { class: 'swipe-row' }, under, row);
  if (admin) {
    gesture(row, {
      mode: 'row',
      onDrag: (dx) => {
        row.classList.add('dragging');
        row.style.transform = `translateX(${dx}px)`;
        paintUnder(under, verdictFor(dx, 0, false), dx);
      },
      onEnd: (dx) => {
        row.classList.remove('dragging');
        row.style.transform = '';
        const v = verdictFor(dx, 0, false);
        if (v != null) apply(v);
      },
    });
  }
  return frag(wrap, panel);
}

// ---------------------------------------------------------------- Arkiv
async function viewArchive(q) {
  const index = await loadIndex();
  if (!index.length) return emptyState('Inga rapporter ännu.');
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

  const present = days.map(valueOf).concat(days.map(forecastOf)).filter((v) => v != null);
  let lo = present.length ? Math.max(0, Math.floor(Math.min(...present)) - 1) : 0;
  let hi = present.length ? Math.min(10, Math.ceil(Math.max(...present)) + 1) : 10;
  if (hi - lo < 2) { lo = Math.max(0, lo - 1); hi = Math.min(10, hi + 1); }
  const px = (v) => `${Math.round(((v - lo) / (hi - lo)) * 110)}px`;
  const every = Math.ceil(days.length / 14);

  const seg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Period' },
    [['7', '7 dagar'], ['14', '14 dagar'], ['30', '30 dagar'], ['all', 'Allt']].map(([k, label]) => h('button', {
      type: 'button', 'aria-pressed': String(k === range),
      onclick: () => { location.hash = `#/arkiv?r=${k}`; },
    }, label)));

  const chart = h('section', { class: 'card card-pad', 'aria-label': 'Hotindex över tid' },
    h('div', { style: 'display:flex;justify-content:space-between;align-items:baseline' },
      h('h2', { style: 'font-size:15px;font-weight:600' }, 'Hotindex'),
      h('div', { class: 'chart-legend' },
        h('span', null, h('i', { class: 'lg-bar' }), 'I dag'),
        h('span', null, h('i', { class: 'lg-tick' }), '30 dagar'))),
    h('div', { class: 'chart', role: 'img', 'aria-label': days.map((d) => `${dateShort(d)}: ${valueOf(d) == null ? 'ingen rapport' : fmt1(valueOf(d))}`).join(', ') },
      days.map((d) => {
        const v = valueOf(d);
        const f = forecastOf(d);
        return h('div', { class: 'bar-slot', title: `${dateShort(d)}: ${v == null ? 'ingen rapport' : fmt1(v)}${f != null ? ` / ${fmt1(f)}` : ''}` },
          v == null ? h('div', { class: 'bar missing', style: 'height:60px' }) : h('div', { class: 'bar', style: `height:${px(v)}` }),
          f != null ? h('div', { class: 'bar-f', style: `bottom:${px(f)}` }) : null);
      })),
    h('div', { class: 'chart-days', 'aria-hidden': 'true' },
      days.map((d, i) => h('span', null, (days.length - 1 - i) % every === 0 ? String(toDate(d).getUTCDate()) : ''))),
    h('p', { class: 'small muted' }, `Skala ${lo}–${hi}`));

  const rows = [];
  for (let d = last; d >= first; d = addDays(d, -1)) {
    const it = byDate.get(d);
    const dayBox = h('span', { class: 'day' }, h('b', null, String(toDate(d).getUTCDate())), h('span', null, weekdayShort(d)));
    if (!it) {
      rows.push(h('div', { class: 'row', style: 'color:var(--muted)' }, dayBox, h('span', { class: 'row-main' }, h('span', { class: 'small' }, 'Ingen rapport'))));
      continue;
    }
    const f = forecastOf(d);
    rows.push(h('a', { class: 'row', href: d === last ? '#/' : `#/rapport/${d}` },
      dayBox,
      h('span', { class: 'row-main' }, h('span', { style: 'font-size:14px;line-height:1.35' }, firstSentence(it.top_sv || '', 110) || dateLong(d))),
      h('span', { class: 'vals' }, h('b', null, fmt1(valueOf(d))), f != null ? h('span', null, `30d ${fmt1(f)}`) : null)));
  }

  return frag(
    h('header', null, h('div', { class: 'kicker' }, `${dateShort(first)} – ${dateShort(last)}`), h('h1', { class: 'title-xl' }, 'Arkiv')),
    seg,
    chart,
    h('section', { class: 'section' }, h('h2', { class: 'kicker' }, 'Rapporter'), h('div', { class: 'card list' }, rows)));
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
  const reports = await loadAllReports();
  let query = q.get('q') || '';
  let topic = TOPICS.includes(q.get('t')) ? q.get('t') : '';

  const all = [];
  for (const r of reports) {
    for (const e of r.events) {
      const outlets = e.articles.map((a) => a.outlet).filter(Boolean);
      all.push({
        r, e, outlets,
        hay: norm([e.title_sv, e.summary_sv, e.title, e.detail, outlets.join(' '), e.sources, e.countries.map(countryName).join(' ')].join(' ')),
      });
    }
  }

  const input = h('input', { id: 'sok', type: 'search', value: query, placeholder: 't.ex. Milrem, Rumänien, skuggflotta', autocomplete: 'off', enterkeyhint: 'search' });
  const results = h('section', { class: 'section', 'aria-live': 'polite' });
  const chips = TOPICS.map((t) => h('button', {
    class: 'chip big', type: 'button', 'aria-pressed': String(t === topic),
    onclick: () => { topic = topic === t ? '' : t; update(); },
  }, t));

  function update() {
    for (const c of chips) c.setAttribute('aria-pressed', String(c.textContent === topic));
    const qs = new URLSearchParams();
    if (query) qs.set('q', query);
    if (topic) qs.set('t', topic);
    // Only while this view is still the one on screen: a slow first render
    // must not rewrite the address after the user has moved on.
    if (currentRoute === 'amnen' && parseHash().parts[0] === 'amnen') {
      history.replaceState(null, '', `#/amnen${qs.toString() ? `?${qs}` : ''}`);
    }
    const terms = query.trim().split(/\s+/).filter(Boolean);
    if (!terms.length && !topic) {
      results.replaceChildren(h('p', { class: 'hint' }, 'Välj ett ämne eller sök i alla rapporter.'));
      return;
    }
    const nterms = terms.map(norm);
    const hits = all.filter((x) => (!topic || x.e.topics.includes(topic)) && nterms.every((t) => x.hay.includes(t)));
    results.replaceChildren(frag(
      h('div', { style: 'display:flex;justify-content:space-between;align-items:baseline' },
        h('h2', { class: 'title-m' }, topic || 'Sökträffar'),
        h('span', { class: 'small muted' }, plural(hits.length, 'träff', 'träffar'))),
      hits.length ? null : h('p', { class: 'muted' }, 'Inga träffar.'),
      hits.slice(0, 100).map(({ r, e, outlets }) => h('a', { class: 'card result', href: eventHref(r.date, e.id) },
        h('span', { class: 'result-top' }, h('b', null, dateShort(r.date)), h('span', null, e.countries.map(countryName).join(', '))),
        h('span', { class: 'result-title' }, highlight(e.title_sv || e.title, terms)),
        h('span', { class: 'result-text' }, highlight(firstSentence(e.summary_sv || e.detail), terms)),
        outlets.length || e.sources ? h('span', { class: 'result-src' }, firstSentence(outlets.join(', ') || e.sources, 90)) : null))));
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
    h('div', { class: 'chips', role: 'group', 'aria-label': 'Ämnen' }, chips),
    results);
}

// ---------------------------------------------------------------- Karta
async function viewMap(q) {
  const reports = await loadAllReports();
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
        chevRight()))) : null));
}

// ---------------------------------------------------------------- Bedöm
const SKIP_KEY = 'hm.skipped';
function loadSkipped() { try { return new Set(JSON.parse(sessionStorage.getItem(SKIP_KEY) || '[]')); } catch { return new Set(); } }
function saveSkipped(set) { try { sessionStorage.setItem(SKIP_KEY, JSON.stringify([...set])); } catch { /* ignore */ } }
const assessHistory = []; // this session's swipes, newest last, for "Ångra"

async function viewAssess() {
  if (!isAdmin()) return adminOnly();
  await assessmentsReady;
  const reports = await loadAllReports();
  const skipped = loadSkipped();
  const cur = currentByArticle();
  const seen = new Set();
  const targets = [];
  for (const r of reports) {
    for (const e of r.events) {
      for (const a of e.articles) {
        if (!a.id || seen.has(a.id)) continue;
        seen.add(a.id);
        const c = cur.get(a.id);
        if ((c && c.value !== 0) || skipped.has(a.id)) continue;
        targets.push({ article: a, event: e, date: r.date });
      }
    }
  }

  const counter = h('span', { class: 'small muted' });
  const stack = h('div', { class: 'stack' });
  const undoBtn = h('button', { class: 'btn', type: 'button', onclick: undoLast }, 'Ångra');
  const buttonsBox = h('div');

  function updateChrome() {
    counter.textContent = targets.length ? `${targets.length} kvar` : '';
    undoBtn.hidden = !assessHistory.length;
  }

  function commit(value, card) {
    const t = targets.shift();
    if (!t) return;
    if (value === 'skip') {
      skipped.add(t.article.id);
      saveSkipped(skipped);
      assessHistory.push({ target: t, skip: true });
    } else {
      const now = currentByArticle().get(t.article.id);
      const row = assess(t, value, now || null);
      assessHistory.push({ target: t, row });
    }
    vibrate();
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (card && !reduce) {
      const dx = value === 'skip' ? 0 : value > 0 ? 1 : -1;
      card.style.transform = `translate(${dx * 520}px, ${value === 'skip' ? -700 : 40}px) rotate(${dx * 18}deg)`;
      card.style.opacity = '0';
      setTimeout(renderStack, 200);
    } else {
      renderStack();
    }
  }

  function undoLast() {
    const item = assessHistory.pop();
    if (!item) return;
    if (item.skip) {
      skipped.delete(item.target.article.id);
      saveSkipped(skipped);
    } else {
      const latest = store.assessments.find((x) => x.id === item.row.id)
        || store.assessments.find((x) => x.client_id && x.client_id === item.row.client_id)
        || item.row;
      undo(latest, item.target);
    }
    targets.unshift(item.target);
    renderStack();
  }

  function card(t, behind) {
    const e = t.event;
    const a = t.article;
    const label = h('div', { class: 'drag-label', 'aria-hidden': 'true' });
    const el = h('article', { class: `swipe-card${behind ? ' behind' : ''}`, 'aria-label': `${a.outlet || 'Källa'}: ${e.title_sv || e.title}` },
      label,
      h('div', { class: 'sc-top' }, h('span', { class: 'sc-outlet' }, a.outlet || 'Okänd källa'), tierBadge(a.tier)),
      h('div', { class: 'kicker' }, [dateShort(t.date), ...e.topics].join(' · ')),
      h('h2', { class: 'sc-title' }, e.title_sv || e.title),
      a.title ? h('p', { class: 'sc-article' }, a.title) : null,
      h('p', { class: 'sc-summary' }, e.summary_sv || e.detail || ''),
      h('div', { class: 'sc-foot' },
        h('span', null, `Modellens poäng ${fmtScore(e.model_score != null ? e.model_score : e.score)}/10`),
        a.url ? h('a', { href: a.url, target: '_blank', rel: 'noopener noreferrer' }, 'Läs artikeln') : null));
    if (!behind) {
      gesture(el, {
        mode: 'free',
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
      });
    }
    return el;
  }

  function renderStack() {
    updateChrome();
    if (!targets.length) {
      stack.replaceChildren(emptyState('Allt är bedömt.',
        h('a', { class: 'btn', href: '#/mina' }, 'Mina bedömningar'),
        skipped.size ? h('button', {
          class: 'btn', type: 'button',
          onclick: () => { skipped.clear(); saveSkipped(skipped); route(); },
        }, `Visa ${plural(skipped.size, 'överhoppad', 'överhoppade')} igen`) : null));
      stack.style.height = 'auto';
      buttonsBox.replaceChildren();
      return;
    }
    stack.style.height = '';
    stack.replaceChildren(...(targets[1] ? [card(targets[1], true)] : []), card(targets[0], false));
    buttonsBox.replaceChildren(verdictButtons((v) => commit(v, stack.lastChild),
      h('button', { class: 'a-skip', type: 'button', onclick: () => commit('skip', stack.lastChild) }, 'Hoppa över')));
  }

  renderStack();
  return frag(
    h('header', { class: 'page-head' },
      h('div', null, h('div', { class: 'kicker' }, 'Operatörsbedömning'), h('h1', { class: 'title-xl' }, 'Bedöm')),
      h('a', { class: 'head-link', href: '#/mina' }, 'Mina bedömningar')),
    h('div', { style: 'display:flex;justify-content:space-between;align-items:center;gap:8px' },
      h('p', { class: 'hint' }, 'Höger: trovärdig, längre: mycket. Vänster: tveksam, längre: inte trovärdig. Upp: hoppa över.'),
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

  const head = frag(
    backLink('#/bedom', 'Bedöm'),
    h('header', null, h('div', { class: 'kicker' }, 'Operatörsbedömning'), h('h1', { class: 'title-xl' }, 'Mina bedömningar')),
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

// ---------------------------------------------------------------- chrome
function updateChrome() {
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
}

onChange(() => {
  updateChrome();
  if ((currentRoute === 'mina' || currentRoute === 'handelse') && !isDragging()) rerender();
});

async function init() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  try {
    await loadMe();
  } catch (e) {
    document.getElementById('view').replaceChildren(errorView(e));
    return;
  }
  document.querySelector('[data-tab="bedom"]').hidden = !isAdmin();
  assessmentsReady = loadAssessments().catch((e) => { console.warn('assessments', e); });
  window.addEventListener('hashchange', () => route());
  window.addEventListener('offline', updateChrome);
  window.addEventListener('online', () => { loadMe().catch(() => {}).finally(updateChrome); });
  updateChrome();
  route();
}

init();

// Exposed for tests and debugging only.
window.__hm = { store, myRows };
