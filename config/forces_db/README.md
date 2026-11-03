# Grunddata om ryska och belarusiska styrkor

Grunddatabasen för fliken Styrkor: Rysslands och Belarus militära baser, de
förband som finns där och de vapensystem de har, med bild och status. Allt
kommer från öppna källor och är **inte verifierat**. Hämtat 1–3 november 2026.

## Filer

| Fil | Innehåll | Antal |
|---|---|---|
| `bases.json` | baser: flygbaser, marinbaser, garnisoner för armé, robot, luftvärn och luftlandsättning, samt ryska baser utomlands | 325 (15 nedlagda, 98 anfall) |
| `units.json` | förband: arméer, kårer, divisioner, brigader, regementen, flottor, och marinens fartyg (`fartyg`) | 487 (varav 104 fartyg; alla med egen text) |
| `systems.json` | vapensystem och materiel: flyg, helikoptrar, drönare, robotar, luftvärn, fordon, artilleri, telekrig, ubåtar, fartyg | 132 (alla 33 vapen på anfallskartan ingår) |

Bilder: 139 bilder i `webapp/public/forces/img/` – 130 system (`sys-<id>.jpg`)
och 9 baser (`base-<id>.jpg`), högst 640 px breda, under 80 kB var, totalt
6,0 MB.

### Bas (`bases.json`)
`id` (stabil slug), `name` (svensk translitterering), `name_ru`, `name_en`,
`lat`, `lon`, `branch` (flyg, marin, armé, luftvärn, robot, fallskärm),
`country` (RU, BY, UA för ockuperade Krim, annars landets ISO-kod),
`military_district`, `description_sv`, `units` (förbands-id), `equipment`
(system-id), `status` (`status_sv`, `as_of`, `note`), `events` (anfall:
`date`, `kind`, `text_sv`, `damage_sv`, `sources`), `image` (som för system, eller saknas) och `sources`. Baser från den
handskrivna listan (`config/forces_curated.json`) har också
`curated_index`, `curated_units` och `curated_equipment`, så att appens
namn och visningssträngar består.

### Förband (`units.json`)
`id`, `name_sv`, `name_ru`, `name_en`, `type`, `branch`, `country`,
`parent` (högre förband), `garrison` (bas-id), `equipment` (system-id),
`status_sv`, `as_of`, `description_sv`, `image` (inga förbandsmärken än),
`sources`, och vid behov `garrison_note_sv`. Fartyg (`type` "fartyg") har
också `class` (system-id för fartygsklassen) och flottan som `parent`.

### System (`systems.json`)
`id`, `name`, `name_ru`, `category_sv`, `role_sv`, `description_sv`,
`key_figures` (korta uppgifter som räckvidd och hastighet, som de
publicerats), `image` (`file`, `commons_file`, `author`, `license`,
`license_url`, `source_url`) eller `null`, och `sources`. Id:n för vapnen
på anfallskartan (`src/strikes.py`) är fasta och kontrolleras av
`src/forces_db_check.py`.

## Källor

- **Wikipedia, ryska**: kategorierna för Rysslands och Belarus
  militära förband, militära flygfält och marinbaser. Förbandens
  faktarutor (förläggning, högre förband, år, materiel) lästes
  maskinellt; ett förband togs med bara om faktarutan anger att det finns
  kvar. Materiel kopplas till ett förband när systemet nämns i faktarutan
  eller i en mening om nutiden (år 2010 eller senare, "на вооружении" med
  flera). Det kan därför finnas äldre materiel med.
- **Wikipedia, engelska**: artiklar om baser och system (länkade som
  källa), och om de anfall som räknas upp.
- **Wikidata**: koordinater där Wikipedia saknar dem, och appens nattliga
  baslista (CC0).
- **OpenStreetMap / Nominatim**: län och land för varje position, som
  avgör militärdistriktet. Positioner där ingen artikel finns länkas till
  OpenStreetMap.
- **Wikimedia Commons**: alla bilder (se nedan).
- **ISW / Critical Threats**: de dagliga bedömningarna aug–nov 2026 för
  förbandens aktuella status (var de strider, med datum och länk).
- **Wikipedias lista över den ryska marinens aktiva fartyg** (nov 2026):
  fartygen, deras klass, flotta, hemmahamn och status.
- **Ukrainska och västliga medier samt ISW**: anfall där Wikipedia inte
  räckte (Espreso, Hromadske, Kyiv Post, ISW/Critical Threats), och
  Reuters och Kyiv Independent för enstaka system.

Inte använt: rysk statsmedia (TASS, RT, RIA, Sputnik, Izvestija, Zvezda,
Rossijskaja Gazeta) och Telegram. Militaryland.net har inga ryska förband längre
(se beslut nedan); OpenStreetMaps Overpass-tjänst gick inte att nå från
molnmiljön, så Wikidata fick stå för kontrollen av saknade baser. Oryx, IISS,
CSIS, RUSI och Janes används inte direkt; förluster och styrketal från
dem kan läggas till för hand med källa.

Uppgifter anges aldrig starkare än källan: "enligt ukrainska uppgifter",
"rapporterades", "enligt källan".

## Bilder: licensregeln

Bara bilder från Wikimedia Commons under fri licens: CC0, CC BY, CC BY-SA
eller allmän egendom. Varje bild har upphovsperson, licens och länk till
filsidan på Commons, och appen visar dem under bilden (krav enligt
licenserna). Inga andra bilder, inget upphovsrättsskyddat material och
inga bilder av identifierbara privatpersoner. Finns ingen fri bild är
`image` null och appen visar bara text. Bilderna ligger på appens egen
domän eftersom sidans Content-Security-Policy bara tillåter bilder därifrån.

## Hur de nattliga och veckovisa jobben bygger på detta

- `src/forces.py` läser databasen varje natt (`load_db`, `apply_db`)
  ovanpå Wikidatas baslista och den handskrivna listan. Databasen vinner
  där den beskriver samma bas (inom 15 km och samma vapenslag, eller samma
  namn). Basen behåller appens id (Wikidatas Q-id eller c<n>) så att
  nattens historik finns kvar, och får fältet `db_id`. Baser som bara finns
  i databasen får dess slug som id. Basens `units` och `equipment` är
  fortfarande visningssträngar (som Workern kontrollerar), och `unit_ids`
  och `system_ids` pekar in i databasen. Databasens innehav blir basens
  `original`, och nattens ändringar (tillfört, flyttat, borta) läggs ovanpå
  som förut.
- Veckosökningen (`src/forces_survey.py`) läser varje bas Wikipedia-artikel
  som förut; den ändrar inte databasen.
- `python3 src/forces.py export-db` skriver appens statiska kopior
  `webapp/public/forces/systems.json` och `units.json`. Kör den efter varje
  ändring här.
- `python3 src/forces_db_check.py` kontrollerar att alla id-hänvisningar
  går att följa, att allt har källa och att varje bild finns med
  upphovsperson och licens. Den kontrollerar också att ingen källa är rysk
  statsmedia eller Telegram, att ingen e-postadress finns i filerna, att
  bildmappen håller sig under 15 MB (80 kB per fil), att förband utan
  garnison har `garrison_note_sv` och att appens payload (under 1,5 MB) och
  den nattliga baslistan (under 60 000 tecken) håller sig inom gränserna.
- Basens `image` följer nu med till appens payload, precis som
  `description_sv`, `status_sv` och `status_as_of`.
- **ISW varje natt** (`src/forces_isw.py`, efter enkäten i `forces.run()`):
  förbandens aktuella status hamnar i tillståndet som
  `units[<id>] = {status_sv, status_as_of, status_source}` och i payloadens
  `units`. Förbandskortet visar den före grunddatabasens status.
  `python3 src/forces.py isw --dry-run` visar styckena och prompten.
- **NASA FIRMS** (`src/forces_firms.py`): anfall de senaste tre dygnen får
  `firms` när satelliten såg brand inom 3 km inom 48 timmar. Kräver
  hemligheten `FIRMS_MAP_KEY`.
- **Bildjobbet** (`forces_images`, onsdagar): `src/forces_db_images.py job`
  lägger till högst 15 fria Commons-bilder och committar dem till kodrepot;
  loggen listar vad som lagts till, för granskning i efterhand.

Att rätta: ändra i JSON-filerna för hand (med källa), kör `export-db` och
kontrollen. Nästa natt når ändringen appen.

## Beslut i andra omgången

Andra omgången (påbörjad 2 nov 2026, gren `grunddata-styrkor-2`).

- **Militaryland.net** har i dag (nov 2026) bara Ukrainas förband i sin
  ordning av bataljon (`/ukraine/...`); sidorna om ryska förband finns inte
  längre (`/russia/` ger 404, sökningen i sajtens API ger bara ukrainska
  förband). Den kan därför inte användas för att kontrollera ryska förband
  och garnisoner. Lästes artigt (en förfrågan var fjärde sekund, med
  User-Agent som namnger repot).
- **Garnisoner (steg 1).** En garnison sattes bara när orten nämns i
  förbandets egen Wikipedia-artikel (ryska eller engelska); den artikeln är
  källan. 158 förband fick garnison på det sättet, fyra till via det högre
  förbandet (då står det i `garrison_note_sv`). 49 nya garnisonsbaser lades
  till med position från ortens ryska Wikipedia-artikel. En ny garnison som
  låg inom 5 km från en befintlig bas slogs ihop med den (till exempel
  Maikop, Znamensk/Kapustin Jar, Olenja Guba/Poljarnyj), utom Kursk där
  staden och flygbasen Chalino hålls isär. 51 förband har `garrison: []` och
  en `garrison_note_sv`: mest regementen och divisioner som bildats under
  kriget och aldrig haft fast förläggning i Ryssland.
- Förband som strider i Ukraina behåller sin hemgarnison; var de strider
  står i `status_sv`.
- **Anfall (steg 5).** Varje anfall har nu `damage_sv` (vad som enligt
  källan träffades; "Okänt." när källan inte säger det). Källorna är de
  västliga och ukrainska artiklar som Wikipedias artiklar om baserna och om
  anfallen i Ryssland och på Krim hänvisar till (Reuters, BBC, AP, Kyiv
  Independent, The War Zone, Forbes, Naval News, ISW med flera), aldrig
  rysk statsmedia eller Telegram. Ett anfall vars datum inte gick att
  fastställa (Tu-142 i Taganrog, maj 2026) togs inte med.
- Stora ammunitionsarsenaler som anfallits (Toropets, Oktjabrskij,
  Tichoretsk, Karatjev, Kotovo, Barsovo, Kotluban) och luftvärnsplatsen på
  kap Tarchankut lades till som baser (vapenslag armé respektive luftvärn).
  Deras positioner är ungefärliga, vilket står i beskrivningen.

- **Molnsessionen 2 nov 2026 (kväll).** Miljöns nätverkspolicy stoppade
  all trafik till Militaryland, Overpass (alla tre speglarna), Wikipedia,
  Wikidata, Commons och ISW. Därför gjordes bara det som går utan att läsa
  källor: basens bild skickas vidare i `src/forces.py` (steg 8), kontrollen
  byggdes ut (steg 10) och appens kopior exporterades på nytt. Steg 1 var
  redan klart (alla förband har garnison eller `[]` med anteckning). Steg
  2, 3, 4, bilderna i steg 6 och steg 7 kräver nätåtkomst och väntar.
  Inga uppgifter skrevs ur minnet utan källa som gick att läsa.

- **Molnsessionen 2 nov 2026 (natt), med nätåtkomst.** Domänerna för
  Wikipedia, Wikidata, Commons, Overpass, Militaryland och ISW/Critical
  Threats lades till i miljöns nätverkspolicy. Wikimedia svarade ofta med
  429 (gemensam adress), så allt hämtades långsamt med cache
  (`src/forces_fetch.py`, `.cache/` ignoreras av git).
- **Steg 2, Militaryland.** Kontrollerat igen: `/russia/` ger 404 och
  `/russia/ground-forces/` omdirigeras till en ukrainsk nyhet. Sajten har
  inga ryska förband och användes inte.
- **Steg 3, OpenStreetMap.** Overpass (overpass-api.de, overpass.kumi.systems,
  overpass.private.coffee) svarade inte från miljön: anslutningen återställs
  eller tar timeout uppströms, flera försök under natten. I stället
  användes Wikidatas militära flygfält och baser i Ryssland, Belarus och
  på Krim med deras Wikipedia-artiklar: 87 kandidater som låg mer än 5 km
  från en befintlig bas lästes, och 13 som artikeln beskriver som aktiva
  lades till (bland andra Mozdoks flygbas med två anfall, Torzjok, Rostov
  nord, Syzran, Luninets i Belarus och marinens provskjutningsfält vid
  Njonoksa). Nedlagda flygfält, rena civila flygplatser och anläggningar
  utanför försvarsmakten (Rosgvardija, rymdövervakning) togs inte med.
- **Steg 4, baser.** Varje bas har nu en egen `description_sv` skriven
  utifrån Wikipedia-ingressen för basen och dess förband, databasens
  materiel och anfall, och ISW för var förbanden strider. Uppgifter som
  inte stod i någon läst källa ströks hellre än skrevs ur minnet. 15 baser
  som Wikipedia beskriver som nedlagda eller civila har `status_sv`
  "nedlagd". Molkino låg fel (vid en by i Rjazan oblast) och flyttades till
  Spetsnaz-basen vid Gorjatjij Kljutj i Krasnodar kraj; Mozdoks Tu-22M3
  flyttades från armégarnisonen till den nya flygbasen.
- **Basbilder.** `src/forces_db_images.py` tar artikelns huvudbild från
  Commons bara om licensen är fri och upphovspersonen anges. Av 26
  kandidater valdes 14 som visar själva basen eller dess flygplan, och 9
  av dem gick att ladda ner innan Wikimedias spärr (429) tog stopp;
  bilder av orter, kyrkor, förbandsmärken och övningar med soldater i
  närbild valdes bort. Varje vald bild granskades visuellt.
  Commons levererar nu miniatyrer från `thumb.wikimedia.org`, som inte är
  tillåten; samma sökväg hämtas från `upload.wikimedia.org`.
- **Steg 6, system.** Oresjnik och Banderol saknar fria fotografier på
  Commons (bara GIF-stillbilder ur video med oklar licens); `image` är null.
- **Steg 7, förband.** 104 fartyg ur Wikipedias lista över den ryska
  marinens aktiva fartyg (nov 2026) lades till som förband av typen
  `fartyg`, för de klasser databasen har ett system för; skrov som listan
  själv markerar som osäkra togs inte med. Där listan bara anger flottan är
  hemmabasen flottans huvudbas för fartygstypen, och det står i
  `garrison_note_sv`. 64 förband fick aktuell status ur ISW:s dagliga
  bedömningar (aug–nov 2026), lästa för hand, med datum och länk. 176 av de
  viktigaste förbanden (arméer, kårer, flottor, divisioner och robot-,
  marininfanteri- och specialförbandsbrigader) har nu egna beskrivningar.
  45:e flyg- och luftförsvarsarmén är markerad som upplöst 2024.

## Beslut i tredje omgången

Tredje omgången (3 nov 2026, gren `styrkor-lopande`): löpande uppdatering
till låg kostnad.

- **Steg 0.** `origin/main` (Narrativ, latin-transkribering) mergades in
  utan konflikter.
- **Steg 1, ISW varje natt.** `understandingwar.org` svarar med en
  Cloudflare-utmaning (403) både på sidorna, RSS och sitemap. Samma dagliga
  bedömningar publiceras på `criticalthreats.org` med förutsägbara adresser
  (`russian-offensive-campaign-assessment-<månad>-<dag>-<år>`), så
  `src/forces_isw.py` läser dem där och provar ISW:s egen adress som
  reserv. Förfiltret i Python (nummer + typ på det sätt ISW skriver, med
  förkortningarna CAA, AC, GTA, MRD, TD, VDV) gav 6–9 förband ur 8 stycken
  på de bedömningar som provades; inget stycke med ett känt förband ger
  inget anrop. Högst ett lite-anrop per dygn (`state["isw"]["called"]`).
- **Steg 2.** Förbands- och baskort visar "uppdaterad <datum>"; status
  äldre än 60 dagar tonas ner och märks "ej bekräftad sedan <datum>".
  Månadsdatum ("2026-11") räknas från månadens första dag.
- **Steg 3, NASA FIRMS.** API:t nås från miljön (svarar "Invalid MAP_KEY"
  utan nyckel). Modulen testas med ett sparat svar i FIRMS format;
  `FIRMS_MAP_KEY` måste skaffas av ägaren (gratis hos NASA FIRMS) och
  läggas som repo-hemlighet. Utan den gör kontrollen ingenting.
- **Steg 4, bildjobbet.** Inga jobb skriver idag till kodrepot (de skriver
  till state-repot via `STATE_DEPLOY_KEY`). Bilderna och databasen hör dock
  hemma i kodrepot, eftersom appen serverar dem som statiska filer, så
  `run_job.py` committar jobbets filer dit med arbetsflödets egen token
  (`permissions: contents: write`). Jobbet pushar till grenen det körs på,
  i drift `main`. Wikimedia stryper nya miniatyrer för miljöns adress
  (429 även vid standardstorlekarna 330 och 500 px, medan redan skapade
  miniatyrer levereras), så sessionen fick inga nya basbilder; jobbet
  stannar vid första 429 och försöker igen veckan efter.
- **Steg 5, frontlinjen: inget kartlager.** Undersökt:
  - *ISW:s karta* (ArcGIS/KMZ): ISW anger inga öppna villkor för kartdatan;
    innehållet är upphovsrättsskyddat och att återpublicera geometrin i en
    app kräver tillstånd. Inte använd.
  - *DeepStateMap*: licenssidan (deepstatemap.live/license-en.html) gick
    inte att läsa från miljön (anslutningen bryts efter TLS-handskakningen).
    Enligt sökresultat om sidan kräver API:t godkännande vid kommersiell
    användning och visuellt material får användas med hänvisning, men
    inget säger att polygondatan fritt får återpubliceras och bearbetas.
    Inte använd utan att villkoren lästs och tillstånd getts.
  - *Wikimedia Commons*: kartorna över ockuperat område är rasterbilder
    eller SVG (CC BY-SA) utan geografisk referens; ingen GeoJSON med fri
    licens hittades. *OpenStreetMap* kartlägger inte ockupationslinjer.
  Om ägaren får skriftligt tillstånd från DeepStateMap (eller en annan
  källa med öppen licens dyker upp) kan ett jobb och ett lager byggas:
  förenkla ytan en gång per dygn till `webapp/public/forces/front.json`
  och rita den halvgenomskinlig under baserna med källan på kartan.
- **Steg 6, grunddata.** De 207 förband som hade kvar malltexten har nu egna
  beskrivningar, skrivna från Wikipedia-ingresserna och ISW; alla 487
  förband och alla 325 baser har egna texter, och kontrollen avvisar
  malltexterna. Några felaktiga högre förband och garnisoner rättades
  (bland annat 103:e regementet under 150:e divisionen, 218:e
  stridsvagnsregementet i Sergejevka, 74:e robotregementet under 28:e
  robotdivisionen). Overpass (alla tre speglarna) svarade fortfarande inte
  från miljön (återställd anslutning eller timeout); OpenStreetMap
  användes därför inte heller i denna omgång.

### Gemini-budget (gratisnivån, 20 anrop per dygn och modell)

Dygnet slår om kl. 09 svensk tid. Tredje omgången lägger till högst ett
anrop per dygn, på lite-modellen.

| Jobb | Modell | Anrop per dygn |
|---|---|---|
| Rapporter, Nato-briefen och nattens styrkeuppdatering (`common.ask_model`) | huvudmodellen | under 20 (byter till lite-modellen när kvoten är slut, sedan 3 nov) |
| Trådbevakningen (`src/hourly_monitor.py`, 12:00 och 21:00, sedan 3 nov) | lite | 2 |
| Narrativ (`src/trends.py`, 8 körningar) | lite | 8 |
| Nattens Wikipedia-enkät (`forces_survey.NIGHTLY_BATCHES`) | lite | 3 |
| **ISW-läsningen (`src/forces_isw.py`), ny** | lite | **högst 1** (0 när inget stycke nämner ett förband; byter aldrig till huvudmodellen) |
| Reserv när huvudmodellen ger 429 eller är överbelastad | lite | varierar, i praktiken 0–2 |
| NASA FIRMS (`src/forces_firms.py`), ny | inga | 0 |
| Bildjobbet (`forces_images`), nytt, en gång i veckan | inga | 0 |
| Lite-modellen totalt | | cirka 14–16 av 20 |

### Siffror efter tredje omgången (3 nov 2026)

325 baser (alla med egen text, 15 nedlagda, 98 anfall, 9 med bild),
487 förband (alla med egen text; 104 fartyg; 63 med daterad status ur ISW
från andra omgången, och från och med nu uppdateras statusen varje natt),
132 system (130 med bild). Payload 457 kB, nattens baslista 38 705 tecken,
bildmappen 6,0 MB. Tester: `python3 -m unittest discover -s tests`
(18 tester, utan nät).
