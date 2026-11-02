# Grunddata om ryska och belarusiska styrkor

Grunddatabasen för fliken Styrkor: Rysslands och Belarus militära baser, de
förband som finns där och de vapensystem de har, med bild och status. Allt
kommer från öppna källor och är **inte verifierat**. Hämtat 1 november 2026.

## Filer

| Fil | Innehåll | Antal |
|---|---|---|
| `bases.json` | baser: flygbaser, marinbaser, garnisoner för armé, robot, luftvärn och luftlandsättning, samt ryska baser utomlands | 312 |
| `units.json` | förband: arméer, kårer, divisioner, brigader, regementen, flottor | 383 |
| `systems.json` | vapensystem och materiel: flyg, helikoptrar, drönare, robotar, luftvärn, fordon, artilleri, telekrig, ubåtar, fartyg | 132 (alla 33 vapen på anfallskartan ingår) |

Bilder: 130 bilder i `webapp/public/forces/img/` (`sys-<id>.jpg`, cirka
640 px breda, under 80 kB var, totalt 5,7 MB).

### Bas (`bases.json`)
`id` (stabil slug), `name` (svensk translitterering), `name_ru`, `name_en`,
`lat`, `lon`, `branch` (flyg, marin, armé, luftvärn, robot, fallskärm),
`country` (RU, BY, UA för ockuperade Krim, annars landets ISO-kod),
`military_district`, `description_sv`, `units` (förbands-id), `equipment`
(system-id), `status` (`status_sv`, `as_of`, `note`), `events` (anfall:
`date`, `kind`, `text_sv`, `sources`) och `sources`. Baser från den
handskrivna listan (`config/forces_curated.json`) har också
`curated_index`, `curated_units` och `curated_equipment`, så att appens
namn och visningssträngar består.

### Förband (`units.json`)
`id`, `name_sv`, `name_ru`, `name_en`, `type`, `branch`, `country`,
`parent` (högre förband), `garrison` (bas-id), `equipment` (system-id),
`status_sv`, `as_of`, `description_sv`, `image` (inga förbandsmärken än),
`sources`.

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
- **Ukrainska och västliga medier samt ISW**: anfall där Wikipedia inte
  räckte (Espreso, Hromadske, Kyiv Post, ISW/Critical Threats), och
  Reuters och Kyiv Independent för enstaka system.

Inte använt: rysk statsmedia (TASS, RT, RIA, Sputnik, Izvestija, Zvezda,
Rossijskaja Gazeta) och Telegram. Militaryland.net tillåter automatisk
läsning enligt robots.txt men lästes inte i denna omgång; OpenStreetMaps
Overpass-tjänst svarade inte (502) när underlaget byggdes. Oryx, IISS,
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
