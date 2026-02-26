#!/bin/bash

WATCH_DIR="/visuals"
OUTPUT_DIR="/visuals/.processed"
MUSIC_DIR="/music"
MUSIC_OUTPUT_DIR="/music/processed"
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
    local gop_size=$((fps_num * 1))
    log "  Source: ${fps_num}fps, GOP: ${gop_size} (1s keyframes)"

    # Определяем наличие аудио в исходнике
    local has_audio audio_args audio_label
    has_audio=$(ffprobe -v error -select_streams a:0 -show_entries stream=codec_type -of csv=p=0 "$input_file" 2>/dev/null)
    if [ -n "$has_audio" ]; then
        audio_args="-c:a aac -b:a 256k -ar 48000"
        audio_label="+audio"
        log "  Audio: preserving (AAC 256k)"
    else
        audio_args="-an"
        audio_label=""
        log "  Audio: none in source"
    fi

    # Streaming-ready: нативный FPS, CBR 6Mbps, H.264 High
    # Выход готов к -c:v copy в стримере (0% CPU/GPU на вещание)
    if ffmpeg -y -hide_banner -loglevel error \
        -hwaccel qsv -hwaccel_output_format nv12 \
        -i "$input_file" \
        -vf "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:black,format=nv12" \
        -c:v h264_qsv -profile:v high -bf 0 \
        -b:v 6000k -maxrate 6000k -minrate 6000k -bufsize 12000k \
        -g $gop_size -keyint_min $gop_size -sc_threshold 0 -flags +cgop \
        $audio_args \
        -movflags +faststart \
        "$tmp_file" 2>> "$LOG_FILE"; then
        mv "$tmp_file" "$output_file"
        log "  Done (QSV CBR 6M ${fps_num}fps${audio_label}): $output_file"
    # Fallback: software encode
    elif ffmpeg -y -hide_banner -loglevel error \
        -i "$input_file" \
        -vf "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:black,format=yuv420p" \
        -c:v libx264 -profile:v high -preset veryfast -bf 0 \
        -b:v 6000k -maxrate 6000k -minrate 6000k -bufsize 12000k \
        -g $gop_size -keyint_min $gop_size -sc_threshold 0 -flags +cgop \
        $audio_args \
        -movflags +faststart \
        "$tmp_file" 2>> "$LOG_FILE"; then
        mv "$tmp_file" "$output_file"
        log "  Done (software CBR 6M ${fps_num}fps${audio_label}): $output_file"
    else
        log "  ERROR: Failed to transcode $filename"
        rm -f "$tmp_file"
    fi
}

process_audio() {
    local input_file="$1"
    local filename=$(basename "$input_file")
    local basename="${filename%.*}"
    local output_file="${MUSIC_OUTPUT_DIR}/${basename}.wav"
    local tmp_file="${MUSIC_OUTPUT_DIR}/.transcoding_${basename}.wav"

    log "Audio: $filename"

    if ffmpeg -y -hide_banner -loglevel error \
        -i "$input_file" \
        -af "loudnorm=I=-14:TP=-1:LRA=7" \
        -ar 44100 -ac 2 -c:a pcm_s16le \
        "$tmp_file" 2>> "$LOG_FILE"; then
        mv "$tmp_file" "$output_file"
        log "  Audio done: $output_file"
    else
        log "  ERROR: Failed to process audio $filename"
        rm -f "$tmp_file"
    fi
}

mkdir -p "$OUTPUT_DIR"
mkdir -p "$MUSIC_OUTPUT_DIR"
mkdir -p "$(dirname $LOG_FILE)"

# Чистим недоделанные транскоды от предыдущих запусков
rm -f "${OUTPUT_DIR}"/.transcoding_*
rm -f "${MUSIC_OUTPUT_DIR}"/.transcoding_*

log "Transcoder started (max $MAX_PARALLEL parallel). Watching: $WATCH_DIR + $MUSIC_DIR"

while true; do
    for file in "$WATCH_DIR"/*.mp4 "$WATCH_DIR"/*.mov "$WATCH_DIR"/*.mkv "$WATCH_DIR"/incoming/*.mp4 "$WATCH_DIR"/incoming/*.mov "$WATCH_DIR"/incoming/*.mkv; do
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
        [ "$size" -lt 1000000 ] && continue

        # Ждём свободный слот
        while [ $(jobs -rp | wc -l) -ge $MAX_PARALLEL ]; do
            sleep 2
        done

        log "Found new file: $filename"
        transcode_video "$file" &
    done

    # Аудио файлы
    for file in "$MUSIC_DIR"/*.wav "$MUSIC_DIR"/*.mp3 "$MUSIC_DIR"/*.flac "$MUSIC_DIR"/*.ogg "$MUSIC_DIR"/*.aac "$MUSIC_DIR"/*.m4a; do
        [ -f "$file" ] || continue

        filename=$(basename "$file")
        basename="${filename%.*}"
        output_file="${MUSIC_OUTPUT_DIR}/${basename}.wav"

        [[ "$filename" == .* ]] && continue
        [[ "$filename" == *.part ]] && continue
        [[ "$filename" == *.tmp ]] && continue

        # Уже обработан
        [ -f "$output_file" ] && continue

        # Файл ещё пишется (< 1MB)
        size=$(stat -c%s "$file" 2>/dev/null || echo 0)
        [ "$size" -lt 1000000 ] && continue

        # Ждём свободный слот
        while [ $(jobs -rp | wc -l) -ge $MAX_PARALLEL ]; do
            sleep 2
        done

        log "Found new audio: $filename"
        process_audio "$file" &
    done

    # Ждём завершения текущих задач
    wait
    sleep 5
done
