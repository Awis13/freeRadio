#!/bin/bash

# ============================================
# STUDIO 23 — BPM Scanner (Live Daemon)
#
# Runs continuously. Every N seconds
# checks /music for new tracks
# not yet in .bpm_map.
# New tracks are scanned and appended.
#
# Drop a track in the folder -> within 15s
# it's in the BPM map -> Liquidsoap picks it up.
# ============================================

MUSIC_DIR="/music"
BPM_MAP="${MUSIC_DIR}/.bpm_map"
SCAN_INTERVAL=15   # Seconds between checks

set -Eeuo pipefail

echo "=========================================="
echo "  STUDIO 23 — BPM Scanner (Live Mode)"
echo "  Watching: ${MUSIC_DIR}"
echo "  Interval: ${SCAN_INTERVAL}s"
echo "=========================================="

# Create .bpm_map if it doesn't exist
touch "$BPM_MAP"

# --- Function: scan a single file ---
scan_file() {
  local FILE="$1"
  local BASENAME
  BASENAME=$(basename "$FILE")

  # Check if already scanned
  if grep -qF "${FILE}|" "$BPM_MAP" 2>/dev/null; then
    return 0
  fi

  # Check that file is not still being written
  # (wait for size to stabilize)
  local SIZE1 SIZE2
  SIZE1=$(stat -c%s "$FILE" 2>/dev/null || echo "0")
  sleep 2
  SIZE2=$(stat -c%s "$FILE" 2>/dev/null || echo "0")
  if [ "$SIZE1" != "$SIZE2" ]; then
    echo "[~] ${BASENAME} -- still copying, skip for now"
    return 1
  fi

  # Scan BPM
  echo -n "[*] Scanning: ${BASENAME}... "
  local BPM RAW_BPM
  RAW_BPM=$(aubio tempo -i "$FILE" 2>/dev/null | tail -1 | awk '{printf "%.1f", $1}')

  if [ -z "$RAW_BPM" ] || [ "$RAW_BPM" = "0.0" ]; then
    echo "SKIP (BPM not detected)"
    echo "${FILE}|0.0" >> "$BPM_MAP"
    return 0
  fi

  # Fix octave ambiguity: aubio often detects half-BPM (first harmonic)
  # Check all octaves and pick the one in the typical dance music range (80-250 BPM)
  BPM="$RAW_BPM"
  local BPM_DOUBLED BPM_HALVED
  BPM_DOUBLED=$(awk "BEGIN {printf \"%.1f\", $RAW_BPM * 2}")
  BPM_HALVED=$(awk "BEGIN {printf \"%.1f\", $RAW_BPM / 2}")
  
  # Check which variants fall into reasonable dance range
  # Raw: 80-300, Doubled: must be <= 250 (avoid 270+ BPM which is unrealistic)
  local IN_RANGE_RAW IN_RANGE_DOUBLE IN_RANGE_HALF
  IN_RANGE_RAW=$(awk "BEGIN {print ($RAW_BPM >= 80 && $RAW_BPM <= 300) ? 1 : 0}")
  IN_RANGE_DOUBLE=$(awk "BEGIN {print ($BPM_DOUBLED >= 80 && $BPM_DOUBLED <= 250) ? 1 : 0}")
  IN_RANGE_HALF=$(awk "BEGIN {print ($BPM_HALVED >= 80 && $BPM_HALVED <= 300) ? 1 : 0}")
  
  # Priority: prefer higher BPM when both are valid (electronic music tends to be faster)
  # This handles the common case where aubio reports 85 instead of 170
  if [ "$IN_RANGE_DOUBLE" = "1" ]; then
    # Doubled is valid - use it (catches 85→170, 134→268[clamped])
    BPM="$BPM_DOUBLED"
    if [ "$BPM" != "$RAW_BPM" ]; then
      echo -n "(${RAW_BPM}→${BPM}) "
    fi
  elif [ "$IN_RANGE_RAW" = "0" ] && [ "$IN_RANGE_HALF" = "1" ]; then
    # Only halved is valid (rare, for very fast tracks)
    BPM="$BPM_HALVED"
    echo -n "(${RAW_BPM}→${BPM}) "
  fi

  echo "${FILE}|${BPM}" >> "$BPM_MAP"
  echo "${BPM} BPM"
  return 0
}

# --- Function: remove map entries for deleted files ---
cleanup_map() {
  if [ ! -s "$BPM_MAP" ]; then
    return
  fi

  local TEMP_MAP="${BPM_MAP}.tmp"
  > "$TEMP_MAP"

  while IFS='|' read -r FILE BPM; do
    if [ -f "$FILE" ]; then
      echo "${FILE}|${BPM}" >> "$TEMP_MAP"
    else
      echo "[-] Removed from map: $(basename "$FILE")"
    fi
  done < "$BPM_MAP"

  mv "$TEMP_MAP" "$BPM_MAP"
}

find_music_files() {
  # NUL-separated output so filenames with spaces/unicode are safe.
  find "$MUSIC_DIR" -maxdepth 1 -type f \( \
    -iname "*.wav" -o -iname "*.mp3" -o -iname "*.flac" -o -iname "*.ogg" -o -iname "*.aac" -o -iname "*.m4a" \
  \) -print0
}

# --- Initial full scan ---
echo "[*] Initial scan..."
initial_scan() {
  while IFS= read -r -d '' FILE; do
    scan_file "$FILE"
  done < <(find_music_files | sort -z)
}

initial_scan

# Show summary
TOTAL=$(grep -c '|' "$BPM_MAP" 2>/dev/null || echo "0")
DETECTED=$(grep -v '|0.0$' "$BPM_MAP" 2>/dev/null | wc -l || echo "0")
echo "=========================================="
echo "[+] Initial scan done: ${DETECTED}/${TOTAL} tracks with BPM"
echo "[*] Now watching for new files..."
echo "=========================================="

# --- Infinite monitoring loop ---
while true; do
  sleep "$SCAN_INTERVAL"

  # Find new files
  while IFS= read -r -d '' FILE; do
    if ! grep -qF "${FILE}|" "$BPM_MAP" 2>/dev/null; then
      scan_file "$FILE"
    fi
  done < <(find_music_files)

  # Clean up deleted files
  cleanup_map
done
