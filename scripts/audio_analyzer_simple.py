#!/usr/bin/env python3
"""
SYSTEM 23 — Simple Audio Analyzer (Essentia)
Сканирует треки и сохраняет в простой текстовый формат как BPM map.

Формат .analysis_map:
filepath|bpm|duration|intro_end|outro_start|mix_in|mix_out
"""

import os
import sys
import time
import essentia
import essentia.standard as es

MUSIC_DIR = "/music"
ANALYSIS_MAP = os.path.join(MUSIC_DIR, ".analysis_map")
SCAN_INTERVAL = 15


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


def analyze_file(filepath):
    """Analyze single file with Essentia."""
    try:
        print(f"[*] Analyzing: {os.path.basename(filepath)}...")
        
        # Load audio
        loader = es.MonoLoader(filename=filepath, sampleRate=44100)
        audio = loader()
        
        sample_rate = 44100
        duration = len(audio) / sample_rate
        
        # Get BPM and beat positions
        rhythm = es.RhythmExtractor2013(method="multifeature", minTempo=100, maxTempo=220)
        bpm, beats, confidence, _, _ = rhythm(audio)
        
        bpm = float(bpm)
        beats = list(beats) if hasattr(beats, '__iter__') else []
        
        print(f"    BPM: {bpm:.1f}, Duration: {duration:.1f}s, Beats: {len(beats)}")
        
        if bpm <= 0 or not beats:
            return None
        
        beat_duration = 60.0 / bpm
        bar_duration = beat_duration * 4.0
        phrase_duration = bar_duration * 16.0  # 16 bars = phrase
        
        # Simple structure detection
        # Intro = first 16-32 bars (depending on track length)
        # Outro = last 16-32 bars
        
        intro_bars = 16.0
        if duration > 180:  # Long track
            intro_bars = 32.0
        
        intro_end = intro_bars * bar_duration
        
        # Outro starts 16-32 bars before end
        outro_bars = 16.0
        if duration > 180:
            outro_bars = 32.0
        outro_start = max(intro_end + bar_duration, duration - (outro_bars * bar_duration))
        
        # Mix points: start of phrases
        mix_in = 0.0  # Start of track (first phrase)
        
        # Find mix_out: start of outro, aligned to phrase boundary
        outro_start_bar = int(outro_start / bar_duration)
        # Round up to next 16-bar phrase
        phrase_bar = ((outro_start_bar // 16) + 1) * 16
        mix_out = phrase_bar * bar_duration
        
        # Ensure mix_out is within track
        if mix_out >= duration - bar_duration:
            mix_out = max(intro_end + phrase_duration, duration - (16 * bar_duration))
        
        print(f"    Intro: {intro_end:.1f}s, Outro: {outro_start:.1f}s")
        print(f"    Mix in: {mix_in:.1f}s, Mix out: {mix_out:.1f}s")
        
        return {
            'filepath': filepath,
            'bpm': bpm,
            'duration': duration,
            'intro_end': intro_end,
            'outro_start': outro_start,
            'mix_in': mix_in,
            'mix_out': mix_out
        }
        
    except Exception as e:
        print(f"    ERROR: {e}")
        return None


def save_analysis(data):
    """Append analysis to map file."""
    line = f"{data['filepath']}|{data['bpm']:.1f}|{data['duration']:.1f}|{data['intro_end']:.1f}|{data['outro_start']:.1f}|{data['mix_in']:.1f}|{data['mix_out']:.1f}\n"
    
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
    print("SYSTEM 23 — Audio Analyzer (Essentia)")
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
        
        # Analyze new files
        for filepath in sorted(files):
            if filepath in existing:
                continue
            
            # Skip if file is still being copied
            if not is_file_stable(filepath):
                print(f"[~] Skipping {os.path.basename(filepath)} — still copying")
                continue
            
            result = analyze_file(filepath)
            if result:
                save_analysis(result)
                print()
        
        # Cleanup
        cleanup_removed(existing)
        
        time.sleep(SCAN_INTERVAL)


if __name__ == "__main__":
    main()
