# STUDIO 23 — TODO

> Last reviewed: 2026-02-23
> Tests: 184/184 green (65 pytest + 119 vitest), bats: 124 (verified locally)

## In Progress

### Schedule audit — баги и улучшения
- Аудит выявил 5 багов и 7 недоработок в планировщике
- **Баги:**
  1. Timezone сохраняется, но не используется — слоты работают по серверному UTC
  2. Executor пушит `/music/track` вместо `/music/processed/track` (неправильные пути)
  3. `Europe/Moscow` — дефолт в коде, но нет в HTML-селекторе; `Europe/Berlin` задублирован
  4. Нет валидации перекрытия weekly-слотов (непредсказуемый результат)
  5. `priority` у events хранится, но не используется при выборе
- **Недоработки:**
  6. Нет PUT для weekly-слотов (только create+delete)
  7. `getNextSlot()` игнорирует one-time events
  8. Past events никогда не чистятся
  9. Нет WebSocket notification при смене слота
  10. Refill рандомный без дедупликации (может повторить трек)
  11. Резкий переход при смене слота (clearQueue+skip)
  12. Нет default video playlist
- **Файлы:** `dashboard/lib/schedule.js`, `dashboard/public/app.js:1700-1950`, `dashboard/public/index.html:525-700`

## Up Next

### Schedule — тесты
- Ноль тестов на schedule.js
- Нужны юнит-тесты: isTimeInRange, getCurrentSlot, getNextSlot, executeScheduleTick
- **Файлы:** `dashboard/lib/schedule.js`, `tests/`

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
- Safari не поддерживает `createMediaElementSource()` с HLS
- Ждём фикса от Apple

### stop → cue → resume: теоретический race condition
- Маловероятный сценарий, если проявится — добавить задержку как в ARMED path

### STREAM_KEYS_SECRET заменён
- Сохранённые RTMP ключи нечитаемы после пересоздания .env
- Нужно ввести заново в дашборде

## Done

- [x] Auto-play on boot — PR #6 (2026-02-23)
- [x] GUI плеера после ARM→PLAY — PR #5 (2026-02-23)
- [x] Cleanup batch: whitelist, CSP, VISUALS_DIR, deactivation — `c47022e` (2026-02-23)
- [x] XSS sanitization — PR #4 (2026-02-23)
- [x] Audio feeder: deadlock + retry — PR #3 (2026-02-23)
- [x] .env восстановлен, .env.example — (2026-02-23)
- [x] Path traversal, schedule video playlists, async readdir — PR #2 (2026-02-23)
- [x] Видео-плейлисты (manual + smart) — PR #1 (2026-02-23)
- [x] Cleanup: .bak/.broken + .gitignore
- [x] Boot auto-restore retry
- [x] ARMED→PLAY race conditions
- [x] Smart mix: единый cross pipeline
- [x] Code review: buffer overflow, dynamic crossfade, queue_list sync
- [x] Smart mix always (no hard cut)
- [x] Умный детектор mix points
- [x] Тестовая инфраструктура: 260 тестов
- [x] HLS стабильность
- [x] Instant PLAY + pipeline sync
- [x] ARM UX reference
- [x] Авторизация дашборда
- [x] Pre-transcoding pipeline (copy mode)
- [x] Multi-RTMP streaming

## Dropped

- **radio.liq** — заменён на `radio_bpm.liq`
- **DSP chain в Liquidsoap** — перенесён в transcoder (loudnorm)
- **Bash tests на сервере** — тесты работают локально, CI не настроен
