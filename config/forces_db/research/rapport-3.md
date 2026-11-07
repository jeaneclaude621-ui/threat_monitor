# Rapport: research av lista 3 (övriga baser), 7 nov 2026

Gren `research-baser-3`. Lista: `todo-3-ovriga.json`, 70 poster (61 med `db_id`,
9 utan). Patch: `patch-3.json`. Kontrollen (`src/forces_db_check.py`) ger OK.

## Sammanfattning

| Utfall | Antal |
|---|---|
| Baser som fick materiel | 19 |
| Baser som bara fick status med källa | 8 |
| Överhoppade baser i grunddatabasen (ingen belagd materiel) | 34 |
| Överhoppade poster utan `db_id` (inte militära baser) | 9 |

25 förband fick `equipment` (18 armé-, marin- och robotförband samt 7 ubåtar),
3 baser fick materiel direkt och 12 nya systemkort lades till (prefix `b3-`).

## Källor och avgränsning

Bara källor som gick att läsa från miljön: engelska och ryska Wikipedia (förbandens,
basernas och systemens artiklar). IISS, Oryx, InformNapalm, Militarnyi och andra
medier gick inte att nå från molnmiljön (anslutningen bröts), så de användes inte.
Ingen rysk statsmedia och inget Telegram. En materielpost lades bara till när
artikeln nämner systemet för just det förbandet. Uppgifter som bara gäller
sovjettiden (till exempel truppsammansättningar 1988–1990) togs inte med. Arméstaber
(1:a stridsvagnsarmén, 41:a, 49:e, 58:e, 29:e och 3:e armén, 33:e robotarmén) fick
ingen materiel, eftersom den tillhör de underställda förbanden på andra orter.

## Baser med materiel (19)

| Bas | Förband | Materiel | Källa (Wikipedia) och tid |
|---|---|---|---|
| Archonskaja | 40:e CBRN-regementet | TOS-1A | ru, förbandets artikel (2019) |
| Bujnaksk | 136:e mot. skyttebrigaden | T-90A, BMP-3, BTR-82A, Tigr, 2S3, BM-21, 2S12, Tor, Tunguska, Strela-10 | en, uppgifter 2011–2017 |
| Chabarovsk | 17:e telekrigsbrigaden | Krasucha-4, Murmansk-BN, Leer-3 | ru |
| Fokino | (baseras direkt) | Ropucha-klass | ru, 100:e landstigningsfartygsbrigaden |
| Jurja | 8:e robotdivisionen | RS-24 Jars | en "RT-2PM Topol": hela den mobila gruppen bytt till Jars dec 2023 |
| Juzjno-Sachalinsk | 39:e mot. skyttebrigaden | MT-LB | en, 68:e armékåren (bild från Vostok-2014) |
| Kap Tarchankut | (baseras direkt) | S-400, S-300 | en, Slaget om Krim (anfall 2023) |
| Kjachta | 37:e mot. skyttebrigaden | T-72B3, BMP-2, MT-LB, BTR-80, Tornado-G, 2S3, 2S12, Strela-10 | en, uppgifter från 2015 |
| Knjaze-Volkonskoje | 64:e mot. skyttebrigaden | T-72 | en (2014) |
| Kyzyl | 55:e mot. skyttebrigaden | Tigr, 2S23, Orlan-10 | ru/en (2018) |
| Novorossijsk | 7:e luftanfallsdivisionen, 108:e regementet | BMD-1, BMD-2, BTR-D, 2S9 | en/ru |
| Petropavlovsk-Kamtjatskij | 40:e marininfanteribrigaden, 7 Kilo-ubåtar | T-80BV, Kilo, Kalibr (de sex 636.3-båtarna) | en, 2021 resp. fartygslistan 2026 |
| Rosjtjinskij | 30:e mot. skyttebrigaden | BTR-82A, D-30, BM-21 | ru/en |
| Sergejevka | 127:e mot. skyttedivisionen | T-72B | en (bilder 2020) |
| Stavropol | 247:e luftanfallsregementet | BMD-2, BTR-D, 2S9 | en/ru (2017) |
| Toropets | (arsenal) | Iskander-M, KN-23, Totjka-U, glidbomber, S-300-robotar | en, innehåll före anfallet sep 2024 |
| Tver | 79:e raketartilleribrigaden | Tornado-S/Smertj (9K58) | ru |
| Vitebsk | 103:e luftlandsättningsbrigaden (BY) | BTR-70, BTR-80, D-30 | en/ru (2021) |
| Vladikavkaz | 19:e mot. skyttedivisionen, 67:e luftvärnsrobotbrigaden | T-72B, 2S3, BTR-82A, Buk | en; Buk enligt 58:e arméns artikel |

Att tänka på vid granskning: flera uppgifter är äldre än kriget (2011–2021) och
förbanden har haft stora förluster sedan 2022. Den engelska artikeln om 58:e armén
placerar 67:e luftvärnsrobotbrigaden i Volgogradområdet, medan databasen (från ryska
Wikipedia) har den i Vladikavkaz.

## Baser med bara status (8)

- **Arsenalerna Barsovo, Karatjev, Kotovo, Oktjabrskij, Tichoretsk och Kotluban:** de
  är ammunitionsförråd. Wikipedias lista över arsenalerna anger deras läge,
  storlek och anfallen men inte vilka vapensystem som lagras. Därför fick de bara
  status med källa och ingen materiel.
- **Njonoksa:** ett provskjutningsfält utan egna förband. Olyckan 2019 kopplas till
  Burevestnik.
- **Poljarnaja zvezda (Wrangelön):** källan nämner radarposter och stridsledning för flyget
  men inga namngivna system.

## Överhoppade i grunddatabasen (34)

Inget av detta gick att belägga med en läsbar källa: förbandens artiklar saknar
uppgifter om materiel efter 1991, eller så är förbandet ett stöd- eller specialförband
utan tunga vapensystem. Där hittades ingen materiel, och ingen gissades fram.

- **Ingenjör-, järnvägs-, CBRN- och underrättelseförband:** Abakan, Alkino-2, Isjim,
  Jevpatorija, Krasnyj Bor, Lesozavodsk, Nachabino, Nizjnij Novgorod, Prochladnyj,
  Rybnoje och Svobodnyj.
- **Specialförband (Spetsnaz, KSSO):** Molkino, Pskov, Senezj, Toljatti och Marina
  Gorka (BY).
- **Mekaniserade och motoriserade förband utan uppgifter efter 1991:** Bikin, Kamen-Rybolov,
  Kalinovskaja, Sjali, Smolensk, Volgograd, Lugansk, Grodno (BY), Minsk (BY) och
  Zaslonava (BY), samt artilleriförbanden i Barano-Orenburgskoje och Brest (BY).
- **Baser med bara en arméstab eller där underlaget är historiskt:** Novosibirsk, Odintsovo,
  Tjita, Omsk och Uljanovsk (104:e divisionen har bara siffror från 1990).
- **Luftvärn:** Rzjev (32:a luftvärnsdivisionen); artikeln nämner inga system.

## Överhoppade poster utan db_id (9)

Q4156540 (9 channel), Q4243543 (GTRK Kuban), Q63433634 (Gatchinskaya Sluzhba Novostey),
Q4409379 (NVK Sakha), Q4452536 (Tatarstan – Yaña Ğasır), Q4308079 (Murman) är
tv-kanaler och tidningar. Q18524259 (Morozovs palats) och Q16683710 (Smirnovs hus) är
byggnader i Moskva, och Q5681816 (Hatsavita) är ett utbildningscentrum utan källa om
materiel. Ingen av dem är en militär bas med materiel, så inga `new_bases` lades
till. De verkar ha kommit in i Wikidatas baslista av misstag och kan rensas där.

## Nya systemkort (12)

`b3-t-90a`, `b3-t-72b`, `b3-t-80bv`, `b3-tunguska`, `b3-strela-10`,
`b3-2s12-sani`, `b3-2s23`, `b3-bmd-1`, `b3-btr-d`, `b3-btr-80`, `b3-btr-70` och
`b3-totjka-u`. Alla har en svensk text, nyckeltal och alternativa stavningar (aliases)
från systemets engelska Wikipedia-artikel. Inget har bild än (`image: null`);
bildjobbet kan ta dem.

## Ändrad kod

`src/forces_db_patch.py`: ett okänt id under `"systems"` som har `name` och
`description_sv` läggs nu till som nytt kort (förut avbröt skriptet). Det behövs
för att patchen ska kunna lägga till systemkort, som instruktionen beskriver.
