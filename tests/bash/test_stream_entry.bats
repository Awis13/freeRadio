#!/usr/bin/env bats
# test_stream_entry.bats — comprehensive tests for stream_entry.sh functions

# ---------------------------------------------------------------------------
# Setup: load bats-support/bats-assert, then source extracted functions
# ---------------------------------------------------------------------------
setup() {
  # Determine project root from this file's location
  PROJECT_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"

  # Load bats-support and bats-assert
  load "$PROJECT_ROOT/node_modules/bats-support/load"
  load "$PROJECT_ROOT/node_modules/bats-assert/load"

  # Create a per-test temp directory
  TEST_DIR="$(mktemp -d)"
  export TEST_DIR
  export SHARED_DIR="$TEST_DIR/shared"
  mkdir -p "$SHARED_DIR"

  export HLS_DIR="$TEST_DIR/hls"
  mkdir -p "$HLS_DIR"

  # Build the sourceable extracted version of stream_entry.sh
  local src="$PROJECT_ROOT/scripts/stream_entry.sh"
  local out="$TEST_DIR/stream_functions.sh"

  awk '
    NR >= 366 && NR <= 373 { next }
    NR >= 835 && NR <= 841 { next }
    NR >= 1306             { next }
    { print }
  ' "$src" > "$out"

  # Disable exit-on-error so individual function failures do not abort tests
  sed -i.bak 's/^set -e$/set +e/' "$out"

  # Redirect /shared/ → ${SHARED_DIR}/  (all three quoting styles used in the source)
  sed -i.bak 's|"/shared/|"${SHARED_DIR}/|g' "$out"
  sed -i.bak "s|'/shared/|'\${SHARED_DIR}/|g" "$out"
  sed -i.bak 's| /shared/| ${SHARED_DIR}/|g' "$out"

  # Redirect /tmp/rtmp_platform_map.txt → ${TEST_DIR}/rtmp_platform_map.txt
  sed -i.bak 's|/tmp/rtmp_platform_map\.txt|${TEST_DIR}/rtmp_platform_map.txt|g' "$out"

  rm -f "$out.bak"

  # Source the extracted functions into this shell
  # shellcheck source=/dev/null
  source "$out"
}

teardown() {
  rm -rf "$TEST_DIR"
}

# ===========================================================================
# A. Pure case-switch functions (no file I/O)
# ===========================================================================

# ---------------------------------------------------------------------------
# get_video_bitrate
# ---------------------------------------------------------------------------
@test "get_video_bitrate: low → 2000k" {
  run get_video_bitrate "low"
  assert_output "2000k"
}

@test "get_video_bitrate: medium → 4000k" {
  run get_video_bitrate "medium"
  assert_output "4000k"
}

@test "get_video_bitrate: kick → 6000k" {
  run get_video_bitrate "kick"
  assert_output "6000k"
}

@test "get_video_bitrate: standard → 6000k" {
  run get_video_bitrate "standard"
  assert_output "6000k"
}

@test "get_video_bitrate: ultra → 12000k" {
  run get_video_bitrate "ultra"
  assert_output "12000k"
}

@test "get_video_bitrate: godmode → 12000k" {
  run get_video_bitrate "godmode"
  assert_output "12000k"
}

@test "get_video_bitrate: high → 6000k (default)" {
  run get_video_bitrate "high"
  assert_output "6000k"
}

@test "get_video_bitrate: unknown → 6000k (default)" {
  run get_video_bitrate "unknown"
  assert_output "6000k"
}

@test "get_video_bitrate: empty string → 6000k (default)" {
  run get_video_bitrate ""
  assert_output "6000k"
}

# ---------------------------------------------------------------------------
# get_audio_bitrate
# ---------------------------------------------------------------------------
@test "get_audio_bitrate: low → 128k" {
  run get_audio_bitrate "low"
  assert_output "128k"
}

@test "get_audio_bitrate: medium → 192k" {
  run get_audio_bitrate "medium"
  assert_output "192k"
}

@test "get_audio_bitrate: kick → 192k" {
  run get_audio_bitrate "kick"
  assert_output "192k"
}

@test "get_audio_bitrate: standard → 192k" {
  run get_audio_bitrate "standard"
  assert_output "192k"
}

@test "get_audio_bitrate: ultra → 320k" {
  run get_audio_bitrate "ultra"
  assert_output "320k"
}

@test "get_audio_bitrate: godmode → 320k" {
  run get_audio_bitrate "godmode"
  assert_output "320k"
}

@test "get_audio_bitrate: high → 256k (default)" {
  run get_audio_bitrate "high"
  assert_output "256k"
}

@test "get_audio_bitrate: empty string → 256k (default)" {
  run get_audio_bitrate ""
  assert_output "256k"
}

# ---------------------------------------------------------------------------
# get_preset_speed
# ---------------------------------------------------------------------------
@test "get_preset_speed: godmode → veryfast" {
  run get_preset_speed "godmode"
  assert_output "veryfast"
}

@test "get_preset_speed: kick → veryfast" {
  run get_preset_speed "kick"
  assert_output "veryfast"
}

@test "get_preset_speed: standard → veryfast" {
  run get_preset_speed "standard"
  assert_output "veryfast"
}

@test "get_preset_speed: ultra → fast" {
  run get_preset_speed "ultra"
  assert_output "fast"
}

@test "get_preset_speed: high → veryfast (default)" {
  run get_preset_speed "high"
  assert_output "veryfast"
}

@test "get_preset_speed: unknown → veryfast (default)" {
  run get_preset_speed "unknown_preset"
  assert_output "veryfast"
}

# ---------------------------------------------------------------------------
# get_x264_extras
# ---------------------------------------------------------------------------
@test "get_x264_extras: ultra → -tune animation" {
  run get_x264_extras "ultra"
  assert_output "-tune animation"
}

@test "get_x264_extras: godmode → -tune animation" {
  run get_x264_extras "godmode"
  assert_output "-tune animation"
}

@test "get_x264_extras: kick → empty string" {
  run get_x264_extras "kick"
  assert_output ""
}

@test "get_x264_extras: standard → empty string" {
  run get_x264_extras "standard"
  assert_output ""
}

@test "get_x264_extras: high → empty string (default)" {
  run get_x264_extras "high"
  assert_output ""
}

@test "get_x264_extras: empty string → empty string (default)" {
  run get_x264_extras ""
  assert_output ""
}

# ---------------------------------------------------------------------------
# get_fps
# ---------------------------------------------------------------------------
@test "get_fps: ultra60 → 60" {
  run get_fps "ultra60"
  assert_output "60"
}

@test "get_fps: godmode60 → 60" {
  run get_fps "godmode60"
  assert_output "60"
}

@test "get_fps: high → 30 (default)" {
  run get_fps "high"
  assert_output "30"
}

@test "get_fps: godmode (without 60) → 30 (default)" {
  run get_fps "godmode"
  assert_output "30"
}

@test "get_fps: ultra (without 60) → 30 (default)" {
  run get_fps "ultra"
  assert_output "30"
}

@test "get_fps: empty string → 30 (default)" {
  run get_fps ""
  assert_output "30"
}

# ---------------------------------------------------------------------------
# get_gop_size
# ---------------------------------------------------------------------------
@test "get_gop_size: ultra60 → 120" {
  run get_gop_size "ultra60"
  assert_output "120"
}

@test "get_gop_size: godmode60 → 120" {
  run get_gop_size "godmode60"
  assert_output "120"
}

@test "get_gop_size: high → 60 (default)" {
  run get_gop_size "high"
  assert_output "60"
}

@test "get_gop_size: godmode (without 60) → 60 (default)" {
  run get_gop_size "godmode"
  assert_output "60"
}

@test "get_gop_size: empty string → 60 (default)" {
  run get_gop_size ""
  assert_output "60"
}

# ===========================================================================
# B. File-reading functions (use $SHARED_DIR temp files)
# ===========================================================================

# ---------------------------------------------------------------------------
# get_stream_mode
# ---------------------------------------------------------------------------
@test "get_stream_mode: no file → standby" {
  rm -f "$SHARED_DIR/stream_mode.json"
  run get_stream_mode
  assert_output "standby"
}

@test "get_stream_mode: mode=live → live" {
  echo '{"mode":"live"}' > "$SHARED_DIR/stream_mode.json"
  run get_stream_mode
  assert_output "live"
}

@test "get_stream_mode: mode=armed → armed" {
  echo '{"mode":"armed"}' > "$SHARED_DIR/stream_mode.json"
  run get_stream_mode
  assert_output "armed"
}

@test "get_stream_mode: mode=standby → standby" {
  echo '{"mode":"standby"}' > "$SHARED_DIR/stream_mode.json"
  run get_stream_mode
  assert_output "standby"
}

@test "get_stream_mode: unknown mode → standby" {
  echo '{"mode":"unknown_mode"}' > "$SHARED_DIR/stream_mode.json"
  run get_stream_mode
  assert_output "standby"
}

@test "get_stream_mode: empty file → standby" {
  echo '' > "$SHARED_DIR/stream_mode.json"
  run get_stream_mode
  assert_output "standby"
}

# ---------------------------------------------------------------------------
# is_streaming_enabled
# ---------------------------------------------------------------------------
@test "is_streaming_enabled: no control file → enabled (return 0)" {
  rm -f "$SHARED_DIR/stream_control.json"
  run is_streaming_enabled
  assert_success
}

@test "is_streaming_enabled: streaming=false → disabled (return 1)" {
  echo '{"streaming":false}' > "$SHARED_DIR/stream_control.json"
  run is_streaming_enabled
  assert_failure
}

@test "is_streaming_enabled: streaming=false with space → disabled (return 1)" {
  echo '{"streaming": false}' > "$SHARED_DIR/stream_control.json"
  run is_streaming_enabled
  assert_failure
}

@test "is_streaming_enabled: streaming=true → enabled (return 0)" {
  echo '{"streaming":true}' > "$SHARED_DIR/stream_control.json"
  run is_streaming_enabled
  assert_success
}

@test "is_streaming_enabled: file missing streaming key → enabled (return 0)" {
  echo '{"broadcast":true}' > "$SHARED_DIR/stream_control.json"
  run is_streaming_enabled
  assert_success
}

# ---------------------------------------------------------------------------
# get_broadcast_enabled
# ---------------------------------------------------------------------------
@test "get_broadcast_enabled: no control file → false" {
  rm -f "$SHARED_DIR/stream_control.json"
  run get_broadcast_enabled
  assert_output "false"
}

@test "get_broadcast_enabled: broadcast=true → true" {
  echo '{"broadcast":true}' > "$SHARED_DIR/stream_control.json"
  run get_broadcast_enabled
  assert_output "true"
}

@test "get_broadcast_enabled: broadcast=true with space → true" {
  echo '{"broadcast": true}' > "$SHARED_DIR/stream_control.json"
  run get_broadcast_enabled
  assert_output "true"
}

@test "get_broadcast_enabled: broadcast=false → false" {
  echo '{"broadcast":false}' > "$SHARED_DIR/stream_control.json"
  run get_broadcast_enabled
  assert_output "false"
}

@test "get_broadcast_enabled: file missing broadcast key → false" {
  echo '{"streaming":true}' > "$SHARED_DIR/stream_control.json"
  run get_broadcast_enabled
  assert_output "false"
}

# ---------------------------------------------------------------------------
# get_visual_mode
# ---------------------------------------------------------------------------
@test "get_visual_mode: no file → visual-radio" {
  rm -f "$SHARED_DIR/visual_mode.json"
  run get_visual_mode
  assert_output "visual-radio"
}

@test "get_visual_mode: mode=live → live" {
  echo '{"mode":"live"}' > "$SHARED_DIR/visual_mode.json"
  run get_visual_mode
  assert_output "live"
}

@test "get_visual_mode: mode=radio → live (alias)" {
  echo '{"mode":"radio"}' > "$SHARED_DIR/visual_mode.json"
  run get_visual_mode
  assert_output "live"
}

@test "get_visual_mode: mode=video-playlist → video-playlist" {
  echo '{"mode":"video-playlist"}' > "$SHARED_DIR/visual_mode.json"
  run get_visual_mode
  assert_output "video-playlist"
}

@test "get_visual_mode: mode=visual-radio → visual-radio" {
  echo '{"mode":"visual-radio"}' > "$SHARED_DIR/visual_mode.json"
  run get_visual_mode
  assert_output "visual-radio"
}

@test "get_visual_mode: unknown mode → visual-radio" {
  echo '{"mode":"other_mode"}' > "$SHARED_DIR/visual_mode.json"
  run get_visual_mode
  assert_output "visual-radio"
}

# ---------------------------------------------------------------------------
# get_live_obs_status
# ---------------------------------------------------------------------------
@test "get_live_obs_status: no file → offline" {
  rm -f "$SHARED_DIR/live_mode.json"
  run get_live_obs_status
  assert_output "offline"
}

@test "get_live_obs_status: obsStatus=connected → connected" {
  echo '{"obsStatus":"connected"}' > "$SHARED_DIR/live_mode.json"
  run get_live_obs_status
  assert_output "connected"
}

@test "get_live_obs_status: obsStatus=disconnected → disconnected" {
  echo '{"obsStatus":"disconnected"}' > "$SHARED_DIR/live_mode.json"
  run get_live_obs_status
  assert_output "disconnected"
}

@test "get_live_obs_status: other obsStatus → offline" {
  echo '{"obsStatus":"reconnecting"}' > "$SHARED_DIR/live_mode.json"
  run get_live_obs_status
  assert_output "offline"
}

@test "get_live_obs_status: missing obsStatus key → offline" {
  echo '{"afkFallback":"visual-radio"}' > "$SHARED_DIR/live_mode.json"
  run get_live_obs_status
  assert_output "offline"
}

# ---------------------------------------------------------------------------
# get_live_afk_fallback
# ---------------------------------------------------------------------------
@test "get_live_afk_fallback: no file → visual-radio" {
  rm -f "$SHARED_DIR/live_mode.json"
  run get_live_afk_fallback
  assert_output "visual-radio"
}

@test "get_live_afk_fallback: afkFallback=video-playlist → video-playlist" {
  echo '{"afkFallback":"video-playlist"}' > "$SHARED_DIR/live_mode.json"
  run get_live_afk_fallback
  assert_output "video-playlist"
}

@test "get_live_afk_fallback: afkFallback=visual-radio → visual-radio" {
  echo '{"afkFallback":"visual-radio"}' > "$SHARED_DIR/live_mode.json"
  run get_live_afk_fallback
  assert_output "visual-radio"
}

@test "get_live_afk_fallback: other afkFallback value → visual-radio" {
  echo '{"afkFallback":"some-other-mode"}' > "$SHARED_DIR/live_mode.json"
  run get_live_afk_fallback
  assert_output "visual-radio"
}

@test "get_live_afk_fallback: missing afkFallback key → visual-radio" {
  echo '{"obsStatus":"connected"}' > "$SHARED_DIR/live_mode.json"
  run get_live_afk_fallback
  assert_output "visual-radio"
}

# ---------------------------------------------------------------------------
# get_live_ingest_key
# ---------------------------------------------------------------------------
@test "get_live_ingest_key: no file → empty string" {
  rm -f "$SHARED_DIR/live_mode.json"
  run get_live_ingest_key
  assert_output ""
}

@test "get_live_ingest_key: ingestKey present → returns key" {
  echo '{"ingestKey":"abc123"}' > "$SHARED_DIR/live_mode.json"
  run get_live_ingest_key
  assert_output "abc123"
}

@test "get_live_ingest_key: ingestKey with complex value" {
  echo '{"ingestKey":"stream-key-xyz-789"}' > "$SHARED_DIR/live_mode.json"
  run get_live_ingest_key
  assert_output "stream-key-xyz-789"
}

@test "get_live_ingest_key: missing ingestKey → empty string" {
  echo '{"obsStatus":"connected","afkFallback":"visual-radio"}' > "$SHARED_DIR/live_mode.json"
  run get_live_ingest_key
  assert_output ""
}

# ---------------------------------------------------------------------------
# get_quality_settings
# ---------------------------------------------------------------------------
@test "get_quality_settings: no file → default JSON" {
  rm -f "$SHARED_DIR/stream_quality.json"
  run get_quality_settings
  assert_output '{"preset":"high"}'
}

@test "get_quality_settings: file exists → returns file content" {
  echo '{"preset":"ultra"}' > "$SHARED_DIR/stream_quality.json"
  run get_quality_settings
  assert_output '{"preset":"ultra"}'
}

@test "get_quality_settings: file with complex content" {
  echo '{"preset":"godmode","extra":true}' > "$SHARED_DIR/stream_quality.json"
  run get_quality_settings
  assert_output '{"preset":"godmode","extra":true}'
}

# ---------------------------------------------------------------------------
# get_audio_settings
# ---------------------------------------------------------------------------
@test "get_audio_settings: no file → default JSON" {
  rm -f "$SHARED_DIR/stream_audio.json"
  run get_audio_settings
  assert_output '{"enhanced":false}'
}

@test "get_audio_settings: file exists → returns file content" {
  echo '{"enhanced":true}' > "$SHARED_DIR/stream_audio.json"
  run get_audio_settings
  assert_output '{"enhanced":true}'
}

# ---------------------------------------------------------------------------
# get_video_settings
# ---------------------------------------------------------------------------
@test "get_video_settings: no file → default JSON" {
  rm -f "$SHARED_DIR/stream_video.json"
  run get_video_settings
  assert_output '{"enhanced":false}'
}

@test "get_video_settings: file exists → returns file content" {
  echo '{"enhanced":true}' > "$SHARED_DIR/stream_video.json"
  run get_video_settings
  assert_output '{"enhanced":true}'
}

# ---------------------------------------------------------------------------
# get_audio_filter
# ---------------------------------------------------------------------------
@test "get_audio_filter: enhanced=false → empty string" {
  echo '{"enhanced":false}' > "$SHARED_DIR/stream_audio.json"
  run get_audio_filter
  assert_output ""
}

@test "get_audio_filter: no audio file → empty string (default enhanced=false)" {
  rm -f "$SHARED_DIR/stream_audio.json"
  run get_audio_filter
  assert_output ""
}

@test "get_audio_filter: enhanced=true → loudnorm filter string" {
  echo '{"enhanced":true}' > "$SHARED_DIR/stream_audio.json"
  run get_audio_filter
  assert_output "loudnorm=I=-14:TP=-1.5:LRA=11,highpass=f=40,lowpass=f=18000,equalizer=f=100:t=h:width=200:g=2,equalizer=f=1000:t=h:width=200:g=1,equalizer=f=10000:t=h:width=2000:g=2"
}

@test "get_audio_filter: enhanced=true with spaces in JSON → loudnorm filter" {
  echo '{"enhanced": true}' > "$SHARED_DIR/stream_audio.json"
  run get_audio_filter
  assert_output "loudnorm=I=-14:TP=-1.5:LRA=11,highpass=f=40,lowpass=f=18000,equalizer=f=100:t=h:width=200:g=2,equalizer=f=1000:t=h:width=200:g=1,equalizer=f=10000:t=h:width=2000:g=2"
}

# ---------------------------------------------------------------------------
# get_video_enhancement_filter
# ---------------------------------------------------------------------------
@test "get_video_enhancement_filter: enhanced=false → empty string" {
  echo '{"enhanced":false}' > "$SHARED_DIR/stream_video.json"
  run get_video_enhancement_filter
  assert_output ""
}

@test "get_video_enhancement_filter: no video file → empty string (default enhanced=false)" {
  rm -f "$SHARED_DIR/stream_video.json"
  run get_video_enhancement_filter
  assert_output ""
}

@test "get_video_enhancement_filter: enhanced=true → eq/unsharp/deband filter" {
  echo '{"enhanced":true}' > "$SHARED_DIR/stream_video.json"
  run get_video_enhancement_filter
  assert_output "eq=saturation=1.15:contrast=1.03,unsharp=3:3:0.5,deband"
}

@test "get_video_enhancement_filter: enhanced=true with spaces in JSON → eq/unsharp/deband filter" {
  echo '{"enhanced": true}' > "$SHARED_DIR/stream_video.json"
  run get_video_enhancement_filter
  assert_output "eq=saturation=1.15:contrast=1.03,unsharp=3:3:0.5,deband"
}

# ===========================================================================
# C. String-parsing functions
# ===========================================================================

# ---------------------------------------------------------------------------
# get_rtmp_mode
# ---------------------------------------------------------------------------
@test "get_rtmp_mode: empty string → none" {
  run get_rtmp_mode ""
  assert_output "none"
}

@test "get_rtmp_mode: empty JSON array [] → none" {
  run get_rtmp_mode "[]"
  assert_output "none"
}

@test "get_rtmp_mode: only YouTube URLs → youtube" {
  local urls='[{"name":"YT","url":"rtmp://a.rtmp.youtube.com/live2/key"}]'
  run get_rtmp_mode "$urls"
  assert_output "youtube"
}

@test "get_rtmp_mode: multiple YouTube URLs → youtube" {
  local urls='[{"name":"YT1","url":"rtmp://a.rtmp.youtube.com/live2/key1"},{"name":"YT2","url":"rtmp://b.rtmp.youtu.be/live2/key2"}]'
  run get_rtmp_mode "$urls"
  assert_output "youtube"
}

@test "get_rtmp_mode: YouTube + Kick → multi" {
  local urls='[{"name":"YT","url":"rtmp://a.rtmp.youtube.com/live2/key"},{"name":"Kick","url":"rtmp://fa723fc1b171.global-contribute.live-video.net/app/key"}]'
  run get_rtmp_mode "$urls"
  assert_output "multi"
}

@test "get_rtmp_mode: only non-YouTube URL → multi" {
  local urls='[{"name":"Kick","url":"rtmp://fa723fc1b171.global-contribute.live-video.net/app/key"}]'
  run get_rtmp_mode "$urls"
  assert_output "multi"
}

@test "get_rtmp_mode: mixed YouTube and Twitch → multi" {
  local urls='[{"name":"YT","url":"rtmp://a.rtmp.youtube.com/live2/key"},{"name":"Twitch","url":"rtmp://live.twitch.tv/app/key"}]'
  run get_rtmp_mode "$urls"
  assert_output "multi"
}

# ---------------------------------------------------------------------------
# get_video_filter_with_scale
# ---------------------------------------------------------------------------
@test "get_video_filter_with_scale: godmode + base filter → scale 1440p prefixed" {
  run get_video_filter_with_scale "godmode" "somefilter" ""
  assert_output "scale=2560:1440:flags=lanczos,somefilter"
}

@test "get_video_filter_with_scale: godmode + no filters → scale 1440p only" {
  run get_video_filter_with_scale "godmode" "" ""
  assert_output "scale=2560:1440:flags=lanczos"
}

@test "get_video_filter_with_scale: godmode + enhance filter → scale + enhance" {
  run get_video_filter_with_scale "godmode" "" "eq=saturation=1.15"
  assert_output "scale=2560:1440:flags=lanczos,eq=saturation=1.15"
}

@test "get_video_filter_with_scale: godmode + base and enhance → scale + combined" {
  run get_video_filter_with_scale "godmode" "base_f" "enhance_f"
  assert_output "scale=2560:1440:flags=lanczos,base_f,enhance_f"
}

@test "get_video_filter_with_scale: standard + base filter → scale 1080p prefixed" {
  run get_video_filter_with_scale "standard" "somefilter" ""
  assert_output "scale=1920:1080:flags=lanczos,somefilter"
}

@test "get_video_filter_with_scale: kick + base filter → scale 1080p prefixed" {
  run get_video_filter_with_scale "kick" "somefilter" ""
  assert_output "scale=1920:1080:flags=lanczos,somefilter"
}

@test "get_video_filter_with_scale: standard + no filters → scale 1080p only" {
  run get_video_filter_with_scale "standard" "" ""
  assert_output "scale=1920:1080:flags=lanczos"
}

@test "get_video_filter_with_scale: high + filters → just the filters (no scale)" {
  run get_video_filter_with_scale "high" "somefilter" ""
  assert_output "somefilter"
}

@test "get_video_filter_with_scale: high + no filters → empty string" {
  run get_video_filter_with_scale "high" "" ""
  assert_output ""
}

@test "get_video_filter_with_scale: high + base and enhance → combined, no scale" {
  run get_video_filter_with_scale "high" "base_f" "enhance_f"
  assert_output "base_f,enhance_f"
}

@test "get_video_filter_with_scale: ultra + base filter → just the filters (no scale)" {
  run get_video_filter_with_scale "ultra" "somefilter" ""
  assert_output "somefilter"
}

# ---------------------------------------------------------------------------
# file_sig
# ---------------------------------------------------------------------------
@test "file_sig: non-existing file → none" {
  run file_sig "$TEST_DIR/no_such_file.json"
  assert_output "none"
}

@test "file_sig: existing file → non-empty string (not 'none')" {
  local f="$TEST_DIR/testfile.txt"
  echo "hello" > "$f"
  run file_sig "$f"
  # The stat format differs between macOS and Linux.
  # We only verify it returns something that is NOT "none".
  refute_output "none"
}

@test "file_sig: empty string path → none" {
  run file_sig ""
  assert_output "none"
}

# ---------------------------------------------------------------------------
# lookup_platform_name
# ---------------------------------------------------------------------------
@test "lookup_platform_name: URL in map file → returns mapped name" {
  printf '%s\t%s\n' "rtmp://a.rtmp.youtube.com/live2/mykey" "YouTube" > "$TEST_DIR/rtmp_platform_map.txt"
  run lookup_platform_name "rtmp://a.rtmp.youtube.com/live2/mykey"
  assert_output "YouTube"
}

@test "lookup_platform_name: partial URL match in map file → returns mapped name" {
  printf '%s\t%s\n' "rtmp://fa723fc1b171.global.live-video.net/app/key" "Kick" > "$TEST_DIR/rtmp_platform_map.txt"
  run lookup_platform_name "rtmp://fa723fc1b171.global.live-video.net/app/key"
  assert_output "Kick"
}

@test "lookup_platform_name: URL not in map → fallback hostname prefix" {
  # Map exists but does not contain this URL
  printf '%s\t%s\n' "rtmp://other.example.com/live/key" "OtherPlatform" > "$TEST_DIR/rtmp_platform_map.txt"
  run lookup_platform_name "rtmp://live.twitch.tv/app/twitchkey"
  # Fallback: strips protocol, takes first segment before '.' → "live"
  assert_output "live"
}

@test "lookup_platform_name: no map file → fallback hostname prefix" {
  rm -f "$TEST_DIR/rtmp_platform_map.txt"
  run lookup_platform_name "rtmp://a.rtmp.youtube.com/live2/key"
  # Strips protocol → a.rtmp.youtube.com/... → before first '/' → a.rtmp.youtube.com
  # Then sed s/\..*// → "a"
  assert_output "a"
}

@test "lookup_platform_name: multiple entries in map → matches correct one" {
  {
    printf '%s\t%s\n' "rtmp://a.rtmp.youtube.com/live2/key1" "YouTube"
    printf '%s\t%s\n' "rtmp://fa723fc1b171.global.live-video.net/app/key2" "Kick"
  } > "$TEST_DIR/rtmp_platform_map.txt"
  run lookup_platform_name "rtmp://fa723fc1b171.global.live-video.net/app/key2"
  assert_output "Kick"
}
