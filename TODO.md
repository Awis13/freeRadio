# STUDIO 23 — TODO

> Last reviewed: 2026-02-23
> Tests: 172/172 green (65 pytest + 107 vitest), bats: 117 (not verified on server)

## In Progress

<!-- Nothing currently in progress -->

## Up Next

### XSS sanitization в innerHTML (app.js)
- Playlist/profile names интерполируются в `innerHTML` без экранирования
- За авторизацией, low risk, но defense-in-depth нужен
- Добавить escape-функцию или использовать `textContent` вместо `innerHTML`
- **Файл:** `dashboard/public/app.js` (модалки schedule, overlay layers)

### Object.assign whitelist в PUT /events/:id
- `Object.assign(ev, req.body)` мержит произвольные ключи из request body в объект event
- Нужен property whitelist: `{ date, startTime, endTime, playlistId, videoPlaylistId, label, priority }`
- **Файл:** `dashboard/lib/schedule.js` ~line 288

## Backlog

### Video playlist — smart rules: duration filter
- Нужен `duration_map` (аналог `.bpm_map`) для видео файлов
- Можно генерировать через `ffprobe -show_entries format=duration` при транскодировании в `transcoder.sh`
- Формат: `filename.mp4=23.5` (секунды)
- Пока smart playlists фильтруют по `namePattern` + `tags`, duration отложен

### Video playlist deactivation при смене слота
- Когда schedule slot заканчивается и следующий слот без `videoPlaylistId`, визуальный профиль остаётся
- Консистентно с `visualProfile.js`, но можно добавить reset к дефолту
- **Файл:** `dashboard/lib/schedule.js`, `executeScheduleTick()`

### Hardcoded VISUALS_DIR в schedule.js
- `/visuals` захардкожен в executor (`schedule.js` line 147)
- `server.js` читает из `process.env.VISUALS_DIR`
- Передать как параметр в `startExecutor()` для консистентности
- **Файл:** `dashboard/lib/schedule.js`

### Channel Strip DSP (Phase 2/3)
- Gate, EQ (3-band), Compressor, Limiter — код написан в `radio_bpm.liq`
- HTTP endpoints готовы (`/strip/config`, `/strip/metering`)
- `strip_bypass = ref(true)` — DSP обходится
- Нужно: протестировать latency/artifacts, снять bypass
- **Файлы:** `configs/liquidsoap/radio_bpm.liq`, `dashboard/lib/channelStrip.js`

### Talkover / Takeover modes
- UI mode cards есть в `app.js` (radio / talkover / takeover)
- Backend: `visualMode.js`, `liveMode.js`
- Talkover (Phase 1): только radio mode реально работает
- Takeover (OBS): `liveMode` с RTMP ingest (`s23-rtmp-ingest` контейнер)
- Нужно: полная реализация talkover с ducking
- **Файлы:** `dashboard/lib/visualMode.js`, `dashboard/lib/liveMode.js`, `dashboard/public/app.js` (~line 2600)

### Bash tests — проверить на сервере
- 117 тестов для `stream_entry.sh` написаны (bats)
- `npx bats` может не работать в production контейнере
- Нужно проверить и добавить в CI
- **Файлы:** `tests/bash/`, `package.json`

## Known Issues

### FFT Analyzer для Safari (WebKit bug 180696)
- Server-side FFT в `dashboard/lib/fftAnalyzer.js` — disabled (`0a0760b`), скрыт на iOS
- Safari не поддерживает `createMediaElementSource()` с HLS
- Баг в WebKit с 2017 — ждём фикса от Apple
- **Файлы:** `server.js:35`, `app.js:295,458,5034`

### stop → cue → resume: теоретический race condition
- После `dj/stop` (pipeline пуст) → `dj/cue` + `dj/resume` без задержки = пустой cross buffer
- Маловероятный сценарий (stop = полная остановка стрима)
- Если проявится: добавить задержку как в ARMED path

## Done

- [x] Up Next cleanup: path traversal, schedule video playlists, async readdir — PR #2, `226cc15` (2026-02-23)
- [x] Видео-плейлисты (manual + smart) для визуалов — PR #1, `830a4ae` (2026-02-23)
- [x] Cleanup: .bak/.broken файлы + .gitignore — `d75bc53`
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
