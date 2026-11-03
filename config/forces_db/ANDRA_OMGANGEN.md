# Andra omgången av grunddatabasen: instruktion för en molnsession

Den här filen är instruktionen till Claude Code för att fortsätta arbetet. Starta en
session på grenen `grunddata-styrkor-2` i repot jeaneclaude621-ui/threat_monitor
och följ den. (Written in English below, for the agent.)

---

You are continuing a LONG, thorough second pass over the foundation database of
Russia's and Belarus's forces in `config/forces_db/` (bases.json, units.json,
systems.json, README.md), checked by `src/forces_db_check.py` and merged into the
app by `src/forces.py` (`python3 src/forces.py export-db` writes
webapp/public/forces/systems.json and units.json; images in webapp/public/forces/img/).
The repo is PUBLIC: never commit an email address, secret or token.
User-facing text is Swedish.

Work on the branch `grunddata-styrkor-2` (already has steps 1 and 5 and the start of 6).
Read config/forces_db/README.md, especially "Beslut i andra omgången", first.

Run as long as it takes. NEVER stop to ask questions: make reasonable decisions,
log them in README under "Beslut i andra omgången", and carry on. Commit and PUSH
to `grunddata-styrkor-2` after every step (and at least hourly), so nothing is
lost. End each commit message with the line
`Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Do NOT merge to main
and do NOT open a PR.

DO NOT EDIT: webapp/public/app.js, app.css, sw.js, index.html, webapp/src/worker.js,
src/strikes.py (the main session owns them). Your scope: config/forces_db/*,
webapp/public/forces/{img,systems.json,units.json}, src/forces.py,
src/forces_db_check.py, helper scripts under src/, README.

Done already: step 1 (garrisons: 158 more units, 49 garrison bases),
step 5 (72 more attacks with damage, arsenals as bases), step 6 started
(images for geran-4, geran-5, gerbera, kn-23, leer-3, merlin-vr, supercam,
tornado-g, tu-214, zala). Check what remains of each before redoing anything.

Remaining steps, in order:
1. Finish step 1: every unit that still exists gets garrison base id(s); a unit
   with genuinely unknown garrison gets `garrison: []` and `garrison_note_sv`.
2. Militaryland.net (robots.txt allows automated reading; one request per 3-5 s,
   User-Agent naming the repo): cross-check and fill units, parent formations,
   garrisons, current status/location; cite the page URL per fact.
3. OpenStreetMap via Overpass (try overpass-api.de, overpass.kumi.systems,
   overpass.private.coffee): military=airfield/base/naval_base and military
   aerodromes in Russia and Belarus; add missing bases (merge within 5 km),
   cite the OSM element URL.
4. Bases: aim for completeness (every active air base, naval base, missile
   brigade/division site, army division/brigade garrison, major air-defence
   regiment; Russia, Belarus, occupied Crimea, abroad). Closed ones stay with
   status_sv "nedlagd". A proper description_sv per base (not a template): role,
   what is there now, notable events since 2022. `image` when Commons has a
   freely licensed photo: {file: "base-<id>.jpg", author, license, source_url}.
5. (done) Attacks on bases since Feb 2022.
6. Systems: every equipment reference resolves; description_sv, key_figures,
   image (freely licensed Commons only, CC0/CC BY/CC BY-SA/PD; else null).
7. Units: real description_sv for at least the 150 most significant; status_sv
   with as_of from the best source (e.g. "i strid vid Pokrovsk enligt ISW,
   okt 2026"). Russian Navy ships by name as units of type "fartyg" with home
   base and class (system id).
8. src/forces.py passes base description_sv, image, status_sv, as_of and unit
   garrison_note_sv through to the payload; payload under 1.5 MB; the nightly
   base list (base_lines) under ~60,000 characters; existing app ids of bases
   never change (db_id is the slug).
9. Limits: webapp/public/forces/img under 15 MB total, each file under 80 KB.
10. Verify: extend and run src/forces_db_check.py (references resolve, every fact
    sourced, every image with author/license/source_url and present, no
    state-media URLs - TASS, RT, RIA, Sputnik, Izvestia, Zvezda, Rossiyskaya
    Gazeta - no Telegram, no emails), syntax checks, `python3 src/forces.py
    --dry-run` if the network allows, `python3 src/forces.py export-db`. Update
    README with counts and sources.

Sources: Western and Ukrainian media, ISW/Critical Threats, Wikipedia (en, ru),
Wikidata, Commons, OSM, Militaryland. Never Russian state media or Telegram.

Final message: branch and last commit, counts before/after (bases, units,
systems, images, events), sources used and not and why, decisions, anything
uncertain, payload and image-folder sizes.
