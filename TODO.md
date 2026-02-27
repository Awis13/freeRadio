# STUDIO 23 — TODO

> Last reviewed: 2026-02-27
> Current sprint: Stabilization — tests for new modules

## Architecture Decisions (brainstorm 2026-02-23)

### Infrastructure
- **Dumb nodes**: Hetzner auction i9/64GB (~€40), Proxmox, no logic
- **LXC-per-tenant**: 1536MB RAM limit, unprivileged, AppArmor. ~40 tenants/node
- **CPU ≈ 0**: QSV copy mode, bottleneck is RAM only
- **No overselling, No cluster**: standalone Proxmox, overcommit=0

### Networking
- **Tailscale mesh** between nodes and control plane
- **Cloudflare DNS API** — A-record on provisioning
- **Caddy per node** — TLS, reverse proxy to LXC

### Control Plane (Go + Postgres + Caddy)
- **Go 1.24** + chi + pgx + golang-migrate. Repo: `github.com/Awis13/controlplane`
- **Dev env**: OrbStack Ubuntu 25.04, Docker compose (Go app + Postgres 17)
- **Multi-project**: projects table, each project = template + ports + stripe plan
- **Auth**: Bearer token middleware. **Encryption**: AES-256-GCM for Proxmox API tokens
- **PostgreSQL** with migrations embedded in binary

## In Progress

<!-- Nothing currently in progress -->

## Up Next

### Phase 2: Tests for new modules
- [ ] **Route tests** — vitest, mock req/res. Minimum: dj, stream-keys, settings. (medium)
- [ ] **Boot.js tests** — mock liqClient/probeStatus/S3. Cases: happy path, bootAborted, already playing, fallback cue. (medium)

## Backlog

- [ ] app.js (5890 lines) — frontend monolith. Refactor when UI changes needed. (large)
- [ ] STREAM_KEYS_SECRET rotation — migration path for `.env` changes. (medium)
- [ ] Health endpoint `GET /api/health` — for Control Plane integration. (small)

## Known Issues

- **FFT Analyzer on Safari** (WebKit bug 180696) — waiting on Apple
- **STREAM_KEYS_SECRET rotation** — recreating `.env` breaks old RTMP keys

## Done

- [x] server.js refactor 839→243 lines — routes/, boot.js, wsServer.js (2026-02-27, PR #12)
- [x] Code review PR #11 — inline handlers, sequential boot, dead code (2026-02-27)
- [x] S3 full lifecycle — source of truth, boot sync, cascade deletes, atomic uploads (2026-02-26, PR #11)
- [x] i18n — all comments/strings translated to English (2026-02-26, PR #11)
- [x] Pipeline audit — `-bf 0` + JSON injection protection (2026-02-24, PR #10)
- [x] CSP compliance — inline handlers removed (2026-02-24, PR #9)
