-- Version 3.30: the Telegram channel figures (src/telegram_log.py), one row
-- a day, the newest served at /api/channels. The Worker also makes this table
-- itself when missing (IF NOT EXISTS), as the deploy token may lack D1 Edit.
CREATE TABLE IF NOT EXISTS channel_stats (
  date TEXT PRIMARY KEY,
  data TEXT NOT NULL
);
