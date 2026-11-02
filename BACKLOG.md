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

**Anfallskartan v2 (driftsatt 1 nov):** målen tas
ur `target_main` (72 av 112 rader har målregioner, nu spritt över hela
Ukraina). Rader utan mål ritas som korta, blekande spår. Vapenkort med bild
och prestanda läses från `webapp/public/forces/systems.json`, som
molnjobbet tar fram med id:n enligt `SYSTEM_IDS` i `src/strikes.py`. Tills
den filen finns visar korten bara text.

**Anfallskartan v3 (driftsatt 1 nov, hm-v3.24):** spåren kopplas ihop per natt
och vapentyp när rapporten delar upp ett anfall på flera rader: en rad med
avfyrningsplatser och målet "Ukraine", och regionala rader med mål men utan
avfyrningsplats. De härledda spåren är streckade. Nätter där ingen rad har
mål (t.ex. 31 okt) får fortfarande korta spår. Testat bara på 31 okt; kontrollera
en natt med mål (t.ex. 30 okt) i appen.

**Tillfällig vapenkatalog** `webapp/public/forces/systems.json` (33 vapen,
beskrivning och nyckeltal, 22 Commons-bilder i `webapp/public/forces/img/`).
Byggd med ett engångsskript från Wikipedias huvudbild, bara fritt
licensierade Commons-filer. Saknar bild: geran-3/4/5, gerbera, kn-23, kh-22,
banderol, supercam, zala, merlin-vr, forpost. Molnjobbets katalog ska ersätta
den vid sammanslagningen; behåll de här posterna för id som molnjobbet saknar.
Id:na följer `SYSTEM_IDS` i `src/strikes.py`.

**Driftsättning:** användaren har lagt in behörighetsregler (via
`/permissions`) för `env -u CLOUDFLARE_API_TOKEN npx wrangler deploy` och
`... d1 migrations apply hotmonitor --remote`. Kör dem som egna kommandon
med arbetsmappen `webapp/`, inte ihopkedjade med `cd`.

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
**Grunddatabasen: sammanslagen och driftsatt 2 nov (hm-v3.25).**
Molnjobbet byggde `config/forces_db/` (255 baser, 383 förband, 132
vapensystem, 120 Commons-bilder, 5,3 MB). Granskat:
- `src/forces_db_check.py` OK;
- inga e-postadresser, ingen rysk statsmedia eller Telegram;
- alla poster har källor och alla bilder har licens;
- nattens historik och veckosökningen finns kvar för alla 265 gamla baser;
- 379 baser totalt och datamängden är 520 KB.
Testat lokalt: vapenkort (`#/styrkor?sys=`), förbandskort (`?unit=`), inga
konsolfel. Uppladdat med jobbet `forces_survey`. Kataloger byggs om med
`python3 src/forces.py export-db`.

Att följa upp i grunddatabasen:
- Förbandskortet för 14:e armékåren säger Petjenga i texten men "Ingen bas
  i underlaget" som garnison. Kontrollera att garnisonerna i `units.json`
  pekar på bas-id som finns.
- Materiel kopplas till förband när artikeln nämner den i nutid (2010 eller
  senare). Äldre materiel kan ha slunkit med.
- Texterna är byggda ur mallar. Status är mest "aktiv enligt källan".
- Militärdistrikten bygger på molnjobbets tolkning av 2024 års reform
  (Engels räknas till Centrala).
- Fem baser har bara OpenStreetMap som källa: asipovitjy-belarus,
  bolsjoje-savino-perm, donskoje-kaliningrad, kamenka-viborg och kapustin-jar-2.
- Fyra anfallsdatum i det handskrivna underlaget rättades (Lipetsk,
  Marinovka, Kursk-Chalino, Sjajkovka). Primorsko-Achtarsk fick ett annat
  anfall, 2 aug 2024.
- Saknar bild: geran-4, geran-5, gerbera, banderol, supercam, zala,
  merlin-vr, kn-23, oresjnik, leer-3, tu-214, tornado-g.
- Inte använt: Overpass (502) och Militaryland.net (robots.txt tillåter
  automatisk läsning). Kan bli nästa påfyllning.
- 86 av de nya baserna saknar Wikipedia-artikel för veckosökningen;
  grunddatabasens text täcker dem.

**Nattens körning 2 nov:** lägesbilden föll på Gemini-kvoten (20 per dygn
på huvudmodellen, nollställs kl. 09 svensk tid), efter manuella körningar
kvällen innan. Nu faller den tillbaka på flash-lite-modellen. Undvik
manuella körningar av `forces` efter kl. 09 dagen före.

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
