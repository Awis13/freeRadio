# STUDIO 23 — TODO

> Last reviewed: 2026-02-23
> Tests: 364/364 green (65 pytest + 175 vitest + 124 bats)
> Phase: Dashboard stabilization COMPLETE. Next: Platform (Phase 1)

## In Progress

<!-- Nothing currently in progress -->

## Up Next

### Phase 1 — Platform (multi-tenant)
- [ ] Go API control plane — Proxmox REST API для LXC provisioning, tenant CRUD, health checks. Single binary, goroutine-per-tenant. (large)
- [ ] Stripe + Coinbase Commerce billing — subscription management, webhook handlers, usage metering. (large)
- [ ] Next.js platform frontend — landing page, Clerk auth, tenant onboarding, dashboard iframe wrapper. (large)
- [ ] Nginx reverse proxy + Let's Encrypt — subdomain per tenant, TLS termination. (medium)
- [ ] CI/CD pipeline — GitHub Actions: test → build → deploy. Currently tests run only locally. (medium)

## Backlog

- [ ] Structured logging — replace 22 console.log statements in dashboard with JSON logger (pino). Needed for multi-tenant log aggregation. (small)
- [ ] Health endpoint — `GET /api/health` checking HLS segment freshness, Icecast, RTMP status. Needed for platform health monitoring. (small)
- [ ] HTTPS for dashboard — self-signed for dev, Let's Encrypt for prod. Currently HTTP only. (small)
- [ ] Hardcoded test line numbers in bats — `tests/bash/test_stream_entry.bats` uses awk NR ranges that break on any code addition. Replace with marker-based stripping (`# TEST_STRIP_BEGIN/END`). (small)
- [ ] Talk Over mode — voice + music with auto-ducking, Phase 2 feature. Voice ducking currently snaps back instantly (no fade). (medium)
- [ ] Channel Strip DSP GUI — Gate → EQ → Comp → Limiter. Code scaffolded in radio_bpm.liq (commented out), HTTP endpoints exist. Phase 2/3. (large)

## Known Issues

### FFT Analyzer на Safari (WebKit bug 180696)
- `MediaElementSource` + HLS не поддерживается. Server-side FFT disabled, скрыт на iOS. Ждём Apple.

### STREAM_KEYS_SECRET rotation
- При пересоздании `.env` старые RTMP ключи (AES-256-GCM) становятся нечитаемыми. Workaround: заново ввести ключи в дашборде.

## Done

- [x] Pipeline audit: -bf 0 encode path + JSON injection protection — PR #10 (2026-02-23)
- [x] CSP compliance: inline handlers → addEventListener — PR #9 (2026-02-23)
- [x] Overnight schedule slots + 56 тестов — PR #8 (2026-02-23)
- [x] Schedule audit: timezone, overlap, priority — PR #7 (2026-02-23)
- [x] Auto-play on boot, ARM→PLAY GUI, XSS sanitization — PR #5-6 (2026-02-23)

## Dropped

- **radio.liq** — заменён на `radio_bpm.liq` (BPM-aware mixing)
- **DSP chain в Liquidsoap** — loudnorm перенесён в transcoder stage
