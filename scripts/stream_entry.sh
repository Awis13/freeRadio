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
APPLIED_SIG_FILE="/tmp/applied_stream_sig.txt"
MAIN_FFMPEG_MATCH="/tmp/videofifo.ts"
FFMPEG_STDERR_LOG="/tmp/ffmpeg_stderr.log"
RTMP_STATUS_FILE="/shared/rtmp_status.json"

# Fetch RTMP URLs from dashboard API (for multi-streaming)
fetch_rtmp_urls() {
  curl -s "${DASHBOARD_API}/api/rtmp-urls" 2>/dev/null || echo "[]"
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

# Check if streaming is enabled
is_streaming_enabled() {
  local control_file="/shared/stream_control.json"
  if [ -f "$control_file" ]; then
    if grep -qE '"streaming"[[:space:]]*:[[:space:]]*true' "$control_file"; then
      return 0
    fi
    if grep -qE '"streaming"[[:space:]]*:[[:space:]]*false' "$control_file"; then
      return 1
    fi
    # Unknown/partial content should not block stream start.
    return 0
  fi
  # Missing control file defaults to enabled.
  return 0
}

# Get stream mode (standby or live)
get_stream_mode() {
  local mode_file="/shared/stream_mode.json"
  if [ -f "$mode_file" ]; then
    local mode
    mode=$(grep -o '"mode":"[^"]*"' "$mode_file" 2>/dev/null | cut -d'"' -f4)
    if [ "$mode" = "live" ]; then
      echo "live"
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

# Get visual mode (radio, visual-radio, video-playlist)
get_visual_mode() {
  local mode_file="/shared/visual_mode.json"
  if [ -f "$mode_file" ]; then
    local mode
    mode=$(grep -o '"mode":"[^"]*"' "$mode_file" 2>/dev/null | cut -d'"' -f4)
    case "$mode" in
      radio|video-playlist) echo "$mode" ;;
      *) echo "visual-radio" ;;
    esac
  else
    echo "visual-radio"
  fi
}

# Get radio visual file path (for radio mode — single looping visual)
get_radio_visual() {
  local mode_file="/shared/visual_mode.json"
  local visual_name=""
  if [ -f "$mode_file" ]; then
    visual_name=$(grep -o '"radioVisual":"[^"]*"' "$mode_file" 2>/dev/null | cut -d'"' -f4)
  fi
  if [ -n "$visual_name" ] && [ -f "/visuals/.processed/$visual_name" ]; then
    echo "/visuals/.processed/$visual_name"
    return
  fi
  # Fallback: first file in .processed/
  find /visuals/.processed -type f \( -name "*.mp4" -o -name "*.mov" -o -name "*.mkv" \) 2>/dev/null | head -1
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

# Pre-transcoded standby file (TV static noise, QSV H.264 CBR 6Mbps, same format as .processed/)
# Generated once: ffmpeg -f lavfi ... -c:v h264_qsv ... /visuals/.processed/_standby_static.mp4
STANDBY_FILE="/visuals/.processed/_standby_static.mp4"

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

# Создаем FIFO
[ -p "$FIFO" ] || mkfifo "$FIFO"

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
  # Нет дефолтных фильтров — пре-транскодированный контент готов к отдаче
}

# Wait for background ffmpeg, kill immediately on mode/visual-mode change or video skip.
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
      kill $ffpid 2>/dev/null; wait $ffpid 2>/dev/null
      echo "[+] Interrupted: $start_mode/$start_vmode → $m/$vm"
      return 0
    fi
    sleep 0.5
  done
  wait $ffpid 2>/dev/null || true
}

# Mode-aware feed_fifo: all playback runs in background with mode-change polling.
# Mode switches kill current clip instantly → next iteration picks new content within 0.5s.
feed_fifo() {
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

    # Логируем смену режима
    if [ "$current_mode" != "$prev_mode" ] || [ "$visual_mode" != "$prev_vmode" ]; then
      echo "[+] Mode: ${prev_mode:-init}/${prev_vmode:-init} → $current_mode/$visual_mode"
      if [ "$current_mode" = "live" ] && [ "$prev_mode" = "standby" ]; then
        SHUFFLED=()
        echo "[+] Shuffle reset for fresh start"
      fi
      prev_mode="$current_mode"
      prev_vmode="$visual_mode"
    fi

    # Определяем следующий файл
    local RANDOM_FILE=""

    if [ "$current_mode" = "standby" ]; then
      # Standby: pre-transcoded TV static with baked-in noise audio — real-time, 0% CPU (copy mode)
      ffmpeg -hide_banner -loglevel error -re \
        -i "$STANDBY_FILE" \
        -c:v copy -c:a copy \
        -f mpegts - 2>/dev/null &
      wait_or_interrupt $! "$current_mode" "$visual_mode"
      continue
    elif [ "$visual_mode" = "radio" ]; then
      # Radio: один визуал в цикле (как standby, но в live)
      RANDOM_FILE=$(get_radio_visual)
      if [ -z "$RANDOM_FILE" ] || [ ! -f "$RANDOM_FILE" ]; then
        echo "[!] No radio visual found, skipping"
        sleep 2
        continue
      fi
    else
      # Visual Radio / Video Playlist: ротация из shuffle
      # В video-playlist режиме сначала проверяем очередь
      local queued_file=""
      if [ "$visual_mode" = "video-playlist" ] && [ -f /shared/video_queue.txt ]; then
        queued_file=$(head -1 /shared/video_queue.txt 2>/dev/null | tr -d '\r')
        if [ -n "$queued_file" ]; then
          # Удаляем первую строку из очереди (atomic: sed + tmp)
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

      # Если не из очереди — shuffle
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

          echo "[+] Новый раунд видео: ${#SHUFFLED[@]} клипов"
        fi

        RANDOM_FILE="${SHUFFLED[0]}"
        SHUFFLED=("${SHUFFLED[@]:1}")
      fi
    fi

    # Записываем текущее видео для дашборда
    echo "${RANDOM_FILE##*/}" > /shared/current_video.txt 2>/dev/null || true

    # Воспроизведение: все режимы выдают video+audio MPEG-TS
    # Все ffmpeg запускаются в фоне + wait_or_interrupt для мгновенного переключения режима
    local abr
    abr=$(get_current_audio_bitrate)

    if [[ "$RANDOM_FILE" == /visuals/.processed/* ]]; then
      if [ "$visual_mode" = "video-playlist" ] && [ "$current_mode" = "live" ]; then
        # Video Playlist: аудио из файла + поддержка skip
        local has_audio
        has_audio=$(ffprobe -v error -select_streams a:0 -show_entries stream=codec_type -of csv=p=0 "$RANDOM_FILE" 2>/dev/null)
        if [ -n "$has_audio" ]; then
          ffmpeg -hide_banner -loglevel error -re -i "$RANDOM_FILE" \
            -c:v copy -c:a aac -b:a "$abr" -ar 48000 -f mpegts - 2>/dev/null &
        else
          ffmpeg -hide_banner -loglevel error -re -i "$RANDOM_FILE" \
            -f lavfi -i anullsrc=r=48000:cl=stereo \
            -c:v copy -c:a aac -b:a 128k -shortest -f mpegts - 2>/dev/null &
        fi
        wait_or_interrupt $! "$current_mode" "$visual_mode"
      else
        # Radio / Visual Radio: видео из файла + аудио из Icecast
        ffmpeg -hide_banner -loglevel error -re \
          -i "$RANDOM_FILE" \
          -reconnect 1 -reconnect_streamed 1 -reconnect_delay_max 2 \
          -i "$ICECAST_URL" \
          -map 0:v -map 1:a -c:v copy -c:a aac -b:a "$abr" -ar 48000 \
          -shortest -f mpegts - 2>/dev/null &
        wait_or_interrupt $! "$current_mode" "$visual_mode"
      fi
    else
      # Non-processed file: transcode video + Icecast audio
      ffmpeg -hide_banner -loglevel error -re \
        -i "$RANDOM_FILE" \
        -reconnect 1 -reconnect_streamed 1 -reconnect_delay_max 2 \
        -i "$ICECAST_URL" \
        -map 0:v -map 1:a \
        -vf "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:black,fps=30,format=yuv420p" \
        -c:v mpeg2video -q:v 2 -c:a aac -b:a "$abr" -ar 48000 \
        -shortest -f mpegts - 2>/dev/null &
      wait_or_interrupt $! "$current_mode" "$visual_mode"
    fi
  done
}

mkdir -p "$HLS_DIR"
rm -f "$HLS_DIR"/*
rm -f "$APPLIED_SIG_FILE"

# Reduce OOM score to prefer killing this process if memory runs out
echo 1000 > /proc/self/oom_score_adj 2>/dev/null || true

# Аргументы для ffmpeg progress (если задан файл)
PROGRESS_ARGS=""
if [ -n "$FFMPEG_PROGRESS_FILE" ]; then
  PROGRESS_ARGS="-progress $FFMPEG_PROGRESS_FILE -stats_period 2"
fi

file_sig() {
  local file="$1"
  if [ -f "$file" ]; then
    cksum "$file" | awk '{print $1 ":" $2}'
  else
    echo "none"
  fi
}

current_stream_sig() {
  # Visual mode switches no longer restart main ffmpeg — feed_fifo handles all modes.
  # Only overlay/quality/key/control changes trigger restart.
  echo "keys=$(file_sig /shared/stream_keys.enc);quality=$(file_sig /shared/stream_quality.json);audio=$(file_sig /shared/stream_audio.json);video=$(file_sig /shared/stream_video.json);control=$(file_sig /shared/stream_control.json);overlay=$(file_sig /shared/overlay_config.json);visual=$(file_sig /shared/active_visual_profile.json);filter=$(file_sig /shared/overlay_filter_string.txt)"
}

watch_stream_config() {
  while true; do
    sleep 1
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

  # Check for logo overlay inputs
  local logo_inputs=""
  local logo_overlays=""
  if [ -f "/shared/overlay_compiled.json" ]; then
    local logo_count
    logo_count=$(grep -c '"asset"' /shared/overlay_compiled.json 2>/dev/null | tr -d '[:space:]' || echo "0")
    [ -z "$logo_count" ] && logo_count=0
    if [ "$logo_count" -gt 0 ]; then
      local idx=1  # input 0=FIFO (video+audio), logos start at 1
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
  
  # Get extra x264 options
  local hw_accel="${HW_ACCEL:-}"
  local video_encoder video_args hwaccel_args vf_args
  hwaccel_args=""
  vf_args=""

  # Определяем нужны ли софтварные фильтры (оверлеи, скейлинг, улучшения)
  local needs_sw_filters=false
  if [ -n "$vfilter" ] || [ -n "$logo_inputs" ]; then
    needs_sw_filters=true
  fi

  local video_enc_args=""
  if [ "$needs_sw_filters" = "true" ]; then
    # Есть оверлеи/фильтры — нужен полный пайплайн
    if [ "$hw_accel" = "qsv" ]; then
      hwaccel_args="-hwaccel qsv -hwaccel_output_format nv12"
      video_enc_args="$vf_args -c:v h264_qsv -load_plugin hevc_hw -b:v $vbr -minrate $vbr -maxrate $vbr -bufsize $vb_buf -g $gop -keyint_min $gop -sc_threshold 0 -flags +cgop"
      echo "[+] QSV decode → filters → QSV encode ($vbr)" >&2
    else
      video_enc_args="$vf_args -c:v libx264 -preset $speed -profile:v high $x264_extras -b:v $vbr -minrate $vbr -maxrate $vbr -bufsize $vb_buf -g $gop -keyint_min $gop -sc_threshold 0 -flags +cgop"
      echo "[+] Software encode with filters ($vbr)" >&2
    fi
  else
    # COPY MODE: видео уже готово к стримингу (CBR, GOP, H.264 High)
    # 0% CPU, 0% GPU — просто перекладываем байты
    # -tag:v 7 нужен т.к. MPEG-TS FIFO передаёт codec tag 0x1b, а FLV/RTMP ожидает 7 (H.264)
    video_enc_args="-c:v copy -tag:v 7"
    echo "[+] VIDEO COPY MODE: 0% CPU, 0% GPU (pre-transcoded CBR stream-ready)" >&2
  fi

  # Unified: FIFO always contains both video+audio (feed_fifo handles all modes)
  echo "[+] Audio: from FIFO (unified — feed_fifo encodes per-clip)" >&2
  local base_args
  base_args="-hide_banner -loglevel error $PROGRESS_ARGS -fflags +genpts+igndts $hwaccel_args -thread_queue_size 10240 -i $FIFO $logo_inputs -map 0:v -map 0:a $video_enc_args -c:a copy"
  
  # Always build tee outputs (HLS + all RTMPs)
  local outputs="[f=hls:hls_time=1:hls_list_size=20:hls_flags=delete_segments+omit_endlist+split_by_time:hls_segment_filename=${HLS_DIR}/seg_%03d.ts]${HLS_PLAYLIST}"
  
  if [ "$rtmp_urls" != "[]" ] && [ -n "$rtmp_urls" ]; then
    local urls
    urls=$(echo "$rtmp_urls" | grep -o '"url":"[^"]*"' | sed 's/"url":"//;s/"$//')
    for url in $urls; do
      url=$(echo "$url" | sed 's/\\\//\//g')
      if [ -n "$url" ]; then
        outputs="${outputs}|[f=flv:onfail=ignore]${url}"
        echo "[+] Adding RTMP output: ${url}" >&2
      fi
    done
  fi
  
  echo "$base_args -f tee \"$outputs\" "
}

# Cleanup stale processes and FIFO
cleanup_stream() {
  # Kill by PID file first
  if [ -f /tmp/feeder.pid ]; then
    kill -9 $(cat /tmp/feeder.pid) 2>/dev/null || true
    rm -f /tmp/feeder.pid
  fi
  pkill -9 -f "mbuffer" 2>/dev/null || true
  pkill -9 -f "ffmpeg.*-f mpegts" 2>/dev/null || true
  pkill -9 -f "ffmpeg.*$FIFO" 2>/dev/null || true
  sleep 0.5
  [ -p "$FIFO" ] && rm -f "$FIFO" && mkfifo "$FIFO"
}

# Main stream function
stream() {
  local cmd stream_sig feeder_pid rc health_pid
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

  feed_fifo | mbuffer -q -s 128k -m 256M > "$FIFO" &
  feeder_pid=$!
  echo "$feeder_pid" > /tmp/feeder.pid
  echo "[+] Feeder started with 256M mbuffer (PID: $feeder_pid)"
  echo "[+] Main ffmpeg PID: $$"

  # Start RTMP health monitor in background
  monitor_rtmp_health &
  health_pid=$!

  echo "[+] FFmpeg command: $cmd" >&2
  rc=0
  eval "ffmpeg $cmd 2>>$FFMPEG_STDERR_LOG" || rc=$?

  # Stop health monitor
  kill "$health_pid" 2>/dev/null || true
  wait "$health_pid" 2>/dev/null || true

  # Set all outputs to offline on exit
  if [ -f "$RTMP_STATUS_FILE" ]; then
    sed -i 's/"status":"live"/"status":"offline"/g;s/"status":"error"/"status":"offline"/g' "$RTMP_STATUS_FILE" 2>/dev/null || true
  fi

  # Force kill feeder and any stale mbuffer/ffmpeg
  if [ -f /tmp/feeder.pid ]; then
    kill -9 $(cat /tmp/feeder.pid) 2>/dev/null || true
    rm -f /tmp/feeder.pid
  fi
  pkill -9 -f "mbuffer" 2>/dev/null || true
  pkill -9 -f "ffmpeg.*-f mpegts" 2>/dev/null || true
  wait "$feeder_pid" 2>/dev/null || true

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

# Monitor RTMP health by watching FFmpeg stderr
monitor_rtmp_health() {
  local platform_map rtmp_urls
  sleep 5  # Wait for FFmpeg to start

  # Get platform name mapping
  fetch_platform_map

  # Get active RTMP URLs
  rtmp_urls=$(fetch_rtmp_urls)
  if [ "$rtmp_urls" = "[]" ] || [ -z "$rtmp_urls" ]; then
    echo "[rtmp-health] No RTMP URLs configured, monitor idle"
    return
  fi

  local urls
  urls=$(echo "$rtmp_urls" | grep -o '"url":"[^"]*"' | sed 's/"url":"//;s/"$//')

  echo "[rtmp-health] Monitoring started"

  # Build reusable arrays of url->name mappings
  local -a url_list name_list
  local idx=0
  for url in $urls; do
    url=$(echo "$url" | sed 's/\\\//\//g')
    url_list[$idx]="$url"
    name_list[$idx]=$(lookup_platform_name "$url")
    idx=$((idx + 1))
  done

  # Initialize status file with all platforms as live
  local json i
  json='{"outputs":{'
  for ((i=0; i<${#url_list[@]}; i++)); do
    [ $i -gt 0 ] && json="${json},"
    json="${json}\"${name_list[$i]}\":{\"url\":\"${url_list[$i]}\",\"status\":\"live\",\"error\":null,\"ts\":$(date +%s)}"
  done
  json="${json}},\"ts\":$(date +%s)}"
  echo "$json" > "$RTMP_STATUS_FILE"

  # Monitor loop: check stderr for errors every 2 seconds
  while true; do
    sleep 2

    # Check if main ffmpeg is running
    if ! pgrep -f "$MAIN_FFMPEG_MATCH" >/dev/null 2>&1; then
      json='{"outputs":{'
      for ((i=0; i<${#url_list[@]}; i++)); do
        [ $i -gt 0 ] && json="${json},"
        json="${json}\"${name_list[$i]}\":{\"url\":\"${url_list[$i]}\",\"status\":\"offline\",\"error\":null,\"ts\":$(date +%s)}"
      done
      json="${json}},\"ts\":$(date +%s)}"
      echo "$json" > "$RTMP_STATUS_FILE"
      continue
    fi

    # Check stderr for recent errors
    if [ ! -f "$FFMPEG_STDERR_LOG" ]; then
      continue
    fi

    json='{"outputs":{'
    for ((i=0; i<${#url_list[@]}; i++)); do
      [ $i -gt 0 ] && json="${json},"

      local url_host error_msg status recent_errors
      url_host=$(echo "${url_list[$i]}" | sed 's|.*://||;s|/.*||')
      recent_errors=$(tail -50 "$FFMPEG_STDERR_LOG" 2>/dev/null | grep -i "$url_host\|tee\|output" | grep -io "broken pipe\|connection refused\|connection reset\|failed to write\|error writing\|i/o error\|no route to host\|network is unreachable" | tail -1)

      status="live"
      error_msg=""
      if [ -n "$recent_errors" ]; then
        status="error"
        error_msg="$recent_errors"
      fi

      if [ -n "$error_msg" ]; then
        json="${json}\"${name_list[$i]}\":{\"url\":\"${url_list[$i]}\",\"status\":\"${status}\",\"error\":\"${error_msg}\",\"ts\":$(date +%s)}"
      else
        json="${json}\"${name_list[$i]}\":{\"url\":\"${url_list[$i]}\",\"status\":\"${status}\",\"error\":null,\"ts\":$(date +%s)}"
      fi
    done
    json="${json}},\"ts\":$(date +%s)}"
    echo "$json" > "$RTMP_STATUS_FILE"

    # Truncate stderr log if it gets too large (keep last 200 lines)
    local line_count
    line_count=$(wc -l < "$FFMPEG_STDERR_LOG" 2>/dev/null || echo "0")
    if [ "$line_count" -gt 500 ]; then
      tail -200 "$FFMPEG_STDERR_LOG" > "${FFMPEG_STDERR_LOG}.tmp" && mv "${FFMPEG_STDERR_LOG}.tmp" "$FFMPEG_STDERR_LOG"
    fi
  done
}

watch_stream_config &

while true; do
  if is_streaming_enabled; then
    stream || true
  else
    echo "[!] Streaming disabled, waiting..."
    sleep 5
    continue
  fi
  echo "[!] Restarting in 1s..."
  sleep 1
done
