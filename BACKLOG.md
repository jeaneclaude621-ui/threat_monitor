# Backlogg

Saker att följa upp. Det översta är nästa att göra. Flytta en punkt till
"Klart" med datum när den är gjord.

## Att följa upp

### Styrkor: läget 3 nov (läs först)
*Uppdaterat 2026-11-03.*

**I produktion (hm-v3.29):**
- Fliken Styrkor har två delar.
  - **Ryska baser:** kartan bygger på grunddatabasen
    (`config/forces_db/`). Vapen- och förbandskort finns på `#/styrkor?sys=`
    och `?unit=`.
  - **Anfall mot Ukraina:** Kaggle-data. Spåren kopplas ihop mellan
    rapportens rader, och vapenkorten visar bild och prestanda.
- **Grunddatabasen (3 nov):** 325 baser och 487 förband, alla med egna
  texter; 104 av förbanden är marinfartyg. 132 system (130 med bild).
  Siffror och beslut i `config/forces_db/README.md`.
- **Nattjobb efter 04:00-rapporten:**
  - `src/forces.py`: anfall, uppföljningar och truppändringar. Faller
    tillbaka på flash-lite när huvudkvoten är slut.
  - Veckosökningen (`src/forces_survey.py`): 3 anrop flash-lite per natt.
  - ISW-läsningen (`src/forces_isw.py`): läser nattens bedömning (via
    criticalthreats.org) och uppdaterar förbandens status. Högst ett
    lite-anrop per dygn, inget när inget känt förband nämns.
  - NASA FIRMS (`src/forces_firms.py`): brand sedd av satellit vid anfall.
    Använder repo-hemligheten `FIRMS_MAP_KEY`, inga modellanrop.
  - `src/strikes.py`: hämtar Kaggle-datan, utan modellanrop.
- **Statusens ålder** syns på förbands- och baskort ("uppdaterad <datum>").
  Status äldre än 60 dagar tonas ner och märks "ej bekräftad sedan".
- **Bildjobbet `forces_images`** körs onsdagar 13:17 UTC och committar
  bilder till `main`. Inga modellanrop.
- **Tester** i `tests/`: `python3 -m unittest discover -s tests` (utan nät).
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

**Kvar att göra:**
1. **Nattloggen 4 nov:** kontrollera raderna `ISW:` och `FIRMS:` i
   Actions → Scheduled jobs → steget "Run". En schemalagd molnsession gör
   den kontrollen 4 nov på morgonen.
2. **Bildjobbet** körs första gången onsdag 4 nov 13:17 UTC. Granska
   loggen och ta bort bilder som inte visar en bas, ett flygplan eller ett
   fartyg.
3. **Viktigt:** bilderna som jobbet committar till `main` syns inte i appen
   förrän nästa `env -u CLOUDFLARE_API_TOKEN npx wrangler deploy` från
   `webapp/`. Driftsätt därför efter en onsdag då jobbet lagt till bilder.
4. Valfritt: frontlinjen som kartlager, om DeepStateMap ger skriftligt
   tillstånd att återpublicera geometrin (steg 5 i
   `config/forces_db/TREDJE_OMGANGEN.md`).

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

- 2026-11-04: Styrkor ser alla anfall i Ryssland och ockuperade områden
  (Version 3.18, hm-v3.33). Nattsökningen letade efter baserna med de
  svenska namnen ("Achtubinsk", "Voronezj", "Tichoretsk (719:e
  ammunitionsbasen)"), som engelska nyheter aldrig skriver; nu används
  engelsk stavning från det ryska namnet. Anfall mot raffinaderier,
  depåer, fabriker, hamnar m.m. utanför baslistan får plats via
  OpenStreetMap och kontrolleras med NASA FIRMS (3 km vid känt mål, 10 km
  när bara orten hittas). Varje anfall har en knapp till FIRMS satellitkarta
  för platsen och dagen. Rysslands anfall mot Ukraina kontrolleras inte med
  FIRMS: flygvapnet anger bara region.

- 2026-11-04: Anfallskartan visar 30 nätter löpande, alla valbara. Kaggle-
  datasetet uppdateras ungefär en gång i veckan (senast 31 okt), så
  nätterna efter dess senaste läses ur nyhetsrubriker som citerar
  flygvapnet (Google News, ingen rysk statsmedia), ett lite-anrop per natt
  högst, märkta preliminära (*) tills datasetet täcker dem. Första
  körningen: 1-3 nov. Nattens rapport kommer ut på morgonen, så natten
  till samma dag läses först nästa morgon. Lite-budgeten blir cirka
  16 av 20 per dygn.
- 2026-11-04: Alla tre trådkontroller den 3 nov föll på 503 hos
  huvudmodellen (före bytet till lite-modellen) men visades som "ok" på
  statussidan. Myndigheter hade inte uppdaterats sedan 2 nov (alla
  körningar föll på kvoten); 07:00-körningen 4 nov gick på lite-modellen
  och laddades upp. Ingen rapport finns för 3 nov.

- 2026-11-04: Appen tog inte emot några uppladdningar mellan 3 nov 21:51
  och 4 nov 07:20 UTC (401 invalid_jwt). `open_app.mjs` hade skapat
  Access-appen "Hotmonitor inloggning" (login, api/ingest/*, api/export/*)
  men dess AUD kom aldrig in i `ACCESS_AUD`. Båda AUD ligger nu i
  wrangler.jsonc och Workern är driftsatt. Morgonrapporten, kurserna och
  kartorna skickades om med det nya jobbet `repush` (inga modellanrop).
  Samma dag kördes `open_app.mjs --force` och den gamla Access-appen togs
  bort: appen är öppen för gäster (kontrollerat: läsvägarna svarar 200 som
  gäst utan e-postadresser och utan ryska rubriker eller länkar; admin 401;
  login, ingest och export bakom Access; jobbens uppladdning fungerar).
  `--force` behövdes för att Macen saknar CF_ACCESS_CLIENT_* i ~/.zshrc.

- 2026-11-03: Andra och tredje omgången av Styrkor (PR #1 och PR #2)
  mergade till main och driftsatta (hm-v3.29): grunddatabasen med 325 baser
  och 487 förband, ISW varje natt, statusens ålder, NASA FIRMS och
  bildjobbet. Repo-hemligheten `FIRMS_MAP_KEY` är inlagd.
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
