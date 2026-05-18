#!/usr/bin/env bash
# Download a public-domain audio track and slice it into fragmented MP4
# (DASH-style) segments suitable for MediaSource Extensions.
#
# Requires: ffmpeg, curl
set -euo pipefail

cd "$(dirname "$0")/.."
mkdir -p assets/chunks
cd assets/chunks

# Audio source: J.S. Bach — Goldberg Variations, Aria (BWV 988).
# Performed by Bradley Lehman, harpsichord. Public domain (Wikimedia Commons).
# Override with AUDIO_URL=<direct .mp3/.ogg/.wav> to use a different source.
SOURCE_URL="${AUDIO_URL:-https://upload.wikimedia.org/wikipedia/commons/d/d8/988-aria.lehman1.ogg}"
SOURCE_FILE="source.${SOURCE_URL##*.}"

if [[ ! -f "$SOURCE_FILE" ]]; then
  echo "Downloading $SOURCE_URL ..."
  curl -L -A "Mozilla/5.0" -o "$SOURCE_FILE" "$SOURCE_URL"
fi

echo "Transcoding + segmenting (5s fMP4 chunks)..."
# Produce an init segment + numbered media segments. AAC-LC in fMP4 plays in all
# evergreen browsers via MediaSource.
ffmpeg -y -i "$SOURCE_FILE" \
  -c:a aac -b:a 96k -ac 2 -ar 44100 \
  -f dash \
  -seg_duration 5 \
  -use_template 1 -use_timeline 0 \
  -init_seg_name 'init.mp4' \
  -media_seg_name 'chunk-$Number%04d$.m4s' \
  -single_file 0 \
  -adaptation_sets "id=0,streams=a" \
  stream.mpd

rm -f stream.mpd
COUNT=$(ls chunk-*.m4s | wc -l | tr -d ' ')
echo "Done. Init + $COUNT chunks generated in assets/chunks/"
echo "Set CHUNK_COUNT=$COUNT in wrangler.toml"
