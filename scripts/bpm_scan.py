#!/usr/bin/env python3
"""BPM Scanner with librosa - handles octave ambiguity correctly."""

import os
import sys
import time
import librosa

MUSIC_DIR = "/music"
BPM_MAP = os.path.join(MUSIC_DIR, ".bpm_map")
SCAN_INTERVAL = 15


def get_existing_tracks():
    """Read already scanned tracks from BPM map."""
    existing = {}
    if os.path.exists(BPM_MAP):
        with open(BPM_MAP, 'r') as f:
            for line in f:
                line = line.strip()
                if '|' in line:
                    filepath, bpm = line.rsplit('|', 1)
                    existing[filepath] = float(bpm)
    return existing


def scan_file(filepath):
    """Scan BPM using librosa."""
    try:
        # Load audio
        y, sr = librosa.load(filepath, sr=None, duration=60)  # First 60s enough for BPM
        
        # Get tempo - librosa handles octave ambiguity internally
        # Use start_bpm to hint at faster tempos (helps with octave detection)
        # Check multiple starting points and pick most confident
        tempos = []
        for start in [170, 130, 85]:  # Try fast, medium, slow
            t, _ = librosa.beat.beat_track(y=y, sr=sr, start_bpm=start)
            import numpy as np
            if isinstance(t, np.ndarray):
                t = float(t[0]) if t.size > 0 else 0.0
            else:
                t = float(t)
            if t > 0:
                tempos.append(t)
        
        # Pick tempo closest to 170 (typical for hard techno)
        # but also consider if it's in "musical" range (100-200)
        if not tempos:
            return 0.0
        
        # Prefer tempos in 140-200 range, closest to 170
        valid_tempos = [t for t in tempos if 100 <= t <= 220]
        if not valid_tempos:
            valid_tempos = tempos
        
        tempo = min(valid_tempos, key=lambda t: abs(t - 170))
        return round(tempo, 1)
    except Exception as e:
        import traceback
        print(f"Error scanning {filepath}: {e}", file=sys.stderr)
        traceback.print_exc()
        return 0.0


def main():
    print("=" * 50)
    print("SYSTEM 23 — BPM Scanner (librosa)")
    print(f"Watching: {MUSIC_DIR}")
    print("=" * 50)
    
    while True:
        existing = get_existing_tracks()
        
        # Find all music files
        files = []
        for f in os.listdir(MUSIC_DIR):
            if f.lower().endswith(('.wav', '.mp3', '.flac', '.ogg', '.aac', '.m4a')):
                filepath = os.path.join(MUSIC_DIR, f)
                files.append(filepath)
        
        # Scan new files
        for filepath in sorted(files):
            if filepath in existing:
                continue
            
            basename = os.path.basename(filepath)
            print(f"[*] Scanning: {basename}... ", end='', flush=True)
            
            bpm = scan_file(filepath)
            
            if bpm > 0:
                print(f"{bpm} BPM")
                with open(BPM_MAP, 'a') as f:
                    f.write(f"{filepath}|{bpm}\n")
            else:
                print("SKIP (not detected)")
                with open(BPM_MAP, 'a') as f:
                    f.write(f"{filepath}|0.0\n")
        
        # Cleanup removed files
        with open(BPM_MAP, 'r') as f:
            lines = f.readlines()
        
        new_lines = []
        for line in lines:
            line = line.strip()
            if '|' in line:
                filepath = line.rsplit('|', 1)[0]
                if os.path.exists(filepath):
                    new_lines.append(line)
                else:
                    print(f"[-] Removed: {os.path.basename(filepath)}")
        
        with open(BPM_MAP, 'w') as f:
            f.write('\n'.join(new_lines) + '\n' if new_lines else '')
        
        time.sleep(SCAN_INTERVAL)


if __name__ == "__main__":
    main()
