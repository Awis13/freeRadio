# STUDIO 23 — TODO

> Last reviewed: 2026-02-23
> Tests: 231/231 green (65 pytest + 175 vitest), bats: 124
> Phase: Dashboard ✅ complete

## In Progress

<!-- Nothing currently in progress -->

## Up Next

<!-- Фаза дашборда закрыта. Следующая фаза определяется отдельно. -->

## Known Issues

### FFT Analyzer для Safari (WebKit bug 180696)
- Server-side FFT disabled, скрыт на iOS — ждём Apple

### STREAM_KEYS_SECRET заменён
- Сохранённые RTMP ключи нечитаемы после пересоздания .env

## Done

- [x] Inline handlers → addEventListener, CSP compliance — PR #9 (2026-02-23)
- [x] Overnight slot matching + 56 тестов schedule.js — PR #8 (2026-02-23)
- [x] Schedule audit: timezone, overlap, priority, WS — PR #7 (2026-02-23)
- [x] Auto-play on boot — PR #6 (2026-02-23)
- [x] ARM→PLAY GUI fix — PR #5 (2026-02-23)
- [x] XSS sanitization — PR #4 (2026-02-23)
- [x] Audio feeder deadlock + retry — PR #3 (2026-02-23)
- [x] Path traversal, schedule video playlists — PR #2 (2026-02-23)
- [x] Видео-плейлисты (manual + smart) — PR #1 (2026-02-23)

## Dropped

- **radio.liq** — заменён на `radio_bpm.liq`
- **DSP chain в Liquidsoap** — перенесён в transcoder (loudnorm)
- **Bash tests на сервере** — тесты работают локально, CI не настроен
