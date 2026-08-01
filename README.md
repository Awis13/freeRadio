# STUDIO 23

[![CI](https://github.com/Awis13/freeRadio/actions/workflows/ci.yml/badge.svg?branch=dev)](https://github.com/Awis13/freeRadio/actions/workflows/ci.yml)

Automated 24/7 streaming platform with BPM-aware music mixing, synchronized video visuals, and a real-time web dashboard. Designed to run as a self-contained Docker stack on a single machine.

![Studio Dashboard](docs/studio-dashboard.png)

## Architecture

```
                    ┌──────────────────┐
                    │   Web Browser    │
                    │  (Dashboard UI)  │
                    └────────┬─────────┘
                             │ HTTP/WS
                    ┌────────▼─────────┐
                    │   Nginx Proxy    │ :80/:443
                    │   (TLS + HTTP)   │
                    └────────┬─────────┘
                             │
                    ┌────────▼─────────┐
                    │    Dashboard     │ :9090
                    │  (Node.js API +  │
                    │ WebSocket + HLS) │
                    └──┬─────┬──────┬──┘
                       │     │      │
          ┌────────────┘     │      └─────────────┐
          │                  │                     │
 ┌────────▼─────────┐ ┌─────▼──────────┐ ┌───────▼──────────┐
 │     Icecast      │ │    Streamer    │ │   RTMP Ingest    │
 │  (Audio Server)  │ │  (FFmpeg +     │ │  (nginx-rtmp)    │
 │     :8000        │ │   mbuffer)     │ │     :1935        │
 └────────┬─────────┘ └─────┬──────────┘ └──────────────────┘
          │                  │
 ┌────────▼─────────┐       │
 │   Liquidsoap     │◄──────┘
 │  (BPM AutoDJ)   │
 │  Harbor :7000    │
 └────────┬─────────┘
          │
 ┌────────▼─────────┐
 │ Audio Analyzer   │
 │(Essentia/Python) │
 └──────────────────┘
```

## Data Pipeline

```
/music/  ──►  Audio Analyzer (Essentia)  ──►  .bpm_map + .analysis_map
/music/  ──►  Liquidsoap (BPM AutoDJ)   ──►  Icecast :8000/live (MP3)
/visuals/ ──►  Transcoder (QSV H.264)   ──►  /visuals/.processed/
Icecast + Video  ──►  FFmpeg Streamer   ──►  HLS (always) + RTMP (optional)
```

## Dashboard Front End

The dashboard ships as plain scripts with no build step. `app.js` is a 579-line
boot substrate: it resolves shared aliases, then wires 27 sibling modules in
boot order and exposes a few test-only hooks.

Each module is a UMD factory that attaches itself to `window.FR*` (`FRPlayer`,
`FRBroadcast`, `FRQueue`, `FRWsHub`, and so on) and exports an `init(deps)` that
receives its host services as callbacks and runs whatever boot side effects used
to be inline. Dependency injection through `init` is the default, which keeps
the wiring visible in one place and the modules independently testable.

Three places call across module boundaries directly, each deliberately:
`broadcast.js` is the top layer and drives its siblings as bare globals rather
than taking thirty-odd injected callbacks; `navigation.js` dispatches per-tab
lazy loads by calling the owning module directly; and `utils.js` (`FRUtils`) is
the shared pure-helper module every file may read. Each is documented in the
header of the file that does it.

## Features

- **BPM-aware AutoDJ** -- Liquidsoap analyzes track BPM and structures smooth transitions with beat-aligned crossfades
- **Audio analysis pipeline** -- Essentia-based Python analyzer detects BPM, beat positions, structure segments, and optimal mix points for every track
- **Synchronized video** -- FFmpeg composites video visuals over audio with hardware-accelerated encoding (Intel QSV)
- **Multi-platform streaming** -- Simultaneous output to HLS (built-in player) and unlimited RTMP destinations (YouTube, Twitch, Kick)
- **Real-time dashboard** -- WebSocket-powered control panel with live waveform, stream stats, playlist management, and file uploads
- **Stream key encryption** -- AES-256-GCM encrypted RTMP keys stored server-side
- **S3 content sync** -- Bidirectional sync of music and visuals with any S3-compatible storage (multi-tenant support)
- **SSO integration** -- HMAC-SHA256 signed token authentication from external control plane
- **Tier-based limits** -- Configurable platform limits, quality presets, and feature gates per subscription tier
- **Security hardened** -- Bearer token auth, CSP strict, rate limiting, non-root containers, WebSocket auth

## Tech Stack

| Component | Technology |
|-----------|------------|
| Dashboard API | Node.js 24, Express 4.21, WebSocket (ws) |
| Frontend | Vanilla JavaScript UMD modules (~9500 LOC), no build step |
| AutoDJ | Liquidsoap v2.3.0 |
| Audio Analysis | Python 3 + Essentia |
| Audio Server | Icecast 2 |
| Video Encoding | FFmpeg + Intel QSV + mbuffer |
| RTMP Ingest | nginx-rtmp |
| File Storage | S3-compatible (any provider) |
| Encryption | AES-256-GCM (stream keys) |
| TLS Proxy | Nginx |
| Testing | Vitest (1678 tests across 78 files) |
| Containerization | Docker Compose (7 services) |

## Quick Start

```bash
# Clone
git clone https://github.com/yourusername/freeRadio.git
cd freeRadio

# Configure
cp .env.example .env
# Edit .env with your Icecast passwords and dashboard token

# TLS certificate for the proxy (certs/ is gitignored, so a fresh clone has none)
scripts/bootstrap-certs.sh

# Add music files
cp your-tracks/*.mp3 content/music/

# Start all services
docker compose up -d

# Dashboard available at http://localhost (or :443 with TLS certs)
```

> **About the certificate:** `scripts/bootstrap-certs.sh` writes a self-signed
> pair to `./certs`, which is what `nginx-proxy/nginx.conf` expects at
> `/certs/tls.crt` and `/certs/tls.key`. It never overwrites an existing pair —
> drop a real certificate in there instead and the script leaves it alone (it
> will warn if what it finds has expired). Set `CERT_CN` for a hostname other
> than `localhost`, or `FORCE=1` to replace the current pair.

> **Dashboard development needs none of this:** the API, the front end and the
> full test suite run from a clean clone with `npm ci && npm test`.

## Configuration

All configuration via environment variables. See [`.env.example`](.env.example).

### Required

| Variable | Description |
|----------|-------------|
| `ICECAST_SOURCE_PASSWORD` | Liquidsoap → Icecast auth |
| `ICECAST_ADMIN_PASSWORD` | Icecast admin panel |
| `ICECAST_PASSWORD` | Icecast listener auth |
| `ICECAST_RELAY_PASSWORD` | Icecast relay auth |
| `DASHBOARD_TOKEN` | Dashboard API Bearer token |
| `STREAM_KEYS_SECRET` | AES-256 key for RTMP key encryption |

### Optional

| Variable | Default | Description |
|----------|---------|-------------|
| `OUTPUT_MODE` | `hls` | `hls` or `rtmp` |
| `RTMP_URL` | -- | Primary RTMP destination |
| `MAX_PLATFORMS` | `3` | Max simultaneous RTMP outputs |
| `MAX_CLIP_DURATION` | `60` | Max seconds per visual clip |
| `S3_ENABLED` | `false` | Enable S3 content sync |
| `S3_ENDPOINT` | -- | S3-compatible endpoint URL |
| `S3_ACCESS_KEY` / `S3_SECRET_KEY` | -- | S3 credentials |
| `S3_BUCKET` | `studio23` | S3 bucket name |
| `S3_REGION` | `eu-central-1` | S3 region |
| `S3_CACHE_MAX_MB` | `4000` | Local S3 cache size limit (MB) |
| `TENANT_ID` | `default` | Tenant identifier (S3 prefix) |
| `TRANSCODER_URL` | -- | External transcoder service URL |
| `TRANSCODER_TOKEN` | -- | External transcoder auth token |

## Docker Services

| Service | Image | Port | Description |
|---------|-------|------|-------------|
| `audio-analyzer` | mtgupf/essentia | -- | BPM detection and beat analysis |
| `icecast` | infiniteproject/icecast | 8000 | Audio streaming server |
| `dj` | savonet/liquidsoap:v2.3.0 | 7000 | BPM-aware AutoDJ with Harbor API |
| `rtmp-ingest` | alfg/nginx-rtmp | 1935 | OBS/external RTMP input |
| `streamer` | s23-streamer (custom) | -- | FFmpeg video+audio compositing |
| `dashboard` | s23-api (custom) | 9090 | REST API + WebSocket + HLS server |
| `proxy` | nginx:alpine | 80/443 | TLS termination |

## API Endpoints

Routers are mounted in `dashboard/server.js`. The table lists mount points
rather than every sub-route; read the router for the full surface.

### Public (no token)

```
GET  /api/status           Stream status (listeners, track, mode)
GET  /api/health           Health check for monitoring
GET  /api/audio-stream     Proxy to the Icecast audio stream
GET  /api/rtmp-health      RTMP ingest status
GET  /api/tier             Subscription tier and limits
POST /api/auth/verify      Dashboard token check
GET  /auth/sso             SSO token exchange (HMAC-signed)
POST /api/live/on_publish  RTMP ingest callback
POST /api/live/on_done     RTMP ingest callback
```

The `/api/live` router holds only those two callbacks, so the whole mount is
public — the RTMP ingest server calls them without a token.

### Protected (Bearer token)

| Mount | Purpose |
|-------|---------|
| `/api/music` | Music library: list, upload, delete |
| `/api/visuals` | Visual library: list, upload, delete |
| `/api/queue` | Track queue: list, push, skip, clear |
| `/api/video-queue` | Video queue, same shape as the track queue |
| `/api/playlists` | Saved playlists |
| `/api/video-playlists` | Saved video playlists |
| `/api/visual-profiles` | Visual profile presets |
| `/api/tracks` | Track metadata and lookup |
| `/api/history` | Recently played tracks |
| `/api/schedule` | Weekly slots and one-off events |
| `/api/overlays` | Overlay layers and assets |
| `/api/voice` | Push-to-talk voice chunks |
| `/api/mixing` | Crossfade mixing mode |
| `/api/dj` | Liquidsoap control: start, resume, cue, stop |
| `/api/stream-keys` | Encrypted RTMP destinations, keyed by platform |
| `/api/rtmp-urls` | Configured RTMP destination URLs |
| `/api/visuals-processed` | Transcoded visuals available to the player |
| `/api/s3/status` | S3 sync state |

Settings share the `/api` mount rather than a prefix of their own, so they read
as flat paths: `/api/audio`, `/api/video`, `/api/quality`, `/api/channel-strip`,
`/api/stream/control`, `/api/stream/mode`, `/api/visual-mode`, `/api/live-mode`
and `/api/restream/settings`. Each is `GET` to read and `POST` to write.

### WebSocket

```
ws://host/                 Real-time events (track changes, stats, FFT frames)
```

The socket is served on the same host and port as the API with no path prefix,
and authenticates by sending the dashboard token as its first message.

## Project Structure

```
freeRadio/
  dashboard/
    server.js                 Express server (API + WebSocket + static files)
    public/                   Dashboard front end, no build step
      index.html              Dashboard SPA
      style.css               Styling
      app.js                  Boot substrate (579 lines) wiring the modules below
      utils.js                Shared pure helpers (window.FRUtils)
      player.js               HLS player, loading and standby overlays
      broadcast.js            Broadcast state machine, transport, mode cards
      wsHub.js                WebSocket transport and message dispatch
      nowplaying.js           Track clock, transport readout, stat row
      queue.js                Track/video queues and the track selector
      analyzer.js             CRT analyzer, WebAudio graph, mute control
      mixer.js                Monitor mixer, mic capture, auto-duck
      ...                     19 more domain modules (playlists, schedule,
                              overlays, platforms, quality, PTT, ...)
    lib/                      38 server modules
      boot.js                 Service initialization and state recovery
      streamControl.js        FFmpeg process management
      liqClient.js            Liquidsoap telnet client
      fileManager.js          File upload/download with S3 + transcoder
      syncWatcher.js          Bidirectional S3 sync
      wsServer.js             WebSocket server
      streamKeys.js           AES-256-GCM encrypted RTMP keys
      tierLimits.js           Subscription tier enforcement
      ...
    routes/                   dj, live, settings, sso, status, streamKeys,
                              videoQueue
    Dockerfile                Dashboard image
    entrypoint.sh             Container entrypoint
  tests/
    dashboard/                Vitest suite (1678 tests across 78 files)
      routes/                 Router-level tests
      helpers/                Shared test helpers
  .github/workflows/ci.yml    GitHub Actions CI (vitest + coverage)
  docker/
    audio-analyzer/           Dockerfile adding rubberband-cli on top of
                              Essentia; not currently referenced by compose
  nginx-proxy/nginx.conf      TLS proxy config
  content/music, content/visuals
                              Media drop directories (empty in git)
  docs/                       Images and documentation assets
  Dockerfile.streamer         FFmpeg streamer image
  vitest.config.js            Test runner configuration
  docker-compose.yml          Main service orchestration
  docker-compose.rtmp.yml     RTMP-specific overrides
```

## Running Tests

```bash
# Install dependencies
npm ci

# Run the test suite (Vitest)
npm test

# Run with coverage
npx vitest run --coverage
```

CI runs the same suite with coverage on every push and pull request to `main` and `dev` via [`.github/workflows/ci.yml`](.github/workflows/ci.yml).

## License

MIT
