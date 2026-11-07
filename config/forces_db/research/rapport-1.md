# Rapport, forskningslista 1: flygbaser väster om 40° O

Lista: `todo-1-flyg-vast.json` (53 poster: 23 med `db_id`, 30 bara i Wikidata).
Patch: `patch-1.json`, inläst med `src/forces_db_patch.py`; `export-db` och
`forces_db_check.py` ger OK (327 baser, 487 förband, 141 system).
Utfört 7 nov 2026. Källor: engelska, ryska, ukrainska och belarusiska
Wikipedia, inklusive "List of military airbases in Russia" och "Russian Naval
Aviation". Ingen rysk statsmedia och inget från Telegram.

## Summering

| | Antal |
|---|---|
| Baser som fick materiel | 7 (6 befintliga och 1 ny) |
| Befintliga baser med bara status | 17 |
| Nya baser (`new_bases`) | 2 (Chrabrovo, Gromovo) |
| Hoppade över | 28 |
| Nya systemkort | 1 (`an-140`) |
| Förband som fick materiel | 2 (55:e gardes helikopterregementet, 4:e gardes marina attackflygregementet) |

## Baser med materiel

| Bas | Materiel | Källa |
|---|---|---|
| Katja (Krim) | An-26, An-12, Be-12, Tu-134, Ka-27/29, Mi-8, MiG-29K (detacherad, anfallen dec 2025) | en/ru Wikipedia, Russian Naval Aviation |
| Korenovsk | Mi-28N, Mi-35M, Mi-8AMTSj, Ka-52 (leveranser 2011–2016) | ru/uk Wikipedia |
| Kusjtjovskaja | Su-27, MiG-29, L-39 (skolflygbas 195) | ru/uk Wikipedia |
| Tjernjachovsk | Su-30SM, Su-24M, Forpost | en/ru Wikipedia |
| Jermolino | Il-76, An-26, An-12 (Rosgvardijas 70:e flygregemente) | ru Wikipedia |
| Tartus (Syrien) | Gorsjkov-klass (Admiral Kasatonov), Steregusjtjij-klass (Stojkij); besökande fartyg 2026, inte fast baserade | en Wikipedia |
| Chrabrovo (ny) | An-26, An-140 (398:e transportskvadronen; An-24 saknar kort) | en Wikipedia, Russian Naval Aviation |

Gromovo (ny) har bara status (se nedan).

## Befintliga baser med bara status

- Nedlagda: Alakurtti, Andreapol, Batajsk, Dorochovo, Karagoz, Kilpjavr,
  Pruzjany, Torosjkovitji.
- Inte längre militär/civil: Malino (DOSAAF sedan 2014; texten rättad, den
  påstod Mi-8 i dag), Lipki (räddningsministeriet).
- Reservfält eller verkstad utan flygförband: Bobrujsk, Jevpatorija,
  Krasnodar-Tsentralnyj (275 ARZ), Rzjev (514 ARZ), Siverskij.
- Okänd materiel: Chmejmim (övergår till syrisk förvaltning enligt beslut i
  aug 2026), Klokovo (490:e helikopterregementet anges bara med sovjetiska
  källor, så Mi-8/Mi-24 lades inte in).

## Nya baser

- **Chrabrovo** (Kaliningrads flygplats, militär del): materiel enligt ovan.
- **Gromovo**: flygbas enligt engelska Wikipedia, men ingen säker
  materiel. Samma Wikipedia-sida anger 33:e regementet både här och i
  Levasjovo. Posten Q111711167 är en dubblett av samma bas.

## Hoppade över (28)

- Nedlagda, övergivna eller plöjda flygfält: Afrikanda, Bagerovo, Balbasovo
  (civil, Orsja), Berjozovka, Bobr, Bobrovitji, Gatjina (bebyggd), Gorelovo
  (allmänflyg, verkstad), Izmajlovo (bebyggt), Lodejnoje Pole, Louchi-3,
  Maladzetjna, Majsionvara, Podusjemje, Postavy, Protasovo (flygklubb),
  Smarhon, Vitsebsk-Nord, Jappilja, Jefremov, Ross. Inget av dem är i dag en
  aktiv militär bas enligt sin artikel (Jefremov och Ross enligt veckoenkätens
  sammanfattning av artikeln; texten hämtades inte färdigt i den här
  sessionen).
- Svartahavsflottans reservledningsplats (Krim): ofärdig, övergiven anläggning.
- Gromovo Air Base (Q111711167): dubblett av Gromovo.
- Rostov-na-Donu Tsentralnyj (Q113015180): ligger 0,6 km från den befintliga
  basen Rostov nord och har ingen egen Wikipedia-artikel.
- Kachalovka, Klimovo, Salmi: bara Wikidata, ingen artikel eller annan källa
  som bekräftar en aktiv militär bas.
- Tobol 8282/6 (Pionerskij): telekrigsanläggning som västliga medier (GPS
  World, RUSI, Polskie Radio) kopplar till störningar av GPS-signaler. Sidorna
  gick inte att läsa från miljön (403/DNS), så den lades inte till. Den passar
  bättre i en telekrigslista med ett eget systemkort när källorna kan läsas.

## Att följa upp

- 1:a gardes blandade flygdivisionen har garnison Krasnodar-Tsentralnyj i
  `units.json`, men enligt rysk Wikipedia ligger staben i Krymsk. Basens
  text säger nu det; förbandets garnison har inte ändrats.
- `src/forces_db_patch.py` kan nu lägga till nya systemkort (ett okänt id med
  fullständigt kort under `systems`). Tidigare avbröts patchen.
