#!/usr/bin/env bash
# Generates a large, valid, playable MP4 test file by encoding one short chunk
# once and then concatenating it N times via stream copy (fast, no re-encoding).
#
# Usage:
#   ./generate-big-video.sh [target_size_gb] [output_path]
#
# Examples:
#   ./generate-big-video.sh 10 ~/streamtube-fixtures/big-10gb.mp4
#   ./generate-big-video.sh 1                # defaults to ./big-test-1gb.mp4

set -euo pipefail

TARGET_GB="${1:-10}"
OUTPUT="${2:-$(pwd)/big-test-${TARGET_GB}gb.mp4}"
WORKDIR="$(mktemp -d)"
CHUNK="$WORKDIR/chunk.mp4"
LIST="$WORKDIR/list.txt"

cleanup() {
  rm -rf "$WORKDIR"
}
trap cleanup EXIT

echo "==> Output: $OUTPUT"
echo "==> Target size: ${TARGET_GB} GiB"
echo "==> Work dir: $WORKDIR"

command -v ffmpeg >/dev/null 2>&1 || { echo "ERROR: ffmpeg not found in PATH"; exit 1; }
command -v ffprobe >/dev/null 2>&1 || { echo "ERROR: ffprobe not found in PATH"; exit 1; }

mkdir -p "$(dirname "$OUTPUT")"

echo "==> Encoding a 30s seed chunk (one-time cost)..."
ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i "testsrc=duration=30:size=1280x720:rate=30" \
  -f lavfi -i "sine=frequency=1000:duration=30" \
  -c:v libx264 -preset ultrafast -pix_fmt yuv420p \
  -c:a aac -shortest \
  "$CHUNK"

if [ ! -s "$CHUNK" ]; then
  echo "ERROR: chunk encoding produced an empty/missing file"
  exit 1
fi

CHUNK_BYTES=$(stat -c%s "$CHUNK" 2>/dev/null || stat -f%z "$CHUNK")
TARGET_BYTES=$((TARGET_GB * 1024 * 1024 * 1024))
REPEATS=$(( (TARGET_BYTES + CHUNK_BYTES - 1) / CHUNK_BYTES ))

echo "==> Chunk size: $CHUNK_BYTES bytes"
echo "==> Repeats needed: $REPEATS"

# Absolute path in the concat list — a relative path here is the #1 cause of
# "Impossible to open" errors from the concat demuxer when cwd changes.
: > "$LIST"
for _ in $(seq 1 "$REPEATS"); do
  printf "file '%s'\n" "$CHUNK" >> "$LIST"
done

echo "==> Concatenating (stream copy, no re-encode)..."
ffmpeg -hide_banner -loglevel error -y \
  -f concat -safe 0 -i "$LIST" \
  -c copy \
  "$OUTPUT"

if [ ! -s "$OUTPUT" ]; then
  echo "ERROR: concat produced an empty/missing output file"
  exit 1
fi

echo "==> Verifying output is a valid, decodable MP4..."
if ! ffprobe -v error -show_entries format=duration,size -of default=noprint_wrappers=1 "$OUTPUT"; then
  echo "ERROR: ffprobe could not read the generated file — it may be corrupt"
  exit 1
fi

FINAL_BYTES=$(stat -c%s "$OUTPUT" 2>/dev/null || stat -f%z "$OUTPUT")
FINAL_GB=$(awk "BEGIN { printf \"%.2f\", $FINAL_BYTES / 1024 / 1024 / 1024 }")
SHA256=$(sha256sum "$OUTPUT" 2>/dev/null | cut -d' ' -f1 || shasum -a 256 "$OUTPUT" | cut -d' ' -f1)

echo ""
echo "=== DONE ==="
echo "File:   $OUTPUT"
echo "Size:   $FINAL_BYTES bytes (~${FINAL_GB} GiB)"
echo "SHA256: $SHA256"
