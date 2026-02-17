#!/bin/bash

WATCH_DIR="/visuals"
OUTPUT_DIR="/visuals/.processed"
LOG_FILE="/var/log/transcoder.log"
MAX_PARALLEL=3

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a "$LOG_FILE"
}

get_video_duration() {
    ffprobe -v error -show_entries format=duration -of csv=p=0 "$1" 2>/dev/null | cut -d. -f1
}

transcode_video() {
    local input_file="$1"
    local filename=$(basename "$input_file")
    local basename="${filename%.*}"
    local output_file="${OUTPUT_DIR}/${basename}.mp4"
    local tmp_file="${OUTPUT_DIR}/.transcoding_${basename}.mp4"

    log "Transcoding: $filename"

    local duration
    duration=$(get_video_duration "$input_file")
    log "  Duration: ${duration}s"

    # Определяем FPS исходника и считаем GOP (2 секунды keyframes)
    local src_fps
    src_fps=$(ffprobe -v error -select_streams v:0 -show_entries stream=r_frame_rate -of csv=p=0 "$input_file" 2>/dev/null | head -1)
    local fps_num=${src_fps%/*}
    [ -z "$fps_num" ] || [ "$fps_num" -eq 0 ] 2>/dev/null && fps_num=24
    local gop_size=$((fps_num * 2))
    log "  Source: ${fps_num}fps, GOP: ${gop_size} (2s keyframes)"

    # Streaming-ready: нативный FPS, CBR 6Mbps, H.264 High
    # Выход готов к -c:v copy в стримере (0% CPU/GPU на вещание)
    if ffmpeg -y -hide_banner -loglevel error \
        -hwaccel qsv -hwaccel_output_format nv12 \
        -i "$input_file" \
        -vf "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:black,format=nv12" \
        -c:v h264_qsv -profile:v high -bf 0 \
        -b:v 6000k -maxrate 6000k -minrate 6000k -bufsize 12000k \
        -g $gop_size -keyint_min $gop_size -sc_threshold 0 -flags +cgop \
        -an \
        -movflags +faststart \
        "$tmp_file" 2>> "$LOG_FILE"; then
        mv "$tmp_file" "$output_file"
        log "  Done (QSV CBR 6M ${fps_num}fps): $output_file"
    # Fallback: software encode
    elif ffmpeg -y -hide_banner -loglevel error \
        -i "$input_file" \
        -vf "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:black,format=yuv420p" \
        -c:v libx264 -profile:v high -preset veryfast -bf 0 \
        -b:v 6000k -maxrate 6000k -minrate 6000k -bufsize 12000k \
        -g $gop_size -keyint_min $gop_size -sc_threshold 0 -flags +cgop \
        -an \
        -movflags +faststart \
        "$tmp_file" 2>> "$LOG_FILE"; then
        mv "$tmp_file" "$output_file"
        log "  Done (software CBR 6M ${fps_num}fps): $output_file"
    else
        log "  ERROR: Failed to transcode $filename"
        rm -f "$tmp_file"
    fi
}

mkdir -p "$OUTPUT_DIR"
mkdir -p "$(dirname $LOG_FILE)"

# Чистим недоделанные транскоды от предыдущих запусков
rm -f "${OUTPUT_DIR}"/.transcoding_*

log "Transcoder started (max $MAX_PARALLEL parallel). Watching: $WATCH_DIR"

while true; do
    for file in "$WATCH_DIR"/*.mp4 "$WATCH_DIR"/*.mov "$WATCH_DIR"/*.mkv; do
        [ -f "$file" ] || continue

        filename=$(basename "$file")
        basename="${filename%.*}"
        output_file="${OUTPUT_DIR}/${basename}.mp4"

        [[ "$filename" == .* ]] && continue
        [[ "$filename" == *.part ]] && continue
        [[ "$filename" == *.tmp ]] && continue

        # Уже обработан
        [ -f "$output_file" ] && continue

        # Файл ещё пишется (< 10MB)
        size=$(stat -c%s "$file" 2>/dev/null || echo 0)
        [ "$size" -lt 10000000 ] && continue

        # Ждём свободный слот
        while [ $(jobs -rp | wc -l) -ge $MAX_PARALLEL ]; do
            sleep 2
        done

        log "Found new file: $filename"
        transcode_video "$file" &
    done

    # Ждём завершения текущих задач
    wait
    sleep 30
done
