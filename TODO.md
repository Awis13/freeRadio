# STUDIO 23 — TODO

> Last reviewed: 2026-02-23
> Tests: 184/184 green (65 pytest + 119 vitest), bats: 124 (verified locally)

## In Progress

<!-- Nothing currently in progress -->

## Up Next

<!-- Nothing currently in Up Next -->

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
- 124 теста для `stream_entry.sh` (bats) — PR #3 добавил 7 поведенческих тестов
- `npx bats` может не работать в production контейнере
- Нужно проверить и добавить в CI
- **Файлы:** `tests/bash/`, `package.json`

## Known Issues

### .env отсутствовал на сервере (решено)
- .env удалён в коммите e727703, не восстановлен
- Все ICECAST_*_PASSWORD были пустые → Liquidsoap 401 auth loop → нет аудио
- **Решено:** .env создан с новыми паролями, .env.example добавлен
- **Осталось:** STREAM_KEYS_SECRET заменён → сохранённые RTMP ключи нечитаемы, нужно ввести заново в дашборде
- **Файлы:** .env, .env.example, .gitignore

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

- [x] GUI плеера не обновляется после ARM→PLAY: lastAudioMsg cache+replay — PR #5, `68c1395` (2026-02-23)
- [x] Cleanup batch: Object.assign whitelist, CSP header, VISUALS_DIR param, video playlist deactivation — `c47022e` (2026-02-23)
- [x] XSS sanitization: escapeHtml() для 24 innerHTML injection points — PR #4, `4fdb312` (2026-02-23)
- [x] Audio feeder: deadlock fix + Icecast retry backoff — PR #3, `691340d` (2026-02-23)
- [x] Восстановлен .env, создан .env.example — Icecast auth починен (2026-02-23)
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
