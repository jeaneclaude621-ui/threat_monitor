# Rapport 2: flygbaser öster om 40° ö.l.

Underlag: `todo-2-flyg-ost.json` (74 baser utan känd materiel, 7 nov 2026).
Patch: `patch-2.json`, inläst med `src/forces_db_patch.py`, följt av
`python3 src/forces.py export-db` och `python3 src/forces_db_check.py` (OK:
328 baser, 487 förband, 144 system).

## Källor

Engelska och ryska Wikipedia, lästa 7 nov 2026: basens egen artikel (via
Wikidatas länkar), regementets artikel där den behövdes, och ryska
Wikipedias *Список военных аэродромов России* (lista över militära flygfält
med typer och förband) som korskontroll. Ingen rysk statsmedia eller
Telegram. Ukrainska och västliga källor (United24, Truth Hounds rapport om
flygfält 2024) gick inte att nå från miljön och användes inte; därför bygger
flera uppgifter på Wikipedias senast kända läge, vilket står i `status_sv`
(till exempel "läget 2014").

## Resultat

| | Antal |
|---|---|
| Baser i listan | 74 (26 i grunddatabasen, 48 bara i Wikidata) |
| Fick materiel | 10 (8 befintliga, 2 nya) |
| Fick bara status (befintliga) | 18 |
| Ny bas med bara status | 1 (Ashuluk) |
| Hoppades över (bara Wikidata) | 45 |
| Nya systemkort | 4 |

### Baser som fick materiel

| Bas | Materiel | Underlag |
|---|---|---|
| Bagaj-Baranovka | An-26, An-72, Mi-8, Mi-24 | 395:e provflygdivisionen (ru, läget 2014; listan) |
| Buturlinovka | Su-34 | 277:e bombflygregementet ombaserat hit april 2022 (en) |
| Kamennyj Rutjej | Tu-142 | ubåtsjaktdivision i 7062:a flygbasen (en) |
| Kapustin Jar | Mi-8, An-26, An-72 | 35:e blandade flygdivisionen (en, ru) |
| Kotelnikovo | L-39 | 704:e skolflygregementet / 213:e skolflygbasen (en; listan) |
| Nikolajevka | Il-38, Ka-27, Mi-8 | Stillahavsflottans marinflyg, 289:e regementet (ru, en) |
| Rtisjtjevo | L-410 (nytt kort) | skolflygbas, L-410UVP-E (ru) |
| Saratov-Sokol | Ansat-U, Ka-226, Mi-2 (nya kort), Mi-8 | 339:e skolflygbasen (ru) |
| Kljutji (ny bas) | An-26, Mi-8 | blandad division ur 35:e transportflygregementet (en; listan) |
| Uljanovsk-Vostotjnyj (ny bas) | Il-76 | 235:e transportflygregementet sedan 2017 (ru; listan) |

Buturlinovkas Su-34 kom dit som ombasering under kriget; basens eget
regemente upplöstes 2009. Kamennyj Rutjejs Tu-22M3 har enligt källan förts
till Belaja och togs inte med.

### Befintliga baser med bara status (ingen materiel)

Nedlagda eller utan militärt flyg: Bobrovka, Galjonki, Jasnyj, Ljambir,
Nertjinsk, Postovaja, Savvatija, Tiksi-Zapadnyj. Utan känt fast förband:
Berdsk-tsentralnyj (sportflyg), Cholodnogorskij (malpåsat 1993,
samlokaliserat sedan 2011), Novonezjino (DOSAAF), Omsk-Severnyj (samlokaliserat
med Roskosmos), Plesetsk (flygkommendantur sedan 2014), Sokol
(kommendantur sedan 2002), Tjebenki (division upplöst 2009), Tjugujevka
(regemente upplöst 2009), Vorkuta (civilflyg och FSB). Uprun har en flyggrupp
ur 17:e gardes arméflygbrigaden, men källan säger inte vilka helikoptertyper,
så materielen lämnades tom.

Obs: Wikidatas post för Cholodnogorskij (Q2545136) är Stavropols flygplats;
statusen bygger därför på ryska Wikipedias artikel om flygfältet Cholodnogorskij.

### Nya baser

- `kljutji` (Q2926050), `uljanovsk-vostotjnyj` (Q2545194): aktiva enligt källorna, med materiel.
- `ashuluk` (Q4073571, vapenslag luftvärn): flygfältet vid luftvärnets skjutfält
  (185:e stridsträningscentret); inget fast flygförband, equipment tom.

### Hoppades över (bara i Wikidata) och varför

- **Övergivna eller nedlagda enligt Wikipedia:** Arabatuk (reservfält i
  vilostatus), Aspidnoje, Bezretjnaja-2, Ostrov Bolsjevik, Tjekurovka,
  Borzja-2 (Chindant; ingen källa om dagens läge), Dzjida (stängt 2011),
  Greem Bell (förstört 2013), Chorol (regemente upplöst 1993, övergivet),
  Kupino, Lebjazje, Letneozjorskij, Orlovka, Orsk, Panfilovo,
  Petjora-Kamenka (Berjozovka), Petrovsk, Povorino, Pristan, Slavgorod,
  Sredne Belaja och Srednebeloje (samma fält, två Wikidata-poster),
  Tiksi-Severnyj, Trojtsk, Ukurej, Vetrovoje, Zavitinsk, Zjerdevka,
  Ozjornaja Pad (Kremovo, stängt 1998), Ponoj (upplöst enligt Wikidata,
  ingen artikel), Vozzjajevka (övergiven 2010; bara "användbart skick" 2024
  på satellitbild, inget förband).
- **Civila flygplatser eller civil användning:** Atjinsk, Bacharevka (stängd
  2007), Blagodatnoje/Kalinka (aeroklubb sedan 2010), Bratsk, Istomino
  (fallskärmshoppning), Kondinskoje, Narjan-Mar (blandad civil-militär, inget
  känt förband), Salka (provfält för NTIIM sedan 2005), Saratov-Juzjnyj
  (riven), Smirnych (civil landningsplats), Jugorsk-Sovetskij (allmänflyg).
- **Okänt läge:** Sjaromy (snöröjd bana 2018, "drift eller vilostatus" enligt
  källan; inget förband).
- **Inte ett flygfält:** Sosnovyj Bor (militärstad vid Ulan-Ude; där finns en
  logistikbrigad, inget flyg).
- **Dubblett:** Tjernigovka (Q55659887) finns redan i grunddatabasen som
  `tjernigovka`. Enligt engelska Wikipedia finns där också 18:e gardes
  attackflygregementet med Su-25SM, som basen inte har; det kan läggas till
  i en senare omgång (basen ingick inte i den här listan).

## Nya systemkort (prefix `b2-`)

`b2-l-410` (L-410 Turbolet), `b2-ansat` (Ansat-U), `b2-ka-226` (Ka-226),
`b2-mi-2` (Mi-2). Ingen bild än (`image: null`).

## Ändring i verktyget

`src/forces_db_patch.py` tar nu emot nya systemkort under patchens
`"systems"`: ett id som inte finns och som har `name` läggs till som nytt
kort (tidigare avbröt verktyget vid okända id).
