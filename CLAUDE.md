# Arbetsregler för Hotmonitor

- **Varje ny eller ändrad funktion i appen** får en rad, eller en uppdaterad
  text, i `webapp/public/features.js` med dagens datum i `added`. Det är den
  raden som tänder knappen "N nya funktioner", förhandsvisningen på Idag och
  siffran på Mer. En ändrad titel eller text visas igen för alla.
- Lägg samtidigt en post i `RELEASE_NOTES` i `webapp/public/app.js` och ett
  avsnitt i `webapp/CONTRACT.md`. Höj versionen i `webapp/public/sw.js` så att
  appen hämtar den nya koden.
- Repot är publikt: inga e-postadresser, nycklar eller tokens i filer.
- Rysk statsmedia och Telegram får inte användas som nyhetskällor i analysen.
- Gemini körs på gratisnivån: huvudmodellen har bara 20 anrop per dygn.
