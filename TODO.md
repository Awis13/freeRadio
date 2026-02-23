# STUDIO 23 — TODO

> Last reviewed: 2026-02-23
> Tests: 143/143 green (65 pytest + 78 vitest), bats: 117 (not verified on server)

## Active

### ~~Cleanup: .bak/.broken файлы + .gitignore~~ DONE
- 10 файлов удалены, .gitignore обновлён. Коммит `d75bc53`

### `readdirSync` в async handler
- **Приоритет:** Low
- **Файл:** `dashboard/server.js` ~line 314 (`/api/dj/cue`)
- `fs.readdirSync('/music/processed')` блокирует event loop
- Заменить на `fs.promises.readdir` при рефакторе

## Backlog

### Channel Strip DSP (Phase 2/3)
- Gate, EQ (3-band), Compressor, Limiter — код написан в `radio_bpm.liq`
- HTTP endpoints готовы (`/strip/config`, `/strip/metering`)
- `strip_bypass = ref(true)` — DSP обходится
- Нужно: протестировать latency/artifacts, снять bypass

### Talkover / Takeover modes
- UI mode cards есть в `app.js` (radio / talkover / takeover)
- Backend: `visualMode.js`, `liveMode.js`
- Talkover (Phase 1): только radio mode реально работает
- Takeover (OBS): `liveMode` с RTMP ingest (`s23-rtmp-ingest` контейнер)
- Нужно: полная реализация talkover с ducking

### FFT Analyzer для Safari (WebKit bug 180696)
- Server-side FFT в `dashboard/lib/fftAnalyzer.js`
- Disabled (`0a0760b`), скрыт на iOS
- Safari не поддерживает `createMediaElementSource()` с HLS
- Баг в WebKit с 2017 — ждём фикса от Apple
- **Файлы:** `server.js:35`, `app.js:295,458,5034`

### stop → cue → resume: теоретический race condition
- После `dj/stop` (pipeline пуст) → `dj/cue` + `dj/resume` без задержки = пустой cross buffer
- Маловероятный сценарий (stop = полная остановка стрима)
- Если проявится: добавить задержку как в ARMED path

### Bash tests — проверить на сервере
- 117 тестов для `stream_entry.sh` написаны (bats)
- `npx bats` может не работать в production контейнере
- Нужно проверить и добавить в CI

## Done (recent)

- [x] Boot auto-restore retry (dedicated HTTP agent, phase split) — `bad35e8`, `3277209`
- [x] ARMED→PLAY race conditions (btn disable, state in .then, rollback) — `3277209`
- [x] Smart mix между 1-м и 2-м треком — единый cross pipeline — `11bb824`
- [x] Code review: buffer overflow clamp, dynamic crossfade, queue_list sync — `11bb824`
- [x] Smart mix всегда (убран hard cut при restart) — `d1a92a8`
- [x] Умный детектор mix points в audio_analyzer — `233ef80`
- [x] Тестовая инфраструктура: 260 тестов (pytest + vitest + bats) — `b718c94`
- [x] HLS стабильность: batch polling, keepAlive — `6e781df`
- [x] Instant PLAY + pipeline sync — `653e0cf`
- [x] ARM UX reference implementation — `d7818a0`
- [x] Авторизация дашборда + env vars — `74cfd25`
- [x] Pre-transcoding pipeline (copy mode) — transcoder + streamer
- [x] Multi-RTMP streaming (YouTube/Kick) — `s23-rtmp` контейнер

## Dropped

- **radio.liq** — заменён на `radio_bpm.liq`, файл остаётся как reference
- **DSP chain в Liquidsoap** — перенесён в transcoder (loudnorm при encode)
