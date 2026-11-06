# Översyn 3b: vad datan faktiskt innehåller (5 nov 2026)

Underlag: körningarnas sparade data (`data/`, `reports/*_report_data.json`)
per 5 nov 05:00 UTC. Bedömare anonymiserade.

## Morgonrapporterna, 19 sep - 5 nov

- **36 rapporter på 48 dagar. 12 dagar saknas:** 29 sep, 6-8 okt,
  20-24 okt, 26-27 okt, 3 nov. Den 3 nov föll rapporten på Gemini-kvoten;
  20-27 okt var den långa luckan före molnkörningarna.
- **Alltid exakt 6 händelser per dag.** Taket är fast, så en dag med 15
  viktiga händelser och en med 2 ser likadana ut. Bilden blir inte "sann"
  i den meningen att det som inte kom med syns ingenstans.
- **Källor per händelse:** i snitt 2-6 utgivare, bara 6 av 216 händelser
  bygger på en enda utgivare. Bra.
- **66 händelser (31 %) saknar länk:** alla från 19-30 sep, då rapporterna
  bara hade en textrad med källnamn ("Reuters (Tier 1), AP ..."). Sedan
  1 okt har varje händelse länkade artiklar. De gamla dagarna är alltså
  inte dokumenterade enligt kravet "varje händelse med källa"; antingen
  märks de "äldre format, källor utan länk" eller tas ur det publika arkivet.
- **Utgivare:** Kyiv Independent (56), Reuters (48), Kyiv Post (40),
  Al Jazeera (38), AP (34), SVT (25), Euronews (20) ... Ukrainska utgivare
  (Kyiv Independent, Kyiv Post, Ukrainska Pravda, Ukrinform, Euromaidan
  Press, Mezha, ArmyInform) står för drygt en fjärdedel. Det är rimligt för
  ämnet men bör vägas: ukrainska uppgifter om anfall bör helst ha en
  oberoende bekräftelse innan höga värden.
- **Inga dubbletter** mellan dagar (ingen rubrik på mer än två dagar).
- **Hotindex** har legat 5,4-8,2. Indexhistoriken har omkalibrerats i
  efterhand (`recalibration.json`: 19 sep 7,8 -> 6,3); den publika grafen
  bör säga att äldre värden är omräknade.
- **Prognosens träffsäkerhet** (`forecast_accuracy`): 12 utvärderade
  dagar, medelfel 0,47, bias +0,13 - prognosen ligger något högt.
- **`index_checks` är tom** i senaste rapporten: kontrollen som ska
  motivera index finns i schemat men fylls inte.

## Bedömningarna (Bedöm)

- **641 bedömningar av 3 bedömare**, mest i skurar (81 den 9 okt, 68 den
  11 okt, 64 den 25 okt).
- **Fördelning:** +2 (mycket trovärdig) 466 (73 %), +1 163 (25 %), -1 12
  (2 %), 0 och -2 inga. Bedömningarna är nästan bara positiva; de säger
  mer om att källorna är etablerade än om enskilda påståenden.
- **"computed +0.03, applied +0.0"** är avsiktligt: effekten avrundas till
  en decimal och små effekter flyttar inte index (rapportens `note_sv`
  säger det). Vikterna (~0,175 per bedömning) gör att även många
  bedömningar sällan flyttar index. Det fungerar alltså som byggt, men
  bedömarnas arbete syns knappt. Förslag: visa effekten per händelse
  (finns redan i `operator.delta`) och låt bedömningar påverka
  trovärdighetsvärdet per händelse mer än index.

## Övriga delar

- **Styrkor:** nattlig lägesbild 1, 2, 4 och 5 nov (3 nov föll på kvoten).
  Före sökfixen 0 anfall mot baser; 5 nov 1 basanfall och 3 andra anfall.
- **Anfallskartan:** 29 nätter av senaste 30 i datan, nyaste från Kaggle
  3 nov; nätter därefter från nyhetsrubriker (preliminära).
- **Narrativ:** 191 poster, 4 sammanfattningar sparade.
- **Handlingsalternativ:** bara 3 dagars historik.
- **Nyhetsflöden:** 30 flöden, 1 fallerar (ERR News, 403 sedan 3 nov).

## De viktigaste problemen i datan

1. Fast tak på 6 händelser: viktiga händelser kan saknas utan spår. Inför
   "Fler händelser i dag" (de som inte kom med, med källor) eller låt taket
   följa nyhetsläget.
2. 19-30 sep saknar länkar: märk eller dölj publikt.
3. 12 saknade dagar: visa dem som luckor i arkiv och graf, inte som
   sammanhängande kurva.
4. Bedömningarna är nästan bara +2: ge bedömarna tydligare skala och
   instruktion; bedöm påståenden, inte utgivare.
5. Omkalibrerat index: säg det i grafen.
6. `index_checks` tom: fyll eller ta bort.
7. Kvoten/överbelastning hos Gemini: tre av fem senaste morgnar gick helt
   eller delvis på lite-modellen; märk rapporten med vilken modell som
   skrev den.
