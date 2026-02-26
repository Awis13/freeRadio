# STUDIO 23 — TODO

> Last reviewed: 2026-02-26
> Phase: S3 integration done. Next: Control Plane real infra integration

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

### Phase 1 — Remaining Infra
- [ ] **Real Proxmox integration** — подключить provisioning к реальному Proxmox через Tailscale. Код есть (Control Plane PR #3), нужна интеграция с живой инфрой. (large)
- [ ] **Cloudflare DNS integration** — при создании tenant → A-record. При удалении → delete. (small)
- [ ] **LXC template** — золотой образ STUDIO 23 из текущего LXC 100. (medium)
- [ ] **Caddy auto-config на нодах** — SSH → update Caddyfile → reload при создании/удалении tenant. (small)
- [ ] **Health polling** — goroutine pool, `health_path` каждые 30s, статус в DB. (medium)
- [ ] **Admin UI (htmx)** — Go templates: список нод, tenants, health. Встроено в binary. (medium)

### Phase 2 — Billing + Public Launch
- [ ] **Stripe integration** — checkout → webhook → provision. Cancel → stop. (large)
- [ ] **Landing page** — static HTML + Tailwind. (medium)
- [ ] **Clerk auth** — JWT validation middleware в Go. (medium)
- [ ] **Onboarding flow** — checkout → waiting → redirect на tenant dashboard. (medium)

## Backlog

- [ ] FK violation (non-existent project_id/node_id) → 422 instead of 500. (small)
- [ ] Pagination on list endpoints (limit/offset). (small)
- [ ] PATCH/PUT endpoints for node/tenant updates. (small)
- [ ] Go tests — handler unit tests with mocked stores. (medium)
- [ ] CI/CD — GitHub Actions: test Go + deploy binary. (medium)
- [ ] Health endpoint в STUDIO 23 dashboard `GET /api/health`. (small)
- [ ] freeRadio: рефакторинг server.js (767 строк). (medium)
- [ ] Pentest LXC isolation — blocking перед launch. (small)

## Known Issues

- **FFT Analyzer на Safari** (WebKit bug 180696) — ждём Apple
- **STREAM_KEYS_SECRET rotation** — пересоздание `.env` ломает старые RTMP ключи

## Done

- [x] S3 full lifecycle — source of truth, boot sync, каскадные удаления, atomic uploads (2026-02-26)
- [x] Drag-and-drop upload с progress bar (2026-02-26)
- [x] i18n — все русские комментарии и строки переведены на English (2026-02-26)
- [x] Pipeline audit — `-bf 0` + JSON injection protection (2026-02-24, PR #10)
- [x] CSP compliance — inline handlers removed (2026-02-24, PR #9)
- [x] Control Plane: tenant provisioning — 86 tests (2026-02-24, CP PR #3)
- [x] Control Plane: Proxmox API client — 42 tests (2026-02-24, CP PR #2)

## Dropped

- **radio.liq** → `radio_bpm.liq`
- **DSP chain в Liquidsoap** → transcoder loudnorm
- **Proxmox cluster** → standalone ноды
- **Node.js / SQLite для control plane** → Go + Postgres
- **React/Vue для админки** → htmx + Go templates
- **Next.js для лендинга (MVP)** → static HTML + Tailwind
