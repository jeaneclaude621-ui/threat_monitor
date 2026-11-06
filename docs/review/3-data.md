# Granskning 3: hur datan har uppdaterats och hur bedömningarna har fungerat

*Gjord 2026-11-05 05:45–07:00 UTC. Bara läsning: ingen kod i main och
ingenting i `threat_monitor-data` har ändrats.*

## Sammanfattning

Innehållet i `data/` och `reports/` (punkt 2 och fördelningen i punkt 3)
analyseras separat i `docs/review/3b-data-innehall.md` på grenen
`oversyn-data-innehall`. Den här filen täcker körningarnas pålitlighet ur
Actions-loggarna och koden bakom punkt 3 och 4.

**Morgonrapporten, 29 okt–5 nov** (tidigare dagar finns inte i Actions):

| Dag | Mejl (UTC) | Utfall |
|---|---|---|
| 29 okt | 09:48 | Sen (+5 h 48 min), GitHubs schema |
| 30 okt | – | Ingen morgonkörning identifierad |
| 31 okt | 07:47 | Sen (+3 h 47 min), startad för hand |
| 1 nov | 03:10 | I tid |
| 2 nov | 03:08 | I tid; Styrkor föll (429) |
| 3 nov | – | **Föll (429), ingen rapport** |
| 4 nov | 03:13 | Mejl i tid; lite-modell i 5 anrop; **401 på alla uppladdningar** |
| 5 nov | 03:13 | I tid; lite-modell i 2 anrop; Styrkor föll (503) |

**De viktigaste slutsatserna** (alla tio finns i avsnitt 5):

1. Körningar blir gröna trots 401, 429 och fallna delar. Statussidan
   visar då "ok" när det inte är det.
2. Styrkor gav ingen fungerande uppdatering under någon av nätterna
   2–5 nov.
3. Bedömarnas effekt på index är avrundningsbrus: +0,04 blir 0 och
   +0,06 blir +0,1, och taket band +0,1 kan stoppa den helt.
4. Kvoten på 20 anrop och 503 gör att delar tyst går på lite-modellen,
   och GDELT saknades varje dag. Inget av det syns i rapporten.

## 0. Underlag och begränsningar

**Det privata datarepot `threat_monitor-data` gick inte att läsa i den här
granskningen.** Att lägga till repot i sessionen nekades, och en direkt
`git clone` gav `could not read Username` (ingen behörighet). Därför har
jag **inte** kunnat läsa `state.json`, `last_run.json`, `forces.json`,
`strikes.json`, `trends.json`, `courses.json`, `authorities.json`,
`operator_assessments.jsonl`, `recalibration.json`, `feed_status.json`,
`logs/` eller `reports/*_report_data.json`. Jag har inte heller kunnat se
filernas historik.

Det jag har kunnat använda:

| Källa | Vad den ger | Täckning |
|---|---|---|
| GitHub Actions, `scheduled-jobs.yml` | 92 körningar, varav 14 jobbloggar lästa (alla morgonkörningar 29 okt–5 nov och de misslyckade) | 25 okt–5 nov |
| GitHub Actions, `authorities.yml` | 17 körningar, status och tider | 1–4 nov |
| GitHub Actions, `trends.yml` | 27 körningar, status och tider | 31 okt–4 nov |
| Koden i `src/` och `schedule/` | Hur siffrorna i loggen räknas fram | nuvarande main |
| `BACKLOG.md` | Projektets egna anteckningar om driften | till 4 nov |

Det betyder:

- **30 dagar går inte att täcka.** Arbetsflödet `scheduled-jobs.yml` har
  sin första körning 25 okt 2026. Dagarna 6–24 okt finns inte i Actions,
  och kodrepots historik börjar 1 nov (äldre historik är inte kvar).
  Bara datarepots `last_run.json`, `logs/` och `reports/` kan visa de
  dagarna.
- **Avsnitt 2 (rapporternas innehåll) och fördelningen i avsnitt 3 kan
  inte räknas fram** utan `reports/*_report_data.json` och
  `operator_assessments.jsonl`. Jag hittar inte på siffror. Bilaga A har
  ett färdigt skript som räknar ut allt som efterfrågas, att köra där
  datarepot finns.
- Alla tider nedan är UTC om inget annat anges. Från 25 okt är svensk tid
  UTC+1, så "04:00 i Stockholm" är 03:00 UTC.

Åtgärd för nästa omgång: ge sessionen läsrätt till
`jeaneclaude621-ui/threat_monitor-data` (anslut GitHub-kontot på nytt
under claude.ai, Settings → Connectors, och se till att Claude-appen på
GitHub har tillgång till repot). Starta sedan en ny session med båda
repona valda.

---

## 1. Körningarnas pålitlighet

### 1.1 Morgonrapporten per dag

"I tid" betyder att mejlet gick iväg före 05:00 svensk tid (04:00 UTC).
Tiden i kolumnen *Mejl* är när loggen skriver `Email sent`.

| Dag (Sthlm) | Körning startade | Mejl | I tid? | Modell | Uppladdning | Anmärkning |
|---|---|---|---|---|---|---|
| 6–24 okt | – | – | ? | ? | ? | Finns inte i Actions. Kräver datarepot |
| 25 okt | 07:37 och 08:08 (manuella) | ? | ? | ? | ? | Inte läst. Schemakörningen 13:19 avbröts efter 60 min |
| 26 okt | 01:32 (schema) | ? | ? | ? | ? | 08:02 var trådbevakning, 08:16 avbröts efter 60 min |
| 27 okt | 00:42 (schema) | ? | ? | ? | ? | 06:43 var trådbevakning; 08:29 och 13:30 avbröts efter 60 min |
| 28 okt | ? | ? | ? | ? | ? | 06:09 var trådbevakning (429 på alla trådar) |
| **29 okt** | 09:06 | **09:48** | **Nej, 5 h 48 min sent** | huvud | ok | GitHubs schema startade 6 h sent |
| 30 okt | ? | ? | ? | ? | ? | 02:06 och 08:53 var trådbevakning; ingen morgonrapport identifierad |
| **31 okt** | 07:23 (manuell) | **07:47** | **Nej, 3 h 47 min sent** | huvud | ok | Startad för hand |
| **1 nov** | 03:01 | 03:10 | **Ja** | huvud (503, nytt försök) | ok | Första dagen med Workerns start i tid |
| **2 nov** | 03:00 | 03:08 | **Ja** | huvud | ok | Styrkor föll på 429 (kvoten slut efter manuella körningar kvällen före) |
| **3 nov** | 03:00 | – | **Ingen rapport** | – | – | Föll på 429 efter 3 min, kod 1. Ingen rapport finns för dagen |
| **4 nov** | 03:00 | 03:13 | **Ja, men** | lite i 5 anrop | **401 på allt** | Rapport, kurser, styrkor och anfallskarta nekades (`invalid_jwt`); skickades om med `repush` |
| **5 nov** | 03:00 | 03:13 | **Ja** | lite i 2 anrop; styrkor föll på båda | ok | Google News 503: ingen preliminär anfallsnatt för 4 nov |

**Summering för de 8 dagar som går att följa (29 okt–5 nov):**

- 4 av 8 kom i tid (1, 2, 4 och 5 nov). Den 4 nov kom bara mejlet i
  tid; appen fick rapporten först efter omsändningen.
- 2 kom för sent (29 okt +5 h 48 min, 31 okt +3 h 47 min).
- 1 föll helt (3 nov, 429).
- 1 morgonrapport (30 okt) syns inte bland körningarna alls.
- 2 av de 4 som kom i tid gick delvis på lite-modellen (4 och 5 nov).
- Den 4 nov gav uppladdningen 401 i 7 anrop: körstatus två gånger,
  `api/export/assessments`, `api/export/sources`, `api/ingest/reports`,
  `api/export/all` (backup), `api/ingest/courses`, `api/ingest/forces`
  och `api/ingest/strikes`.
- Den 4 nov stämmer loggarna inte med backloggen. Enligt `BACKLOG.md`
  tog appen inte emot något "mellan 3 nov 21:51 och 4 nov 07:20 UTC".
  Men de tre korta körningarna som rimligen var `repush` startade
  05:17, 05:47 och 06:04 UTC. Antingen är 07:20 svensk tid, eller så
  föll två av omsändningarna. Det går inte att avgöra utan
  `last_run.json`.

### 1.2 Felen i siffror (25 okt–5 nov, `scheduled-jobs.yml`)

| Utfall | Antal | Exempel |
|---|---|---|
| Lyckade körningar | 83 av 92 | – |
| Avbrutna efter 60 min timeout | 7 | 25 okt 13:19, 26 okt 08:16 och 20:41, 27 okt 08:29 och 13:30, 29 okt 21:57; plus en manuell 1 nov 22:13 |
| Misslyckade | 2 | 3 nov 03:00 (daily, 429), 5 nov 05:01 (`forces_places`: `NameError: name '_nominatim' is not defined`) |
| Grön men med fel inuti | flera | 29 okt 02:45: 4 av 6 trådar föll på 429, och körningen var ändå "success". 4 nov 03:00: "success" trots 401 på alla uppladdningar |

**Orsaker:**

1. **Kvoten på 20 anrop per dygn för huvudmodellen** (`gemini-3.8-flash`,
   gratisnivån). Till och med 30 okt gick trådbevakningen varje timme
   (`SCHEDULE: 30 * * * *` i loggen) med ett anrop per tråd, alltså
   upp till 6 anrop i timmen. Kvoten tog slut tidigt på dygnet, och
   körningarna fastnade i omförsök på 30–300 s tills de nådde
   60-minutersgränsen. Den 28 okt 06:09 föll 3 av 6 trådar på 429, och
   den 30 okt 02:06 föll 2 av 6. Efter 1 nov har kvoten tagit slut två
   gånger av egna, manuella körningar (2 och 3 nov enligt backloggen).
2. **503 "high demand"** hos huvudmodellen förekommer i varje läst
   morgonlogg från 1 nov. Sedan 3 nov byter koden till lite-modellen
   efter 2 omförsök i stället för att falla. Det gjorde att 4 och
   5 nov blev av, men delvis på en svagare modell.
3. **GitHubs eget schema är opålitligt.** Före 1 nov startade
   morgonrapporten 6 h sent (29 okt) eller fick startas för hand
   (31 okt). Sedan Workern började starta körningarna via
   `workflow_dispatch` har alla morgonkörningar startat 03:00 UTC.
4. **Åtkomstfel (401)**: en ny Access-applikation vars AUD-tagg inte
   fanns i Workern. Det är åtgärdat enligt `BACKLOG.md`.
5. **Externa källor:** GDELT var otillgänglig i **alla** lästa
   morgonkörningar från 1 nov: 429 (1, 4 och 5 nov) eller timeout
   (2 nov). Det syns bara som en rad i loggen. Google News svarade 503
   för anfallsrubrikerna 5 nov.

### 1.3 Övriga jobb

| Jobb | Tänkt | Faktiskt (1–4 nov) |
|---|---|---|
| Myndigheter och Nato (`authorities.yml`), 07 och 17 | 2 per dag | 2 nov: 07 ok, **17 föll**. 3 nov: **07 och 17 föll**. 4 nov: båda ok, 07 på lite-modellen. Från 2 nov 07 till 4 nov 07 (cirka 48 h) var sidan oförändrad |
| Trender och Narrativ (`trends.yml`), 08, 12, 16 och 21 | 4 per dag | 2–4 nov: 11 av 12 ok. 2 nov 16 avbröts efter 21 min |
| Trådbevakning | 12 och 21 sedan 3 nov | Enligt backloggen föll alla tre kontroller 3 nov på 503 men visades som "ok" på statussidan |

De schemalagda reservkörningarna (event `schedule`, cirka 20 s) är
avsiktliga: de ser att Workern redan har kört och hoppar över. De
räknas inte som fel ovan.

---

## 2. Rapporternas innehåll över tid

**Kan inte besvaras med siffror utan `reports/*_report_data.json`.**
Följande frågor räknas ut av skriptet i bilaga A:

- antal händelser per dag,
- källor (artiklar) per händelse och andelen händelser med en enda källa,
- vilka utgivare som dominerar (efter `canonical_outlet`),
- samma artikel-URL eller samma rubrik på flera dagar,
- händelser utan någon länk,
- hotindex och 30-dagarsindex per dag, band och hopp större än 0,5.

Det som går att säga från loggarna och koden:

- **Underlaget per dag:** insamlade artiklar efter filtrering var
  702 (31 okt), 425 (1 nov), 419 (2 nov), 852 (4 nov) och 583 (5 nov),
  av 823–1 272 flödesposter. Det skiftar en faktor två mellan dagar utan
  att läget gör det. Rimligen beror det på flödena och GDELT, inte på
  händelserna. Utan `feed_status.json` går det inte att se vilka flöden
  som saknades.
- **GDELT saknades varje dag**, så den bredaste icke-RSS-källan bidrog
  inte i någon läst rapport från 1 nov. Rapporterna säger inte det till
  läsaren.
- **Dubbletter mellan dagar.** `drop_repeated_articles`
  (`src/daily_report.py:533`) tar bort artiklar som citerades de senaste
  dagarna, *utom när det skulle lämna en händelse helt utan artiklar*.
  En händelse som bara bygger på gamla artiklar visas alltså igen med
  samma länkar och ser ut som en ny händelse. Det bör mätas med bilaga A
  (`repeat_events`).
- **Hotindexet** hålls av kod: ±0,5 inom bandet (`enforce_bands`), högst
  band +0,1 utan delvis uppfyllt villkor för nästa band (`PLACEMENT_CAP`)
  och högst ett band ner om bandet saknar underlag
  (`apply_index_rules`). Hopp mellan dagar kan därför bara komma av byte
  av band. Bilaga A listar dem.

---

## 3. Bedömarnas bedömningar

### 3.1 Antal (ur loggen)

| Morgon | Nya | Totalt |
|---|---|---|
| 31 okt | 22 | 570 |
| 1 nov | 0 | 570 |
| 2 nov | 0 | 570 |
| 3 nov | (föll innan raden skrevs ut) | ? |
| 4 nov | **hämtningen gav 401** | – |
| 5 nov | 57 | 641 |

Mellan 2 och 5 nov kom alltså 71 nya rader. Den 4 nov räknades inga
bedömningar in, eftersom hämtningen nekades. 57 av dem kom in först
5 nov, ett dygn sent.

**Fördelning, per bedömare och mot senare utfall:** kräver
`operator_assessments.jsonl` och rapporternas `self_check`. Se bilaga A
(`assessments`). Bedömarna ska anonymiseras som Bedömare 1, 2 och så
vidare, vilket skriptet gör. Observera att `track_record`
(`src/operator_weight.py:194`) bara räknar händelser som senare blev
CONFIRMED eller CONTRADICTED. UNRESOLVED, som i praktiken är det
vanligaste i en självkontroll efter ett dygn, faller bort.

### 3.2 Påverkar de index som avsett? Nej, nästan aldrig

| Morgon | Beräknat | Tillämpat |
|---|---|---|
| 31 okt | +0,07 | **+0,1** |
| 1 nov | +0,04 | **0,0** |
| 2 nov | +0,06 | **+0,1** |
| 4 nov | +0,04 | **0,0** |
| 5 nov | +0,03 | **0,0** |

Varför "computed +0.03, applied +0.0" (`apply_to_index`,
`src/operator_weight.py:154–191`):

1. **Avrundning till en decimal.** Index sparas med en decimal
   (`round(moved, 1)`). En effekt under 0,05 försvinner, och en effekt på
   0,05–0,149 blir 0,1. Effekten blir alltså en trappa: +0,04 ger noll
   och +0,06 ger +0,1. Det ser ut som att bedömarna antingen inte
   påverkar alls eller påverkar mer än beräknat, och skillnaden mellan
   dagarna beror på slumpen i andra decimalen.
2. **Effekten är liten redan från början.** Den är medelvärdet av
   händelsernas signal × `MAX_INDEX_DELTA` (0,3). Signalen späds ut av
   att en bedömning av en annan artikel från samma utgivare bara väger
   35 % (`OUTLET_WEIGHT`), av halveringstiden på 30 dagar, och av att
   bara eskalerande och deeskalerande händelser räknas. Medelvärdet över
   alla bedömda händelser drar mot noll när bedömarna är oense eller
   bedömer händelser åt olika håll.
3. **Taket i bandet.** `index_range` sätts i `apply_index_rules` till
   (band − 0,5, band + 0,1) när inget delvis uppfyllt villkor finns
   (`PLACEMENT_CAP`). Ligger index redan på band +0,1 kan bedömarna inte
   flytta det uppåt alls. Loggen skiljer inte på "för litet" och "taket"
   (det gör bara `note_sv` i rapporten).

**Slutsats:** bedömarnas effekt på hotindexet är i praktiken
avrundningsbrus. Bedömningarna gör sannolikt mer nytta i
händelsepoängen (±1, en decimal), men det kan inte kontrolleras utan
rapportdatan.

`recalibration.json` kunde inte läsas.

---

## 4. Delarna var för sig: uppdateras de som tänkt?

| Del | Tänkt | Observerat (1–5 nov) | Fel och luckor |
|---|---|---|---|
| **Styrkor** (nattlig lägesbild) | varje natt efter rapporten | 2 nov: **föll** (429). 3 nov: ingen körning. 4 nov: körde på lite-modellen men gav "**0 attacks, 0 follow-ups, 0 changes**". 5 nov: **föll** på båda modellerna (503) | **Inga av 4 nätter gav en fungerande uppdatering.** Nollan 4 nov var ett riktigt fel: sökningen använde svenska basnamn ("Achtubinsk") som engelska nyheter inte skriver, vilket rättades i `fd9e131` samma dag. Antalet baser gick från 265 (2 nov) till 431 (4 nov) när grunddatabasen kom in |
| Styrkor: enkäten | 3 lite-anrop per natt | 4 nov: 11 baser lästa, 34 utan artikel, 15 kvar. 5 nov: 3 lästa, 12 utan artikel | 5 nov föll enkätens lite-anrop delvis på 503 |
| Styrkor: ISW | högst 1 per dygn | 4 nov: ISW från 2 nov, 6 förbandsstatusar | ISW låg 2 dagar efter |
| Styrkor: FIRMS | vid anfall | 4 nov: 0 kontrollerade (inga anfall hittades) | Följd av nollan ovan |
| **Anfallskartan** (`strikes`) | varje natt, Kaggle plus preliminära nätter | 2 nov: 29 nätter av 30, senast 31 okt. 4 nov: **27** nätter, senast 31 okt. 5 nov: 29 nätter, senast 3 nov | Kaggle låg 4–5 dagar efter. Den preliminära natten 4 nov saknas (Google News 503) och kommer bara in om nästa körning läser den. Inget i loggen säger om en saknad natt hämtas i efterhand |
| **Handlingsalternativ** (`courses`) | varje dag efter rapporten | 2 nov: hög/måttlig/låg, tecken 2/4, 0/4, 0/4. 3 nov: ingen. 4 nov: samma, 2/4 (laddades upp först med `repush`). 5 nov: samma, 1/4 | Sannolikheterna har inte ändrats någon dag. Med regeln om högst ett steg per dag och samma underlag kan de vara fastlåsta. Bör prövas mot `courses.json`-historiken |
| **Myndigheter och Nato** | 07 och 17 | se 1.3 | Cirka 48 h utan uppdatering 2–4 nov. Appen visar senaste lyckade, men det framgår inte hur gammal den är |
| **Narrativ** (`trends`) | 08, 12, 16 och 21 | 11 av 12 ok 2–4 nov | Status "success" säger inget om innehållet. Backloggen nämner att 58 av 105 ryska inlägg var oöversatta 2 nov, och att 11–15 av 40 var utanför ämnet. Det måste kontrolleras i `trends.json` och D1 |
| **Trådbevakning** | 12 och 21 | se 1.3 | Se nedan |

**Trådbevakningen: klassning och förfilter (ur loggarna 26–30 okt):**

| Körning | Klassade som NEW_DEVELOPMENT | Förfiltret skulle ha hoppat över | …varav med förändring enligt Gemini |
|---|---|---|---|
| 26 okt 08:03 | 4 av 6 | 5 | 3 |
| 27 okt 06:44 | 5 av 5 (1 föll) | 4 | 3 |
| 28 okt 06:09 | 3 av 3 (3 föll) | 4 | 1 |
| 29 okt 02:45 | 0 av 2 (4 föll) | 4 | – |
| 30 okt 02:06 | 3 av 4 (2 föll) | 3 | 2 |
| 30 okt 08:53 | 4 av 6 | 4 | 2 |

- Förfiltret i skuggläge skulle ha missat en förändring i **minst 11 av 20**
  överhoppade trådar som Gemini faktiskt kontrollerade. Det är inte
  redo att slås på.
- Trådar som faller (429/503) försvinner ur resultatet utan markering.
  Körningen blir ändå "success", och appen får bara de lyckade.
- Andelen "ny utveckling" är hög (19 av 26 klassade trådar ovan, 73 %). Det
  stämmer med backloggens farhåga om att nästan allt klassas som nytt.

---

## 5. Slutsatser: de 10 viktigaste problemen

Ordnade efter hur mycket de gör bilden mindre sann eller sämre
dokumenterad. Insats: S = timmar, M = en dag, L = flera dagar.

| # | Problem | Följd för bilden | Åtgärd | Filer | Insats |
|---|---|---|---|---|---|
| 1 | **Gröna körningar med fel inuti.** 401 på alla uppladdningar, 4 av 6 trådar på 429 och styrkor som faller ger ändå "success" | Statussidan och Actions visar att allt är bra när det inte är det; luckor dokumenteras inte | Räkna delfel och avsluta med egen kod (t.ex. 2 = "klar med fel"), och skicka delstatus per del till körstatus. Låt workflowen markera gult | `schedule/run_job.py`, `src/daily_report.py`, `src/hourly_monitor.py`, `src/app_sync.py` | M |
| 2 | **Styrkor uppdaterades inte en enda natt av fyra** (429, ingen körning, 0 träffar på grund av fel basnamn, 503) | Lägesbilden för styrkor är äldre än den ser ut | Visa "senast uppdaterad" och orsaken i appen. Gör om styrkor senare samma morgon om nattkörningen föll (en ny `--at`-tid). Ett test att sökningen ger träffar på ett känt anfall | `src/forces.py`, `webapp/public/app.js`, `scheduled-jobs.yml` | M |
| 3 | **Bedömarnas effekt på index är avrundningsbrus** (+0,04 → 0, +0,06 → +0,1) och kan stoppas av taket band +0,1 | Det som ska vara "hög vikt" syns inte, eller syns slumpmässigt | Spara index med två decimaler internt och avrunda bara i visningen. Alternativt: tillämpa först från 0,1, men skriv då i loggen och i appen att effekten var för liten. Skriv ut vilken av orsakerna som gällde | `src/operator_weight.py:154–191`, `src/daily_report.py` | S |
| 4 | **Huvudkvoten (20 per dygn) räcker inte**, och 503 är vardag | Dagar utan rapport (3 nov), delar på svagare modell utan att läsaren får veta | Märk i rapporten och appen vilka delar som gick på lite-modellen. Budgetera anropen i kod (räkna per kvotdygn i `state.json`) och vägra manuella körningar som äter morgonens kvot. Överväg betald nivå för morgonrapporten | `src/common.py`, `schedule/run_job.py`, `src/pptx_builder.py` | M |
| 5 | **GDELT saknades varje dag och Google News svarade 503**, utan att rapporten säger det | Underlaget är smalare än läsaren tror, och storleken skiftar en faktor två mellan dagar | Skriv källornas status (`feed_status.json`) i rapporten: "GDELT saknades i dag, N flöden svarade inte". Sätt en tröskel som varnar | `src/news_sources.py`, `src/daily_report.py`, `src/pptx_builder.py` | S |
| 6 | **Bedömningar räknas inte in när hämtningen faller** (4 nov: 401; 57 rader kom ett dygn sent) | Bedömarna tror att de påverkar dagens bild, men gör det inte | Stoppa, eller märk tydligt, när bedömningarna inte kunde hämtas. Lägg det i `operator_influence.note_sv` | `src/app_sync.py`, `src/operator_weight.py` | S |
| 7 | **Trådar som faller försvinner tyst**, och "ny utveckling" är cirka 73 % | Läsaren ser färre trådar eller överdriven rörelse | Skicka "ej kontrollerad (fel)" per tråd till appen. Kräv konkret ny fakta med datum för NEW_DEVELOPMENT och mät andelen | `src/hourly_monitor.py` | S |
| 8 | **Upprepade händelser** när alla artiklar redan citerats (`drop_repeated_articles` behåller dem) | Gamla händelser ser nya ut och kan hålla uppe bandet | Märk sådana händelser "tidigare rapporterad" i stället för att behålla dem tyst, och räkna dem inte som bandunderlag | `src/daily_report.py:533–549` | S |
| 9 | **Myndigheter stod still i cirka 48 h** (2–4 nov), och anfallskartans luckor (preliminär natt 4 nov) hämtas inte uttryckligen i efterhand | Gammal text kan läsas som dagens | Visa ålder och "uppdatering misslyckades" på sidan. Låt anfallsjobbet hämta alla saknade preliminära nätter, inte bara gårdagens | `src/authorities.py`, `src/strikes.py`, `webapp/public/app.js` | S |
| 10 | **Dokumentationen räcker inte för en granskning i efterhand.** Actions-historiken börjar 25 okt och artefakterna sparas i 30 dagar. Backloggens tider stämmer inte med loggarna (4 nov, "07:20 UTC"). Datan ligger i ett repo som granskaren inte når | Det går inte att visa i efterhand vad som hände en viss dag | Skriv en daglig, maskinläsbar körlogg (en rad per del: start, slut, modell, fel, uppladdning) i datarepot. Ange tidszon i backloggen. Ge granskningar läsrätt till datarepot | `schedule/run_job.py`, `BACKLOG.md` | M |

Två saker som fungerar:

- Workerns start via `workflow_dispatch` har gett start kl. 03:00 UTC
  varje morgon sedan 1 nov.
- Bytet till lite-modellen (3 nov) gjorde att 4 och 5 nov blev av trots
  slut kvot och 503.

---

## Bilaga A: skript för det som inte kunde räknas här

Kör från datarepots rot (`python3 -I analys.py`). Skriptet läser bara
filerna och skriver en sammanställning till stdout. Det anonymiserar
bedömarna. Det är **inte** kört i den här granskningen, eftersom datan
inte fanns tillgänglig. Fältnamnen följer `src/daily_report.py`
(`events[].articles[].url/outlet/title`, `threat_index`, `index_band`,
`self_check.results[]`) och `src/operator_weight.py` (`operator`,
`value`, `event_id`, `ts`, `supersedes`). Kontrollera dem mot en
verklig fil först.

```python
import json, glob, collections, statistics, re
from urllib.parse import urlsplit

def norm(u):
    s = urlsplit(u or "")
    return (s.netloc.lower().removeprefix("www.") + s.path.rstrip("/")).lower()

reports = []
for f in sorted(glob.glob("reports/*_report_data.json")):
    day = re.search(r"(\d{4}-\d{2}-\d{2})", f).group(1)
    reports.append((day, json.load(open(f, encoding="utf-8"))))

print("dag | händelser | källor/händelse (median) | 1 källa | utan länk | index | band | 30d")
outlets, seen_urls, seen_titles, outcomes = collections.Counter(), {}, {}, {}
prev = None
for day, r in reports:
    ev = r.get("events", [])
    n_src = [len({norm(a.get("url")) for a in e.get("articles", []) if a.get("url")}) for e in ev]
    one = sum(1 for n in n_src if n == 1)
    nolink = sum(1 for n in n_src if n == 0)
    for e in ev:
        for a in e.get("articles", []):
            outlets[a.get("outlet") or urlsplit(a.get("url") or "").netloc] += 1
            k = norm(a.get("url"))
            if k:
                seen_urls.setdefault(k, set()).add(day)
        t = (e.get("title") or "").strip().lower()
        if t:
            seen_titles.setdefault(t, set()).add(day)
    for x in (r.get("self_check") or {}).get("results", []):
        outcomes[x.get("event_id")] = x.get("outcome")
    idx = r.get("threat_index")
    jump = "" if prev is None or idx is None else f" (hopp {idx - prev:+.1f})" if abs(idx - prev) > 0.5 else ""
    prev = idx if idx is not None else prev
    med = statistics.median(n_src) if n_src else 0
    print(f"{day} | {len(ev)} | {med} | {one} ({one / max(len(ev), 1):.0%}) | {nolink} | {idx}{jump} | "
          f"{r.get('index_band')} | {r.get('threat_index_30d')}")

print("\nTopp 15 utgivare:", outlets.most_common(15))
rep_u = {u: d for u, d in seen_urls.items() if len(d) > 1}
rep_t = {t: d for t, d in seen_titles.items() if len(d) > 1}
print(f"Artikel-URL på fler än en dag: {len(rep_u)}; rubriker på fler än en dag (repeat_events): {len(rep_t)}")
for t, d in list(rep_t.items())[:10]:
    print("  ", sorted(d), t[:90])

# Bedömningar (assessments), anonymiserade
rows = [json.loads(l) for l in open("data/operator_assessments.jsonl", encoding="utf-8") if l.strip()]
sup = {r.get("supersedes") for r in rows if r.get("supersedes")}
cur = {}
for r in sorted(rows, key=lambda r: r.get("ts", "")):
    if r["id"] not in sup:
        cur[(r.get("operator"), r.get("article_id") or r.get("url") or r["id"])] = r
alias = {op: f"Bedömare {i + 1}" for i, op in enumerate(sorted({r.get("operator") for r in rows}))}
print(f"\nBedömningar: {len(rows)} rader, {len(cur)} gällande")
by = collections.defaultdict(collections.Counter)
match = collections.defaultdict(collections.Counter)
for (op, _), r in cur.items():
    by[alias[op]][r.get("value")] += 1
    o = outcomes.get(r.get("event_id"))
    if r.get("value") and o:
        ok = (r["value"] > 0) == (o == "CONFIRMED") if o != "UNRESOLVED" else None
        match[alias[op]][{True: "stämde", False: "stämde inte", None: "olöst"}[ok]] += 1
for a in sorted(by):
    print(f"  {a}: värden {dict(sorted(by[a].items()))}; mot utfall {dict(match[a])}")
per_day = collections.Counter((r.get("ts") or "")[:10] for r in rows)
print("  per dag:", dict(sorted(per_day.items())))
```

För pålitligheten 6–24 okt, kör också:

```bash
git log --since=2026-10-06 --format='%ad %s' --date=iso -- data/last_run.json reports/ | head -200
ls reports/*_report_data.json | sed 's/.*\///' | cut -c1-10 | sort > /tmp/har.txt   # visar saknade dagar
grep -h -E "Email sent|Uploaded to web app|HTTP 401|429|503|flash-lite|Daily report done|exited with code" data/logs/daily_run_cloud.log | tail -400
```
