# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

SYSTEM 23 is a 24/7 automated streaming system for hard techno music with visuals. It combines audio from Liquidsoap DJ software with random video loops and streams via HLS (browser preview) or RTMP (YouTube/Kick). All services run as Docker containers. A Node.js dashboard provides real-time monitoring, file management, and HLS preview on port 9090.

## Commands

Start the full stack (dashboard at http://localhost:9090):
```bash
docker compose up -d
```

Start with RTMP output (YouTube/Kick streaming — dashboard still works):
```bash
docker compose -f docker-compose.yml -f docker-compose.rtmp.yml up -d
```

View logs:
```bash
docker compose logs -f [service]  # services: bpm-scanner, icecast, dj, streamer, dashboard
```

Stop all services:
```bash
docker compose down
```

## Architecture

Five Docker services connected via `rave-net` bridge network:

1. **bpm-scanner** (`scripts/bpm_scan.sh`) - Daemon that monitors `/music` every 15s, detects BPM via aubio, writes to `.bpm_map`
2. **icecast** - Audio streaming server on port 8000, receives MP3 from Liquidsoap
3. **dj** (Liquidsoap) - AutoDJ that plays tracks from `/music` with crossfades, normalizes/compresses audio, outputs to Icecast. Exposes metadata HTTP endpoint on port 7000.
4. **streamer** (`scripts/stream_entry.sh`) - Feeds random videos via FIFO pipe, combines with Icecast audio, outputs HLS (or dual HLS+RTMP via tee muxer) via FFmpeg
5. **dashboard** (Node.js/Express) - Serves HLS player, REST API for file management, WebSocket for real-time stats at http://localhost:9090

Data flow:
```
/music → bpm-scanner → .bpm_map
/music → dj (liquidsoap) → icecast:8000/live
                         → dj:7000/metadata (HTTP JSON)
/visuals → feed_fifo() → FIFO pipe ─┐
                                     ├→ ffmpeg → HLS segments (always)
              icecast:8000/live ─────┘        → RTMP (when rtmp mode)
                                                  ↓
                                     dashboard (express:9090)
                                       ├─ HLS player
                                       ├─ WebSocket (live stats)
                                       ├─ REST API (file mgmt)
                                       └─ polls icecast/dj/ffmpeg
```

### Streamer Pipeline (stream_entry.sh)

The video pipeline uses a named FIFO (`/tmp/videofifo.ts`). A background `feed_fifo()` function picks random videos with a history buffer (size 2) to avoid repeats, and writes them as MPEG-TS to the pipe. The main FFmpeg process reads the FIFO for video and Icecast for audio.

In HLS mode: outputs HLS segments directly. In RTMP mode: uses `-f tee` to output both HLS + RTMP simultaneously, so the dashboard always has a live preview.

Video encoding: first tries stream copy (`-c copy`), falls back to re-encoding (mpeg2video 20Mbps) if formats don't match. Final output is x264 8Mbps + AAC 256kbps.

FFmpeg progress stats are written to `/shared/ffmpeg_progress.txt` for the dashboard to read.

### Dashboard (dashboard/)

Node.js Express app with WebSocket. Replaces the old nginx preview + fetch-hlsjs services.

- `server.js` - Main server: Express + WebSocket + pollers
- `lib/icecast.js` - Polls icecast:8000/status-json.xsl every 5s
- `lib/liquidsoap.js` - Polls dj:7000/metadata every 2s (falls back to icecast)
- `lib/ffmpeg.js` - Reads ffmpeg progress file every 3s
- `lib/bpmMap.js` - Parses .bpm_map every 20s
- `lib/fileManager.js` - Express router for file list/upload/delete
- `public/` - Frontend SPA (index.html, style.css, app.js)

REST API: GET/POST/DELETE `/api/music`, GET/POST/DELETE `/api/visuals`, GET `/api/status`

### Liquidsoap Configs

- `configs/liquidsoap/radio.liq` - **Active by default.** Simple random playlist with 3s crossfade. Playlist reloads every 1s (rounds mode). Includes harbor HTTP metadata endpoint on port 7000.
- `configs/liquidsoap/radio_bpm.liq` - Advanced BPM-aware version. Reads `.bpm_map` before each transition. Requires changing the `dj` service command in docker-compose.yml to `/config/radio_bpm.liq`.
  - BPM transitions: ≤5 diff = 20s fade, ≤10 = 10s fade, >10 = 3s quick cut, no data = 16s default

Both configs apply: normalize (target -14dB) → compress (threshold -18dB, ratio 3:1) → limit (-1dB). Output: MP3 320kbps to Icecast.

## Configuration

- `.env` - `OUTPUT_MODE` (hls/rtmp), `RTMP_URL`, `MAX_CLIP_DURATION` (seconds per visual clip)
- `docker-compose.yml` - Main stack (HLS mode with dashboard)
- `docker-compose.rtmp.yml` - RTMP overlay (adds nginx-rtmp server, forces RTMP mode)

## Content Directories

- `content/music/` - Audio files (wav, mp3, flac, ogg, aac, m4a)
- `content/visuals/` - Video loops (mp4, mov, mkv)
- `content/music/.bpm_map` - Auto-generated BPM database (format: `filepath|bpm`)

## Notes

- Code comments are in Russian
- Docker volumes `hls-data` and `shared-data` are used for inter-container data sharing
- The dashboard auto-detects Safari (native HLS) vs Chrome/Firefox (hls.js) and includes a debug log panel
- Icecast uses default password "hackme" for all roles
- HLS segments are always generated (even in RTMP mode) so the dashboard preview always works
