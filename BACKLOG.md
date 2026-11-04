# Backlogg

Saker att följa upp. Det översta är nästa att göra. Flytta en punkt till
"Klart" med datum när den är gjord.

## Att följa upp

### Styrkor: läget 2 nov (läs först)
*Uppdaterat 2026-11-03.*

**I produktion (hm-v3.26):**
- Fliken Styrkor har två delar.
  - **Ryska baser:** 379 baser, varav 255 ur grunddatabasen
    (`config/forces_db/`). Vapen- och förbandskort finns på `#/styrkor?sys=`
    och `?unit=`.
  - **Anfall mot Ukraina:** Kaggle-data. Spåren kopplas ihop mellan
    rapportens rader, och vapenkorten visar bild och prestanda.
- **Nattjobb efter 04:00-rapporten:**
  - `src/forces.py`: anfall, uppföljningar och truppändringar. Faller
    tillbaka på flash-lite när huvudkvoten är slut.
  - Veckosökningen (`src/forces_survey.py`): 3 anrop flash-lite per natt.
  - `src/strikes.py`: hämtar Kaggle-datan, utan modellanrop.
- **Kartorna (2 nov):**
  - Djup zoom. Grupper efter skärmavstånd som löses upp när man zoomar.
  - Basnamn under punkterna och bara där de får plats; de skymmer aldrig en
    bas och tar inga tryck.
  - Land- och stadsnamn, gradnät, mjuk zoom med hjulet och dubbeltryck
    för att zooma in. Ett drag väljer ingen bas av misstag.
  - Anfallskartan går också att panorera och zooma.
  - Gemensamma hjälpfunktioner i `app.js`: `attachPanZoom`, `mapLand`
    och `mapPlaces`.
- **Kartan, version 2 (hm-v3.27):**
  - Fina kustlinjer och gränser (Natural Earth 1:10m) laddas när man
    zoomar in; bara länder i bild ritas.
  - Sjöar, de stora floderna och regiongränserna i Ryssland, Belarus och
    Ukraina.
  - Minikarta nere till vänster när man har zoomat in. Den visar var man
    är, och ett tryck flyttar dit.
  - Underlag och skript finns i `webapp/scripts/map_data/`.
- **Bilder** förstoras när man håller nere eller trycker på dem
  (`zoomableImg`), med upphovsperson och licens.
- Nattjobbet ser nu tidigare nätters "Övrigt", så att samma händelse inte
  tas upp igen (Rostov kom tillbaka 2 nov).
- **Driftsättning:** behörighetsregler finns (`/permissions`). Kör
  `env -u CLOUDFLARE_API_TOKEN npx wrangler deploy` som ett eget
  kommando med arbetsmappen `webapp/`.

**Viktigt om "molnjobb":** subagenter som startas med molnisolering härifrån
kördes lokalt i `.claude/worktrees/` på användarens vanliga användningsgräns,
inte i molnet. Den andra omgången stoppades av femtimmarsgränsen 2 nov kl. 06.
Användaren vill använda molnkrediterna. Starta därför långa jobb som en egen
session på claude.ai/code, och skriv instruktionen till en fil i grenen.

**Grunddatabasen och löpande uppdatering: klart på grenar, väntar på granskning.**
*Uppdaterat 2026-11-03.*

- **Andra omgången** (gren `grunddata-styrkor-2`, PR
  jeaneclaude621-ui/threat_monitor#1 mot main): 325 baser och 487 förband
  (104 marinfartyg) med egna texter, 13 nya baser, status ur ISW för 63
  förband, 9 basbilder, rättade garnisoner. Se `config/forces_db/README.md`.
- **Tredje omgången** (gren `styrkor-lopande`, bygger på andra omgången och
  main 3 nov): klar enligt `config/forces_db/TREDJE_OMGANGEN.md`.
  - ISW varje natt (`src/forces_isw.py`): högst ett lite-anrop per dygn;
    förbandskorten visar aktuell status med datum och länk.
  - Statusens ålder syns på förbands- och baskort; äldre än 60 dagar tonas
    ner, "ej bekräftad sedan" (Version 3.29, `sw.js` hm-v3.29).
  - NASA FIRMS (`src/forces_firms.py`): brand sedd av satellit vid anfall.
  - Bildjobbet `forces_images` på onsdagar, som committar bilder till
    kodrepot (`permissions: contents: write` i `scheduled-jobs.yml`).
  - Alla förband har egna texter. Tester i `tests/`.
  - Frontlinjen som kartlager gick inte: ingen källa med villkor som
    tillåter återpublicering (ISW, DeepStateMap). Se README.
  - Ej nått från molnmiljön: Overpass, deepstatemap.live och nya
    miniatyrer på Wikimedia (429).

**Kvar för användaren (lokalt):**
1. Granska PR #1 och grenen `styrkor-lopande` (den innehåller PR #1).
   Kör `python3 -I src/forces_db_check.py` och
   `python3 -m unittest discover -s tests`.
2. Testa i mockservern: förbandskort med ISW-status, gammal status
   tonad ("ej bekräftad sedan"), baskort, FIRMS-raden vid ett anfall.
3. Merga till main och driftsätt Workern och appen (hm-v3.29).
4. **Skaffa en gratis `FIRMS_MAP_KEY`** hos NASA FIRMS och lägg den som
   repo-hemlighet med det namnet. Utan den gör FIRMS-kontrollen ingenting.
5. Kör `python3 src/forces.py isw --dry-run` en gång efter merge och se att
   förfiltret hittar förband i nattens ISW-bedömning.
6. Bildjobbet: titta i loggen efter första onsdagen och ta bort bilder som
   inte visar en bas, ett flygplan eller ett fartyg.
7. Om DeepStateMap ger skriftligt tillstånd att återpublicera
   frontlinjens geometri: bygg lagret enligt steg 5 i TREDJE_OMGANGEN.md.

**Kvar att följa upp i grunddatabasen:**
- Materiel kopplas till förband när artikeln nämner den i nutid; äldre
  materiel kan ha slunkit med.
- Militärdistrikten bygger på tolkningen av reformen 2024.
- Fem baser har bara OpenStreetMap som källa: asipovitjy-belarus,
  bolsjoje-savino-perm, donskoje-kaliningrad, kamenka-viborg och
  kapustin-jar-2.
- Fartygens hemmabas är flottans huvudbas när Wikipedias lista bara anger
  flotta.

**Kvota:** huvudmodellen gemini-3.8-flash har 20 anrop per dygn, och dygnet
nollställs kl. 09 svensk tid. Rapporterna tar ungefär 16. Lite-modellen:
trådbevakningen 2, Narrativ 8, enkäten 3, ISW högst 1, plus reserv
(budgettabell i `config/forces_db/README.md`). Kör inte `forces`
manuellt efter kl. 09 dagen före en natt, för då kan 04-körningen få slut
på kvoten (det hände 2 nov). Flash-lite har en egen kvot och används av
veckosökningen och som reserv.

### Telegram-filtret: kontrollera effekten
*Lagt till 2026-11-02.* Den 2 nov rörde ungefär 11–15 av de 40 senaste
ryska posterna inte Nato, Europa eller grannländerna. Exempel: fältpräster i
Luhansk, Vernadskij, Kozlov, bäverbygge i Novosibirsk, hockey-VM och Hegseth.
Det översättningsanrop som redan körs varje dag markerar nu ryska inlägg med
`on_topic` (`src/trends.py`). Inlägg utanför ämnet sparas med
`off_topic`, men skickas inte till appen och räknas inte in i
dagssammanfattningen. Redan inlagda poster i D1 försvinner när de blir för
gamla.

Kolla om ett par dagar:
`npx wrangler d1 execute hotmonitor --remote --command "SELECT place, title_sv FROM trends WHERE side='ru' ORDER BY last_seen DESC LIMIT 40"`
Om mer än en av fem fortfarande är utanför ämnet: kräv också två träffar
på `RU_TOPIC`.

### Håll koll på trådbevakningens klassning
*Lagt till 2026-10-31. Kontrollerat 2026-11-02.* De senaste körningarna gav
2, 5 respektive 2 av 6 trådar som "ny utveckling". Ingen ändring behövs än.
Om det går tillbaka till nästan alla trådar varje gång, skärp instruktionen i
`src/hourly_monitor.py`.

### Förnya GitHub-token för Workern innan den går ut
*Lagt till 2026-10-31.*

Workern startar körningarna med Worker-hemligheten `GITHUB_DISPATCH_TOKEN`,
en finkornig token för `threat_monitor` med Actions read/write. När den går
ut faller körningarna tillbaka på GitHubs opålitliga schema. Skapa en ny token
och kör `npx wrangler secret put GITHUB_DISPATCH_TOKEN` i Terminal-appen,
från mappen `webapp/`. Se `webapp/DEPLOY.md`, Version 3.8.

## Förslag som väntar på beslut

Inga just nu.

## Klart

- 2026-11-04: Appen tog inte emot några uppladdningar mellan 3 nov 21:51
  och 4 nov 07:20 UTC (401 invalid_jwt). `open_app.mjs` hade skapat
  Access-appen "Hotmonitor inloggning" (login, api/ingest/*, api/export/*)
  men dess AUD kom aldrig in i `ACCESS_AUD`. Båda AUD ligger nu i
  wrangler.jsonc och Workern är driftsatt. Morgonrapporten, kurserna och
  kartorna skickades om med det nya jobbet `repush` (inga modellanrop).
  Kvar av Version 3.17: den gamla Access-appen täcker fortfarande hela
  adressen, så gäster kommer inte in förrän den tas bort (steg 6 i
  `node webapp/scripts/open_app.mjs`, kräver användarens egen token).

- 2026-11-03: Appen är öppen för alla som gäst (Version 3.17, hm-v3.31).
  Gäster läser Idag, Arkiv, Ämnen, Karta, Styrkor, Narrativ och
  Myndigheter utan inloggning. Bedömarnas e-postadresser byts mot
  "Bedömare N", den ryska sidan i Narrativ visas bara som svenska
  sammanfattningar, svaren cachas en minut och sidan Om har AI-märkning.
  Bedöm, notiser och admin kräver fortfarande inloggning via `/login`.
  Detta ersätter förslaget om en hemlig gästlänk. Kräver driftsättning
  och ändrad Access, se `webapp/DEPLOY.md`, Version 3.17.
- 2026-11-03: Fliken Källor tar inte emot Telegram eller rysk statsmedia
  (Version 3.16, hm-v3.30). Workern svarar 422, även efter omdirigering;
  exporten till analysen och `src/news_sources.py` filtrerar bort sådana
  källor som redan finns. Kräver driftsättning av Workern.
- 2026-11-03: Huvudkvoten tog slut två gånger den 3 nov: 04:00-rapporten
  föll (mina manuella Styrkor-körningar kvällen före tog av samma
  kvotdygn) och Nato-briefen 17:00. Åtgärder: trådbevakningen går bara
  12:00 och 21:00 och på lite-modellen; ett anrop på huvudmodellen som
  möter slut kvot, eller överbelastning efter 2 omförsök (förr 6), byter
  till lite-modellen i stället för att falla. Narrativ och trådbevakningen
  byter åt andra hållet. Kör inga manuella Gemini-jobb på kvällen före en
  morgonrapport.
- 2026-11-03: Narrativ översätter på lite-modellen, max 60 per anrop;
  inlägg som modellen bedömer utanför ämnet tas bort ur appens databas.
  0 oöversatta ryska inlägg efter ändringen.

- 2026-11-02: Första dagliga bedömningen av handlingsalternativen
  granskad och rimlig. De markerade tecknen har källor: drönare över Rumänien
  är observerat, sabotage i Europa delvis. Sannolikheterna är stabila (hög,
  måttlig, låg), och kartan stämmer med texten.
- 2026-11-02: Första nattliga lägesbilden för Styrkor. Den föll på
  huvudkvoten och kördes om på flash-lite. Nu finns en reservmodell.
- 2026-11-02: Grunddatabasen, första omgången, sammanslagen och
  driftsatt (hm-v3.25): 255 baser, 383 förband, 132 vapensystem och 120
  bilder.
- 2026-11-02: Kartorna och bildförstoringen (hm-v3.26).

- 2026-11-01: Rysslands handlingsalternativ. Uppdateras varje dag efter
  morgonrapporten, 1 anrop. Den ryska sidan i Narrativ hålls utanför.

- 2026-11-01: Nato. En flik bredvid Svenska myndigheter, i samma Gemini-anrop
  (alternativ 1), översatt till svenska. Raden på Idag heter "Sverige och
  Nato".

- 2026-11-01: Svenska myndigheter. En rad på Idag och en egen sida, uppdateras
  kl. 07 och 17 (alternativ B). Mockupen finns på
  https://claude.ai/artifact/FMnaHUVGGBjyWZDTiD3rnd.
