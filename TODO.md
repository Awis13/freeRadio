# STUDIO 23 — TODO

> Last reviewed: 2026-02-27
> Current sprint: Стабилизация — рефакторинг server.js + код-ревью
> Phase: S3 integration done. Next: stabilization + refactoring

## Architecture Decisions (brainstorm 2026-02-23)

### Infrastructure
- **Тупые ноды**: Hetzner auction i9/64GB (~€40), Proxmox, никакой логики
- **LXC-per-tenant**: 1536MB RAM limit, unprivileged, AppArmor. ~40 tenants/нода
- **CPU ≈ 0**: QSV copy mode, bottleneck только RAM
- **No overselling, No cluster**: standalone Proxmox, overcommit=0

### Networking
- **Tailscale mesh** между нодами и control plane
- **Cloudflare DNS API** — A-record при provisioning
- **Caddy на каждой ноде** — TLS, reverse proxy к LXC

### Control Plane (Go + Postgres + Caddy)
- **Go 1.24** + chi + pgx + golang-migrate. Repo: `github.com/Awis13/controlplane`
- **Dev env**: OrbStack Ubuntu 25.04, Docker compose (Go app + Postgres 17)
- **Мультипроектность**: projects table, каждый проект = template + ports + stripe plan
- **Auth**: Bearer token middleware. **Encryption**: AES-256-GCM для Proxmox API tokens
- **PostgreSQL** с миграциями embedded в binary

### Frontend стек
- **Админка**: htmx + Go templates, встроена в binary
- **Лендинг**: static HTML + Tailwind + vanilla JS
- **Auth**: Clerk (hosted signup/login), JWT в Go middleware

## In Progress

<!-- Nothing currently in progress -->

## Up Next

### Фаза 0: Закрыть хвосты
- [ ] **Код-ревью PR #11** (S3 lifecycle) — codereview, фиксы, мерж в master. (small)
- [ ] **Удалить syncWatcher.js** — `dashboard/lib/syncWatcher.js` мёртвый код (убран в a8c67e5). (small)

### Фаза 1: Рефакторинг server.js (839 → ~150 строк)
- [ ] **Создать `dashboard/routes/`** — вынести 42 inline-роута: `dj.js`, `streamKeys.js`, `settings.js`, `status.js`, `videoQueue.js`, `live.js`. (medium)
- [ ] **Вынести boot logic** в `dashboard/lib/boot.js` — S3 sync + auto-restore (~120 строк). (medium)
- [ ] **Вынести WebSocket** в `dashboard/lib/wsServer.js` — WS, broadcast, TLS (~60 строк). (small)
- [ ] **Финализация server.js** — imports → app → middleware → mount → WS → boot → listen. (small)

### Фаза 2: Тесты
- [ ] **Тесты на роуты** — vitest, mock req/res. Минимум: dj, stream-keys, settings. (medium)
- [ ] **Тест boot.js** — mock liqClient/probeStatus/S3. (medium)

## Backlog

- [ ] app.js (5890 строк) — фронтенд-монолит. Рефакторить при изменении UI. (large)
- [ ] STREAM_KEYS_SECRET rotation — migration path для смены `.env`. (medium)
- [ ] Health endpoint `GET /api/health` — для Control Plane интеграции. (small)
- [ ] Рефакторинг server.js — **MOVED TO UP NEXT** (medium)

## Known Issues

- **FFT Analyzer на Safari** (WebKit bug 180696) — ждём Apple
- **STREAM_KEYS_SECRET rotation** — пересоздание `.env` ломает старые RTMP ключи

## Done

- [x] audio-analyzer Dockerfile (2026-02-27)
- [x] S3 full lifecycle — source of truth, boot sync, каскадные удаления, atomic uploads (2026-02-26)
- [x] Drag-and-drop upload с progress bar (2026-02-26)
- [x] i18n — все русские комментарии и строки переведены на English (2026-02-26)
- [x] Pipeline audit — `-bf 0` + JSON injection protection (2026-02-24, PR #10)
- [x] CSP compliance — inline handlers removed (2026-02-24, PR #9)
- [x] Control Plane: tenant provisioning — 86 tests (2026-02-24, CP PR #3)

## Dropped

- **radio.liq** → `radio_bpm.liq`
- **DSP chain в Liquidsoap** → transcoder loudnorm
- **Proxmox cluster** → standalone ноды
- **Node.js / SQLite для control plane** → Go + Postgres
- **React/Vue для админки** → htmx + Go templates
- **Next.js для лендинга (MVP)** → static HTML + Tailwind
