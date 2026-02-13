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
MAIN_FFMPEG_MATCH="/tmp/videofifo.ts -i http://icecast:8000/live"

# Fetch RTMP URLs from dashboard API (for multi-streaming)
fetch_rtmp_urls() {
  curl -s "${DASHBOARD_API}/api/rtmp-urls" 2>/dev/null || echo "[]"
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

# Fetch quality settings from file
get_quality_settings() {
  local quality_file="/shared/stream_quality.json"
  if [ -f "$quality_file" ]; then
    cat "$quality_file"
  else
    echo '{"preset":"high"}'
  fi
}

# Get video bitrate based on preset
get_video_bitrate() {
  local preset="$1"
  case "$preset" in
    low) echo "2000k" ;;
    medium) echo "4000k" ;;
    *) echo "8000k" ;;  # high default
  esac
}

# Get audio bitrate based on preset
get_audio_bitrate() {
  local preset="$1"
  case "$preset" in
    low) echo "128k" ;;
    medium) echo "192k" ;;
    *) echo "256k" ;;  # high default
  esac
}

# Get preset speed
get_preset_speed() {
  local preset="$1"
  case "$preset" in
    *) echo "veryfast" ;;
  esac
}

echo "[*] Waiting for icecast..."
sleep 5
echo "[+] Go!"

# Создаем FIFO
[ -p "$FIFO" ] || mkfifo "$FIFO"

# Функция: честный shuffle — каждое видео играет ровно раз за раунд
feed_fifo() {
  declare -a SHUFFLED
  SHUFFLED=()

  while true; do
    # Раунд закончился или первый запуск — пересканировать и перемешать
    if [ ${#SHUFFLED[@]} -eq 0 ]; then
      mapfile -t ALL_VIDEOS < <(find /visuals -type f \( -name "*.mp4" -o -name "*.mov" -o -name "*.mkv" \) 2>/dev/null)

      if [ ${#ALL_VIDEOS[@]} -eq 0 ]; then
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

    # Берём следующий клип из перемешанного списка
    RANDOM_FILE="${SHUFFLED[0]}"
    SHUFFLED=("${SHUFFLED[@]:1}")

    # Пишем в FIFO: H.264 с Annex-B format для YouTube
    ffmpeg -hide_banner -loglevel error -re -i "$RANDOM_FILE" \
      -vf "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:black,fps=30" \
      -c:v libx264 -preset ultrafast -tune zerolatency -x264-params "repeat-headers=1:keyint=30" -b:v 8M -maxrate 8M -bufsize 16M \
      -pix_fmt yuv420p -bsf:v h264_mp4toannexb -f mpegts - 2>/dev/null || true
  done
}

mkdir -p "$HLS_DIR"
rm -f "$HLS_DIR"/*
rm -f "$APPLIED_SIG_FILE"

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
  echo "keys=$(file_sig /shared/stream_keys.enc);quality=$(file_sig /shared/stream_quality.json);control=$(file_sig /shared/stream_control.json)"
}

watch_stream_config() {
  while true; do
    sleep 2
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
  local quality_json preset vbr abr speed vbr_num vb_buf
  
  quality_json=$(get_quality_settings)
  preset=$(echo "$quality_json" | grep -o '"preset":"[^"]*"' | cut -d'"' -f4)
  [ -z "$preset" ] && preset="high"
  
  vbr=$(get_video_bitrate "$preset")
  abr=$(get_audio_bitrate "$preset")
  speed=$(get_preset_speed "$preset")
  vbr_num="${vbr%k}"
  vb_buf="$((vbr_num * 2))k"
  
  echo "[+] Quality preset: $preset (video: $vbr, audio: $abr, speed: $speed)" >&2
  
  # Base ffmpeg args (without output)
  local base_args="-hide_banner -loglevel error $PROGRESS_ARGS -fflags +genpts+igndts -i $FIFO -i $ICECAST_URL -map 0:v -map 1:a -vf fps=30,format=yuv420p -c:v libx264 -preset $speed -profile:v high -b:v $vbr -minrate $vbr -maxrate $vbr -bufsize $vb_buf -g 60 -keyint_min 60 -sc_threshold 0 -c:a aac -b:a $abr -ar 48000"
  
  # Get RTMP URLs
  local rtmp_urls
  rtmp_urls=$(fetch_rtmp_urls)
  
  # Always build tee outputs (HLS + all RTMPs)
  local outputs="[f=hls:hls_time=2:hls_list_size=15:hls_flags=delete_segments+omit_endlist+split_by_time:hls_segment_filename=${HLS_DIR}/seg_%03d.ts]${HLS_PLAYLIST}"
  
  if [ "$rtmp_urls" != "[]" ] && [ -n "$rtmp_urls" ]; then
    local urls
    urls=$(echo "$rtmp_urls" | grep -o '"url":"[^"]*"' | sed 's/"url":"//;s/"$//')
    for url in $urls; do
      url=$(echo "$url" | sed 's/\\\//\//g')
      if [ -n "$url" ]; then
        outputs="${outputs}|[f=flv]${url}"
        echo "[+] Adding RTMP output: ${url}" >&2
      fi
    done
  fi
  
  echo "$base_args -f tee \"$outputs\""
}

# Main stream function
stream() {
  local cmd stream_sig feeder_pid rc
  if ! is_streaming_enabled; then
    echo "[!] Streaming disabled, skip stream start."
    return 0
  fi

  cmd=$(build_outputs)
  stream_sig=$(current_stream_sig)
  echo "$stream_sig" > "$APPLIED_SIG_FILE"

  feed_fifo > "$FIFO" &
  feeder_pid=$!
  echo "[+] Feeder started (PID: $feeder_pid)"

  echo "[+] FFmpeg command: $cmd" >&2
  rc=0
  eval "ffmpeg $cmd" || rc=$?

  kill "$feeder_pid" 2>/dev/null || true
  wait "$feeder_pid" 2>/dev/null || true

  return $rc
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
