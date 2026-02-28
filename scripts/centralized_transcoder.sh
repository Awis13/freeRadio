#!/bin/bash
# Централизованный транскодер для мультитенантной платформы
# Запускается в LXC 99, обрабатывает все тенанты последовательно
# Сканирует /tenants/*/visuals/incoming/ и /tenants/*/music/
# Round-robin: 1 файл от каждого тенанта за раунд (fairness)
# Валидация duration: перекодированный файл проверяется на соответствие

TENANTS_DIR="/tenants"
LOG_FILE="/var/log/transcoder.log"
MAX_PARALLEL=1
MAX_RETRIES=2
DURATION_TOLERANCE=2  # допуск в секундах

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a "$LOG_FILE"
}

get_video_duration() {
    ffprobe -v error -show_entries format=duration -of csv=p=0 "$1" 2>/dev/null | cut -d. -f1
}

# Валидация: сравнивает duration входа и выхода
validate_duration() {
    local input_file="$1"
    local output_file="$2"
    local tenant_id="$3"

    local input_dur output_dur
    input_dur=$(get_video_duration "$input_file")
    output_dur=$(get_video_duration "$output_file")

    if [ -z "$input_dur" ] || [ -z "$output_dur" ]; then
        log "  [${tenant_id}] WARN: Не удалось получить duration (input=${input_dur:-?}, output=${output_dur:-?})"
        return 1
    fi

    local diff=$(( input_dur > output_dur ? input_dur - output_dur : output_dur - input_dur ))
    if [ "$diff" -gt "$DURATION_TOLERANCE" ]; then
        log "  [${tenant_id}] ERROR: Duration mismatch! input=${input_dur}s output=${output_dur}s diff=${diff}s"
        return 1
    fi

    log "  [${tenant_id}] Duration OK: input=${input_dur}s output=${output_dur}s"
    return 0
}

transcode_video() {
    local input_file="$1"
    local output_dir="$2"
    local tenant_id="$3"
    local filename=$(basename "$input_file")
    local basename="${filename%.*}"
    local output_file="${output_dir}/${basename}.mp4"
    local tmp_file="${output_dir}/.transcoding_${basename}.mp4"

    log "[${tenant_id}] Transcoding: $filename"

    local duration
    duration=$(get_video_duration "$input_file")
    log "  [${tenant_id}] Duration: ${duration}s"

    # Detect source FPS and compute GOP (1-second keyframes)
    local src_fps
    src_fps=$(ffprobe -v error -select_streams v:0 -show_entries stream=r_frame_rate -of csv=p=0 "$input_file" 2>/dev/null | head -1)
    local fps_num=${src_fps%/*}
    [ -z "$fps_num" ] || [ "$fps_num" -eq 0 ] 2>/dev/null && fps_num=24
    local gop_size=$((fps_num * 1))
    log "  [${tenant_id}] Source: ${fps_num}fps, GOP: ${gop_size} (1s keyframes)"

    # Detect audio in source
    local has_audio audio_args audio_label
    has_audio=$(ffprobe -v error -select_streams a:0 -show_entries stream=codec_type -of csv=p=0 "$input_file" 2>/dev/null)
    if [ -n "$has_audio" ]; then
        audio_args="-c:a aac -b:a 256k -ar 48000"
        audio_label="+audio"
    else
        audio_args="-an"
        audio_label=""
    fi

    local attempt
    for attempt in $(seq 1 $((MAX_RETRIES + 1))); do
        rm -f "$tmp_file"

        # QSV hardware encode
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

            # Валидация duration
            if validate_duration "$input_file" "$tmp_file" "$tenant_id"; then
                mv "$tmp_file" "$output_file"
                log "  [${tenant_id}] Done (QSV CBR 6M ${fps_num}fps${audio_label}): $output_file"
                return 0
            fi

            if [ "$attempt" -le "$MAX_RETRIES" ]; then
                log "  [${tenant_id}] Retry $attempt/$MAX_RETRIES (QSV)..."
                rm -f "$tmp_file"
                sleep 2
                continue
            fi
        fi

        # Fallback: software encode
        rm -f "$tmp_file"
        if ffmpeg -y -hide_banner -loglevel error \
            -i "$input_file" \
            -vf "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:black,format=yuv420p" \
            -c:v libx264 -profile:v high -preset veryfast -bf 0 \
            -b:v 6000k -maxrate 6000k -minrate 6000k -bufsize 12000k \
            -g $gop_size -keyint_min $gop_size -sc_threshold 0 -flags +cgop \
            $audio_args \
            -movflags +faststart \
            "$tmp_file" 2>> "$LOG_FILE"; then

            if validate_duration "$input_file" "$tmp_file" "$tenant_id"; then
                mv "$tmp_file" "$output_file"
                log "  [${tenant_id}] Done (software CBR 6M ${fps_num}fps${audio_label}): $output_file"
                return 0
            fi

            if [ "$attempt" -le "$MAX_RETRIES" ]; then
                log "  [${tenant_id}] Retry $attempt/$MAX_RETRIES (software)..."
                rm -f "$tmp_file"
                sleep 2
                continue
            fi
        fi
    done

    log "  [${tenant_id}] ERROR: Failed to transcode $filename after $MAX_RETRIES retries"
    rm -f "$tmp_file"
    return 1
}

process_audio() {
    local input_file="$1"
    local output_dir="$2"
    local tenant_id="$3"
    local filename=$(basename "$input_file")
    local basename="${filename%.*}"
    local output_file="${output_dir}/${basename}.wav"
    local tmp_file="${output_dir}/.transcoding_${basename}.wav"

    log "[${tenant_id}] Audio: $filename"

    if ffmpeg -y -hide_banner -loglevel error \
        -i "$input_file" \
        -af "loudnorm=I=-14:TP=-1:LRA=7" \
        -ar 44100 -ac 2 -c:a pcm_s16le \
        "$tmp_file" 2>> "$LOG_FILE"; then
        mv "$tmp_file" "$output_file"
        log "  [${tenant_id}] Audio done: $output_file"
    else
        log "  [${tenant_id}] ERROR: Failed to process audio $filename"
        rm -f "$tmp_file"
    fi
}

# Собирает список файлов для обработки от одного тенанта
# Возвращает первый найденный (round-robin: 1 файл за раунд)
collect_tenant_work() {
    local tenant_dir="$1"
    local tenant_id="$2"
    local visuals_in="${tenant_dir}/visuals/incoming"
    local processed_dir="${tenant_dir}/visuals/.processed"
    local music_dir="${tenant_dir}/music"
    local music_out="${tenant_dir}/music/processed"

    # Видео
    for file in "$visuals_in"/*.mp4 "$visuals_in"/*.mov "$visuals_in"/*.mkv; do
        [ -f "$file" ] || continue
        local filename=$(basename "$file")
        local basename="${filename%.*}"

        [[ "$filename" == .* ]] && continue
        [[ "$filename" == *.part ]] && continue
        [[ "$filename" == *.tmp ]] && continue

        # Уже обработано
        [ -f "${processed_dir}/${basename}.mp4" ] && continue

        # Файл ещё пишется (< 10MB)
        local size=$(stat -c%s "$file" 2>/dev/null || echo 0)
        [ "$size" -lt 10000000 ] && continue

        echo "video:${file}:${processed_dir}:${tenant_id}"
        return  # Один файл за раунд
    done

    # Аудио
    for file in "$music_dir"/*.wav "$music_dir"/*.mp3 "$music_dir"/*.flac "$music_dir"/*.ogg "$music_dir"/*.aac "$music_dir"/*.m4a; do
        [ -f "$file" ] || continue
        local filename=$(basename "$file")
        local basename="${filename%.*}"

        [[ "$filename" == .* ]] && continue
        [[ "$filename" == *.part ]] && continue
        [[ "$filename" == *.tmp ]] && continue

        # Уже обработано
        [ -f "${music_out}/${basename}.wav" ] && continue

        # Файл ещё пишется (< 1MB)
        local size=$(stat -c%s "$file" 2>/dev/null || echo 0)
        [ "$size" -lt 1000000 ] && continue

        echo "audio:${file}:${music_out}:${tenant_id}"
        return  # Один файл за раунд
    done
}

mkdir -p "$(dirname $LOG_FILE)"

# Clean up incomplete transcodes from all tenants
find "$TENANTS_DIR" -name '.transcoding_*' -delete 2>/dev/null

log "Centralized transcoder started (MAX_PARALLEL=$MAX_PARALLEL). Watching: $TENANTS_DIR/*/visuals/incoming/ + $TENANTS_DIR/*/music/"

while true; do
    # Собираем работу от всех тенантов (round-robin)
    work_items=()
    for tenant_dir in "$TENANTS_DIR"/*/; do
        [ -d "$tenant_dir" ] || continue
        tenant_id=$(basename "$tenant_dir")

        # Пропускаем не-числовые директории
        [[ "$tenant_id" =~ ^[0-9]+$ ]] || continue

        item=$(collect_tenant_work "$tenant_dir" "$tenant_id")
        [ -n "$item" ] && work_items+=("$item")
    done

    # Обрабатываем собранные задачи последовательно (MAX_PARALLEL=1)
    for item in "${work_items[@]}"; do
        IFS=':' read -r type file output_dir tenant_id <<< "$item"

        case "$type" in
            video)
                log "Found new file from tenant ${tenant_id}: $(basename "$file")"
                transcode_video "$file" "$output_dir" "$tenant_id"
                ;;
            audio)
                log "Found new audio from tenant ${tenant_id}: $(basename "$file")"
                process_audio "$file" "$output_dir" "$tenant_id"
                ;;
        esac
    done

    sleep 5
done
