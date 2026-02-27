#!/usr/bin/env python3
"""
STUDIO 23 — Advanced Audio Analyzer (Essentia)

Analyzes tracks and detects:
- BPM and all beat positions
- Onsets (transients)
- Track structure (intro, drop, outro)
- Optimal mix points (mix-in, mix-out)

Saves to JSON for use by Liquidsoap.
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
    """A point for mixing."""
    time: float  # time in seconds
    type: str    # 'mix_in' or 'mix_out'
    confidence: float  # 0.0 - 1.0
    bar_number: int


@dataclass
class TrackAnalysis:
    """Full track analysis."""
    filepath: str
    duration: float
    bpm: float
    bpm_confidence: float

    # Beat positions (in seconds)
    beats: List[float]

    # Onset positions (in seconds) - transients, sound onsets
    onsets: List[float]

    # Track structure
    intro_end: float  # end of intro (start of first drop)
    outro_start: float  # start of outro

    # Mix points
    mix_points: List[MixPoint]

    # Raw data for debugging
    onset_times: List[float]
    segment_boundaries: List[float]


def ensure_dir(path: str):
    """Create directory if it doesn't exist."""
    os.makedirs(path, exist_ok=True)


def get_analysis_path(filepath: str) -> str:
    """Get path to analysis file."""
    basename = os.path.basename(filepath)
    name = os.path.splitext(basename)[0]
    return os.path.join(ANALYSIS_DIR, f"{name}{ANALYSIS_EXT}")


def detect_beats(audio: np.ndarray, sample_rate: int) -> Tuple[float, List[float], float]:
    """
    Find BPM and beat positions.

    Returns:
        (bpm, beat_positions, confidence)
    """
    # RhythmExtractor2013 — most reliable for electronic music
    rhythm_extractor = es.RhythmExtractor2013(
        method="multifeature",
        minTempo=100,
        maxTempo=220,
    )
    
    bpm, beats, beats_confidence, _, _ = rhythm_extractor(audio)
    
    # Convert beats to list of seconds
    beat_positions = beats.tolist() if isinstance(beats, np.ndarray) else list(beats)
    
    return float(bpm), beat_positions, float(beats_confidence)


def detect_onsets(audio: np.ndarray, sample_rate: int) -> List[float]:
    """
    Find onsets (transients — starts of hits, sounds).

    Returns:
        List of times in seconds
    """
    # OnsetDetection with HFC (High Frequency Content) — better for percussive sounds
    onset_algo = es.OnsetDetection(method="hfc")
    
    # Windowing and FFT
    w = es.Windowing(type='hann')
    fft = es.FFT()
    c2p = es.CartesianToPolar()
    
    # Compute onset detection function
    onset_times = []
    onset_values = []
    
    frame_size = 1024
    hop_size = 512
    
    for frame in es.FrameGenerator(audio, frameSize=frame_size, hopSize=hop_size):
        mag, phase = c2p(fft(w(frame)))
        onset_val = onset_algo(mag, phase)
        onset_values.append(onset_val)
    
    # OnsetDetectionGlobal finds peaks in ODF
    onset_detect = es.OnsetDetectionGlobal()
    onsets = onset_detect(
        np.array(onset_values),
        np.array([]),  # no additional features
    )
    
    # Convert frame indices to seconds
    onset_times = [float(o * hop_size / sample_rate) for o in onsets]
    
    return onset_times


def analyze_structure(audio: np.ndarray, sample_rate: int, beats: List[float], bpm: float) -> Tuple[float, float]:
    """
    Track structure analysis: find intro end and outro start.

    Returns:
        (intro_end, outro_start) in seconds
    """
    duration = len(audio) / sample_rate
    
    if not beats or bpm <= 0:
        return duration * 0.1, duration * 0.9
    
    # Beat duration in seconds
    beat_duration = 60.0 / bpm
    bar_duration = beat_duration * 4  # 4/4 time

    # Phrase length (8 or 16 bars)
    phrase_duration = bar_duration * 16  # 16 bars = typical phrase

    # Find Novelty Curve — spectral changes
    # Helps detect section boundaries
    novelty = []
    hop_size = 512
    frame_size = 2048
    
    w = es.Windowing(type='hann')
    spectrum = es.Spectrum()
    
    prev_spec = None
    for frame in es.FrameGenerator(audio, frameSize=frame_size, hopSize=hop_size, startFromZero=True):
        spec = spectrum(w(frame))
        if prev_spec is not None:
            # Cosine distance between spectra = change
            diff = np.sum(np.abs(spec - prev_spec))
            novelty.append(diff)
        prev_spec = spec
    
    if not novelty:
        return duration * 0.1, duration * 0.9
    
    novelty = np.array(novelty)
    
    # Smooth novelty curve
    window_size = int(phrase_duration * sample_rate / hop_size / 2)  # half-phrase window
    if window_size > 1:
        novelty_smooth = np.convolve(novelty, np.ones(window_size)/window_size, mode='same')
    else:
        novelty_smooth = novelty
    
    # Find first significant novelty peak after 8 bars — likely the drop
    min_intro_bars = 8
    min_intro_time = min_intro_bars * bar_duration
    min_intro_frame = int(min_intro_time * sample_rate / hop_size)
    
    intro_end = duration * 0.1
    if len(novelty_smooth) > min_intro_frame:
        # Search for novelty peak in first half of track
        search_end = len(novelty_smooth) // 2
        peak_idx = min_intro_frame + np.argmax(novelty_smooth[min_intro_frame:search_end])
        intro_end = peak_idx * hop_size / sample_rate
    
    # Find outro start — where novelty drops and stays low
    # Search for last significant peak before end
    outro_start = duration * 0.85
    if len(novelty_smooth) > 100:
        # Analyze second half
        half_point = len(novelty_smooth) // 2
        # Find where novelty drops and stays low
        threshold = np.mean(novelty_smooth[half_point:]) * 0.5
        for i in range(len(novelty_smooth) - 1, half_point, -1):
            if novelty_smooth[i] > threshold:
                outro_start = i * hop_size / sample_rate
                break
    
    return intro_end, outro_start


def find_mix_points(beats: List[float], bpm: float, duration: float,
                    intro_end: float, outro_start: float) -> List[MixPoint]:
    """
    Find optimal mix points.

    Mix-in: at track start, on phrase boundary, preferably in intro
    Mix-out: at track end, on phrase boundary, preferably in outro

    Returns:
        List of MixPoint
    """
    mix_points = []
    
    if not beats or bpm <= 0:
        # Fallback: just start and end
        mix_points.append(MixPoint(time=0.0, type="mix_in", confidence=0.5, bar_number=0))
        mix_points.append(MixPoint(time=duration * 0.9, type="mix_out", confidence=0.5, bar_number=0))
        return mix_points
    
    beat_duration = 60.0 / bpm
    bar_duration = beat_duration * 4
    
    # Phrase size (number of bars)
    phrase_bars = 16
    phrase_duration = bar_duration * phrase_bars
    
    # --- MIX-IN points ---
    # Find first phrase boundary after start (16, 32 bars)
    for bar_offset in [0, 16, 32, 48]:
        time_offset = bar_offset * bar_duration
        if time_offset >= duration:
            break
        
        # Find closest beat
        closest_beat = min(beats, key=lambda b: abs(b - time_offset))
        beat_idx = beats.index(closest_beat)
        
        # Confidence: better if in intro and exactly on phrase boundary
        is_in_intro = closest_beat <= intro_end
        time_diff = abs(closest_beat - time_offset)
        confidence = 0.7 if is_in_intro else 0.5
        confidence -= time_diff / bar_duration * 0.2  # penalty for imprecision
        confidence = max(0.3, min(1.0, confidence))
        
        mix_points.append(MixPoint(
            time=closest_beat,
            type="mix_in",
            confidence=confidence,
            bar_number=bar_offset
        ))
    
    # --- MIX-OUT points ---
    # Find phrase boundaries before track end, starting from outro_start
    outro_start_bar = int(outro_start / bar_duration)
    # Round to nearest phrase
    outro_phrase_bar = ((outro_start_bar // phrase_bars) + 1) * phrase_bars
    
    for bar_offset in [outro_phrase_bar, outro_phrase_bar + 16, outro_phrase_bar + 32]:
        time_offset = bar_offset * bar_duration
        if time_offset >= duration - bar_duration:
            break
        
        closest_beat = min(beats, key=lambda b: abs(b - time_offset))
        
        # Confidence: better if in outro
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
    
    # Sort by time
    mix_points.sort(key=lambda x: x.time)
    
    return mix_points


def analyze_file(filepath: str) -> Optional[TrackAnalysis]:
    """
    Full analysis of a single file.
    """
    print(f"[*] Analyzing: {os.path.basename(filepath)}...")
    
    try:
        # Load audio
        loader = es.MonoLoader(filename=filepath, sampleRate=44100)
        audio = loader()
        
        sample_rate = 44100
        duration = len(audio) / sample_rate
        
        print(f"    Duration: {duration:.1f}s")
        
        # 1. Find BPM and beats
        print(f"    Detecting beats...")
        bpm, beats, bpm_confidence = detect_beats(audio, sample_rate)
        print(f"    BPM: {bpm:.1f} (confidence: {bpm_confidence:.2f})")
        
        # 2. Find onsets
        print(f"    Detecting onsets...")
        onsets = detect_onsets(audio, sample_rate)
        print(f"    Found {len(onsets)} onsets")
        
        # 3. Analyze structure
        print(f"    Analyzing structure...")
        intro_end, outro_start = analyze_structure(audio, sample_rate, beats, bpm)
        print(f"    Intro ends: {intro_end:.1f}s, Outro starts: {outro_start:.1f}s")
        
        # 4. Find mix points
        print(f"    Finding mix points...")
        mix_points = find_mix_points(beats, bpm, duration, intro_end, outro_start)
        print(f"    Found {len(mix_points)} mix points")
        
        # Build result
        analysis = TrackAnalysis(
            filepath=filepath,
            duration=duration,
            bpm=bpm,
            bpm_confidence=bpm_confidence,
            beats=beats[:200] if len(beats) > 200 else beats,  # limit size
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
    """Save analysis to JSON."""
    analysis_path = get_analysis_path(analysis.filepath)
    
    # Convert dataclass to dict
    data = asdict(analysis)
    
    with open(analysis_path, 'w') as f:
        json.dump(data, f, indent=2)
    
    print(f"    Saved to: {analysis_path}")


def load_analysis(filepath: str) -> Optional[TrackAnalysis]:
    """Load analysis from JSON."""
    analysis_path = get_analysis_path(filepath)
    
    if not os.path.exists(analysis_path):
        return None
    
    try:
        with open(analysis_path, 'r') as f:
            data = json.load(f)
        
        # Convert back to TrackAnalysis
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
    """Get set of already analyzed tracks."""
    existing = set()
    if not os.path.exists(ANALYSIS_DIR):
        return existing
    
    for f in os.listdir(ANALYSIS_DIR):
        if f.endswith(ANALYSIS_EXT):
            # Extract track name from analysis filename
            track_name = f[:-len(ANALYSIS_EXT)]
            existing.add(track_name)
    
    return existing


def get_all_music_files() -> List[str]:
    """Get list of all music files."""
    files = []
    if not os.path.exists(MUSIC_DIR):
        return files
    
    for f in os.listdir(MUSIC_DIR):
        if f.lower().endswith(('.wav', '.mp3', '.flac', '.ogg', '.aac', '.m4a')):
            files.append(os.path.join(MUSIC_DIR, f))
    
    return sorted(files)


def main():
    print("=" * 60)
    print("STUDIO 23 — Advanced Audio Analyzer (Essentia)")
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
            
            # Analyze
            analysis = analyze_file(filepath)
            
            if analysis:
                save_analysis(analysis)
                print()
        
        # Cleanup deleted files
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
