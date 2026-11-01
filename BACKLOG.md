# Backlogg

Saker att följa upp. Det översta är nästa att göra. Flytta en punkt till
"Klart" med datum när den är gjord.

## Att följa upp

### Styrkor: status 1 nov kväll (läs först)
*Lagt till 2026-11-01.* Allt om fliken Styrkor och dess grunddata.

**I produktion:**
- Nattlig lägesbild (`src/forces.py`, ett Gemini-anrop efter 04:00-rapporten):
  anfall, uppföljningar och truppändringar mot ursprungligt underlag.
  API v3.12, D1 `force_maps`, fliken `#/styrkor`.
- Handskrivet underlag: 83 baser med förband och materiel
  (`config/forces_curated.json`), totalt 265 baser med Wikidata.

**Driftsatt 1 nov 23:21 (v3.13, migration 0013):**
- Veckosökningen (`src/forces_survey.py`): Wikipedia-artikeln för varje
  bas, läst av `gemini-3.5-flash-lite` med egen kvot, 3 anrop per natt
  (15 baser per anrop). Visas som rutan "Om basen".
- Anfallskartan över Ukraina (`src/strikes.py`, fliken "Anfall mot
  Ukraina", `#/styrkor?s=anfall`) från Kaggle-datasetet. Ingen modell.
  Första uppladdningen gick bra. Körs dagligen efter 04:00-rapporten.
- Behörighetsspärren stoppar `wrangler deploy` om inte användaren har sagt
  till uttryckligen i samma meddelande.

**Kaggle: klart 1 nov.** Hemligheterna är satta, och jobbet `strikes` hämtade
4306 rader och 30 nätter (senast 31 okt, 134 Shahed varav 105 nedskjutna).
Saknade
platsnamn läggs till i `LAUNCH` och `TARGET` i `src/strikes.py` (loggraden
"places not on the map").

**Pågår:**
- Veckosökningen: första fullständiga körningen klar 1 nov 23:16
  (`gemini-3.5-flash-lite`, valdes automatiskt). 228 baser lästa, 113 med
  förband, 34 utan Wikipedia-artikel. Stickprov bra (Engels-2,
  Gadzjijevo, Migalovo). Nedlagda baser (t.ex. Orlovka, stängd 2001)
  syns som "status okänd"; överväg en egen status "nedlagd" från
  veckosökningen.
- Molnjobb (Claude Code i molnet, användarens krediter) bygger
  grunddatabasen på grenen `grunddata-styrkor`:
  - `config/forces_db/bases.json`, `units.json` och `systems.json`;
  - bilder från Wikimedia Commons med licens i `webapp/public/forces/img/`;
  - klickbara förband och vapensystem i appen (`#/styrkor?sys=`, `?unit=`);
  - export till `webapp/public/forces/`.
  Det slår inte ihop något självt.

**Att göra när molnjobbet är klart:**
1. Granska grenen:
   - alla id-hänvisningar ska gå att lösa upp;
   - varje bild ska ha upphovsperson, licens och källa;
   - varje uppgift ska ha en källa, och ingen rysk statsmedia eller Telegram;
   - datamängden ska ligga långt under 2 MB och mappen med bilder ha rimlig storlek;
   - inga e-postadresser (repot är publikt);
   - nattens historik ska vara kvar (gamla id:n behålls, `db_id` är nytt).
2. Testa lokalt med `webapp/dev/mock_server.py` och data från datarepot
   (`gh api repos/jeaneclaude621-ui/threat_monitor-data/contents/data/forces.json`).
3. Slå ihop till main, driftsätt Workern (statiska filer) och kör jobbet
   `forces` så att den nya grunden laddas upp.

Kvoten efter allt: ungefär 16 av 20 anrop per dygn på huvudmodellen, plus 3
per natt på flash-lite.

### Kolla den första dagliga bedömningen av Rysslands handlingsalternativ
*Lagt till 2026-11-01.* Den första körs efter morgonrapporten 2 nov kl. 04.

Kontrollera:
- att tecknen markeras rimligt, att observerat betyder att något faktiskt
  har hänt och inte bara att det skulle kunna hända;
- att sannolikheterna inte står still eller flyter iväg;
- att kartan stämmer med texten.

Kvoten: ungefär 15 av 20 anrop per dygn.


### Kolla den första nattliga lägesbilden för styrkekartan
*Lagt till 2026-11-01.* Körs efter morgonrapporten, efter handlingsalternativen.

Kontrollera i fliken Styrkor:
- att anfallen hamnar på rätt bas och inte är gamla händelser som tas upp igen;
- att flyttade eller tillförda förband har stöd i källan;
- att "Övrigt" fångar anfall på platser som inte finns i baslistan (raffinaderier, fabriker).

Kvoten: ungefär 16 av 20 anrop per dygn.

### Skärp filtret för ryska Telegram-inlägg om för mycket kommer igenom
*Lagt till 2026-11-01. Kolla vid nästa session.*

Narrativ-flikens ryska sida släpper ibland igenom inlägg som inte handlar om
Nato, Europa eller grannländerna. Ett exempel 1 nov är Rybars minnestext om
vetenskapsmannen Vladimir Vernadskij. Filtret är regexen `RU_TOPIC` i
`src/trends.py`. Ett inlägg tas med om det någonstans nämner till exempel
Europa, Polen, Baltikum, sanktioner eller sabotage.

Så kollar du:
1. Läs de senaste dygnens ryska poster: `data/trends.json` i datarepot
   (`threat_monitor-data`), eller tabellen `trends` med `side = 'ru'` i D1:
   `npx wrangler d1 execute hotmonitor --remote --command "SELECT place, title_sv FROM trends WHERE side='ru' ORDER BY last_seen DESC LIMIT 40"`
2. Räkna hur många som inte rör Nato, EU eller grannländerna.

Om fler än ungefär en av fem är irrelevanta, välj en av lösningarna:
- Kräv att ämnesordet finns i inläggets första stycke i stället för var som
  helst i texten.
- Kräv två träffar i stället för en.
- Låt det dagliga Gemini-anropet som ändå översätter inläggen markera de som
  är utanför ämnet, och dölj dem. Det kostar inga extra anrop.

### Håll koll på trådbevakningens klassning
*Lagt till 2026-10-31.*

Efter omläggningen till ett anrop per körning klassades 5–6 av 6 trådar som
"ny utveckling". Den 1 nov var det 1–4 av 6. Om det går tillbaka till nästan
alla trådar varje gång, skärp instruktionen i `src/hourly_monitor.py`.

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

- 2026-11-01: Rysslands handlingsalternativ. Uppdateras varje dag efter
  morgonrapporten, 1 anrop. Den ryska sidan i Narrativ hålls utanför.

- 2026-11-01: Nato. En flik bredvid Svenska myndigheter, i samma Gemini-anrop
  (alternativ 1), översatt till svenska. Raden på Idag heter "Sverige och
  Nato".

- 2026-11-01: Svenska myndigheter. En rad på Idag och en egen sida, uppdateras
  kl. 07 och 17 (alternativ B). Mockupen finns på
  https://claude.ai/artifact/FMnaHUVGGBjyWZDTiD3rnd.
