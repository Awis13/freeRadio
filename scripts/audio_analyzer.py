#!/usr/bin/env python3
"""
SYSTEM 23 — Advanced Audio Analyzer (Essentia)

Анализирует треки и находит:
- BPM и позиции всех битов (beat positions)
- Onset'ы (транзиенты)
- Структуру трека (интро, дроп, аутро)
- Оптимальные точки для микширования (mix-in, mix-out)

Сохраняет в JSON для использования Liquidsoap.
"""

import os
import sys
import json
import time
import numpy as np
from dataclasses import dataclass, asdict
from typing import List, Tuple, Optional

# Essentia
import essentia
import essentia.standard as es

MUSIC_DIR = "/music"
ANALYSIS_DIR = os.path.join(MUSIC_DIR, ".analysis")
ANALYSIS_EXT = ".json"
SCAN_INTERVAL = 15


@dataclass
class MixPoint:
    """Точка для микширования."""
    time: float  # время в секундах
    type: str    # 'mix_in' или 'mix_out'
    confidence: float  # 0.0 - 1.0
    bar_number: int


@dataclass
class TrackAnalysis:
    """Полный анализ трека."""
    filepath: str
    duration: float
    bpm: float
    bpm_confidence: float
    
    # Beat positions (в секундах)
    beats: List[float]
    
    # Onset positions (в секундах) - транзиенты, начала звуков
    onsets: List[float]
    
    # Структура трека
    intro_end: float  # конец интро (начало первого дропа)
    outro_start: float  # начало аутро
    
    # Точки для микширования
    mix_points: List[MixPoint]
    
    # Сырые данные для отладки
    onset_times: List[float]
    segment_boundaries: List[float]


def ensure_dir(path: str):
    """Создать директорию если не существует."""
    os.makedirs(path, exist_ok=True)


def get_analysis_path(filepath: str) -> str:
    """Получить путь к файлу анализа."""
    basename = os.path.basename(filepath)
    name = os.path.splitext(basename)[0]
    return os.path.join(ANALYSIS_DIR, f"{name}{ANALYSIS_EXT}")


def detect_beats(audio: np.ndarray, sample_rate: int) -> Tuple[float, List[float], float]:
    """
    Найти BPM и позиции битов.
    
    Returns:
        (bpm, beat_positions, confidence)
    """
    # Используем RhythmExtractor2013 - самый надёжный для электронной музыки
    rhythm_extractor = es.RhythmExtractor2013(
        method="multifeature",
        minTempo=100,
        maxTempo=220,
    )
    
    bpm, beats, beats_confidence, _, _ = rhythm_extractor(audio)
    
    # Конвертируем beats в список секунд
    beat_positions = beats.tolist() if isinstance(beats, np.ndarray) else list(beats)
    
    return float(bpm), beat_positions, float(beats_confidence)


def detect_onsets(audio: np.ndarray, sample_rate: int) -> List[float]:
    """
    Найти onset'ы (транзиенты - начала ударов, звуков).
    
    Returns:
        Список времен в секундах
    """
    # OnsetDetection с HFC (High Frequency Content) - лучше для ударных
    onset_algo = es.OnsetDetection(method="hfc")
    
    # Windowing и FFT
    w = es.Windowing(type='hann')
    fft = es.FFT()
    c2p = es.CartesianToPolar()
    
    # Вычисляем onset detection function
    onset_times = []
    onset_values = []
    
    frame_size = 1024
    hop_size = 512
    
    for frame in es.FrameGenerator(audio, frameSize=frame_size, hopSize=hop_size):
        mag, phase = c2p(fft(w(frame)))
        onset_val = onset_algo(mag, phase)
        onset_values.append(onset_val)
    
    # OnsetDetectionGlobal находит пики в ODF
    onset_detect = es.OnsetDetectionGlobal()
    onsets = onset_detect(
        np.array(onset_values),
        np.array([]),  # не используем дополнительные фичи
    )
    
    # Конвертируем frame indices в секунды
    onset_times = [float(o * hop_size / sample_rate) for o in onsets]
    
    return onset_times


def analyze_structure(audio: np.ndarray, sample_rate: int, beats: List[float], bpm: float) -> Tuple[float, float]:
    """
    Анализ структуры трека: найти конец интро и начало аутро.
    
    Returns:
        (intro_end, outro_start) в секундах
    """
    duration = len(audio) / sample_rate
    
    if not beats or bpm <= 0:
        return duration * 0.1, duration * 0.9
    
    # Длина такта в секундах
    beat_duration = 60.0 / bpm
    bar_duration = beat_duration * 4  # 4/4 такт
    
    # Длина фразы (8 или 16 тактов)
    phrase_duration = bar_duration * 16  # 16 тактов = типичная фраза
    
    # Находим Novelty Curve - изменения в спектре
    # Это помогает определить смены секций
    novelty = []
    hop_size = 512
    frame_size = 2048
    
    w = es.Windowing(type='hann')
    spectrum = es.Spectrum()
    
    prev_spec = None
    for frame in es.FrameGenerator(audio, frameSize=frame_size, hopSize=hop_size, startFromZero=True):
        spec = spectrum(w(frame))
        if prev_spec is not None:
            # Cosine distance между спектрами = изменение
            diff = np.sum(np.abs(spec - prev_spec))
            novelty.append(diff)
        prev_spec = spec
    
    if not novelty:
        return duration * 0.1, duration * 0.9
    
    novelty = np.array(novelty)
    
    # Сглажива novelty curve
    window_size = int(phrase_duration * sample_rate / hop_size / 2)  # окно в полфразы
    if window_size > 1:
        novelty_smooth = np.convolve(novelty, np.ones(window_size)/window_size, mode='same')
    else:
        novelty_smooth = novelty
    
    # Находим первый существенный пик novelty после 8 тактов - это скорее всего дроп
    min_intro_bars = 8
    min_intro_time = min_intro_bars * bar_duration
    min_intro_frame = int(min_intro_time * sample_rate / hop_size)
    
    intro_end = duration * 0.1
    if len(novelty_smooth) > min_intro_frame:
        # Ищем пик novelty в первой половине трека
        search_end = len(novelty_smooth) // 2
        peak_idx = min_intro_frame + np.argmax(novelty_smooth[min_intro_frame:search_end])
        intro_end = peak_idx * hop_size / sample_rate
    
    # Находим начало аутро - где novelty падает и остаётся низким
    # Ищем последний существенный пик перед концом
    outro_start = duration * 0.85
    if len(novelty_smooth) > 100:
        # Анализируем вторую половину
        half_point = len(novelty_smooth) // 2
        # Находим где novelty становится низким и остаётся таким
        threshold = np.mean(novelty_smooth[half_point:]) * 0.5
        for i in range(len(novelty_smooth) - 1, half_point, -1):
            if novelty_smooth[i] > threshold:
                outro_start = i * hop_size / sample_rate
                break
    
    return intro_end, outro_start


def find_mix_points(beats: List[float], bpm: float, duration: float, 
                    intro_end: float, outro_start: float) -> List[MixPoint]:
    """
    Найти оптимальные точки для микширования.
    
    Mix-in: в начале трека, на границе фразы, желательно в интро
    Mix-out: в конце трека, на границе фразы, желательно в аутро
    
    Returns:
        Список MixPoint
    """
    mix_points = []
    
    if not beats or bpm <= 0:
        # Fallback: просто начало и конец
        mix_points.append(MixPoint(time=0.0, type="mix_in", confidence=0.5, bar_number=0))
        mix_points.append(MixPoint(time=duration * 0.9, type="mix_out", confidence=0.5, bar_number=0))
        return mix_points
    
    beat_duration = 60.0 / bpm
    bar_duration = beat_duration * 4
    
    # Размер фразы (сколько тактов)
    phrase_bars = 16
    phrase_duration = bar_duration * phrase_bars
    
    # --- MIX-IN точки ---
    # Ищем первую границу фразы после начала (16, 32 тактов)
    for bar_offset in [0, 16, 32, 48]:
        time_offset = bar_offset * bar_duration
        if time_offset >= duration:
            break
        
        # Находим ближайший бит
        closest_beat = min(beats, key=lambda b: abs(b - time_offset))
        beat_idx = beats.index(closest_beat)
        
        # Confidence: лучше если это в интро и ровно на границе фразы
        is_in_intro = closest_beat <= intro_end
        time_diff = abs(closest_beat - time_offset)
        confidence = 0.7 if is_in_intro else 0.5
        confidence -= time_diff / bar_duration * 0.2  # штраф за неточность
        confidence = max(0.3, min(1.0, confidence))
        
        mix_points.append(MixPoint(
            time=closest_beat,
            type="mix_in",
            confidence=confidence,
            bar_number=bar_offset
        ))
    
    # --- MIX-OUT точки ---
    # Ищем границы фразы до конца трека, начиная с outro_start
    outro_start_bar = int(outro_start / bar_duration)
    # Округляем до ближайшей фразы
    outro_phrase_bar = ((outro_start_bar // phrase_bars) + 1) * phrase_bars
    
    for bar_offset in [outro_phrase_bar, outro_phrase_bar + 16, outro_phrase_bar + 32]:
        time_offset = bar_offset * bar_duration
        if time_offset >= duration - bar_duration:
            break
        
        closest_beat = min(beats, key=lambda b: abs(b - time_offset))
        
        # Confidence: лучше если это в аутро
        is_in_outro = closest_beat >= outro_start
        time_diff = abs(closest_beat - time_offset)
        confidence = 0.8 if is_in_outro else 0.5
        confidence -= time_diff / bar_duration * 0.2
        confidence = max(0.3, min(1.0, confidence))
        
        mix_points.append(MixPoint(
            time=closest_beat,
            type="mix_out",
            confidence=confidence,
            bar_number=bar_offset
        ))
    
    # Сортируем по времени
    mix_points.sort(key=lambda x: x.time)
    
    return mix_points


def analyze_file(filepath: str) -> Optional[TrackAnalysis]:
    """
    Полный анализ одного файла.
    """
    print(f"[*] Analyzing: {os.path.basename(filepath)}...")
    
    try:
        # Загружаем аудио
        loader = es.MonoLoader(filename=filepath, sampleRate=44100)
        audio = loader()
        
        sample_rate = 44100
        duration = len(audio) / sample_rate
        
        print(f"    Duration: {duration:.1f}s")
        
        # 1. Находим BPM и биты
        print(f"    Detecting beats...")
        bpm, beats, bpm_confidence = detect_beats(audio, sample_rate)
        print(f"    BPM: {bpm:.1f} (confidence: {bpm_confidence:.2f})")
        
        # 2. Находим onset'ы
        print(f"    Detecting onsets...")
        onsets = detect_onsets(audio, sample_rate)
        print(f"    Found {len(onsets)} onsets")
        
        # 3. Анализируем структуру
        print(f"    Analyzing structure...")
        intro_end, outro_start = analyze_structure(audio, sample_rate, beats, bpm)
        print(f"    Intro ends: {intro_end:.1f}s, Outro starts: {outro_start:.1f}s")
        
        # 4. Находим точки для микширования
        print(f"    Finding mix points...")
        mix_points = find_mix_points(beats, bpm, duration, intro_end, outro_start)
        print(f"    Found {len(mix_points)} mix points")
        
        # Создаём результат
        analysis = TrackAnalysis(
            filepath=filepath,
            duration=duration,
            bpm=bpm,
            bpm_confidence=bpm_confidence,
            beats=beats[:200] if len(beats) > 200 else beats,  # ограничиваем размер
            onsets=onsets[:500] if len(onsets) > 500 else onsets,
            intro_end=intro_end,
            outro_start=outro_start,
            mix_points=mix_points,
            onset_times=onsets[:100] if len(onsets) > 100 else onsets,
            segment_boundaries=[]
        )
        
        return analysis
        
    except Exception as e:
        print(f"    ERROR: {e}")
        import traceback
        traceback.print_exc()
        return None


def save_analysis(analysis: TrackAnalysis):
    """Сохранить анализ в JSON."""
    analysis_path = get_analysis_path(analysis.filepath)
    
    # Конвертируем dataclass в dict
    data = asdict(analysis)
    
    with open(analysis_path, 'w') as f:
        json.dump(data, f, indent=2)
    
    print(f"    Saved to: {analysis_path}")


def load_analysis(filepath: str) -> Optional[TrackAnalysis]:
    """Загрузить анализ из JSON."""
    analysis_path = get_analysis_path(filepath)
    
    if not os.path.exists(analysis_path):
        return None
    
    try:
        with open(analysis_path, 'r') as f:
            data = json.load(f)
        
        # Конвертируем обратно в TrackAnalysis
        mix_points = [MixPoint(**mp) for mp in data.get('mix_points', [])]
        
        return TrackAnalysis(
            filepath=data['filepath'],
            duration=data['duration'],
            bpm=data['bpm'],
            bpm_confidence=data['bpm_confidence'],
            beats=data['beats'],
            onsets=data['onsets'],
            intro_end=data['intro_end'],
            outro_start=data['outro_start'],
            mix_points=mix_points,
            onset_times=data.get('onset_times', []),
            segment_boundaries=data.get('segment_boundaries', [])
        )
    except Exception as e:
        print(f"Error loading analysis for {filepath}: {e}")
        return None


def get_existing_tracks() -> set:
    """Получить список уже проанализированных треков."""
    existing = set()
    if not os.path.exists(ANALYSIS_DIR):
        return existing
    
    for f in os.listdir(ANALYSIS_DIR):
        if f.endswith(ANALYSIS_EXT):
            # Извлекаем имя трека из имени файла анализа
            track_name = f[:-len(ANALYSIS_EXT)]
            existing.add(track_name)
    
    return existing


def get_all_music_files() -> List[str]:
    """Получить список всех музыкальных файлов."""
    files = []
    if not os.path.exists(MUSIC_DIR):
        return files
    
    for f in os.listdir(MUSIC_DIR):
        if f.lower().endswith(('.wav', '.mp3', '.flac', '.ogg', '.aac', '.m4a')):
            files.append(os.path.join(MUSIC_DIR, f))
    
    return sorted(files)


def main():
    print("=" * 60)
    print("SYSTEM 23 — Advanced Audio Analyzer (Essentia)")
    print(f"Music dir: {MUSIC_DIR}")
    print(f"Analysis dir: {ANALYSIS_DIR}")
    print("=" * 60)
    
    ensure_dir(ANALYSIS_DIR)
    
    while True:
        existing_names = get_existing_tracks()
        files = get_all_music_files()
        
        for filepath in files:
            basename = os.path.basename(filepath)
            name = os.path.splitext(basename)[0]
            
            if name in existing_names:
                continue
            
            # Анализируем
            analysis = analyze_file(filepath)
            
            if analysis:
                save_analysis(analysis)
                print()
        
        # Cleanup удалённых файлов
        current_names = {os.path.splitext(os.path.basename(f))[0] for f in files}
        for name in list(existing_names):
            if name not in current_names:
                analysis_path = os.path.join(ANALYSIS_DIR, f"{name}{ANALYSIS_EXT}")
                if os.path.exists(analysis_path):
                    os.remove(analysis_path)
                    print(f"[-] Removed analysis for: {name}")
        
        time.sleep(SCAN_INTERVAL)


if __name__ == "__main__":
    main()
