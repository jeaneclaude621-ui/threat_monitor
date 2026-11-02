# Backlogg

Saker att följa upp. Det översta är nästa att göra. Flytta en punkt till
"Klart" med datum när den är gjord.

## Att följa upp

### Styrkor: läget 2 nov (läs först)
*Uppdaterat 2026-11-02.*

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

**Pågår: andra omgången av grunddatabasen (molnjobb, gren `grunddata-styrkor-2`).**
Startad 2 nov förmiddag och får köra över dagen. Den ska inte fråga
något, och den pushar efter varje steg. Steg:
1. garnisoner för alla förband (212 av 383 saknade);
2. Militaryland.net;
3. OpenStreetMap (Overpass);
4. fler baser, med nedlagda kvar och markerade "nedlagd", och riktiga
   beskrivningar och basbilder;
5. anfall mot baser sedan 2022 med skador;
6. vapensystem och de 12 bilder som saknas;
7. förbandstexter och fartyg;
8. genomsläpp i `forces.py`;
9. storleksgränser;
10. kontroller.
Molnjobbet får inte röra `app.js`, `app.css`, `sw.js`, `index.html`,
`worker.js` eller `strikes.py`. Appen visar redan `b.image` och
`description_sv` för baser.

**När molnjobbet är klart (planerat 2 nov eftermiddag):**
1. Hämta grenen. Kör `python3 -I src/forces_db_check.py`.
2. Leta efter e-postadresser, rysk statsmedia, Telegram och bilder utan licens.
3. Slå ihop med nattens riktiga data och kontrollera:
   - att inga gamla id:n med data försvinner;
   - att datamängden är under 1,5 MB;
   - att `base_lines` är under 60 000 tecken.
4. Testa lokalt med mock-servern: baskort, förbandskort (garnison) och vapenkort.
5. Slå ihop till main, driftsätt och kör jobbet `forces_survey` så att
   allt laddas upp.
6. Uppdatera det här avsnittet.

**Kvar att följa upp i grunddatabasen** (bör täckas av andra omgången):
- Texterna är byggda ur mallar, och status är mest "aktiv enligt källan".
- Materiel kopplas till förband när artikeln nämner den i nutid; äldre
  materiel kan ha slunkit med.
- Militärdistrikten bygger på molnjobbets tolkning av reformen 2024.
- Fem baser har bara OpenStreetMap som källa: asipovitjy-belarus,
  bolsjoje-savino-perm, donskoje-kaliningrad, kamenka-viborg och
  kapustin-jar-2.
- 86 baser saknar Wikipedia-artikel för veckosökningen.

**Kvota:** huvudmodellen gemini-3.8-flash har 20 anrop per dygn, och dygnet
nollställs kl. 09 svensk tid. Rapporterna tar ungefär 16. Kör inte `forces`
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

### Spärra Telegram och rysk statsmedia i fliken Källor
*Föreslaget 2026-11-01.*

Fliken Källor är den enda vägen för Telegram eller rysk statsmedia in i
analysen: en länk som läggs in där läses av rapporten. Förslaget är att
Workern vägrar sådana länkar (t.me, tass, rt.com, ria.ru, sputnik).

### Gäståtkomst med länk, utan mejl (NÄSTA STEG)
*Beslutat 2026-11-01 att detta är nästa steg. Detaljerna bestäms när vi tar upp det.*

Den som har en länk ska kunna läsa appen utan att logga in och utan att
uppge e-post. En enkel lösning:
- En hemlig gästlänk, till exempel `.../?g=<token>`. Workern känner igen
  token och ger läsbehörighet.
- Länken kan dras tillbaka genom att token byts ut.
- Hela läsdelen visas för gäster: Idag, Arkiv, Ämnen, Karta, Narrativ och
  Myndigheter. Bedöm och admin kräver fortfarande inloggning.
- Gästläsningen får inte räknas mot Cloudflare Access gratisnivå på 50
  användare. Läsvägarna måste därför gå förbi Access (bypass) för den som
  har en giltig token.

Allt som byggts sedan 1 nov är rena läsanrop och klara för detta. Följande
i punkten nedan gäller även här: e-postadresser bort ur rapportdatan,
gästläge i appen, cachning, AI-märkning.

### Gör appen öppen för alla, gratis
*Föreslaget 2026-11-01.*

Läsdelen blir öppen utan inloggning. Bedöm och admin ligger kvar bakom
Cloudflare Access, vars gratisnivå bara räcker till 50 användare.
Förutsättningar:
- Ta bort bedömarnas e-postadresser ur rapportdatan.
- Gästläge i appen.
- Cachning av publika svar.
- "Om"-sida med AI-märkning enligt EU:s AI-förordning.
- Visa bara svenska sammanfattningar av den ryska sidan publikt.

Öppen fråga: ska Narrativ vara publikt eller bara för inloggade?

## Klart

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
