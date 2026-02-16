# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

SYSTEM 23 is a 24/7 automated streaming system for hard techno music with synchronized video visuals. It combines Liquidsoap (AutoDJ) with FFmpeg video processing and streams via HLS (browser preview) or RTMP (YouTube/Kick). All services run as Docker containers. A Node.js dashboard at port 80 provides real-time monitoring, file/queue/schedule management, and an HLS preview player.

## Commands

```bash
# Start full stack (dashboard at http://<host>:80)
docker compose up -d

# Start with RTMP output (YouTube/Kick streaming)
docker compose -f docker-compose.yml -f docker-compose.rtmp.yml up -d

# Optional monitoring (Prometheus :9092, Grafana :3000)
docker compose -f docker-compose.yml -f docker-compose.monitoring.yml up -d

# View logs (services: audio-analyzer, icecast, dj, streamer, dashboard)
docker compose logs -f [service]

# Rebuild a single service after code changes
docker compose up -d [service] --build

# Stop
docker compose down
```

## Architecture

Six Docker services on `rave-net` bridge network:

1. **audio-analyzer** (Essentia) — beat detection/structure analysis, writes `.analysis_map` and `.bpm_map` in `/music`
2. **icecast** — audio streaming server on port 8000
3. **dj** (Liquidsoap v2.3.0) — AutoDJ with crossfades, outputs MP3 320kbps to Icecast. Currently runs `radio_bpm.liq` (BPM-aware mixing). HTTP metadata API on port 7000
4. **streamer** (FFmpeg + mbuffer) — reads random videos via FIFO pipe + Icecast audio, outputs HLS segments (always) and optionally RTMP via `-f tee`
5. **dashboard** (Node.js/Express) — SPA with WebSocket real-time stats, REST API, HLS player

Data flow:
```
/music → audio-analyzer → .bpm_map + .analysis_map
/music → dj (liquidsoap) → icecast:8000/live
                          → dj:7000/metadata (HTTP JSON)
/visuals → feed_fifo() → FIFO pipe ─┐
                                     ├→ ffmpeg → HLS segments (always)
              icecast:8000/live ────┘         → RTMP (when enabled)
dashboard:9090 ← polls icecast/dj/ffmpeg, serves UI + REST API + WebSocket
```

### Streamer Pipeline (scripts/stream_entry.sh)

Video pipeline uses a named FIFO (`/tmp/videofifo.ts`). Background `feed_fifo()` picks random videos (Fisher-Yates shuffle, history buffer to avoid repeats), writes MPEG-TS to the pipe through mbuffer (1GB). Main FFmpeg reads FIFO for video + Icecast for audio.

The script watches config files in `/shared/` and restarts FFmpeg when quality/overlay/audio/video settings change. Quality presets control resolution, bitrate, and codec selection (see `dashboard/lib/quality.js`).

### Dashboard (dashboard/)

Express server with WebSocket. UI is a SPA with tabs: Studio, Schedule, Playlists, Visuals, Analytics, Management.

Key server-side modules in `dashboard/lib/`:
- `liqClient.js` — HTTP client for Liquidsoap Harbor API (queue push/skip/clear)
- `icecast.js` — polls Icecast status every 5s
- `track.js` — polls current track from `/shared/current_audio.txt` every 2s
- `ffmpeg.js` — reads FFmpeg progress stats every 3s
- `bpmMap.js` — parses `.bpm_map` every 20s
- `streamKeys.js` — AES-256-GCM encrypted RTMP key storage
- `quality.js` — 7 quality presets (low 480p → godmode 1440p VP9)
- `fileManager.js` — music/visuals upload/download/delete (500MB limit, path traversal protection)
- `queue.js` — queue management + playlist loading
- `playlist.js` — manual playlists + smart playlists (BPM range, pattern, tags)
- `schedule.js` — weekly slots + one-time events + schedule executor daemon
- `history.js` — play history tracking (JSONL in `/shared/play_history.jsonl`)
- `overlay.js` — logo/text/clock/scrolling overlays, generates FFmpeg drawtext filters
- `visualProfile.js` — named video selection profiles
- `trackMeta.js` — per-track tags/genre/custom metadata

REST API base path: `/api/` — endpoints for `status`, `music`, `visuals`, `queue`, `playlists`, `tracks`, `schedule`, `history`, `visual-profiles`, `overlays`, `stream-keys`, `quality`, `audio`, `video`, `stream/control`, `restream/settings`.

### Liquidsoap Configs (configs/liquidsoap/)

- `radio.liq` — simple random playlist, 3s crossfade
- `radio_bpm.liq` — **currently active.** BPM-aware mixing from `.analysis_map`. Adaptive crossfade: ≤5 BPM diff = 20s fade, ≤10 = 10s, >10 = 3s cut. Harbor HTTP API on port 7000 (metadata, queue push/skip/clear)

Both configs: normalize (-14dB) → compress (3:1, -18dB threshold) → limit (-1dB). Output: MP3 320kbps to Icecast.

## Configuration

- `.env` — `OUTPUT_MODE` (hls/rtmp), `RTMP_URL`, `MAX_CLIP_DURATION` (seconds per visual clip)
- Inter-container state files in `shared-data` volume (`/shared/`): `stream_quality.json`, `stream_audio.json`, `stream_video.json`, `stream_control.json`, `stream_keys.enc`, `overlay_config.json`, `overlay_filter_string.txt`, `active_visual_profile.json`, `schedule.json`, `playlists.json`, `play_history.jsonl`, `track_metadata.json`
- `content/music/` — audio files (wav, mp3, flac, ogg, aac, m4a)
- `content/visuals/` — video loops (mp4, mov, mkv)

## Notes

- Code comments are in Russian
- Icecast binds to Tailscale IP (100.110.164.51), dashboard maps port 80→9090
- Icecast uses default password "hackme" for all roles
- HLS segments are always generated (even in RTMP mode) so the dashboard preview always works
- Frontend (`dashboard/public/app.js`, ~2000 lines) auto-detects Safari (native HLS) vs Chrome/Firefox (hls.js)
