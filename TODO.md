# STUDIO 23 — TODO

> Last reviewed: 2026-02-23
> Tests: 184/184 green (65 pytest + 119 vitest), bats: 124 (verified locally)

## In Progress

<!-- Nothing currently in progress -->

## Up Next

### Schedule — тесты
- Ноль тестов на schedule.js
- Нужны юнит-тесты: isTimeInRange, getCurrentSlot, getNextSlot, slotsOverlap, getNowInTimezone
- **Файлы:** `dashboard/lib/schedule.js`, `tests/`

### Schedule — overnight slot matching (known limitation)
- Weekly slot day=1 22:00-06:00 не матчится на day=2 в 03:00 (getCurrentSlot)
- isTimeInRange работает, но `ws.day === weekday` фейлит на следующий календарный день
- Аналогично для overnight events: `ev.date === dateStr` фейлит
- Нужно: проверять (day+1)%7 для overnight слотов

## Backlog

### Video playlist — smart rules: duration filter
- Нужен `duration_map` (аналог `.bpm_map`) для видео файлов
- Формат: `filename.mp4=23.5` (секунды)
- Пока smart playlists фильтруют по `namePattern` + `tags`, duration отложен

### Channel Strip DSP (Phase 2/3)
- Gate, EQ, Compressor, Limiter — код написан в `radio_bpm.liq`
- HTTP endpoints готовы (`/strip/config`, `/strip/metering`)
- `strip_bypass = ref(true)` — DSP обходится, нужно протестировать и снять bypass
- **Файлы:** `configs/liquidsoap/radio_bpm.liq`, `dashboard/lib/channelStrip.js`

### Talkover / Takeover modes
- Radio mode работает, talkover/takeover нет
- Нужно: полная реализация talkover с ducking, takeover (OBS) с RTMP ingest
- **Файлы:** `dashboard/lib/visualMode.js`, `dashboard/lib/liveMode.js`, `dashboard/public/app.js`

## Known Issues

### FFT Analyzer для Safari (WebKit bug 180696)
- Server-side FFT disabled, скрыт на iOS
- Ждём фикса от Apple

### STREAM_KEYS_SECRET заменён
- Сохранённые RTMP ключи нечитаемы после пересоздания .env
- Нужно ввести заново в дашборде

## Done

- [x] Schedule audit: timezone, overlap, overnight, priority, WS — PR #7, `5b01a91` (2026-02-23)
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
