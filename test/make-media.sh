#!/bin/sh
# Generates the test media: a 10 minute "episode" and a 20 second "ad".
set -e
cd "$(dirname "$0")/player"
ffmpeg -loglevel error -y -f lavfi -i testsrc2=size=426x240:rate=24:duration=600 \
  -f lavfi -i sine=frequency=440:duration=600 \
  -c:v libx264 -pix_fmt yuv420p -preset veryfast -crf 34 -g 48 -c:a aac -b:a 32k -movflags +faststart -shortest episode.mp4
ffmpeg -loglevel error -y -f lavfi -i "color=c=red:size=426x240:rate=24:duration=20,drawtext=text='AD %{pts}':fontsize=40:x=20:y=20" \
  -f lavfi -i sine=frequency=880:duration=20 \
  -c:v libx264 -pix_fmt yuv420p -preset veryfast -crf 34 -c:a aac -b:a 32k -movflags +faststart -shortest ad.mp4 2>/dev/null \
|| ffmpeg -loglevel error -y -f lavfi -i color=c=red:size=426x240:rate=24:duration=20 \
  -f lavfi -i sine=frequency=880:duration=20 \
  -c:v libx264 -pix_fmt yuv420p -preset veryfast -crf 34 -c:a aac -b:a 32k -movflags +faststart -shortest ad.mp4
ls -la episode.mp4 ad.mp4
