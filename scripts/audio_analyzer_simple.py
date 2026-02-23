#!/usr/bin/env python3
"""
STUDIO 23 — Simple Audio Analyzer (Essentia)
Сканирует треки и сохраняет в простой текстовый формат как BPM map.

Формат .analysis_map:
filepath|bpm|duration|intro_end|outro_start|mix_in|mix_out|first_beat
"""

import os
import sys
import time
import functools
from multiprocessing import Pool, cpu_count
import numpy as np
import essentia
import essentia.standard as es

# Unbuffered stdout for docker logs
print = functools.partial(print, flush=True)

MUSIC_DIR = "/music"
ANALYSIS_MAP = os.path.join(MUSIC_DIR, ".analysis_map")
SCAN_INTERVAL = 15
WORKERS = min(cpu_count(), 8)


def get_existing_tracks():
    """Read already analyzed tracks."""
    existing = {}
    if os.path.exists(ANALYSIS_MAP):
        with open(ANALYSIS_MAP, 'r') as f:
            for line in f:
                line = line.strip()
                if '|' in line:
                    parts = line.split('|')
                    if len(parts) >= 2:
                        existing[parts[0]] = parts[1]
    return existing


def is_file_stable(filepath, wait_secs=2, max_attempts=3):
    """
    Check if file has finished copying by verifying size is stable.
    Returns True if file size hasn't changed between checks.
    """
    for attempt in range(max_attempts):
        try:
            size1 = os.path.getsize(filepath)
            time.sleep(wait_secs)
            size2 = os.path.getsize(filepath)

            if size1 == size2:
                return True

            print(f"    [~] File still copying (size changed: {size1} -> {size2}), waiting...")
        except OSError:
            return False

    return False


def detect_bpm(audio):
    """Two-pass BPM detection with octave error correction.
    Pass 1: wide range (60-220). Pass 2: if result < 100 BPM, test double-tempo hypothesis."""
    rhythm = es.RhythmExtractor2013(method="multifeature", minTempo=60, maxTempo=220)
    bpm, beats, confidence, _, _ = rhythm(audio)
    bpm = float(bpm)
    confidence = float(confidence)
    beats = list(beats) if hasattr(beats, '__iter__') else []

    if bpm < 100.0 and bpm > 0.0:
        double_bpm = bpm * 2.0
        low = int(max(60, min(180, double_bpm - 10)))
        high = int(min(220, double_bpm + 10))
        rhythm2 = es.RhythmExtractor2013(method="multifeature", minTempo=low, maxTempo=high)
        bpm2, beats2, conf2, _, _ = rhythm2(audio)
        bpm2 = float(bpm2)
        conf2 = float(conf2)
        beats2 = list(beats2) if hasattr(beats2, '__iter__') else []

        if conf2 >= confidence * 0.8:
            print(f"    Octave correction: {bpm:.1f} -> {bpm2:.1f} (conf {confidence:.2f} -> {conf2:.2f})")
            bpm, beats, confidence = bpm2, beats2, conf2

    # Force double if still under 100 — Essentia maxTempo=180 blocks correction for fast tracks
    if bpm < 100.0 and bpm > 0.0:
        print(f"    Force octave correction: {bpm:.1f} -> {bpm * 2.0:.1f} (Essentia limit workaround)")
        bpm = bpm * 2.0

    return bpm, beats, confidence


# ---- SMART MIX POINT DETECTION ----

def find_mix_in_point(audio, beats, bpm, sample_rate=44100):
    """
    Найти точку входа для микса: первый значимый onset (пропуск тишины/шума).
    Использует RMS по 50ms фреймам для точного определения.
    Округляет до ближайшего бита вниз.
    """
    if bpm <= 0 or len(audio) == 0:
        return 0.0

    beat_period = 60.0 / bpm

    # RMS по 50ms фреймам (2205 samples при 44100)
    frame_samples = int(sample_rate * 0.05)
    n_frames = len(audio) // frame_samples

    if n_frames < 10:
        return 0.0

    # Анализируем только первые 10 секунд (тишина дольше — маловероятна)
    max_check = min(n_frames, int(10.0 / 0.05))  # 200 фреймов = 10 секунд
    trimmed = audio[:max_check * frame_samples]
    frames = np.reshape(trimmed, (max_check, frame_samples))
    rms_per_frame = np.sqrt(np.mean(frames ** 2, axis=1))

    # Пиковый RMS из первых 10 секунд (может быть тихое интро)
    # Берём максимум из всего трека для корректного порога
    full_check = min(n_frames, int(60.0 / 0.05))  # До 60 секунд
    full_trimmed = audio[:full_check * frame_samples]
    full_frames = np.reshape(full_trimmed, (full_check, frame_samples))
    full_rms = np.sqrt(np.mean(full_frames ** 2, axis=1))
    max_rms = float(np.max(full_rms))

    if max_rms == 0:
        return 0.0

    # Порог: -40dB от пика (0.01 * max)
    threshold = max_rms * 0.01

    # Первый фрейм выше порога
    onset_time = 0.0
    for i in range(max_check):
        if rms_per_frame[i] > threshold:
            onset_time = i * 0.05  # 50ms шаг
            break

    # Округляем вниз до ближайшего бита
    if onset_time > beat_period:
        beat_idx = int(onset_time / beat_period)
        onset_time = beat_idx * beat_period

    return round(max(0.0, onset_time), 3)


def find_intro_end(audio, bpm, duration, sample_rate=44100):
    """
    Найти конец интро: первый значительный скачок энергии (drop/build).
    Ищет самый большой рост RMS в первой половине трека.
    Выравнивает по 16-барным фразам.
    Fallback: фиксированная оценка (16/32 бара).
    """
    if bpm <= 0 or duration <= 0:
        return 0.0

    bar_duration = (60.0 / bpm) * 4.0

    # RMS по барам
    samples_per_bar = int(bar_duration * sample_rate)
    n_bars = len(audio) // samples_per_bar

    if n_bars < 8:
        return min(16.0 * bar_duration, duration * 0.3)

    trimmed = audio[:n_bars * samples_per_bar]
    bars_audio = np.reshape(trimmed, (n_bars, samples_per_bar))
    bar_energies = np.sqrt(np.mean(bars_audio ** 2, axis=1))

    # Ищем самый большой скачок энергии в первой половине
    half = min(n_bars // 2, 64)  # Не дальше 64 баров
    window = 4  # Сглаживание: усреднение по 4 барам

    max_jump = 0.0
    jump_bar = 16  # Дефолт

    for i in range(window, half):
        avg_before = float(np.mean(bar_energies[max(0, i - window):i]))
        avg_after = float(np.mean(bar_energies[i:min(n_bars, i + window)]))

        if avg_before > 0:
            jump = (avg_after - avg_before) / avg_before  # Относительный скачок
        else:
            jump = float(avg_after)

        if jump > max_jump:
            max_jump = jump
            jump_bar = i

    # Выравниваем по 16-барной фразе (округляем вверх)
    phrase_bar = ((jump_bar + 15) // 16) * 16
    intro_end = phrase_bar * bar_duration

    # Fallback: если скачок незначительный (< 50%), фиксированная оценка
    if max_jump < 0.5:
        intro_bars = 16.0 if duration <= 180 else 32.0
        intro_end = intro_bars * bar_duration
        print(f"    Intro: fallback to {intro_bars:.0f} bars (jump={max_jump:.2f} < 0.5)")
    else:
        print(f"    Intro: detected at bar {phrase_bar} (jump={max_jump:.2f} at bar ~{jump_bar})")

    # Ограничиваем разумным диапазоном
    intro_end = max(4.0 * bar_duration, min(intro_end, duration * 0.4))

    return round(intro_end, 1)


def find_outro_start(audio, bpm, duration, intro_end, sample_rate=44100):
    """
    Найти начало аутро: последний значительный спад энергии.
    Ищет во второй половине трека. Выравнивает по 16-барным фразам.
    Fallback: фиксированная оценка (16/32 баров от конца).
    """
    if bpm <= 0 or duration <= 0:
        return duration * 0.7

    bar_duration = (60.0 / bpm) * 4.0
    samples_per_bar = int(bar_duration * sample_rate)
    n_bars = len(audio) // samples_per_bar

    if n_bars < 8:
        return max(0, duration - 16.0 * bar_duration)

    trimmed = audio[:n_bars * samples_per_bar]
    bars_audio = np.reshape(trimmed, (n_bars, samples_per_bar))
    bar_energies = np.sqrt(np.mean(bars_audio ** 2, axis=1))

    # Ищем самый большой спад энергии во второй половине
    half_start = max(n_bars // 2, 16)
    window = 4

    max_drop = 0.0
    drop_bar = n_bars - 16  # Дефолт

    for i in range(half_start, n_bars - window):
        avg_before = float(np.mean(bar_energies[max(0, i - window):i]))
        avg_after = float(np.mean(bar_energies[i:min(n_bars, i + window)]))

        if avg_before > 0:
            drop = (avg_before - avg_after) / avg_before  # Относительный спад
        else:
            drop = 0.0

        if drop > max_drop:
            max_drop = drop
            drop_bar = i

    # Выравниваем по 16-барной фразе (округляем вниз)
    phrase_bar = (drop_bar // 16) * 16
    outro_start = phrase_bar * bar_duration

    # Fallback: если спад незначительный
    if max_drop < 0.3:
        outro_bars = 16.0 if duration <= 180 else 32.0
        outro_start = max(0.0, duration - outro_bars * bar_duration)
        print(f"    Outro: fallback to {outro_bars:.0f} bars from end (drop={max_drop:.2f} < 0.3)")
    else:
        print(f"    Outro: detected at bar {phrase_bar} (drop={max_drop:.2f} at bar ~{drop_bar})")

    # Ограничиваем: не раньше intro_end + 4 бара, не позже чем 4 бара до конца
    outro_start = max(intro_end + 4.0 * bar_duration, min(outro_start, duration - 4.0 * bar_duration))

    return round(outro_start, 1)


def analyze_file(filepath):
    """Analyze single file with Essentia."""
    try:
        print(f"[*] Analyzing: {os.path.basename(filepath)}...")

        # Load audio
        loader = es.MonoLoader(filename=filepath, sampleRate=44100)
        audio = loader()

        sample_rate = 44100
        duration = len(audio) / sample_rate

        # Two-pass BPM detection (60-220 range with octave correction)
        bpm, beats, confidence = detect_bpm(audio)

        first_beat = beats[0] if beats else 0.0
        print(f"    BPM: {bpm:.1f}, Confidence: {confidence:.2f}, Duration: {duration:.1f}s, Beats: {len(beats)}, First beat: {first_beat:.3f}s")

        if bpm <= 0 or not beats:
            return None

        beat_duration = 60.0 / bpm
        bar_duration = beat_duration * 4.0

        # --- Smart mix point detection ---

        # 1. Mix-in: первый значимый onset (пропуск тишины)
        mix_in = find_mix_in_point(audio, beats, bpm, sample_rate)

        # 2. Intro end: скачок энергии (drop) в первой половине
        intro_end = find_intro_end(audio, bpm, duration, sample_rate)

        # 3. Outro start: спад энергии во второй половине
        outro_start = find_outro_start(audio, bpm, duration, intro_end, sample_rate)

        # 4. Mix-out: начало аутро, выравненное по 16-барной фразе
        outro_start_bar = int(outro_start / bar_duration)
        mix_out_bar = ((outro_start_bar + 15) // 16) * 16  # Rounded UP to next phrase
        mix_out = mix_out_bar * bar_duration

        # Убеждаемся что mix_out внутри трека
        if mix_out >= duration - bar_duration:
            mix_out = max(intro_end + 16.0 * bar_duration, duration - 16.0 * bar_duration)

        # Убеждаемся что mix_out > intro_end
        if mix_out <= intro_end:
            mix_out = intro_end + 16.0 * bar_duration

        print(f"    Intro end: {intro_end:.1f}s, Outro start: {outro_start:.1f}s")
        print(f"    Mix in: {mix_in:.3f}s, Mix out: {mix_out:.1f}s")

        return {
            'filepath': filepath,
            'bpm': bpm,
            'duration': duration,
            'intro_end': intro_end,
            'outro_start': outro_start,
            'mix_in': mix_in,
            'mix_out': mix_out,
            'first_beat': first_beat
        }

    except Exception as e:
        print(f"    ERROR: {e}")
        return None


def save_analysis(data):
    """Append analysis to map file."""
    line = f"{data['filepath']}|{data['bpm']:.1f}|{data['duration']:.1f}|{data['intro_end']:.1f}|{data['outro_start']:.1f}|{data['mix_in']:.3f}|{data['mix_out']:.1f}|{data['first_beat']:.3f}\n"

    with open(ANALYSIS_MAP, 'a') as f:
        f.write(line)

    # Also update .bpm_map for dashboard compatibility
    bpm_line = f"{data['filepath']}|{data['bpm']:.1f}\n"
    with open(os.path.join(MUSIC_DIR, '.bpm_map'), 'a') as f:
        f.write(bpm_line)

    print(f"    [+] Saved")


def cleanup_removed(existing):
    """Remove entries for deleted files."""
    if not os.path.exists(ANALYSIS_MAP):
        return

    with open(ANALYSIS_MAP, 'r') as f:
        lines = f.readlines()

    new_lines = []
    for line in lines:
        line = line.strip()
        if '|' in line:
            filepath = line.split('|')[0]
            if os.path.exists(filepath):
                new_lines.append(line)
            else:
                print(f"[-] Removed: {os.path.basename(filepath)}")

    with open(ANALYSIS_MAP, 'w') as f:
        f.write('\n'.join(new_lines) + '\n' if new_lines else '')


def main():
    print("=" * 60)
    print("STUDIO 23 — Audio Analyzer (Essentia)")
    print(f"Music dir: {MUSIC_DIR}")
    print(f"Output: {ANALYSIS_MAP}")
    print("=" * 60)

    while True:
        existing = get_existing_tracks()

        # Find all music files
        files = []
        if os.path.exists(MUSIC_DIR):
            for f in os.listdir(MUSIC_DIR):
                if f.lower().endswith(('.wav', '.mp3', '.flac', '.ogg', '.aac', '.m4a')):
                    filepath = os.path.join(MUSIC_DIR, f)
                    files.append(filepath)

        # Filter to new, stable files
        to_analyze = []
        for filepath in sorted(files):
            if filepath in existing:
                continue
            if not is_file_stable(filepath):
                print(f"[~] Skipping {os.path.basename(filepath)} — still copying")
                continue
            to_analyze.append(filepath)

        # Analyze in parallel
        if to_analyze:
            print(f"[*] Analyzing {len(to_analyze)} files with {WORKERS} workers...")
            with Pool(WORKERS) as pool:
                results = pool.map(analyze_file, to_analyze)
            for result in results:
                if result:
                    save_analysis(result)

        # Cleanup
        cleanup_removed(existing)

        time.sleep(SCAN_INTERVAL)


if __name__ == "__main__":
    main()
