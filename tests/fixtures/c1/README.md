# Regression fixtures (review 1-traffsakerhet, #11)

Saved article lists (`search_results`, the list the model was given, as
`common.LAST_SEARCH_RESULTS`; `pool_items`, raw items for
`news_sources.Pool`) and model answers (`events`), one known case per file.
`tests/test_c1_regression.py` runs them through the public functions.

| File | Case |
|---|---|
| `fabricated_ref.json` | refs the model was never given |
| `tass_google_news.json` | TASS via Google News (outlet `TASS`, link news.google.com) |
| `youtube_alone.json` | a lone YouTube source (and YouTube beside SVT) |
| `ap_syndicated.json` | one AP text in ten papers |
| `old_news_new_date.json` | a 2025 article the model dates today |
| `lite_shortened.json`, `lite_truncated.txt` | a lite-model answer that was shortened / cut off |

An event "is carried" when it is still in `enrich_events`' output and not
marked unconfirmed. The tests accept `unconfirmed: true`, `verified: false`,
or a `status`/`label`/`flag`/`badge_sv` containing "obekräftad" or
"unconfirmed"; adjust `_unconfirmed` in the test if the launch fix names it
otherwise.
