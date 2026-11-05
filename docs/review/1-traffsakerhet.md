# Granskning 1: träffsäkerhet och källkritik

*Granskat 2026-11-05 på grenen `oversyn-traffsakerhet`, mot main i det skick
den hade då. Ingen kod är ändrad. Radnummer gäller den versionen.*

## Sammanfattning

Hotmonitor har en bra grund. Modellen söker inte själv: den läser en
numrerad artikellista som koden har hämtat (`src/news_sources.py:1-17`).
Länkar sätts bara på artiklar som modellen citerar med ett ref som finns i
listan (`src/app_data.py:113-167`). Hotindex hålls till ankarband med
kodkontroller (`src/daily_report.py:185-238`), och operatörens påverkan har
tak i kod (`src/operator_weight.py:248-259`). Styrkor, Myndigheter och
Kurser kräver ref per post.

Inför en lansering till allmänheten finns ändå sju brister som kan ge
läsaren en felaktig bild. De är rangordnade efter allvar:

1. **En händelse kan visas med källor som aldrig hämtades.** En artikel
   vars ref inte matchar listan sparas ändå, utan länk men med modellens
   egen rubrik och utgivare (`src/app_data.py:141-156`). Fältet `sources`
   i fritext tolkas också till "artiklar" (`src/app_data.py:137`,
   `89-105`). Läsaren ser alltså utgivarnamn som kan vara påhittade.
2. **Trovärdighetsvärdet är i praktiken utgivarens nivå, inte
   korsverifiering.** Prompten säger "Credibility tiers to use when
   scoring each item (1-10)" (`src/daily_report.py:336-337`), där nivå 1
   är 9-10. En enda Reuters-artikel kan alltså ge 9-10. Skalan "10 =
   confirmed by 10+ independent outlets" (`config/methodology.json:5`)
   finns i konfigurationen men används ingenstans i koden. Inget i koden
   kräver två oberoende källor.
3. **Rysk statsmedia filtreras bara bort ur appens egna källor.** Google
   News- och GDELT-träffar i dygnsrapporten, trådbevakningen och
   självkontrollen går rakt in i prompten utan filter
   (`src/news_sources.py:295-318`, `272-292`, `src/daily_report.py:53-55`).
   Spärren mot TASS, RT och liknande vilar där bara på systemprompten
   (`src/daily_report.py:35-40`).
4. **Ingen versionsstämpel för modellen.** När huvudmodellen byts mot
   lite-modellen syns det bara i körloggen (`src/common.py:226`). Det
   syns inte i rapporten, i appen eller för läsaren.
5. **Operatörens påverkan på index är större än taket ±0,3.** Operatörens
   justering av händelsepoängen görs *före* bandkontrollen
   (`src/daily_report.py:404-405`). En svepning kan därför lyfta en
   händelse över eller under gränsen 7 (`MIN_BAND_SCORE`,
   `src/daily_report.py:181`), och då flyttas hela bandet med 1,0.
6. **Taket för operatörens påverkan slår snett.** En höjning stoppas
   nästan alltid av placeringstaket (band +0,1), medan en sänkning har
   0,5 att röra sig på. Det förklarar loggraden "computed X, applied
   +0.0" (se avsnitt 4).
7. **Ingen mätning av träffsäkerhet mot facit.** Självkontrollen låter
   samma modell bedöma sina egna påståenden från gårdagen, utifrån
   artiklar som har hämtats med påståendets egna ord
   (`src/daily_report.py:46-104`). Rättelser syns inte på den publicerade
   händelsen.

De fem förslag som ger mest nytta för minst arbete (detaljer i avsnitt 5):
släng händelsens källor som inte går att verifiera, räkna trovärdigheten i
kod från oberoende verifierade källor, filtrera statsmedia på ett ställe
för alla vägar in, stämpla modellen på varje utdata och kör
bandkontrollen på modellens egen poäng.

---

## 1. Hur källor väljs och vägs

### Källnivåer

Nivåerna finns i `config/methodology.json:6-75`:

| Nivå | Poäng | Exempel |
|---|---|---|
| 1 Nyhetsbyrå/primär | 9-10 | Reuters, AP, AFP, BBC |
| 2 Större medier | 7-9 | Al Jazeera, DW, NATO.int, ministerier |
| 3 Part i saken | 5-7 | Kyiv Independent, Kyiv Post, Moscow Times |
| 4 Opinion/analys | 3-4 | Substack, tankesmedjor, bloggar |
| Utesluten | 1-2 | Sputnik, RT, TASS, anonyma Telegram/X |

Därtill finns svenska namngivna källor (`config/methodology.json:145-210`),
till exempel TT (nivå 1), SVT, SR, DN, SvD och myndigheterna (nivå 2), samt
Cornucopia (nivå 4, "never sole confirmation"). Flödena i
`config/feeds.json` har ett `tier`-fält.

**Problem med hur nivåerna används:**

- **Nivån sätts av modellen, inte av koden.** Artikellistan som modellen
  ser innehåller bara `[A12] Utgivare · datum · rubrik - sammanfattning`
  (`src/news_sources.py:255-256`). Nivån från `feeds.json` följer inte
  med. Modellen gissar nivån från utgivarnamnet, och koden tar modellens
  `tier` som den är (`src/app_data.py:149`, `155`). Utgivare som inte
  finns i listan, till exempel Yahoo, MSN, Devdiscourse eller lokala
  sajter från GDELT, får en nivå som ingen har bestämt.
- **Utgivarnivå och händelsens trovärdighet blandas ihop.** Se punkt 2 i
  sammanfattningen. Hur bra en källa brukar vara säger inget om huruvida
  just den här uppgiften har bekräftats. En Reuters-artikel som skriver
  "enligt ryska Telegramkanaler" kan ändå ge 9.
- **Aggregatorer och syndikering.** I `Pool.add` sållas dubbletter bort
  bara på exakt länk eller exakt rubrik (`src/news_sources.py:228-236`).
  Samma AP- eller Reuters-text i tjugo tidningar, med olika rubriker, ser
  ut som tjugo oberoende källor. Ingen kod sammanför syndikerade texter
  eller räknar oberoende ursprung. Varningen för aggregatorer ("Magzter,
  HurBra") finns bara i myndighetsprompten (`src/authorities.py:244-245`),
  inte i dygnsrapporten.

### Rysk statsmedia och Telegram

Det finns fyra olika spärrlistor, och de täcker olika vägar:

| Var | Lista | Vad den skyddar |
|---|---|---|
| `src/news_sources.py:156-164` | `BLOCKED_HOSTS` (värdnamn) | bara källor som lagts till i appen (`:178`) |
| `src/forces.py:104-105`, `:339` | `STATE_MEDIA` (regex, med Kommersant och Interfax) | Styrkors nattliga artiklar |
| `src/strikes.py:200`, `:215` | `STATE_MEDIA` (kortare regex) | preliminära anfallsnätter |
| `src/forces_db_check.py:28` | `BANNED` | grunddatabasens filer |

**Brist:** `for_daily` och `for_thread` (`src/news_sources.py:272-318`)
filtrerar inte Google News- eller GDELT-träffar alls. En TASS-artikel som
Google News eller GDELT (`source` = `tass.com`) ger kommer med i prompten.
Bara systemprompten (`src/daily_report.py:35-40`,
`src/hourly_monitor.py:24-29`) ber modellen att inte räkna den. För Google
News hjälper värdnamnsfiltret inte heller, eftersom länken går till
`news.google.com`. Där måste man filtrera på utgivarnamnet (`source`).

Listorna saknar också hela det prokremlska nätverket utanför de stora
statskanalerna, till exempel "Pravda"-nätverket (Portal Kombat), News
Front, lenta.ru, gazeta.ru, kp.ru, aif.ru och ukraina.ru. Det är just
sådana sajter som GDELT plockar upp.

Narrativ (`src/trends.py`) läser ryska Telegramkanaler, men är
avsiktligt isolerat: "Nothing here feeds the daily report"
(`src/trends.py:14-16`). Kurser läser inte trends (`src/courses.py:20-21`).
Det är rätt gjort.

### Kan en ensam eller svag källa bära en händelse?

**Ja, i dygnsrapporten.**

- Inget i koden kräver mer än en artikel per händelse. `drop_repeated_articles`
  låter till och med en händelse stå kvar med gamla artiklar om alla nya
  skulle försvinna (`src/daily_report.py:533-549`).
- Artiklar som lagts till i appen läses med upp till 1 500 tecken text
  (`src/news_sources.py:43`, `:254`), medan övriga får 300. Det enda som
  spärras där är Telegram och statsmedia. En YouTube-, X-, Facebook- eller
  Substack-länk som läggs in under Källor väger alltså tyngre i prompten
  än en Reuters-rubrik.
- YouTube och sociala medier spärras bara i Styrkor, och där bara för
  anfall och "övrigt" (`src/forces.py:446-475`, `:490`, `:536`).
  Uppföljningar och förbandsändringar tar vilken källa som helst
  (`src/forces.py:503`, `:516`). En enda artikel räcker för att ta bort
  materiel från en bas eller flytta ett förband (`src/forces.py:510-535`).
- Trådbevakningen citerar inga artiklar alls (`record=False`,
  `src/hourly_monitor.py:126`). "outlets" är fritext från modellen
  (`:66`, `:174`). Sammanfattningarna går ändå ut i appens "Löpande i dag"
  (`:180-182`, `:198`) och in i dygnsrapportens prompt som underlag
  (`src/daily_report.py:349-351`, "factor them in").

---

## 2. Hur händelser, sammanfattningar, index och trovärdighet tas fram

### Kedjan

1. Artiklar samlas (`src/daily_report.py:586-589`) och numreras
   (`src/news_sources.py:243-259`). De senaste 450 hamnar i prompten.
2. Självkontroll av gårdagen (`src/daily_report.py:46-104`).
3. Svepet (`src/daily_report.py:298-412`), ett anrop med upp till
   22 000 utdatatoken. Det ger upp till sex händelser med
   `score`, svenska texter, `known_sv`/`unknown_sv`, `direction`, artiklar
   med ref, båda indexen och bandmotiveringen.
4. Kodsteg: `enforce_bands` (`:185-195`), `enrich_events` (länkkontroll,
   `src/app_data.py:113-167`), `drop_repeated_articles` (`:533`),
   operatören på händelser (`src/operator_weight.py:318-370`),
   `apply_index_rules` (`:202-238`) och operatören på index
   (`src/operator_weight.py:392-429`).
5. Därefter Executive-sammanfattningen (`src/executive_sv.py:67-77`), som
   uttryckligen ska ha "inga källhänvisningar i meningarna"
   (`src/executive_sv.py:61`), samt Kurser, Styrkor och Anfall.

### Var modellen kan hitta på, överdriva eller blanda ihop

| Risk | Var | Kodskydd i dag |
|---|---|---|
| Påhittad utgivare eller rubrik | `articles[]` utan giltigt ref | **Inget.** Posten behålls utan länk (`src/app_data.py:141-156`) |
| Påhittade källor i fritext | `sources` | Tolkas till artiklar om `articles` saknas (`src/app_data.py:137`) |
| Fel nivå på källan | `articles[].tier` | Bara intervallet 1-4 kontrolleras (`src/app_data.py:155`) |
| Fel publiceringsdatum | `articles[].published` | Bara formatet kontrolleras (`src/app_data.py:159`), inte mot artikelns verkliga datum i listan |
| Uppblåst trovärdighet | `score` | Inget tak kopplat till antal eller nivå på verifierade källor |
| Påstående utan stöd i artikeln | `detail`, `known_sv`, `summary_sv` | Inget krav på ref per påstående |
| Två händelser blandas ihop | en händelse med artiklar om olika saker | `relation` (bekräftar/motsäger/tillför) sätts av modellen och kontrolleras inte |
| Gammal nyhet tas upp som ny | odaterade artiklar | `Pool.since` behåller odaterade (`src/news_sources.py:238-240`); ingen URL-datumkontroll som den i `src/authorities.py:262-270` |
| Hourly-sammanfattningar som underlag | `hourly_summary` | Inga ref; går in som underlag (`src/daily_report.py:313`, `349-351`) |
| Sammanfattning som glider | `new_snapshot` | Skrivs över av modellen varje körning (`src/hourly_monitor.py:191-192`). Fel ackumuleras och blir nästa körnings "kända läge" |
| Executive och översikter | `executive_sv`, `overall_sv`, `nato_overall_sv`, Kursernas text | Inga ref |

**Det som är bra:** länkar kan inte hittas på (`src/common.py:41-45`,
`src/app_data.py:147`). Styrkor kräver ref för varje post
(`src/forces.py:424`, `454-463`). ISW-statusen måste gälla ett känt
förband, ha ett datum inom gränsen och peka på ISW
(`src/forces_isw.py:188-211`). Myndigheter kräver ref, har en kontroll av
gamla nyheter och skriver "via" när uppgiften kommer från medier
(`src/authorities.py:258-284`). Kurser begränsar ändringar i sannolikhet
till ett steg per dygn och knyter tecknen till ref (`src/courses.py:7-17`,
`:160-162`). Anfallsnätterna märks preliminära och får inga summeringar
mellan nätter (`src/strikes.py:225-244`).

**Smärre fel som ger en falsk bild:**

- `src/forces_isw.py:205-206`: URL:en kommer från modellen och bara
  domänen kontrolleras. Använd den URL som faktiskt hämtades
  (`fetch_latest`, `:142-157`).
- `src/forces_firms.py:2`, `:7`: Modulen kallas "satellite confirmation".
  Raffinaderier och industrier facklar dygnet runt, och
  `match` (`:54-76`) jämför inte med normalläget före anfallet. En
  FIRMS-träff vid ett raffinaderi bevisar alltså inget anfall. Jämför med
  dygnen före, och skriv "brand sedd", inte "bekräftad".
- Slutpoängen visas med en decimal, till exempel 9,3
  (`src/operator_weight.py:365-366`, `webapp/CONTRACT.md:25`). Det ger
  en precision som underlaget inte har.

### Hur indexet tas fram

Modellen väljer band och placering. Koden ser till att placeringen ligger
inom ±0,5 från bandet (`src/daily_report.py:185-195`). Om inget i
underlaget når poäng 7 och inget bestående villkor anges sänks bandet med
ett (`:213-223`). Över band +0,1 krävs ett namngivet villkor från nästa
band (`:224-232`). Tidigare värden visas inte för modellen (`:301-304`).
Det är genomtänkt.

**Svagheter:**

- "band_standing_conditions" kontrolleras inte. Modellen kan ange vilket
  villkor som helst med vilket datum som helst, och då klarar sig bandet
  (`src/daily_report.py:217-218`).
- Bandkontrollen litar på `score`, och den sätts av modellen och
  operatören, inte av källäget (se avsnitt 4).
- Ett hopp på 1,5 eller mer, och att inga nedtrappande faktorer finns,
  ger bara en loggrad (`:408-411`). Läsaren ser inget.

### Kontroller som finns och saknas

| Krav | Status |
|---|---|
| Källa per påstående | **Saknas.** Bara per händelse, och utan krav |
| Datumkontroll | Delvis: Pool 26 h (`src/news_sources.py:313`). Odaterade släpps igenom; artikeldatumet kontrolleras inte |
| Dubblettkontroll, artikel | Exakt länk/rubrik (`src/news_sources.py:228-236`) |
| Dubblettkontroll, händelse över dagar | Bara en instruktion i prompten (`src/daily_report.py:367-372`) och att citerade länkar tas bort (`:533`) |
| Korsverifiering, oberoende källor | **Saknas i kod** |
| Självkontroll i efterhand | Finns, men samma modell bedömer sig själv (se nedan) |

**Självkontrollen** (`src/daily_report.py:46-104`) söker med de åtta
första orden i påståendets rubrik (`:55`). Det ger artiklar som upprepar
samma påstående, och då klassas det lätt som CONFIRMED. `accuracy_pct` är
modellens egen siffra (`:91`) och räknas inte om i kod från resultaten.
CONTRADICTED påverkar morgondagens band (`:597-600`), men gårdagens
publicerade händelse ändras inte. Det finns ingen rättelse på den.

---

## 3. När kvoten tar slut eller modellen är överbelastad

### Så fungerar det

- Huvudmodellen `gemini-3.8-flash`, 20 anrop per dygn
  (`src/common.py:26`, `BACKLOG.md:102-108`).
- Ett anrop på huvudmodellen som får 429 utan retryDelay, en dygnskvot
  (PerDay) eller 5xx fler än 2 gånger (`src/common.py:35`, `255-265`)
  flyttas till `lite_model()`. Det är den nyaste flash-lite som nyckeln
  har tillgång till (`src/common.py:171-192`, `219-230`).
- Gäller alla anrop med `model=None`: svepet, självkontrollen,
  watchlist, förslaget, Executive, Myndigheter, Kurser och Styrkor.
  Trådbevakningen och Narrativ går tvärtom: lite först, huvudmodellen som
  reserv (`src/hourly_monitor.py:146-147`, `src/trends.py:348-350`).
- `ask_model_json` gör ett extra anrop om JSON-svaret inte går att tolka
  (`src/common.py:278-293`). Det tar också av kvoten och kan landa på den
  andra modellen. Ett svep kan alltså skrivas av två olika modeller.
- Styrkor har en egen reservväg (`src/forces.py:761-775`). Den är
  överflödig, eftersom `ask_model` redan byter modell.

### Kvalitetsrisker med lite-modellen

- Dygnssvepet är det tyngsta anropet: 450 artiklar, ett tjugotal fält per
  händelse, banddisciplin och svensk text, med `max_tokens=22000`
  (`src/daily_report.py:398`). En mindre modell
  - följer sämre regeln om ref, och då växer andelen olänkade "källor"
    (avsnitt 2);
  - blandar oftare ihop händelser och sätter nivåer på källor fel;
  - följer sämre placeringsregeln. Koden fångar en del (`enforce_bands`),
    men inte fritt angivna `band_standing_conditions`;
  - kortar oftare av utdata (MAX_TOKENS ger bara en loggrad,
    `src/common.py:234-235`), och svaret kan tolkas om från en avkortad
    text.
- Självkontrollen på lite-modellen ger sämre facit, och den matar ändå
  nästa dags band och operatörens träffsäkerhet
  (`src/daily_report.py:644-645`).

### Hur det syns för läsaren

**Inte alls.** `report_data` (`src/daily_report.py:621-648`) har inget fält
för modell eller version. Ingen annan utdata har det heller (inget
`model`-fält i `src/`). Bytet syns bara som en rad i Actions-loggen
(`src/common.py:226`). Läsaren kan inte se att en rapport är skriven av
reservmodellen, och ägaren kan inte i efterhand jämföra kvaliteten mellan
modellerna.

---

## 4. Operatörsbedömningarna (Bedöm) och index

### Så fungerar det

Operatören sveper artiklar: +2, +1, −1, −2, och 0 för att återkalla. Raderna
hämtas till `data/operator_assessments.jsonl` (`src/app_sync.py:63-88`).
Varje bedömning halveras i vikt var 30:e dag (`src/operator_weight.py:304-310`).

**På händelser** (`src/operator_weight.py:318-370`):
- En bedömning av samma artikel väger 1,0. Annars väger bedömningar av
  samma utgivare 0,35 (`:335-342`).
- Effekt per bedömning = värde/2 × vikt (`:349`). Medelvärdet tas per
  artikel och sedan över de artiklar som har någon bedömning (`:358-360`).
- Poängen flyttas högst ±1 (`:361-366`). `divergent` sätts när operatören
  och modellen tydligt är oense (`:362-363`).

**På index** (`src/operator_weight.py:392-429`):
- Bara händelser som eskalerar eller trappar ned och som har en bedömning
  räknas med (`:403-405`).
- `computed = 0,3 × medel(riktning × signal)` (`:406`).
- Resultatet klämms till `index_range` (`:411-415`). Där
  `next_band_partial` saknas är det **[band − 0,5, band + 0,1]**
  (`src/daily_report.py:233-236`).
- Raden "Operator effect on index: computed X, applied +0.0" skrivs när
  `computed ≠ 0` (`:427-428`).

### Varför det nästan alltid blir "applied +0.0"

1. **Artikelbedömningar träffar nästan aldrig.** Artikelns id är en hash
   av dess URL (`src/app_data.py:73-75`). Operatören bedömer artiklar i
   tidigare rapporter, men dagens rapport får inte citera dem igen:
   prompten säger åt modellen att undvika det (`src/daily_report.py:367-372`),
   och koden tar bort dem (`:533-549`). Därför återstår nästan bara
   utgivarbedömningar, med vikten 0,35 × avklingning.
2. **Effekten blir för liten för att synas.** Ett räkneexempel: +2 på
   Reuters för 15 dagar sedan ger 1 × 0,35 × 0,71 ≈ 0,25 i signal. Det
   ger computed = 0,3 × 0,25 ≈ 0,07 på index. Det avrundas till 0,1 om det
   finns utrymme, och blir 0,0 när flera händelser utan tydlig riktning
   drar ned medelvärdet.
3. **Det finns inget utrymme uppåt.** Utan ett villkor från nästa band
   ligger taket på band + 0,1, och modellen placerar ofta i mitten av
   bandet (−0,1 till +0,1) eller får sitt värde kapat till +0,1
   (`src/daily_report.py:228-229`). Då är `hi − idx` 0 till 0,2, och en
   höjning klipps bort. En sänkning har däremot upp till 0,5 att röra sig
   på. Operatörens påverkan blir alltså **asymmetrisk och drar nedåt**.
4. Indexet avrundas till en decimal före jämförelsen (`:413-415`). Små
   effekter försvinner.

**Fungerar det som avsett? Bara delvis.**

- Taket ±0,3 och "aldrig utanför bandet" stämmer i `apply_to_index`. Men
  **operatörens poängändring görs före bandkontrollen**
  (`src/daily_report.py:404` före `:405`). Lyfts en händelse från 6,8
  till 7,1 kan den hålla upp bandet. Sänks den från 7,2 till 6,9 kan
  bandet tappa 1,0. Det strider mot löftet i `webapp/CONTRACT.md:104-108`
  ("Index: at most +/-0.3", "the operator can never alone make a claim
  confirmed").
- **Operatören räknas två gånger.** Bedömningarna står i prompten med
  "Give them HIGH weight" (`src/daily_report.py:353-360`), och koden lägger
  sedan på dem igen. Prompten säger visserligen att effekten läggs på i
  kod, men samtidigt att modellen ska ge dem hög vikt. Det är motsägelsefullt.
- **Trovärdighet blandas med eskalering.** En positiv bedömning av
  utgivaren bakom en eskalerande händelse höjer index
  (`src/operator_weight.py:396-399`). Logiken håller ("om det stämmer
  pekar det uppåt"), men en utgivarbedömning för länge sedan flyttar då
  index för alla framtida händelser från den utgivaren.
- `divergent` visas, men ändrar inget (`webapp/CONTRACT.md:108`). Det är
  rimligt, men det borde också sänka händelsen till "obekräftad" i appen.

---

## 5. Förbättringar i nyttoordning

Insats: **S** < 1 dag, **M** 1-3 dagar, **L** > 3 dagar.

| # | Vad | Varför | Filer | Insats |
|---|---|---|---|---|
| 1 | **Bara verifierade källor.** Släng artiklar utan matchande ref, i stället för att visa dem olänkade. Använd inte `parse_sources` för nya rapporter. En händelse utan någon verifierad artikel tas bort, eller märks "Obekräftad – ingen hämtad källa" | Ta bort risken för påhittade källor | `src/app_data.py:137-156`, `src/daily_report.py:401` | S |
| 2 | **Räkna trovärdigheten i kod.** Ta nivån från `feeds.json`/`named_sources` och en utgivartabell, inte från modellen. Tak: 1 oberoende källa ≤ 6, nivå 3-4 ensam ≤ 5, **≥ 7 kräver två oberoende källor (olika ursprung) varav en nivå 1-2**, ≥ 9 kräver tre. Modellens `score` blir ett förslag som klämms | Minst två oberoende källor för höga värden; gör `MIN_BAND_SCORE` meningsfull | `src/app_data.py`, `src/daily_report.py:336-337`, `config/methodology.json:5` | M |
| 3 | **En gemensam spärrlista för statsmedia och prokremlska sajter**, på värdnamn och utgivarnamn, i `Pool.add`, så att den gäller alla vägar: flöden, Google News, GDELT, appen, Styrkor och Anfall. Lägg till Pravda-nätverket, News Front, lenta, gazeta, kp, aif och ukraina.ru | Ett hål i dag (avsnitt 1); fyra listor som spretar | `src/news_sources.py:156-164`, `:228`, `src/forces.py:104`, `src/strikes.py:200`, `src/forces_db_check.py:28` | S |
| 4 | **Stämpla modellen.** `common.ask_model` sparar vilken modell som svarade, och om reservmodellen användes. Lägg `generated_by: {model, fallback_used, prompt_version, code_sha}` i `report_data` och övriga utdata. Visa "Skriven av reservmodell – lägre säkerhet" i appen och i mejlet | Läsaren och ägaren ser kvaliteten; behövs för mätning (#10) | `src/common.py:200-237`, `src/daily_report.py:621-648`, `src/hourly_monitor.py`, `src/authorities.py`, `src/courses.py`, `src/forces.py`, `webapp/CONTRACT.md` | S |
| 5 | **Kör bandkontrollen på `model_score`**, inte på poängen efter operatörens justering. Byt ordning eller använd `model_score` i `apply_index_rules`. Ta bort "Give them HIGH weight" i prompten, eller ta bort koden: välj en av dem | Håller taket ±0,3 som CONTRACT lovar; ingen dubbelräkning | `src/daily_report.py:216`, `:353-360`, `:404-405` | S |
| 6 | **Symmetriskt utrymme för operatören.** Klämm till [idx − 0,3, idx + 0,3] ∩ [band − 0,5, band + 0,5], inte till placeringstaket. Logga också varför "applied" blev 0 (tak, avrundning eller utan riktning) | Förklarar och rättar "computed X, applied +0.0" | `src/operator_weight.py:406-429`, `src/daily_report.py:233-236` | S |
| 7 | **Märk obekräftat tydligt.** Visa `unknown_sv` överst. En märkning "Obekräftad" (en källa, nivå 3-4, `divergent`, eller självkontrollen UNRESOLVED/CONTRADICTED) syns på kortet. Visa poängen som heltal eller i ord (låg/måttlig/hög) | Läsaren ska inte läsa ett påstående som fakta | `src/app_data.py`, `webapp/` (appen), `webapp/CONTRACT.md` | M |
| 8 | **Rättelser och ändringslogg.** När självkontrollen ger CONTRADICTED läggs `correction: {date, note, refs}` på den ursprungliga händelsen och rapporten skickas om. En sida "Rättelser" i appen. Logga också varje ändring av metoden (`accepted_changes`) med datum | Ger en sann bild över tid och bygger förtroende | `src/daily_report.py:46-104`, `src/app_sync.py:104`, `webapp/` | M |
| 9 | **Källa per påstående.** `known_sv` blir `[{text, refs}]`. Koden släpper bara meningar vars ref finns. Gör samma sak för `detail` och Executive (tillåt ref eller hänvisa till händelsen) | "Varje händelse dokumenterad med källor" på påståendenivå | `src/app_data.py:170-197`, `src/daily_report.py:375-377`, `src/executive_sv.py:61`, `webapp/` | M |
| 10 | **Mät precision.** Ägaren eller en granskare märker ett slumpurval av händelser varje vecka (stämmer, delvis, fel, källa saknas). Räkna precision per modell (#4), per nivå och per ämne. Byt ut `accuracy_pct` från modellen mot en siffra som koden räknar fram | Ingen mätning finns i dag; självkontrollen bedömer sig själv | ny `src/precision.py`, `src/daily_report.py:89-95`, `webapp/` | M |
| 11 | **Regressionstester med kända fall.** Fixturer med sparade artikellistor och modellsvar: påhittat ref, TASS via Google News, en ensam nivå 4-källa, en syndikerad AP-text i tio tidningar, en gammal nyhet med nytt datum, en lite-modell som kortar av svaret. Tester för `enrich_events`, `apply_index_rules`, `apply_to_index` och spärrlistan. I dag finns bara tester för Styrkor och `news_sources` (`tests/`) | Fångar återfall innan de når läsaren | `tests/`, `tests/fixtures/` | M |
| 12 | **Oberoendekontroll.** Sammanför syndikerade texter (likhet i rubrik och ingress, eller "(AP)"/"Reuters" i texten) till ett ursprung innan källorna räknas. Kartlägg aggregatorer (MSN, Yahoo, Devdiscourse) till ursprunglig utgivare eller vikta ned dem | Krävs för att #2 ska mäta oberoende på riktigt | `src/news_sources.py:224-259`, `src/app_data.py:20-70` | M |
| 13 | **Datumkontroll.** Skriv över modellens `published` med artikelns verkliga datum ur listan. Släpp odaterade artiklar bara om de kommer från appen. Kontrollera datum i URL:en på samma sätt som `src/authorities.py:116-130` | Gamla nyheter i nytt datum | `src/news_sources.py:238-240`, `src/app_data.py:159`, `src/daily_report.py` | S |
| 14 | **Trådbevakning med ref.** `prompt_block(record=True)` per tråd (egen lista) och `refs` per uppdatering. Uppdateringar utan ref går inte till appen. Spara historiken för `new_snapshot` i stället för att skriva över den, och visa inte hourly-sammanfattningar som underlag i svepet utan ref | Stoppar fel som glider från körning till körning; "Löpande i dag" får källor | `src/hourly_monitor.py:66-72`, `:126`, `:180-192`, `src/daily_report.py:313` | M |
| 15 | **Sociala medier aldrig ensamma**, i hela kedjan. Använd `forces.is_news` gemensamt i `Pool`/`enrich_events`, och även för uppföljningar och förbandsändringar i Styrkor. Två oberoende källor krävs för att ta bort eller flytta materiel | YouTube/X/Substack via appen kan i dag bära en händelse | `src/forces.py:446-451`, `:503`, `:516`, `src/news_sources.py:198-218`, `src/app_data.py` | S |
| 16 | **Kontrollera bestående villkor.** Ett `band_standing_conditions` måste peka på en händelse i en tidigare rapport (id), annars räknas det inte | Annars kan modellen hålla uppe bandet med vad som helst | `src/daily_report.py:217`, `:138-141` | S |
| 17 | **ISW-länken och FIRMS.** Använd den hämtade ISW-URL:en. För FIRMS: jämför med 7 dygn före anfallet och byt texten till "brand sedd", inte "bekräftelse" | Undviker falsk bekräftelse | `src/forces_isw.py:205-206`, `src/forces_firms.py:2-7`, `:54-76` | S |
| 18 | **Lite-modellen i svepet.** Om svepet måste gå på reservmodellen: färre artiklar (till exempel 200), högst 4 händelser, ingen JSON-räddning på en annan modell än den första, och tydlig märkning (#4). Överväg att skjuta upp till nästa kvotdygn i stället för att publicera | Mindre risk för påhitt när kvaliteten är lägre | `src/common.py:219-230`, `:278-293`, `src/daily_report.py:398` | S |

**Föreslagen ordning före lansering:** 1, 3, 4, 5, 6, 13, 15 och 17 (alla
S, ungefär 3-4 dagar sammanlagt). Därefter 2 och 12 tillsammans, 7, 8 och
11. Sedan 9, 10 och 14.

---

## Bilaga: mindre iakttagelser

- `src/hourly_monitor.py:2` säger att trådbevakningen körs kl. 12, 16
  och 21, men den körs kl. 12 och 21 (`webapp/CONTRACT.md:566-572`).
- När en tråd klassas NARRATIVE_SHIFT räknas det som "uncorrected
  contradiction" för alla fem utgivare (`src/hourly_monitor.py:187-189`),
  även för dem som bara rapporterade. Siffrorna används bara i förslaget
  (`src/daily_report.py:483-484`), men de är missvisande.
- `credibility_scale` och `scale_definition` i `config/methodology.json:4-5`
  läses aldrig av koden.
- `canonical_outlet` tar bort sidokommentarer inom parentes
  (`src/app_data.py:63`). "Meduza (relay of The Atlantic)" blir Meduza,
  och ursprunget går förlorat. Det är relevant för
  oberoendekontrollen (#12).
