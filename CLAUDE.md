# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

STUDIO 23 is a 24/7 automated streaming system for hard techno music with synchronized video visuals. It combines Liquidsoap (AutoDJ) with FFmpeg video processing and streams via HLS (browser preview) or RTMP (YouTube/Kick). All services run as Docker containers. A Node.js dashboard at port 80 provides real-time monitoring, file/queue/schedule management, and an HLS preview player.

## Commands

```bash
# Start full stack (dashboard at http://<host>:80)
docker compose up -d

# Start with RTMP output (YouTube/Kick streaming)
docker compose -f docker-compose.yml -f docker-compose.rtmp.yml up -d

# Optional monitoring (Prometheus :9092, Grafana :3000)
docker compose -f docker-compose.yml -f docker-compose.monitoring.yml up -d

# View logs (services: audio-analyzer, icecast, dj, streamer, transcoder, dashboard)
docker compose logs -f [service]

# Rebuild a single service after code changes
docker compose up -d [service] --build

# Stop
docker compose down
```

No linter and no build step. The dashboard frontend is vanilla JS (`dashboard/public/app.js`) — no bundler or transpiler.

## Tests

```bash
# Python (audio_analyzer_simple.py) — 65 tests
pytest tests/

# JavaScript (dashboard/public/utils.js) — 78 tests
npx vitest run

# Bash (scripts/stream_entry.sh) — 117 tests
npx bats tests/bash/
```

Dependencies: `requirements-test.txt` (pytest, numpy), `package.json` (vitest, bats).

## Architecture

Six Docker services on `rave-net` bridge network:

1. **audio-analyzer** (Essentia) — beat detection/structure analysis, writes `.analysis_map` and `.bpm_map` in `/music`
2. **icecast** — audio streaming server on port 8000
3. **dj** (Liquidsoap v2.3.0) — AutoDJ with crossfades, outputs MP3 320kbps to Icecast. Currently runs `radio_bpm.liq` (BPM-aware mixing). Harbor HTTP API on port 7000 (metadata, queue push/skip/clear)
4. **streamer** (FFmpeg + mbuffer) — reads pre-transcoded videos via FIFO pipe + Icecast audio, outputs HLS segments (always) and optionally RTMP via `-f tee`
5. **transcoder** — watches `/visuals/` for new files, auto-transcodes to `/visuals/.processed/` (QSV H.264, CBR 8Mbps, 1080p, stream-ready)
6. **dashboard** (Node.js/Express) — SPA with WebSocket real-time stats, REST API, HLS player

Data flow:
```
/music → audio-analyzer → .bpm_map + .analysis_map
/music → dj (liquidsoap) → icecast:8000/live
                          → dj:7000/metadata (HTTP JSON)
/visuals → transcoder → /visuals/.processed/
/visuals/.processed/ → feed_fifo() → mbuffer → FIFO pipe ─┐
                                                           ├→ ffmpeg → HLS (always)
                            icecast:8000/live ────────────┘         → RTMP (tee, per-platform)
dashboard:9090 ← polls icecast/dj/ffmpeg, serves UI + REST API + WebSocket
```

### Pre-transcoding Pipeline (copy mode)

This is the core performance optimization. The pipeline has two stages:

1. **Transcoder** (`scripts/transcoder.sh`): QSV hardware decode+encode, CBR 8Mbps, native FPS, H.264 High profile, `-bf 0` (no B-frames), up to 3 parallel jobs. Output goes to `/visuals/.processed/`.
2. **Streamer** (`scripts/stream_entry.sh`): When no overlays are active, uses `-c:v copy` (zero CPU/GPU on video). `feed_fifo()` remuxes `.processed/` files to MPEG-TS with `-c:v copy`. Audio is Icecast MP3 → AAC encode only.

Critical constraints:
- **`-bf 0` (no B-frames)** is required because `-fflags +igndts` in the main FFmpeg breaks B-frame DTS ordering
- **Native FPS preserved** — Kling AI outputs 24fps; forcing `fps=30` causes visible frame duplication judder
- **QSV needs `-hwaccel_output_format nv12`** (not `qsv`) when using software filters like scale/pad, because QSV surface format is incompatible with CPU filters
- When overlays are enabled, the streamer falls back to full encode (QSV or libx264) and `fps=30`

### Config-Driven Restart Mechanism

The streamer watches config files in `/shared/` every 2 seconds via `watch_stream_config()`. It computes a checksum-based signature of all config files (quality, audio, video, overlay, control, stream keys, visual profile). When the signature changes, it kills and restarts the main FFmpeg process to apply new settings.

### Streamer Pipeline Details (scripts/stream_entry.sh)

Video pipeline uses a named FIFO (`/tmp/videofifo.ts`). Background `feed_fifo()` picks random videos (Fisher-Yates shuffle, full-round before repeat), writes MPEG-TS to the pipe through mbuffer (256MB). Main FFmpeg reads FIFO for video + Icecast for audio. Multi-RTMP output uses `-f tee` with `onfail=ignore` per destination.

RTMP health monitoring runs in a background function, parsing FFmpeg stderr for connection errors and writing status JSON to `/shared/rtmp_status.json`.

### Dashboard (dashboard/)

Express server with WebSocket on port 9090 (mapped to 80). UI is a single-page app with tabs: Studio, Schedule, Playlists, Visuals, Analytics, Management. Frontend in `dashboard/public/app.js` (~2000 lines vanilla JS) auto-detects Safari (native HLS) vs Chrome/Firefox (hls.js).

Key server-side modules in `dashboard/lib/`:
- `liqClient.js` — HTTP client for Liquidsoap Harbor API (queue push/skip/clear, port 7000)
- `icecast.js` — polls Icecast status every 5s
- `track.js` — polls current track from `/shared/current_audio.txt` every 2s
- `ffmpeg.js` — reads FFmpeg progress stats every 3s
- `bpmMap.js` — parses `.bpm_map` every 20s
- `streamKeys.js` — AES-256-GCM encrypted RTMP key storage, builds full RTMP URLs from base URL + stream key
- `quality.js` — 7 quality presets (low 480p → godmode 1440p)
- `fileManager.js` — music/visuals upload/download/delete (500MB limit, path traversal protection)
- `queue.js` — queue management + playlist loading via liqClient
- `playlist.js` — manual playlists + smart playlists (BPM range, pattern, tags)
- `schedule.js` — weekly slots + one-time events + schedule executor daemon
- `history.js` — play history tracking (JSONL in `/shared/play_history.jsonl`)
- `overlay.js` — logo/text/clock/scrolling overlays, generates FFmpeg drawtext filter strings → `/shared/overlay_filter_string.txt`
- `visualProfile.js` — named video selection profiles
- `trackMeta.js` — per-track tags/genre/custom metadata

REST API base path: `/api/` — endpoints for `status`, `music`, `visuals`, `queue`, `playlists`, `tracks`, `schedule`, `history`, `visual-profiles`, `overlays`, `stream-keys`, `rtmp-urls`, `rtmp-health`, `quality`, `audio`, `video`, `stream/control`, `restream/settings`.

### Liquidsoap Config (configs/liquidsoap/)

- `radio.liq` — simple random playlist, 3s crossfade (not in use)
- `radio_bpm.liq` — **currently active.** Single cross pipeline (5s buffer). BPM-aware smart mix from `.analysis_map`: 2-3 bar crossfade with beat-aligned sin curves and compression. All tracks (including first track at stream start) go through `request.queue` → `cross()` for consistent transitions. `/playback/cue` pushes into the queue; dashboard waits ~5.5s for buffer fill before opening gate. Harbor HTTP API on port 7000 for metadata/queue/skip/cue/resume.

Audio chain: DSP (normalize/compress/limit) removed from Liquidsoap — applied at transcode time via loudnorm. Output: AAC 256kbps to Icecast.

### Inter-service Communication

Services communicate through two mechanisms:
1. **Shared volume** (`shared-data` → `/shared/`): JSON config files written by dashboard, read by streamer shell script. Changes detected via checksum polling.
2. **HTTP APIs**: Dashboard → Liquidsoap (port 7000) for queue/skip; Dashboard → Icecast (port 8000) for status; Streamer → Dashboard (port 9090) for RTMP URL list.

## Configuration

- `.env` — `OUTPUT_MODE` (hls/rtmp), `RTMP_URL`, `MAX_CLIP_DURATION` (seconds per visual clip)
- Config files in `shared-data` volume (`/shared/`): `stream_quality.json`, `stream_audio.json`, `stream_video.json`, `stream_control.json`, `stream_keys.enc`, `overlay_config.json`, `overlay_filter_string.txt`, `active_visual_profile.json`, `schedule.json`, `playlists.json`, `play_history.jsonl`, `track_metadata.json`
- `content/music/` — audio files (wav, mp3, flac, ogg, aac, m4a)
- `content/visuals/` — raw video loops; `content/visuals/.processed/` — transcoded stream-ready files

## Notes

- Code comments are in Russian
- Dashboard maps port 80→9090, авторизация через DASHBOARD_TOKEN
- Proxmox NAT: 95.217.38.43:8080 → 10.10.10.2:80 (dashboard через интернет)
- Monitoring/RTMP порты открыты на 0.0.0.0 (Prometheus :9092, Grafana :3000)
- HLS segments are always generated (even in RTMP mode) so the dashboard preview always works
- Container memory limits: streamer 1536m, transcoder 512m
- The `linuxserver/ffmpeg:latest` image is used for both streamer and transcoder (has full QSV support)
- Streamer Dockerfile only adds `mbuffer` on top of the ffmpeg image
