# STUDIO 23 — TODO

> Last reviewed: 2026-02-23
> Tests: 172/172 green (65 pytest + 107 vitest), bats: 117 (not verified on server)

## In Progress

<!-- Nothing currently in progress -->

## Up Next

### Path traversal sanitization (project-wide)
- `videoPlaylist.js` уже защищён (`path.basename()` на все входные filenames)
- Аналогичную защиту добавить в `playlist.js` (manual tracks) и `visualProfile.js` (video names из API body)
- Паттерн: `const safe = path.basename(t); if (safe !== t) reject;`
- Приоритет: Medium — auth защищает все endpoints, но defense-in-depth нужен
- **Файлы:** `dashboard/lib/playlist.js:48`, `dashboard/lib/visualProfile.js:65`

### Video playlist — schedule integration
- Добавить поле `videoPlaylistId` в schedule slots (weekly + events) рядом с существующим `playlistId`
- При смене слота в `executeScheduleTick()`: если `videoPlaylistId` задан, загрузить видео-плейлист как профиль или в очередь
- Нужно: добавить поле в `schedule.js` (POST /weekly, POST /events), обновить executor, обновить UI schedule таба
- **Файлы:** `dashboard/lib/schedule.js`, `dashboard/public/app.js` (schedule section ~line 1800)

### `readdirSync` в async handler
- `fs.readdirSync(/music/processed)` блокирует event loop
- Заменить на `fs.promises.readdir` при рефакторе
- **Файл:** `dashboard/server.js` ~line 314 (`/api/dj/cue`)

## Backlog

### Video playlist — smart rules: duration filter
- Нужен `duration_map` (аналог `.bpm_map`) для видео файлов
- Можно генерировать через `ffprobe -show_entries format=duration` при транскодировании в `transcoder.sh`
- Формат: `filename.mp4=23.5` (секунды)
- Пока smart playlists фильтруют по `namePattern` + `tags`, duration отложен

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
