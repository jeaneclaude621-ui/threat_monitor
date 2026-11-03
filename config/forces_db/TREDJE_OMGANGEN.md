# Styrkor, tredje omgången: löpande uppdatering till låg kostnad

Instruktion för en molnsession på grenen `styrkor-lopande`. Arbeta igenom
alla steg utan att stanna och fråga. Går något inte (nät, licens, källa
som saknas): skriv beslutet och skälet i `config/forces_db/README.md`
under "Beslut i tredje omgången" och gå vidare till nästa steg. Committa
och pusha efter varje avklarat steg (små commits, engelska meddelanden).

## Ramar (gäller allt)

- **Noll driftkostnad.** Inga betalda API:er. Gemini bara på gratisnivån:
  20 anrop per dygn och modell, dygnet slår om 09:00 svensk tid.
  - Huvudmodellen (`common.ask_model`) används redan ~16 gånger per dygn.
    Lägg **inga** nya anrop på den.
  - Lite-modellen (`common.lite_model()`) används idag av Narrativ
    (`src/trends.py`, 8 körningar per dygn = 8 anrop) och nattens enkät
    (`forces_survey.NIGHTLY_BATCHES` = 3). Plus reservanrop när
    huvudmodellen ger 429. Nya lite-anrop: högst 2 per dygn totalt.
  - Räkna budgeten i README:n (tabell: jobb, modell, anrop per dygn).
- **Repot är publikt:** inga e-postadresser, nycklar eller tokens i filer.
- **Källor:** inga ryska statsmedier (TASS, RT, RIA, Sputnik, Izvestija,
  Zvezda, Rossijskaja Gazeta) och inget Telegram som källa. ISW, Wikipedia,
  Wikidata, Commons, västliga och ukrainska medier går bra.
- **Bilder:** bara fritt licensierade Commons-filer med upphovsperson och
  licens, högst 640 px breda och under 80 kB, granska varje bild visuellt.
- **Skapa inga konton och mata inte in nycklar.** Kod som behöver en nyckel
  (FIRMS) ska läsa den ur en miljövariabel och göra ingenting om den saknas.
- **Deploya inte och rör inte `main`.** Granskning, merge och deploy görs
  lokalt efteråt.
- Kör `python3 -I src/forces_db_check.py` före varje commit som ändrar
  databasen; den ska passera.

## Steg 0: uppdatera grenen

Merga `origin/main` in i grenen (main har fått Narrativ-ändringar och
latin-transkribering i appen efter att grenen skapades). Lös konflikter så
att båda sidors ändringar behålls.

## Steg 1: ISW varje natt (högst 1 lite-anrop per natt)

Mål: förbandens status uppdateras löpande, inte bara de 64 som har en
daterad status idag.

- Ny modul `src/forces_isw.py`. Hämta ISW:s senaste dagliga bedömning
  ("Russian Offensive Campaign Assessment", understandingwar.org). Läs
  hellre RSS/sitemap än att skrapa startsidan. Bara text, inga bilder.
- **Förfiltrera i Python, utan anrop:** bygg en namnlista ur
  `config/forces_db/units.json` (engelska namn, nummer + typ, vanliga
  förkortningar som "CAA", "VDV", "MRD", "GTA", "Naval Infantry Brigade").
  Behåll bara stycken som nämner ett förband i databasen. Ingen träff:
  inget anrop.
- Ett enda lite-anrop med styckena och kandidat-id:n. Svar i strikt JSON:
  `[{unit_id, place, activity_sv, date, url}]`. Validera att `unit_id`
  finns, att datumet är rimligt (högst 3 dygn gammalt) och att `url` är
  ISW:s.
- Spara i forces-tillståndet som förbandets `status_sv`, `status_as_of`,
  `status_source` (en lista med de senaste 5 posterna per förband).
- Koppla in i `src/forces.py run()` efter nattens uppdatering, med samma
  felhantering som enkäten (ett fel får aldrig stoppa resten av natten).
  Lägg till CLI `python3 src/forces.py isw --dry-run`.
- Tester: förfiltret mot ett sparat ISW-utdrag i `tests/` eller
  `webapp/dev/` (inte nätet), och validering av modellens svar.

## Steg 2: synlig ålder på status (inga anrop)

- I `webapp/public/app.js`: visa "uppdaterad <datum>" på förbands- och
  baskort. Status äldre än 60 dagar tonas ner och märks "ej bekräftad
  sedan <datum>". Gäller även baser.
- Höj `VERSION` i `webapp/public/sw.js` ett steg.
- Testa med mockservern (`MOCK_ROLE=admin MOCK_PORT=8791 python3
  webapp/dev/mock_server.py`) och ta bort testfiler efteråt.

## Steg 3: NASA FIRMS, satellitbekräftade anfall (inga anrop)

- Ny modul `src/forces_firms.py`. Läser `FIRMS_MAP_KEY` ur miljön; saknas
  den skrivs en rad i loggen och modulen gör ingenting.
- För anfall de senaste 3 dygnen: fråga FIRMS area-API (VIIRS, NRT) om
  brandpunkter inom 3 km från basen inom 48 h efter anfallet. Träff:
  anfallet får `firms: {date, count, confidence}` och appen visar
  "brand sedd av satellit (NASA FIRMS)".
- Lägg `FIRMS_MAP_KEY` som env i `.github/workflows/scheduled-jobs.yml`
  (`${{ secrets.FIRMS_MAP_KEY }}`). Skapa ingen nyckel själv.
- Testa med sparat FIRMS-svar, inte nätet.
- Om firms.modaps.eosdis.nasa.gov inte nås från miljön: bygg och testa
  ändå med det sparade svaret och skriv det i README.

## Steg 4: bildjobb en gång i veckan (inga anrop)

- Gör `src/forces_db_images.py` körbar som jobb: högst 15 nya bilder per
  körning, cache, paus och avbrott vid 429, bara baser/system utan bild.
- Nytt jobb `forces_images` i `schedule/run_job.py` (lägg det i
  `QUIET_JOBS`) och som val i `scheduled-jobs.yml`. Jobbet committar
  bilderna och de uppdaterade JSON-filerna till repot. Kolla hur andra jobb
  skriver till repot innan du väljer sätt.
- Den visuella granskningen kan inte göras i ett jobb. Ta därför bara
  artikelns huvudbild när filnamn eller beskrivning innehåller flygfält,
  bas, hamn, flygplan eller fartyg, och lista allt jobbet lagt till i
  jobbets logg så att det kan granskas i efterhand.
- Kör också själv här i sessionen så många basbilder som Wikimedia tillåter
  (granska varje bild visuellt, som i andra omgången).

## Steg 5: frontlinjen som kartlager (inga anrop), bara med fri licens

- Utred licensen för ISW:s kartdata (ArcGIS/KMZ), DeepStateMap och andra
  öppna källor till ockuperat område. Använd bara en källa vars villkor
  tillåter återpublicering i en app, och ange källan på kartan.
- Finns en sådan: jobb som hämtar och förenklar ytan en gång per dygn
  (eller vecka), sparar den som `webapp/public/forces/front.json` eller via
  forces-payloaden, och ett lager i `viewForces`/`viewStrikes` med
  halvgenomskinlig fyllning under baserna.
- Finns ingen: skriv vad som undersöktes och varför det inte gick i README.

## Steg 6: fyll på grunddata

- Basbeskrivningar och förbandstexter för de förband som saknar text
  (källa: Wikipedia, ISW). Samma regel som förut: hellre stryka än skriva
  ur minnet.
- Försök OpenStreetMap/Overpass igen för militära områden; om det inte nås,
  skriv det.

## Steg 7: avslut

- Uppdatera `config/forces_db/README.md`: siffror, budgettabellen för
  Gemini, vad som gjordes och inte gjordes per steg.
- Uppdatera `BACKLOG.md` (avsnittet Styrkor): vad som är klart på grenen
  och vad som återstår för granskning, merge, deploy och nyckeln
  `FIRMS_MAP_KEY` som användaren skaffar själv.
- Kör kontrollen en sista gång och pusha.

## Domäner som behöver vara öppna i miljön

understandingwar.org, www.understandingwar.org, firms.modaps.eosdis.nasa.gov,
*.wikipedia.org, www.wikidata.org, query.wikidata.org,
commons.wikimedia.org, upload.wikimedia.org, overpass-api.de,
deepstatemap.live, services.arcgis.com, github.com, pypi.org,
files.pythonhosted.org.
