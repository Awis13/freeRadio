#!/bin/bash
set -e

OUTPUT_MODE="${OUTPUT_MODE:-hls}"
HLS_DIR="${HLS_DIR:-/hls}"
HLS_PLAYLIST="${HLS_PLAYLIST:-${HLS_DIR}/stream.m3u8}"
ICECAST_URL="${ICECAST_URL:-}"
RTMP_URL="${RTMP_URL:-}"
FFMPEG_PROGRESS_FILE="${FFMPEG_PROGRESS_FILE:-}"
DASHBOARD_API="${DASHBOARD_API:-http://dashboard:9090}"
FIFO="/tmp/videofifo.ts"
AUDIO_FIFO="/tmp/audiofifo.ts"
APPLIED_SIG_FILE="/tmp/applied_stream_sig.txt"
MAIN_FFMPEG_MATCH="/tmp/videofifo.ts"
FFMPEG_STDERR_LOG="/tmp/ffmpeg_stderr.log"
RTMP_STATUS_FILE="/shared/rtmp_status.json"

# Escape a string for safe JSON embedding (RFC 8259: quotes, backslashes, control chars)
json_escape_value() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/\t/\\t/g' | tr -d '\n\r'
}


# Fetch RTMP URLs from dashboard API (for multi-streaming)
fetch_rtmp_urls() {
  curl -s -H "Authorization: Bearer ${DASHBOARD_TOKEN}" \
    "${DASHBOARD_API}/api/rtmp-urls" 2>/dev/null || echo "[]"
}

# Check if RTMP URLs contain only YouTube (returns "youtube" or "multi")
get_rtmp_mode() {
  local rtmp_urls="$1"
  local url_count youtube_count
  
  if [ "$rtmp_urls" = "[]" ] || [ -z "$rtmp_urls" ]; then
    echo "none"
    return
  fi
  
  # Count total URLs and YouTube URLs
  url_count=$(echo "$rtmp_urls" | grep -o '"url":"[^"]*"' | wc -l)
  youtube_count=$(echo "$rtmp_urls" | grep -o '"url":"[^"]*"' | grep -c "youtube\|youtu.be" || echo "0")
  
  if [ "$url_count" -eq "$youtube_count" ] && [ "$youtube_count" -gt 0 ]; then
    echo "youtube"  # Only YouTube
  else
    echo "multi"     # YouTube + others or only others
  fi
}

# Check if streaming is enabled — pure bash, no subprocesses
is_streaming_enabled() {
  local control_file="/shared/stream_control.json"
  if [ -f "$control_file" ]; then
    local content
    content=$(<"$control_file")
    if [[ "$content" == *'"streaming":false'* ]] || [[ "$content" == *'"streaming": false'* ]]; then
      return 1
    fi
    return 0
  fi
  # Missing control file defaults to enabled.
  return 0
}

# Check if broadcast is enabled (RTMP output) — pure bash, no subprocesses
get_broadcast_enabled() {
  local control_file="/shared/stream_control.json"
  if [ -f "$control_file" ]; then
    local content
    content=$(<"$control_file")
    if [[ "$content" == *'"broadcast":true'* ]] || [[ "$content" == *'"broadcast": true'* ]]; then
      echo "true"
      return
    fi
  fi
  echo "false"
}

# Get stream mode (standby, armed, or live) — pure bash, no subprocesses
get_stream_mode() {
  local mode_file="/shared/stream_mode.json"
  if [ -f "$mode_file" ]; then
    local content
    content=$(<"$mode_file")
    if [[ "$content" == *'"mode":"live"'* ]]; then
      echo "live"
    elif [[ "$content" == *'"mode":"armed"'* ]]; then
      echo "armed"
    else
      echo "standby"
    fi
  else
    echo "standby"
  fi
}

# Get standby visual file path
get_standby_visual() {
  local mode_file="/shared/stream_mode.json"
  local visual_name=""
  if [ -f "$mode_file" ]; then
    visual_name=$(grep -o '"standbyVisual":"[^"]*"' "$mode_file" 2>/dev/null | cut -d'"' -f4)
  fi
  # Resolve to full path
  if [ -n "$visual_name" ] && [ -f "/visuals/.processed/$visual_name" ]; then
    echo "/visuals/.processed/$visual_name"
    return
  fi
  # Fallback: first file in .processed/
  local first
  first=$(find /visuals/.processed -type f \( -name "*.mp4" -o -name "*.mov" -o -name "*.mkv" \) 2>/dev/null | head -1)
  echo "$first"
}

# Generate poster video (5s still frame from first content video) for armed mode
generate_poster() {
  local poster_mp4="/tmp/poster.mp4"
  local poster_png="/tmp/poster.png"
  # Pick first video from rotation
  local first_video
  first_video=$(get_video_list | head -1)
  if [ -z "$first_video" ] || [ ! -f "$first_video" ]; then
    echo "[poster] No content videos, using standby black"
    cp "$STANDBY_FILE" "$poster_mp4" 2>/dev/null || true
    return
  fi
  echo "[poster] Extracting frame from: ${first_video##*/}"
  # Extract first frame
  ffmpeg -hide_banner -loglevel error -i "$first_video" -vframes 1 -y "$poster_png" 2>/dev/null
  if [ ! -f "$poster_png" ]; then
    echo "[poster] Frame extraction failed, using standby black"
    cp "$STANDBY_FILE" "$poster_mp4" 2>/dev/null || true
    return
  fi
  # Create 5s still H.264 video matching transcoder format
  ffmpeg -hide_banner -loglevel error \
    -loop 1 -i "$poster_png" \
    -c:v libx264 -profile:v high -bf 0 -pix_fmt yuv420p \
    -t 5 -r 24 \
    -vf "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:black" \
    -y "$poster_mp4" 2>/dev/null
  if [ ! -f "$poster_mp4" ]; then
    echo "[poster] Encode failed, using standby black"
    cp "$STANDBY_FILE" "$poster_mp4" 2>/dev/null || true
    return
  fi
  rm -f "$poster_png"
  echo "[poster] Ready: $poster_mp4"
}

# Get visual mode (live, visual-radio, video-playlist) — pure bash, no subprocesses
get_visual_mode() {
  local mode_file="/shared/visual_mode.json"
  if [ -f "$mode_file" ]; then
    local content
    content=$(<"$mode_file")
    if [[ "$content" == *'"mode":"live"'* ]] || [[ "$content" == *'"mode":"radio"'* ]]; then
      echo "live"
    elif [[ "$content" == *'"mode":"video-playlist"'* ]]; then
      echo "video-playlist"
    else
      echo "visual-radio"
    fi
  else
    echo "visual-radio"
  fi
}

# Get OBS connection status from live_mode.json — pure bash
get_live_obs_status() {
  local live_file="/shared/live_mode.json"
  if [ -f "$live_file" ]; then
    local content
    content=$(<"$live_file")
    if [[ "$content" == *'"obsStatus":"connected"'* ]]; then
      echo "connected"
    elif [[ "$content" == *'"obsStatus":"disconnected"'* ]]; then
      echo "disconnected"
    else
      echo "offline"
    fi
  else
    echo "offline"
  fi
}

# Get AFK fallback mode — pure bash
get_live_afk_fallback() {
  local live_file="/shared/live_mode.json"
  if [ -f "$live_file" ]; then
    local content
    content=$(<"$live_file")
    if [[ "$content" == *'"afkFallback":"video-playlist"'* ]]; then
      echo "video-playlist"
    else
      echo "visual-radio"
    fi
  else
    echo "visual-radio"
  fi
}

# Get ingest key for RTMP URL — pure bash
get_live_ingest_key() {
  local live_file="/shared/live_mode.json"
  if [ -f "$live_file" ]; then
    local content
    content=$(<"$live_file")
    # Extract key value between quotes after "ingestKey":"
    local key=""
    key="${content#*\"ingestKey\":\"}"
    key="${key%%\"*}"
    if [ -n "$key" ] && [ "$key" != "$content" ]; then
      echo "$key"
      return
    fi
  fi
  echo ""
}

# Fetch quality settings from file
get_quality_settings() {
  local quality_file="/shared/stream_quality.json"
  if [ -f "$quality_file" ]; then
    cat "$quality_file"
  else
    echo '{"preset":"high"}'
  fi
}

# Fetch audio settings from file
get_audio_settings() {
  local audio_file="/shared/stream_audio.json"
  if [ -f "$audio_file" ]; then
    cat "$audio_file"
  else
    echo '{"enhanced":false}'
  fi
}

# Get audio enhancement filter
get_audio_filter() {
  local audio_json
  audio_json=$(get_audio_settings)
  if echo "$audio_json" | grep -q '"enhanced":[[:space:]]*true'; then
    # Simplified audio filter without complex mcompand (spaces break shell)
    echo "loudnorm=I=-14:TP=-1.5:LRA=11,highpass=f=40,lowpass=f=18000,equalizer=f=100:t=h:width=200:g=2,equalizer=f=1000:t=h:width=200:g=1,equalizer=f=10000:t=h:width=2000:g=2"
  else
    echo ""
  fi
}

# Fetch video settings from file
get_video_settings() {
  local video_file="/shared/stream_video.json"
  if [ -f "$video_file" ]; then
    cat "$video_file"
  else
    echo '{"enhanced":false}'
  fi
}

# Get video enhancement filter
get_video_enhancement_filter() {
  local video_json
  video_json=$(get_video_settings)
  if echo "$video_json" | grep -q '"enhanced":[[:space:]]*true'; then
    echo "eq=saturation=1.15:contrast=1.03,unsharp=3:3:0.5,deband"
  else
    echo ""
  fi
}

# Get video bitrate based on preset
get_video_bitrate() {
  local preset="$1"
  case "$preset" in
    low) echo "2000k" ;;
    medium) echo "4000k" ;;
    kick) echo "6000k" ;;  # kick safe bitrate
    standard) echo "6000k" ;;  # multi-platform standard
    ultra|godmode) echo "12000k" ;;  # ultra/godmode super quality (YouTube-only)
    *) echo "6000k" ;;  # high default
  esac
}

# Get audio bitrate based on preset
get_audio_bitrate() {
  local preset="$1"
  case "$preset" in
    low) echo "128k" ;;
    medium|kick|standard) echo "192k" ;;  # kick/standard uses 192k
    ultra|godmode) echo "320k" ;;  # ultra/godmode super quality
    *) echo "256k" ;;  # high default
  esac
}

# Get preset speed
get_preset_speed() {
  local preset="$1"
  case "$preset" in
    godmode|kick|standard) echo "veryfast" ;;  # veryfast for godmode/kick/standard
    ultra) echo "fast" ;;  # slower = better quality for ultra
    *) echo "veryfast" ;;
  esac
}

# Get extra x264 options based on preset (tune, etc.)
get_x264_extras() {
  local preset="$1"
  case "$preset" in
    ultra|godmode) echo "-tune animation" ;;
    kick|standard) echo "" ;;  # no tune for kick/standard
    *) echo "" ;;
  esac
}

# Get FPS based on preset
get_fps() {
  local preset="$1"
  case "$preset" in
    ultra60|godmode60) echo "60" ;;  # 60fps for special presets only
    *) echo "30" ;;  # 30fps default
  esac
}

# Get GOP size based on preset (2 seconds worth of frames)
get_gop_size() {
  local preset="$1"
  case "$preset" in
    ultra60|godmode60) echo "120" ;;  # 2 seconds at 60fps
    *) echo "60" ;;  # 2 seconds at 30fps
  esac
}

# Get video filter with optional upscaling for VP9 force
get_video_filter_with_scale() {
  local preset="$1"
  local base_filter="$2"
  local enhance_filter="$3"
  local final_filter=""
  
  # Combine base filter with enhancement if present
  if [ -n "$enhance_filter" ] && [ -n "$base_filter" ]; then
    final_filter="$base_filter,$enhance_filter"
  elif [ -n "$enhance_filter" ]; then
    final_filter="$enhance_filter"
  else
    final_filter="$base_filter"
  fi
  
  case "$preset" in
    godmode) echo "scale=2560:1440:flags=lanczos${final_filter:+,}$final_filter" ;;  # Scale first, then filters
    standard|kick) echo "scale=1920:1080:flags=lanczos${final_filter:+,}$final_filter" ;;  # 1080p for multi-platform
    *) echo "$final_filter" ;;
  esac
}

# Pre-transcoded standby file (solid black, QSV H.264 CBR 6Mbps, same format as .processed/)
# Black frames: even if stale data leaks through mbuffer during standby→live transition,
# it's invisible (black) instead of jarring noise/static.
STANDBY_FILE="/visuals/.processed/_standby_black.mp4"

# Get current audio bitrate from quality preset (for feed_fifo per-clip encoding)
get_current_audio_bitrate() {
  local quality_json preset
  quality_json=$(get_quality_settings)
  preset=$(echo "$quality_json" | grep -o '"preset":"[^"]*"' | cut -d'"' -f4)
  get_audio_bitrate "${preset:-high}"
}

echo "[*] Waiting for icecast..."
sleep 2
echo "[+] Go!"

# Create FIFO pipes
[ -p "$FIFO" ] || mkfifo "$FIFO"
[ -p "$AUDIO_FIFO" ] || mkfifo "$AUDIO_FIFO"

# Get video list from active visual profile or fallback to all visuals
get_video_list() {
  local profile="/shared/active_visual_profile.json"
  if [ -f "$profile" ]; then
    local files
    files=$(grep -o '"[^"]*\.\(mp4\|mov\|mkv\)"' "$profile" 2>/dev/null | tr -d '"')
    if [ -n "$files" ]; then
      local result=()
      while IFS= read -r f; do
        if [ -f "/visuals/.processed/$f" ]; then
          result+=("/visuals/.processed/$f")
        elif [ -f "/visuals/$f" ]; then
          result+=("/visuals/$f")
        fi
      done <<< "$files"
      if [ ${#result[@]} -gt 0 ]; then
        printf '%s\n' "${result[@]}"
        return
      fi
    fi
  fi
  # Fallback: all videos in .processed (exclude _standby_static used for standby mode)
  find /visuals/.processed -type f \( -name "*.mp4" -o -name "*.mov" -o -name "*.mkv" \) ! -name "_standby_*" 2>/dev/null
}

# Build video filter chain from overlay config
build_video_filters() {
  local filter_file="/shared/overlay_filter_string.txt"
  if [ -f "$filter_file" ] && [ -s "$filter_file" ]; then
    cat "$filter_file"
  fi
  # No default filters — pre-transcoded content is ready to stream
}

# Wait for background ffmpeg, kill immediately on mode/visual-mode change, video skip, or OBS connect.
# Usage: wait_or_interrupt <ffpid> <mode> <vmode>
wait_or_interrupt() {
  local ffpid=$1 start_mode=$2 start_vmode=$3
  while kill -0 $ffpid 2>/dev/null; do
    # Video skip signal (video-playlist)
    if [ -f /shared/video_skip ]; then
      rm -f /shared/video_skip
      kill $ffpid 2>/dev/null; wait $ffpid 2>/dev/null
      echo "[+] Video skipped"
      return 0
    fi
    # Mode or visual-mode changed → kill clip, let loop pick new content instantly
    local m=$(get_stream_mode) vm=$(get_visual_mode)
    if [ "$m" != "$start_mode" ] || [ "$vm" != "$start_vmode" ]; then
      # armed→live: kill preview, start concat playlist
      kill $ffpid 2>/dev/null; wait $ffpid 2>/dev/null
      echo "[+] Interrupted: $start_mode/$start_vmode → $m/$vm"
      return 0
    fi
    # Live mode AFK: interrupt clip when OBS connects
    if [ "$start_vmode" = "live" ] && [ "$(get_live_obs_status)" = "connected" ]; then
      kill $ffpid 2>/dev/null; wait $ffpid 2>/dev/null
      echo "[+] Interrupted: OBS connected, switching to RTMP"
      return 0
    fi
    sleep 0.5
  done
  wait $ffpid 2>/dev/null || true
}

# Mode-aware feed_fifo: all playback runs in background with mode-change polling.
# Mode switches kill current clip instantly → next iteration picks new content within 0.5s.
feed_fifo() {
  # Redirect echo/printf to stderr (docker logs), keep fd 3 for data pipe (stdout → mbuffer → FIFO)
  exec 3>&1 1>&2
  declare -a SHUFFLED
  SHUFFLED=()
  local prev_mode="" prev_vmode=""

  while true; do
    # Check if main ffmpeg is still running
    if ! pgrep -f "ffmpeg.*$FIFO" >/dev/null 2>&1; then
      echo "[!] Main ffmpeg died, exiting feeder"
      exit 0
    fi

    local current_mode visual_mode
    current_mode=$(get_stream_mode)
    visual_mode=$(get_visual_mode)

    # Log mode changes
    if [ "$current_mode" != "$prev_mode" ] || [ "$visual_mode" != "$prev_vmode" ]; then
      echo "[+] Mode: ${prev_mode:-init}/${prev_vmode:-init} → $current_mode/$visual_mode"
      if [ "$current_mode" = "armed" ]; then
        # Each ARM = new playlist
        SHUFFLED=()
        echo "[+] Armed: playlist reset (new shuffle pending)"
      elif [ "$current_mode" = "live" ] && [ "$prev_mode" = "armed" ]; then
        # Armed → Live: playlist ready in SHUFFLED, PLAY picks it up
        echo "[+] Armed → Live: playlist ready (${#SHUFFLED[@]} clips)"
      elif [ "$current_mode" = "live" ] && [ "$prev_mode" = "standby" ]; then
        SHUFFLED=()
        echo "[+] Shuffle reset (standby → live)"
      fi
      # Armed: feed_fifo switches to real content video below (no poster needed)
      prev_mode="$current_mode"
      prev_vmode="$visual_mode"
    fi

    # Determine next file
    local RANDOM_FILE=""

    if [ "$current_mode" = "standby" ]; then
      if [ "$visual_mode" = "video-playlist" ]; then
        # Standby + video-playlist: video+audio from standby file, infinite loop
        ffmpeg -hide_banner -loglevel error -re \
          -stream_loop -1 -i "$STANDBY_FILE" \
          -c:v copy -c:a copy \
          -f mpegts - >&3 2>/dev/null &
      else
        # Standby + live/visual-radio: video-only, infinite loop
        ffmpeg -hide_banner -loglevel error -re \
          -stream_loop -1 -i "$STANDBY_FILE" \
          -c:v copy -an \
          -f mpegts - >&3 2>/dev/null &
      fi
      wait_or_interrupt $! "$current_mode" "$visual_mode"
      continue
    elif [ "$current_mode" = "armed" ]; then
      # Armed: shuffle playlist, play first clip. PLAY picks up this same playlist.
      if [ ${#SHUFFLED[@]} -eq 0 ]; then
        mapfile -t ALL_VIDEOS < <(get_video_list)
        if [ ${#ALL_VIDEOS[@]} -gt 0 ]; then
          SHUFFLED=("${ALL_VIDEOS[@]}")
          for ((i=${#SHUFFLED[@]}-1; i>0; i--)); do
            j=$((RANDOM % (i+1)))
            tmp="${SHUFFLED[$i]}"
            SHUFFLED[$i]="${SHUFFLED[$j]}"
            SHUFFLED[$j]="$tmp"
          done
          echo "[+] Armed: new playlist ${#SHUFFLED[@]} clips, preview: ${SHUFFLED[0]##*/}"
        fi
      fi
      local arm_video="${SHUFFLED[0]:-$STANDBY_FILE}"
      if [ ! -f "$arm_video" ]; then
        arm_video="$STANDBY_FILE"
      fi
      ffmpeg -hide_banner -loglevel error -re \
        -stream_loop -1 -i "$arm_video" \
        -c:v copy -an \
        -f mpegts - >&3 2>/dev/null &
      wait_or_interrupt $! "$current_mode" "$visual_mode"
      continue
    elif [ "$visual_mode" = "live" ]; then
      # Live mode: OBS connected → RTMP passthrough, OBS disconnected → AFK shuffle
      local obs_status ingest_key
      obs_status=$(get_live_obs_status)
      ingest_key=$(get_live_ingest_key)

      if [ "$obs_status" = "connected" ] && [ -n "$ingest_key" ]; then
        # OBS LIVE: passthrough video from RTMP ingest (copy mode, 0% CPU)
        local rtmp_url="rtmp://rtmp-ingest:1935/ingest/${ingest_key}"
        echo "[+] Live: OBS video from ${rtmp_url##*/ingest/}"

        # Retry up to 3 times — stream may not be ready for subscribers immediately
        local obs_ffpid=0 retry
        for retry in 1 2 3; do
          ffmpeg -hide_banner -loglevel warning \
            -rw_timeout 5000000 \
            -rtmp_live live \
            -i "$rtmp_url" \
            -c:v copy -an \
            -f mpegts - >&3 2>&2 &
          obs_ffpid=$!
          sleep 1
          if kill -0 $obs_ffpid 2>/dev/null; then
            echo "[+] Live: OBS video connected (attempt $retry)"
            break
          fi
          echo "[!] Live: OBS video failed (attempt $retry)"
          wait $obs_ffpid 2>/dev/null || true
          obs_ffpid=0
        done

        if [ "$obs_ffpid" -eq 0 ] || ! kill -0 $obs_ffpid 2>/dev/null; then
          echo "[!] Live: OBS video failed after 3 attempts, AFK fallback"
          # Fall through to AFK shuffle below
        else
          # Monitor: check for mode change, visual-mode change, or OBS disconnect
          local grace_start=0
          while kill -0 $obs_ffpid 2>/dev/null; do
            local m vm os
            m=$(get_stream_mode)
            vm=$(get_visual_mode)
            os=$(get_live_obs_status)
            # Mode or visual-mode changed → kill and re-enter loop
            if [ "$m" != "$current_mode" ] || [ "$vm" != "$visual_mode" ]; then
              kill $obs_ffpid 2>/dev/null; wait $obs_ffpid 2>/dev/null
              echo "[+] Live: interrupted by mode change ($m/$vm)"
              break
            fi
            # OBS disconnected → 3s grace period
            if [ "$os" != "connected" ]; then
              if [ "$grace_start" -eq 0 ]; then
                grace_start=$(date +%s)
                echo "[+] Live: OBS signal lost, 3s grace..."
              elif [ $(( $(date +%s) - grace_start )) -ge 3 ]; then
                echo "[+] Live: OBS disconnected, switching to AFK"
                kill $obs_ffpid 2>/dev/null; wait $obs_ffpid 2>/dev/null
                break
              fi
            else
              grace_start=0
            fi
            sleep 0.5
          done
          wait $obs_ffpid 2>/dev/null || true
          continue
        fi
      fi

      # AFK fallback: use shuffle code below (same as visual-radio)
      echo "[+] Live AFK: shuffle fallback"
    fi
    # Common path for visual-radio, video-playlist, and live-AFK: shuffle/queue
    if [ -z "$RANDOM_FILE" ]; then
      # In video-playlist mode, check queue first
      local queued_file=""
      if [ "$visual_mode" = "video-playlist" ] && [ -f /shared/video_queue.txt ]; then
        queued_file=$(head -1 /shared/video_queue.txt 2>/dev/null | tr -d '\r')
        if [ -n "$queued_file" ]; then
          # Remove first line from queue (atomic: sed + tmp)
          sed -i '1d' /shared/video_queue.txt 2>/dev/null || true
          if [ -f "/visuals/.processed/$queued_file" ]; then
            RANDOM_FILE="/visuals/.processed/$queued_file"
            echo "[+] Queue: $queued_file"
          else
            echo "[!] Queue file not found: $queued_file"
            queued_file=""
          fi
        fi
      fi

      # If not from queue — shuffle
      if [ -z "$queued_file" ]; then
        if [ ${#SHUFFLED[@]} -eq 0 ]; then
          mapfile -t ALL_VIDEOS < <(get_video_list)

          if [ ${#ALL_VIDEOS[@]} -eq 0 ]; then
            echo "[!] No video files found, skipping"
            sleep 2
            continue
          fi

          # Fisher-Yates shuffle
          SHUFFLED=("${ALL_VIDEOS[@]}")
          for ((i=${#SHUFFLED[@]}-1; i>0; i--)); do
            j=$((RANDOM % (i+1)))
            tmp="${SHUFFLED[$i]}"
            SHUFFLED[$i]="${SHUFFLED[$j]}"
            SHUFFLED[$j]="$tmp"
          done

          echo "[+] New video round: ${#SHUFFLED[@]} clips"
        fi

        # === CONCAT DEMUXER: seamless playback of entire round ===
        # Instead of separate ffmpeg per 5s clip (with gaps between them),
        # build a concat list and play the whole round with a single ffmpeg.
        # visual-radio + all processed files → concat (0 gaps)
        if [ "$visual_mode" != "video-playlist" ]; then
          local all_processed=true
          for cf in "${SHUFFLED[@]}"; do
            if [[ "$cf" != /visuals/.processed/* ]]; then
              all_processed=false
              break
            fi
          done

          if [ "$all_processed" = true ] && [ ${#SHUFFLED[@]} -gt 0 ]; then
            local concat_file="/tmp/concat_list.txt"
            > "$concat_file"
            local clip_count=${#SHUFFLED[@]}
            # First round — current SHUFFLED (prepared in armed or fresh)
            for cf in "${SHUFFLED[@]}"; do
              echo "file '$cf'" >> "$concat_file"
            done
            # Additional rounds with re-shuffle (seamless, ~10+ min of content)
            local round round_arr
            for round in $(seq 2 20); do
              round_arr=("${ALL_VIDEOS[@]}")
              for ((i=${#round_arr[@]}-1; i>0; i--)); do
                j=$((RANDOM % (i+1)))
                tmp="${round_arr[$i]}"
                round_arr[$i]="${round_arr[$j]}"
                round_arr[$j]="$tmp"
              done
              for cf in "${round_arr[@]}"; do
                echo "file '$cf'" >> "$concat_file"
              done
            done
            local total_clips=$((clip_count * 20))
            echo "[+] Concat: $clip_count clips x 20 rounds = $total_clips (seamless)"
            echo "${SHUFFLED[0]##*/}" > /shared/current_video.txt 2>/dev/null || true
            SHUFFLED=()

            ffmpeg -hide_banner -loglevel error -re \
              -f concat -safe 0 -i "$concat_file" \
              -c:v copy -an \
              -f mpegts - >&3 2>/dev/null &
            wait_or_interrupt $! "$current_mode" "$visual_mode"
            continue
          fi
        fi

        # Fallback: single clip (queue, video-playlist, non-processed)
        RANDOM_FILE="${SHUFFLED[0]}"
        SHUFFLED=("${SHUFFLED[@]:1}")
      fi
    fi

    # Write current video for dashboard
    echo "${RANDOM_FILE##*/}" > /shared/current_video.txt 2>/dev/null || true

    # Playback: video-playlist outputs video+audio, live/visual-radio — video only
    local abr
    abr=$(get_current_audio_bitrate)

    if [[ "$RANDOM_FILE" == /visuals/.processed/* ]]; then
      if [ "$visual_mode" = "video-playlist" ] && [ "$current_mode" = "live" ]; then
        local has_audio
        has_audio=$(ffprobe -v error -select_streams a:0 -show_entries stream=codec_type -of csv=p=0 "$RANDOM_FILE" 2>/dev/null)
        if [ -n "$has_audio" ]; then
          ffmpeg -hide_banner -loglevel error -re -i "$RANDOM_FILE" \
            -c:v copy -c:a aac -b:a "$abr" -ar 48000 -f mpegts - >&3 2>/dev/null &
        else
          ffmpeg -hide_banner -loglevel error -re -i "$RANDOM_FILE" \
            -f lavfi -i anullsrc=r=48000:cl=stereo \
            -c:v copy -c:a aac -b:a 128k -shortest -f mpegts - >&3 2>/dev/null &
        fi
        wait_or_interrupt $! "$current_mode" "$visual_mode"
      else
        ffmpeg -hide_banner -loglevel error -re \
          -i "$RANDOM_FILE" \
          -c:v copy -an \
          -f mpegts - >&3 2>/dev/null &
        wait_or_interrupt $! "$current_mode" "$visual_mode"
      fi
    else
      if [ "$visual_mode" = "video-playlist" ] && [ "$current_mode" = "live" ]; then
        ffmpeg -hide_banner -loglevel error -re \
          -i "$RANDOM_FILE" \
          -vf "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:black,fps=30,format=yuv420p" \
          -c:v mpeg2video -q:v 2 -c:a aac -b:a "$abr" -ar 48000 \
          -f mpegts - >&3 2>/dev/null &
      else
        ffmpeg -hide_banner -loglevel error -re \
          -i "$RANDOM_FILE" \
          -vf "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:black,fps=30,format=yuv420p" \
          -c:v mpeg2video -q:v 2 -an \
          -f mpegts - >&3 2>/dev/null &
      fi
      wait_or_interrupt $! "$current_mode" "$visual_mode"
    fi
  done
}

# Audio feeder: Icecast always connected (gate in Liquidsoap controls silence/music).
# No mbuffer — no silence buffer. On PLAY music starts instantly.
# live+OBS → RTMP audio. video-playlist = idle (audio from video FIFO).
feed_audio() {
  # Redirect echo to stderr (docker logs), keep fd 3 for data pipe
  exec 3>&1 1>&2

  while true; do
    if ! pgrep -f "ffmpeg.*$FIFO" >/dev/null 2>&1; then
      echo "[audio] Main ffmpeg died, exiting"
      exit 0
    fi

    local visual_mode obs_status audio_source
    visual_mode=$(get_visual_mode)

    # Video-playlist: audio comes from video FIFO, not us.
    if [ "$visual_mode" = "video-playlist" ]; then
      sleep 2
      continue
    fi

    # Determine audio source
    audio_source="icecast"
    if [ "$visual_mode" = "live" ]; then
      obs_status=$(get_live_obs_status)
      if [ "$obs_status" = "connected" ]; then
        audio_source="rtmp"
      fi
    fi

    local audio_pid=0

    if [ "$audio_source" = "rtmp" ]; then
      # OBS audio: second subscriber on the same nginx-rtmp stream
      local ingest_key
      ingest_key=$(get_live_ingest_key)
      local rtmp_url="rtmp://rtmp-ingest:1935/ingest/${ingest_key}"
      echo "[audio] OBS RTMP audio subscriber (AAC 256k)"
      ffmpeg -hide_banner -loglevel warning \
        -rw_timeout 5000000 \
        -rtmp_live live \
        -i "$rtmp_url" -vn \
        -c:a aac -b:a 256k -ar 48000 \
        -f mpegts - >&3 2>&2 &
      audio_pid=$!
    else
      # Check Icecast /live availability before connecting (avoid retry spam)
      if ! curl -s --connect-timeout 2 --max-time 3 -o /dev/null -w "%{http_code}" "$ICECAST_URL" 2>/dev/null | grep -q "200"; then
        echo "[audio] Icecast not ready, retry in 2s"
        sleep 2
        continue
      fi
      # Icecast — always connected, gate handles silence/music. No mbuffer = no delay.
      echo "[audio] Icecast AAC passthrough (no mbuffer, gate handles standby/live)"
      ffmpeg -hide_banner -loglevel error \
        -reconnect 1 -reconnect_streamed 1 -reconnect_delay_max 5 \
        -i "$ICECAST_URL" -vn \
        -c:a copy \
        -f mpegts - >&3 2>/dev/null &
      audio_pid=$!
    fi

    local health_counter=0
    local audio_start_time
    audio_start_time=$(date +%s)

    # Monitor: visual mode change, OBS status change, stale connection
    while kill -0 $audio_pid 2>/dev/null; do
      local new_vmode new_obs_status new_source
      new_vmode=$(get_visual_mode)

      # Restart on visual mode change
      if [ "$new_vmode" != "$visual_mode" ]; then
        echo "[audio] Visual mode changed: $visual_mode → $new_vmode"
        kill $audio_pid 2>/dev/null; wait $audio_pid 2>/dev/null; break
      fi

      # In live mode: check if audio source should change
      if [ "$visual_mode" = "live" ]; then
        new_obs_status=$(get_live_obs_status)
        new_source="icecast"
        if [ "$new_obs_status" = "connected" ]; then
          new_source="rtmp"
        fi
        if [ "$new_source" != "$audio_source" ]; then
          echo "[audio] Source switch: $audio_source → $new_source"
          kill $audio_pid 2>/dev/null; wait $audio_pid 2>/dev/null; break
        fi
      fi

      # Every 5s: verify ffmpeg is still alive and connected
      health_counter=$((health_counter + 1))
      if [ $((health_counter % 10)) -eq 0 ]; then
        if ! kill -0 $audio_pid 2>/dev/null; then break; fi
        if [ "$audio_source" = "icecast" ]; then
          if ! ls -la /proc/$audio_pid/fd/ 2>/dev/null | grep -q socket; then
            echo "[audio] ffmpeg lost Icecast connection, restarting"
            kill $audio_pid 2>/dev/null; wait $audio_pid 2>/dev/null; break
          fi
        fi
      fi
      sleep 0.5
    done

    # Backoff on fast ffmpeg crash (Icecast not ready, network error, etc.)
    local audio_elapsed=$(( $(date +%s) - audio_start_time ))
    if [ "$audio_elapsed" -lt 2 ]; then
      echo "[audio] ffmpeg exited too fast (${audio_elapsed}s), backoff 3s"
      sleep 3
    fi
  done
}

mkdir -p "$HLS_DIR"
rm -f "$HLS_DIR"/*
rm -f "$APPLIED_SIG_FILE"

# Reduce OOM score to prefer killing this process if memory runs out
echo 1000 > /proc/self/oom_score_adj 2>/dev/null || true

# Args for ffmpeg progress (if file is set)
PROGRESS_ARGS=""
if [ -n "$FFMPEG_PROGRESS_FILE" ]; then
  PROGRESS_ARGS="-progress $FFMPEG_PROGRESS_FILE -stats_period 2"
fi

file_sig() {
  local file="$1"
  if [ -f "$file" ]; then
    stat -c '%Y%s' "$file" 2>/dev/null || echo "none"
  else
    echo "none"
  fi
}

current_stream_sig() {
  # Mode changes (standby/armed/live) are handled internally by feed_fifo/feed_audio polling (0.5s).
  # stream_mode.json excluded — no main ffmpeg restart needed on mode transitions.
  # stream_control.json excluded — broadcast flag handled by restream_manager, streaming flag by main loop.
  # live_mode.json excluded — obsStatus changes handled by feed_fifo/feed_audio polling, no main ffmpeg restart needed
  echo "keys=$(file_sig /shared/stream_keys.enc);quality=$(file_sig /shared/stream_quality.json);audio=$(file_sig /shared/stream_audio.json);video=$(file_sig /shared/stream_video.json);overlay=$(file_sig /shared/overlay_config.json);visual=$(file_sig /shared/active_visual_profile.json);filter=$(file_sig /shared/overlay_filter_string.txt);vmode=$(file_sig /shared/visual_mode.json)"
}

watch_stream_config() {
  # Grace period: don't touch ffmpeg for the first 10 seconds after start
  sleep 10
  while true; do
    sleep 1

    # Pipeline restart signal (standby -> armed): flush stale mbuffer data
    if [ -f /shared/restart_stream ]; then
      rm -f /shared/restart_stream
      if pgrep -f "$MAIN_FFMPEG_MATCH" >/dev/null 2>&1; then
        echo "[!] Pipeline restart signaled (standby->armed), flushing stale buffer..."
        pkill -TERM -f "$MAIN_FFMPEG_MATCH" 2>/dev/null || true
      fi
      continue
    fi

    [ -f "$APPLIED_SIG_FILE" ] || continue

    if pgrep -f "$MAIN_FFMPEG_MATCH" >/dev/null 2>&1 && ! is_streaming_enabled; then
      echo "$(current_stream_sig)" > "$APPLIED_SIG_FILE"
      echo "[!] Streaming disabled, stopping ffmpeg..."
      pkill -TERM -f "$MAIN_FFMPEG_MATCH" 2>/dev/null || true
      continue
    fi

    local expected_sig current_sig
    expected_sig=$(cat "$APPLIED_SIG_FILE" 2>/dev/null || true)
    [ -n "$expected_sig" ] || continue

    current_sig=$(current_stream_sig)
    if [ "$current_sig" != "$expected_sig" ]; then
      if pgrep -f "$MAIN_FFMPEG_MATCH" >/dev/null 2>&1; then
        echo "$current_sig" > "$APPLIED_SIG_FILE"
        echo "[!] Stream config changed, restarting ffmpeg to apply updates..."
        pkill -TERM -f "$MAIN_FFMPEG_MATCH" 2>/dev/null || true
      fi
    fi
  done
}

# Build ffmpeg outputs for multi-streaming
build_outputs() {
  local quality_json preset vbr abr speed vbr_num vb_buf gop
  
  # Get RTMP URLs first to determine mode
  local rtmp_urls rtmp_mode
  rtmp_urls=$(fetch_rtmp_urls)
  rtmp_mode=$(get_rtmp_mode "$rtmp_urls")
  
  quality_json=$(get_quality_settings)
  preset=$(echo "$quality_json" | grep -o '"preset":"[^"]*"' | cut -d'"' -f4)
  [ -z "$preset" ] && preset="high"
  
  # Auto-switch preset based on RTMP mode
  # Only YouTube -> allow godmode (1440p VP9 force)
  # Multi-platform (YouTube + Kick/Twitch) -> force standard (1080p 8Mbps)
  if [ "$rtmp_mode" = "multi" ] && { [ "$preset" = "godmode" ] || [ "$preset" = "ultra" ]; }; then
    echo "[!] Multi-platform detected, forcing standard preset (1080p 8Mbps)" >&2
    preset="standard"
  elif [ "$rtmp_mode" = "youtube" ] && [ "$preset" = "godmode" ]; then
    echo "[!] YouTube only detected, using godmode (1440p VP9 force)" >&2
  fi
  
  vbr=$(get_video_bitrate "$preset")
  abr=$(get_audio_bitrate "$preset")
  speed=$(get_preset_speed "$preset")
  gop="60"  # Fixed GOP 60 for auto FPS (2 seconds at 30fps typical)
  vbr_num="${vbr%k}"
  vb_buf="$((vbr_num * 2))k"
  
  echo "[+] Quality preset: $preset (video: $vbr, audio: $abr, speed: $speed, gop: $gop) [RTMP mode: $rtmp_mode]" >&2
  
  # Base ffmpeg args (without output)
  local vfilter base_vfilter enhance_vfilter
  base_vfilter=$(build_video_filters)
  enhance_vfilter=$(get_video_enhancement_filter)
  if [ -n "$enhance_vfilter" ]; then
    echo "[+] Video enhancement: ENABLED" >&2
  fi
  vfilter=$(get_video_filter_with_scale "$preset" "$base_vfilter" "$enhance_vfilter")
  echo "[+] Video filter: $vfilter" >&2

  # Audio routing: separate AUDIO_FIFO for live/visual-radio (managed by feed_audio),
  # video FIFO audio for video-playlist (synced with clips in feed_fifo).
  # feed_audio: Icecast always-on (gate handles silence), no mbuffer — NO restart on PLAY/STOP.
  local cur_vmode audio_input audio_map audio_enc logo_start_idx
  cur_vmode=$(get_visual_mode)

  if [ "$cur_vmode" = "video-playlist" ]; then
    audio_input=""
    audio_map="-map 0:a"
    audio_enc="-c:a copy"
    logo_start_idx=1   # inputs: 0=VIDEO_FIFO, 1+=logos
    echo "[+] Audio: from VIDEO FIFO (video-playlist — file audio per-clip)" >&2
  else
    audio_input="-thread_queue_size 4096 -i $AUDIO_FIFO"
    audio_map="-map 1:a"
    audio_enc="-c:a copy"
    logo_start_idx=2   # inputs: 0=VIDEO_FIFO, 1=AUDIO_FIFO, 2+=logos
    echo "[+] Audio: from AUDIO FIFO (Icecast always-on, no mbuffer)" >&2
  fi

  # Check for logo overlay inputs (index depends on whether Icecast is an input)
  local logo_inputs=""
  local logo_overlays=""
  if [ -f "/shared/overlay_compiled.json" ]; then
    local logo_count
    logo_count=$(grep -c '"asset"' /shared/overlay_compiled.json 2>/dev/null | tr -d '[:space:]' || echo "0")
    [ -z "$logo_count" ] && logo_count=0
    if [ "$logo_count" -gt 0 ]; then
      local idx=$logo_start_idx
      while IFS= read -r asset_path; do
        if [ -f "$asset_path" ]; then
          logo_inputs="$logo_inputs -i $asset_path"
          local x y
          x=$(grep -A2 "$asset_path" /shared/overlay_compiled.json | grep -o '"x":"[^"]*"' | head -1 | cut -d'"' -f4)
          y=$(grep -A2 "$asset_path" /shared/overlay_compiled.json | grep -o '"y":"[^"]*"' | head -1 | cut -d'"' -f4)
          [ -z "$x" ] && x="W-w-20"
          [ -z "$y" ] && y="20"
          if [ -z "$logo_overlays" ]; then
            logo_overlays="[0:v][$idx:v]overlay=$x:$y"
          else
            logo_overlays="$logo_overlays;[tmp][$idx:v]overlay=$x:$y"
          fi
          idx=$((idx + 1))
        fi
      done < <(grep -o '"asset":"[^"]*"' /shared/overlay_compiled.json | cut -d'"' -f4)
    fi
  fi

  # Get extra x264 options
  local x264_extras
  x264_extras=$(get_x264_extras "$preset")

  # Hardware accel and video encoder selection
  local hw_accel="${HW_ACCEL:-}"
  local video_encoder video_args hwaccel_args vf_args
  hwaccel_args=""
  vf_args=""

  # Check if software filters are needed (overlays, scaling, enhancements)
  local needs_sw_filters=false
  if [ -n "$vfilter" ] || [ -n "$logo_inputs" ]; then
    needs_sw_filters=true
  fi

  # Build -vf argument from computed filters
  if [ -n "$vfilter" ]; then
    vf_args="-vf $vfilter"
  fi

  local video_enc_args=""
  if [ "$needs_sw_filters" = "true" ]; then
    # Has overlays/filters — full pipeline needed
    if [ "$hw_accel" = "qsv" ]; then
      hwaccel_args="-hwaccel qsv -hwaccel_output_format nv12"
      video_enc_args="$vf_args -c:v h264_qsv -load_plugin hevc_hw -bf 0 -b:v $vbr -minrate $vbr -maxrate $vbr -bufsize $vb_buf -g $gop -keyint_min $gop -sc_threshold 0 -flags +cgop"
      echo "[+] QSV decode → filters → QSV encode ($vbr)" >&2
    else
      video_enc_args="$vf_args -c:v libx264 -preset $speed -profile:v high -bf 0 $x264_extras -b:v $vbr -minrate $vbr -maxrate $vbr -bufsize $vb_buf -g $gop -keyint_min $gop -sc_threshold 0 -flags +cgop"
      echo "[+] Software encode with filters ($vbr)" >&2
    fi
  else
    # COPY MODE: video already stream-ready (CBR, GOP, H.264 High)
    # 0% CPU, 0% GPU — just passing bytes through
    video_enc_args="-c:v copy"
    echo "[+] VIDEO COPY MODE: 0% CPU, 0% GPU (pre-transcoded CBR stream-ready)" >&2
  fi

  local base_args
  base_args="-hide_banner -loglevel error $PROGRESS_ARGS -fflags +genpts+igndts $hwaccel_args -thread_queue_size 10240 -i $FIFO $audio_input $logo_inputs -map 0:v $audio_map $video_enc_args $audio_enc"
  
  # HLS-only output (RTMP handled separately by restream_manager)
  echo "$base_args -f hls -hls_time 1 -hls_list_size 60 -hls_flags delete_segments+omit_endlist -hls_segment_filename ${HLS_DIR}/seg_%03d.ts ${HLS_PLAYLIST}"
}

# Cleanup stale processes and FIFO
cleanup_stream() {
  # Kill by PID files + all their child processes
  if [ -f /tmp/feeder.pid ]; then
    local fpid=$(cat /tmp/feeder.pid)
    kill -9 -$fpid 2>/dev/null || kill -9 $fpid 2>/dev/null || true
    rm -f /tmp/feeder.pid
  fi
  if [ -f /tmp/audio_feeder.pid ]; then
    local apid=$(cat /tmp/audio_feeder.pid)
    kill -9 -$apid 2>/dev/null || kill -9 $apid 2>/dev/null || true
    rm -f /tmp/audio_feeder.pid
  fi
  pkill -9 -f "mbuffer" 2>/dev/null || true
  pkill -9 -f "ffmpeg.*-f mpegts" 2>/dev/null || true
  pkill -9 -f "ffmpeg.*$FIFO" 2>/dev/null || true
  pkill -9 -f "ffmpeg.*-f flv" 2>/dev/null || true
  if [ -f /tmp/restream_manager.pid ]; then
    kill -9 $(cat /tmp/restream_manager.pid) 2>/dev/null || true
    rm -f /tmp/restream_manager.pid
  fi
  sleep 1  # increased from 0.5 — ensure all processes are terminated
  # Recreate FIFO after killing all processes — unblocks stuck writes
  rm -f "$FIFO" "$AUDIO_FIFO"
  mkfifo "$FIFO"
  mkfifo "$AUDIO_FIFO"
  # Flush old HLS segments so player doesn't pick up stale frames
  rm -f "$HLS_DIR"/seg_*.ts "$HLS_PLAYLIST"
}

# Main stream function
stream() {
  local cmd stream_sig feeder_pid rc restream_pid
  if ! is_streaming_enabled; then
    echo "[!] Streaming disabled, skip stream start."
    return 0
  fi

  cleanup_stream

  cmd=$(build_outputs)
  stream_sig=$(current_stream_sig)
  echo "$stream_sig" > "$APPLIED_SIG_FILE"

  # Clean up stderr log for fresh start
  > "$FFMPEG_STDERR_LOG"

  feed_fifo | mbuffer -q -s 128k -m 16M > "$FIFO" &
  feeder_pid=$!
  echo "$feeder_pid" > /tmp/feeder.pid
  echo "[+] Video feeder started with 16M mbuffer (PID: $feeder_pid)"

  feed_audio > "$AUDIO_FIFO" &
  local audio_feeder_pid=$!
  echo "$audio_feeder_pid" > /tmp/audio_feeder.pid
  echo "[+] Audio feeder started (Icecast always-on, no mbuffer) (PID: $audio_feeder_pid)"

  echo "[+] Main ffmpeg PID: $$"

  # Start RTMP restream manager (separate ffmpeg per platform, PID = health)
  restream_manager &
  restream_pid=$!
  echo "$restream_pid" > /tmp/restream_manager.pid

  echo "[+] FFmpeg command: $cmd" >&2
  rc=0
  # Use array-based exec to prevent shell injection
  read -r -a ffmpeg_args <<< "$cmd"
  ffmpeg "${ffmpeg_args[@]}" 2>>"$FFMPEG_STDERR_LOG" || rc=$?

  # Stop restream manager (its trap cleans up child ffmpeg processes)
  kill "$restream_pid" 2>/dev/null || true
  wait "$restream_pid" 2>/dev/null || true
  rm -f /tmp/restream_manager.pid
  pkill -9 -f "ffmpeg.*-f flv" 2>/dev/null || true

  # Set all outputs to offline on exit
  if [ -f "$RTMP_STATUS_FILE" ]; then
    sed -i 's/"status":"live"/"status":"offline"/g;s/"status":"error"/"status":"offline"/g' "$RTMP_STATUS_FILE" 2>/dev/null || true
  fi

  # Force kill feeders and any stale mbuffer/ffmpeg
  if [ -f /tmp/feeder.pid ]; then
    kill -9 $(cat /tmp/feeder.pid) 2>/dev/null || true
    rm -f /tmp/feeder.pid
  fi
  if [ -f /tmp/audio_feeder.pid ]; then
    kill -9 $(cat /tmp/audio_feeder.pid) 2>/dev/null || true
    rm -f /tmp/audio_feeder.pid
  fi
  pkill -9 -f "mbuffer" 2>/dev/null || true
  pkill -9 -f "ffmpeg.*-f mpegts" 2>/dev/null || true

  # Wait for feeder with timeout (3s) to avoid hanging on wait forever
  local _t
  for _t in $(seq 1 6); do
    kill -0 "$feeder_pid" 2>/dev/null || break
    sleep 0.5
  done
  kill -9 "$feeder_pid" 2>/dev/null || true
  wait "$feeder_pid" 2>/dev/null || true

  # Wait for audio feeder with timeout (3s)
  for _t in $(seq 1 6); do
    kill -0 "$audio_feeder_pid" 2>/dev/null || break
    sleep 0.5
  done
  kill -9 "$audio_feeder_pid" 2>/dev/null || true
  wait "$audio_feeder_pid" 2>/dev/null || true

  # Recreate FIFO — unblocks stuck writes
  rm -f "$FIFO" "$AUDIO_FIFO"
  mkfifo "$FIFO"
  mkfifo "$AUDIO_FIFO"

  return $rc
}

# Fetch platform name mapping from dashboard API
# Writes pairs to /tmp/rtmp_platform_map.txt: url<TAB>name
fetch_platform_map() {
  local rtmp_json
  rtmp_json=$(curl -s "${DASHBOARD_API}/api/rtmp-urls" 2>/dev/null || echo "[]")
  > /tmp/rtmp_platform_map.txt
  # Parse {"name":"X","url":"Y"} pairs
  echo "$rtmp_json" | grep -o '{"name":"[^"]*","url":"[^"]*"}' | while IFS= read -r entry; do
    local pname purl
    pname=$(echo "$entry" | grep -o '"name":"[^"]*"' | cut -d'"' -f4)
    purl=$(echo "$entry" | grep -o '"url":"[^"]*"' | cut -d'"' -f4)
    purl=$(echo "$purl" | sed 's/\\\//\//g')
    if [ -n "$pname" ] && [ -n "$purl" ]; then
      printf '%s\t%s\n' "$purl" "$pname" >> /tmp/rtmp_platform_map.txt
    fi
  done
}

# Look up platform name for a given URL
lookup_platform_name() {
  local url="$1"
  local result=""
  if [ -f /tmp/rtmp_platform_map.txt ]; then
    result=$(grep -F "$url" /tmp/rtmp_platform_map.txt 2>/dev/null | head -1 | cut -f2)
  fi
  if [ -z "$result" ]; then
    # Fallback: extract hostname prefix
    result=$(echo "$url" | sed 's|.*://||;s|/.*||;s|\..*||' | head -c 20)
  fi
  echo "$result"
}

# Restream HLS to RTMP platforms via separate ffmpeg processes.
# Process alive = stream alive. Guaranteed, no stderr parsing.
restream_manager() {
  # Wait for HLS playlist to appear
  local wait_count=0
  while [ ! -f "${HLS_PLAYLIST}" ] && [ $wait_count -lt 30 ]; do
    sleep 1
    wait_count=$((wait_count + 1))
  done
  if [ ! -f "${HLS_PLAYLIST}" ]; then
    echo "[restream] HLS playlist not found after 30s, exiting"
    return
  fi

  fetch_platform_map

  # Retry fetching RTMP URLs — dashboard may not be ready yet
  local rtmp_urls="" url_wait=0
  while [ $url_wait -lt 60 ]; do
    rtmp_urls=$(fetch_rtmp_urls)
    if [ "$rtmp_urls" != "[]" ] && [ -n "$rtmp_urls" ]; then
      break
    fi
    if [ $url_wait -eq 0 ]; then
      echo "[restream] Waiting for RTMP URLs from dashboard..."
    fi
    sleep 3
    url_wait=$((url_wait + 3))
  done
  if [ "$rtmp_urls" = "[]" ] || [ -z "$rtmp_urls" ]; then
    echo "[restream] No RTMP URLs configured after 60s, manager idle"
    return
  fi

  # Parse URLs and names into arrays
  local -a url_list name_list ff_pid last_start
  local idx=0
  local urls
  urls=$(echo "$rtmp_urls" | grep -o '"url":"[^"]*"' | sed 's/"url":"//;s/"$//')
  for url in $urls; do
    url=$(echo "$url" | sed 's/\\\//\//g')
    if [ -n "$url" ]; then
      url_list[$idx]="$url"
      name_list[$idx]=$(lookup_platform_name "$url")
      ff_pid[$idx]=0
      last_start[$idx]=0
      idx=$((idx + 1))
    fi
  done

  if [ ${#url_list[@]} -eq 0 ]; then
    echo "[restream] No valid RTMP URLs, manager idle"
    return
  fi

  # Cleanup all child ffmpeg on exit
  cleanup_restreams() {
    for pid in "${ff_pid[@]}"; do
      [ "$pid" -ne 0 ] && kill "$pid" 2>/dev/null || true
    done
    wait 2>/dev/null || true
  }
  trap cleanup_restreams EXIT TERM INT

  echo "[restream] Managing ${#url_list[@]} platform(s)"

  # Monitor loop: start/restart ffmpeg per platform, write status
  # Respects broadcast flag — only streams when broadcast=true
  while true; do
    local now broadcast_on
    now=$(date +%s)
    broadcast_on=$(get_broadcast_enabled)

    if [ "$broadcast_on" = "false" ]; then
      # Kill all RTMP processes when broadcast is off
      for ((i=0; i<${#url_list[@]}; i++)); do
        if [ "${ff_pid[$i]}" -ne 0 ] && kill -0 "${ff_pid[$i]}" 2>/dev/null; then
          echo "[restream] ${name_list[$i]}: broadcast off, stopping"
          kill "${ff_pid[$i]}" 2>/dev/null || true
          wait "${ff_pid[$i]}" 2>/dev/null || true
          ff_pid[$i]=0
        fi
      done
      # Write offline status
      local json
      json='{"outputs":{'
      for ((i=0; i<${#url_list[@]}; i++)); do
        [ $i -gt 0 ] && json="${json},"
        json="${json}\"$(json_escape_value "${name_list[$i]}")\":{\"url\":\"$(json_escape_value "${url_list[$i]}")\",\"status\":\"offline\",\"error\":null,\"ts\":$now}"
      done
      json="${json}},\"ts\":$now}"
      echo "$json" > "$RTMP_STATUS_FILE"
      sleep 2
      continue
    fi

    for ((i=0; i<${#url_list[@]}; i++)); do
      # Check if ffmpeg is running for this platform
      if [ "${ff_pid[$i]}" -eq 0 ] || ! kill -0 "${ff_pid[$i]}" 2>/dev/null; then
        # Reap zombie
        [ "${ff_pid[$i]}" -ne 0 ] && wait "${ff_pid[$i]}" 2>/dev/null || true

        # Cooldown: don't restart faster than every 5s
        local elapsed=$((now - ${last_start[$i]}))
        if [ "$elapsed" -lt 5 ]; then
          continue
        fi

        [ "${ff_pid[$i]}" -ne 0 ] && echo "[restream] ${name_list[$i]}: disconnected, restarting..."

        ffmpeg -hide_banner -loglevel error \
          -rw_timeout 5000000 \
          -live_start_index -3 \
          -i "${HLS_PLAYLIST}" \
          -c copy -f flv "${url_list[$i]}" 2>/dev/null &
        ff_pid[$i]=$!
        last_start[$i]=$now
        echo "[restream] ${name_list[$i]}: started (PID ${ff_pid[$i]})"
      fi
    done

    # Write rtmp_status.json based on PID liveness
    local json
    json='{"outputs":{'
    for ((i=0; i<${#url_list[@]}; i++)); do
      [ $i -gt 0 ] && json="${json},"
      local status="error"
      if kill -0 "${ff_pid[$i]}" 2>/dev/null; then
        status="live"
      fi
      json="${json}\"$(json_escape_value "${name_list[$i]}")\":{\"url\":\"$(json_escape_value "${url_list[$i]}")\",\"status\":\"${status}\",\"error\":null,\"ts\":$(date +%s)}"
    done
    json="${json}},\"ts\":$(date +%s)}"
    echo "$json" > "$RTMP_STATUS_FILE"

    sleep 2
  done
}

watch_stream_config &

while true; do
  if is_streaming_enabled; then
    stream || true
  else
    echo "[!] Streaming disabled, waiting..."
    sleep 1
    continue
  fi
  echo "[!] Restarting in 1s..."
  sleep 1
done
