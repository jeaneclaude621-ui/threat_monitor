// Hotmonitor's functions, for the "Funktioner" menu on Idag (Version 3.19).
// Add a row here when a function is added: `added` is the day it reached
// the app, and the menu lists the last NEW_DAYS days' first. `href` is a
// route in the app; `action` names something the app does instead
// (app.js FEATURE_ACTIONS). `admin`: only admins see it. `user`: only
// people who are logged in (not guests).
export const NEW_DAYS = 10;

export const AREAS = [
  ['idag', 'Idag'],
  ['styrkor', 'Styrkor'],
  ['narrativ', 'Narrativ'],
  ['arkiv', 'Arkiv, ämnen och karta'],
  ['bedom', 'Bedöm'],
  ['admin', 'Administration'],
  ['app', 'Appen'],
];

export const FEATURES = [
  // Idag
  { id: 'hotlaget', area: 'idag', title: 'Hotläget i dag', href: '#/', added: '2026-10-01',
    desc: 'Dagens hotindex, det viktigaste och dygnets händelser med källor.', keywords: 'hotindex index rapport morgonrapport' },
  { id: 'lopande', area: 'idag', title: 'Löpande uppdateringar', href: '#/', added: '2026-11-03',
    desc: 'Bevakade trådar kontrolleras kl. 12 och 21; nytt visas under Löpande i dag.', keywords: 'trådar bevakning uppdatering nyheter' },
  { id: 'meddelanden', area: 'idag', title: 'Meddelanden', href: '#/', added: '2026-10-01',
    desc: 'Korta meddelanden från administratörerna överst på Idag.', keywords: 'notis meddelande' },
  { id: 'myndigheter', area: 'idag', title: 'Svenska myndigheter', href: '#/myndigheter', added: '2026-11-01',
    desc: 'Vad svenska myndigheter säger om hotläget, sammanfattat två gånger om dagen.', keywords: 'msb säpo försvarsmakten fra myndighet' },
  { id: 'nato', area: 'idag', title: 'Nato', href: '#/myndigheter?s=nato', added: '2026-11-01',
    desc: 'Natos egna uttalanden och lägesbilder.', keywords: 'nato allians' },
  { id: 'handlingsalternativ', area: 'idag', title: 'Rysslands handlingsalternativ', href: '#/handlingsalternativ', added: '2026-11-01',
    desc: 'Troligast, möjligt och farligast, med tecken att hålla utkik efter. Uppdateras varje dag.', keywords: 'scenario troligast farligast tecken' },

  // Styrkor
  { id: 'baser', area: 'styrkor', title: 'Ryska baser på kartan', href: '#/styrkor', added: '2026-11-01',
    desc: '431 baser i Ryssland och Belarus med förband, materiel och status.', keywords: 'bas flygbas marinbas karta' },
  { id: 'forband', area: 'styrkor', title: 'Förband och materiel', href: '#/styrkor', added: '2026-11-02',
    desc: 'Grunddatabas: tryck på ett förband eller vapensystem för beskrivning och bild.', keywords: 'förband materiel system flygplan fartyg databas' },
  { id: 'isw', area: 'styrkor', title: 'Förbandens status från ISW', href: '#/styrkor', added: '2026-11-03',
    desc: 'Var förbanden senast rapporterades, läst varje natt ur ISW:s bedömningar.', keywords: 'isw status förband front' },
  { id: 'anfall-ukraina', area: 'styrkor', title: 'Anfall mot Ukraina', href: '#/styrkor?s=anfall', added: '2026-11-04',
    desc: 'Rysslands drönar- och robotanfall natt för natt, 30 nätter bakåt.', keywords: 'drönare robotar anfallskarta ukraina flygvapnet' },
  { id: 'andra-anfall', area: 'styrkor', title: 'Andra anfall i Ryssland och ockuperade områden', href: '#/styrkor', added: '2026-11-04',
    desc: 'Raffinaderier, depåer, fabriker och hamnar som anfallits, senaste veckan.', keywords: 'raffinaderi depå fabrik hamn krim anfall' },
  { id: 'firms', area: 'styrkor', title: 'Satellitkarta, bränder (NASA FIRMS)', href: '#/styrkor', added: '2026-11-04',
    desc: 'Vid varje anfall: om satelliter sett brand, och en knapp till NASA:s karta för platsen och dagen.', keywords: 'satellit brand firms nasa' },

  // Narrativ
  { id: 'narrativ', area: 'narrativ', title: 'Narrativ, öppna källor', href: '#/narrativ', added: '2026-10-31',
    desc: 'Vad som trendar i öppna källor om Ryssland och hybridhot.', keywords: 'trender trend narrativ' },
  { id: 'narrativ-ru', area: 'narrativ', title: 'Den ryska sidan', href: '#/narrativ?s=ru', added: '2026-10-31',
    desc: 'Vad ryska kanaler driver, som svenska sammanfattningar.', keywords: 'rysk propaganda kanaler narrativ' },

  // Arkiv, ämnen och karta
  { id: 'arkiv', area: 'arkiv', title: 'Arkiv', href: '#/arkiv', added: '2026-10-01',
    desc: 'Alla tidigare dagars rapporter.', keywords: 'tidigare dagar historik rapport' },
  { id: 'amnen', area: 'arkiv', title: 'Ämnen och sök', href: '#/amnen', added: '2026-10-01',
    desc: 'Sök i alla händelser och följ ämnen och länder över tid.', keywords: 'sök ämne land filter' },
  { id: 'karta', area: 'arkiv', title: 'Karta över händelser', href: '#/karta', added: '2026-10-01',
    desc: 'Händelserna per land, senaste 7 eller 30 dagarna.', keywords: 'karta land europa' },

  // Bedöm
  { id: 'bedom', area: 'bedom', title: 'Bedöm källor', href: '#/bedom', added: '2026-10-01', admin: true,
    desc: 'Svep för att bedöma nyheternas trovärdighet; påverkar hotindex.', keywords: 'bedömning svep trovärdighet' },
  { id: 'bedom-skala', area: 'bedom', title: 'Skalan i Bedöm förklarad', href: '#/bedom', added: '2026-11-05', admin: true,
    desc: 'Bedöm om påståendet stämmer enligt källan, inte om utgivaren är seriös. En mening per värde.', keywords: 'bedöm skala värde trovärdig tveksam' },
  { id: 'styrkor-uppgift', area: 'styrkor', title: 'Uppgifter med en källa och normal brandnivå', href: '#/styrkor', added: '2026-11-05',
    desc: 'Ändringar med bara en källa visas som uppgift och listan ändras inte. Vid satellitbränder står hur många brandpunkter som är normalt veckan före.', keywords: 'styrkor uppgift källa brand satellit firms normalt' },
  { id: 'mina', area: 'bedom', title: 'Mina bedömningar', href: '#/mina', added: '2026-10-01', admin: true,
    desc: 'Det du har bedömt, och hur det stämde.', keywords: 'bedömningar historik' },

  // Administration
  { id: 'status', area: 'admin', title: 'Systemstatus', href: '#/admin?s=status', added: '2026-10-12', admin: true,
    desc: 'Körningarna, larm och när rapporten senast kom.', keywords: 'status körning larm' },
  { id: 'kallor', area: 'admin', title: 'Källor', href: '#/admin?s=sources', added: '2026-10-24', admin: true,
    desc: 'Lägg till egna nyhetskällor. Telegram och rysk statsmedia tas inte emot.', keywords: 'källa rss flöde telegram' },
  { id: 'anvandare', area: 'admin', title: 'Användare', href: '#/admin?s=users', added: '2026-10-01', admin: true,
    desc: 'Bjud in och hantera vilka som kan logga in.', keywords: 'användare inbjudan konto' },
  { id: 'admin-meddelanden', area: 'admin', title: 'Skicka meddelande', href: '#/admin?s=notices', added: '2026-10-01', admin: true,
    desc: 'Ett meddelande överst på Idag, med notis om du vill.', keywords: 'meddelande notis push' },
  { id: 'sakerhet', area: 'admin', title: 'Säkerhet och logg', href: '#/admin?s=security', added: '2026-10-01', admin: true,
    desc: 'Nekade inloggningar och vad administratörerna har gjort.', keywords: 'säkerhet logg' },

  // Appen
  { id: 'introduktion', area: 'app', title: 'Kort introduktion', action: 'intro', added: '2026-11-05',
    desc: 'Tre kort om vad Hotmonitor är, hur siffrorna läses och hur du får notiser.', keywords: 'introduktion välkommen hjälp kom igång' },
  { id: 'rattelser', area: 'app', title: 'Rättelser', href: '#/rattelser', added: '2026-11-05',
    desc: 'Händelser där en uppgift har rättats. Rättelsen står också överst på händelsen.', keywords: 'rättelse fel ändring korrigering' },
  { id: 'kallhanvisning', area: 'idag', title: 'Källa vid varje uppgift', href: '#/', added: '2026-11-05',
    desc: 'Under Vad vi vet visar små länkar vilken artikel varje uppgift kommer från.', keywords: 'källa hänvisning vad vi vet artikel' },
  { id: 'trovardighetstak', area: 'idag', title: 'Varför trovärdigheten är begränsad', href: '#/om?s=index', added: '2026-11-05',
    desc: 'Vid poängen står hur många oberoende källor det finns, t.ex. ”Högst 6: en oberoende källa”.', keywords: 'trovärdighet oberoende källor högst tak poäng' },
  { id: 'fler-handelser', area: 'idag', title: 'Fler händelser i dag', href: '#/', added: '2026-11-05',
    desc: 'Mindre nyheter från dygnet, hopfällda under händelselistan.', keywords: 'fler händelser nyheter övrigt' },
  { id: 'folj', area: 'app', title: 'Notiser utan konto, följ ämnen och länder', action: 'settings', added: '2026-11-05',
    desc: 'Slå på notiser utan att logga in, och välj vilka ämnen och länder du vill få notiser om.', keywords: 'notis gäst följ ämne land push' },
  { id: 'rss', area: 'app', title: 'RSS-flöde', href: '#/om?s=rss', added: '2026-11-05',
    desc: 'Dagens rapport i din nyhetsläsare.', keywords: 'rss flöde nyhetsläsare feed' },
  { id: 'tillbaka', area: 'app', title: 'Pil bakåt på alla sidor', href: '#/arkiv', added: '2026-11-05',
    desc: 'Pilen uppe till vänster tar dig tillbaka dit du var, på samma ställe på sidan.', keywords: 'tillbaka bakåt pil navigering' },
  { id: 'dela', area: 'app', title: 'Dela en händelse eller dagens läge', href: '#/', added: '2026-11-05',
    desc: 'Knappen Dela på händelsesidan och på Idag skickar en länk, eller kopierar den.', keywords: 'dela länk skicka kopiera' },
  { id: 'siffran', area: 'idag', title: 'Vad betyder siffran?', href: '#/om?s=index', added: '2026-11-05',
    desc: 'Hotindex skala 1–10 i klartext, och att händelsernas siffra är trovärdighet.', keywords: 'hotindex skala trovärdighet poäng förklaring' },
  { id: 'integritet', area: 'app', title: 'Integritetspolicy', href: '#/om?s=integritet', added: '2026-11-05',
    desc: 'Vilka uppgifter som sparas, varför, hur länge och vem som hjälper till.', keywords: 'integritet gdpr personuppgifter radera utdrag' },
  { id: 'funktioner', area: 'app', title: 'Funktioner och nyheter', action: 'features', added: '2026-11-05',
    desc: 'Den här menyn: det nya först, sedan allt, sökbart.', keywords: 'meny hjälp sök funktioner' },
  { id: 'gast', area: 'app', title: 'Läs utan att logga in', href: '#/om', added: '2026-11-03',
    desc: 'Appen är öppen för alla att läsa. Logga in för notiser och för att bedöma.', keywords: 'gäst inloggning öppen' },
  { id: 'om', area: 'app', title: 'Om Hotmonitor och AI', href: '#/om', added: '2026-11-03',
    desc: 'Vad appen är, hur AI används, källor och integritet.', keywords: 'om ai integritet källor' },
  { id: 'notiser', area: 'app', title: 'Notiser', action: 'settings', added: '2026-10-01', user: true,
    desc: 'Notis när hotindex ändras mycket eller en allvarlig händelse kommer.', keywords: 'notis push larm klocka' },
  { id: 'hemskarm', area: 'app', title: 'Lägg till på hemskärmen', action: 'install', added: '2026-10-01',
    desc: 'Öppna Hotmonitor som en app från telefonens hemskärm.', keywords: 'hemskärm installera app' },
];
