#!/usr/bin/env bash
# test_helper.bash — shared setup for stream_entry.sh bats tests
#
# Strategy:
#   1. Extract all function definitions from stream_entry.sh, skipping the
#      three inline execution blocks (lines 366-372, 835-840, 1306-1319).
#   2. Rewrite every hardcoded /shared/ path in the extracted code to use
#      the SHARED_DIR variable so tests redirect all file I/O to a temp dir.
#   3. Source the patched file in setup() so every test gets fresh functions.

PROJECT_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
STREAM_ENTRY="$PROJECT_ROOT/scripts/stream_entry.sh"

# Node-installed bats helpers (absolute paths so they work from any cwd)
BATS_SUPPORT="$PROJECT_ROOT/node_modules/bats-support/load.bash"
BATS_ASSERT="$PROJECT_ROOT/node_modules/bats-assert/load.bash"

# ---------------------------------------------------------------------------
# load_helpers — call once at the top of each .bats file (outside @test)
# ---------------------------------------------------------------------------
load_helpers() {
  # shellcheck source=/dev/null
  source "$BATS_SUPPORT"
  # shellcheck source=/dev/null
  source "$BATS_ASSERT"
}

# ---------------------------------------------------------------------------
# extract_functions — write a sourceable version of stream_entry.sh to
#                    $BATS_TMPDIR/stream_functions.sh
# ---------------------------------------------------------------------------
extract_functions() {
  local src="$STREAM_ENTRY"
  local out="$BATS_TMPDIR/stream_functions.sh"

  # We need lines: 1-365, 374-833, 843-1304
  # (Skip inline blocks: 366-373, 834-841 [note: 835-840 are the HLS mkdir/rm/echo block],
  #  and 1306-1319 [the main loop])
  #
  # The cleanest, portable way: print every line that is NOT in the skip ranges.
  awk '
    NR >= 366 && NR <= 373 { next }
    NR >= 835 && NR <= 841 { next }
    NR >= 1306             { next }
    { print }
  ' "$src" > "$out"

  # Replace "set -e" with "set +e" so sourcing does not abort the test process
  sed -i.bak 's/^set -e$/set +e/' "$out"

  # Rewrite all hardcoded /shared/ references → ${SHARED_DIR}/
  # We use a placeholder that is safe even if SHARED_DIR contains slashes.
  sed -i.bak 's|"/shared/|"${SHARED_DIR}/|g' "$out"
  sed -i.bak "s|'/shared/|'\${SHARED_DIR}/|g" "$out"

  # Also rewrite unquoted /shared/ paths (e.g., bare word in case/echo)
  sed -i.bak 's| /shared/| ${SHARED_DIR}/|g' "$out"

  # Rewrite /tmp/rtmp_platform_map.txt → ${TEST_DIR}/rtmp_platform_map.txt
  sed -i.bak 's|/tmp/rtmp_platform_map\.txt|${TEST_DIR}/rtmp_platform_map.txt|g' "$out"

  rm -f "$out.bak"
}

# ---------------------------------------------------------------------------
# setup / teardown helpers — call from each test file's setup()/teardown()
# ---------------------------------------------------------------------------
common_setup() {
  TEST_DIR="$(mktemp -d)"
  export TEST_DIR
  export SHARED_DIR="$TEST_DIR/shared"
  mkdir -p "$SHARED_DIR"

  # Dummy dirs that stream_entry.sh variables reference
  export HLS_DIR="$TEST_DIR/hls"
  export MUSIC_DIR="$TEST_DIR/music"
  mkdir -p "$HLS_DIR" "$MUSIC_DIR"

  extract_functions

  # shellcheck source=/dev/null
  source "$BATS_TMPDIR/stream_functions.sh"
}

common_teardown() {
  rm -rf "$TEST_DIR"
}
