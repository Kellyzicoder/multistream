#!/usr/bin/env bash
# Puts the ffmpeg program where ffmpeg-static expects it (node_modules/ffmpeg-static/ffmpeg).
# The normal download (GitHub, eugeneware/ffmpeg-static) sometimes times out with 504,
# so this tries it a few times, then a copy of the same file on npmmirror,
# then a ready-made ffmpeg from another well-known site for this kind of computer.
# Use: bash scripts/get-ffmpeg.sh [x64|arm64]   (default: this computer's kind)
set -u
cd "$(dirname "$0")/.."
DIR=node_modules/ffmpeg-static
ARCH="${1:-$(node -p process.arch)}"
OS="$(node -p process.platform)"
EXE=ffmpeg; [ "$OS" = win32 ] && EXE=ffmpeg.exe
OUT="$DIR/$EXE"

works() {
  [ -f "$OUT" ] || return 1
  chmod +x "$OUT" 2>/dev/null
  if [ "$OS" = darwin ]; then
    want=arm64; [ "$ARCH" = x64 ] && want=x86_64
    file "$OUT" | grep -q "$want" || return 1
  fi
  # only run it when it is made for this computer (an Intel ffmpeg may not run on an M1 build machine)
  if [ "$ARCH" = "$(node -p process.arch)" ]; then
    "$OUT" -hide_banner -version >/dev/null 2>&1 || return 1
  fi
  return 0
}

if works; then echo "ffmpeg already here"; exit 0; fi
rm -f "$OUT"

# 1) the normal download, a few tries
for i in 1 2 3; do
  echo "ffmpeg: normal download, try $i"
  npm_config_arch="$ARCH" node "$DIR/install.js" && works && { echo "ffmpeg ok (normal)"; exit 0; }
  rm -f "$OUT"; sleep $((i * 10))
done

# 2) the same file from the npmmirror copy
for base in https://cdn.npmmirror.com/binaries/ffmpeg-static https://registry.npmmirror.com/-/binary/ffmpeg-static; do
  echo "ffmpeg: trying $base"
  FFMPEG_BINARIES_URL="$base" npm_config_arch="$ARCH" node "$DIR/install.js" && works && { echo "ffmpeg ok (mirror)"; exit 0; }
  rm -f "$OUT"
done

# 3) a ready-made ffmpeg for this kind of computer
TMP="$(mktemp -d)"
get() { curl -fL --retry 4 --retry-delay 5 --connect-timeout 30 -o "$TMP/$2" "$1"; }
pick() { f="$(find "$TMP" -type f -name "$EXE" | head -n 1)"; [ -n "$f" ] && cp "$f" "$OUT" && works; }
case "$OS-$ARCH" in
  linux-x64)
    get https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz f.tar.xz && tar -xJf "$TMP/f.tar.xz" -C "$TMP" && pick && { echo "ffmpeg ok (johnvansickle)"; exit 0; } ;;
  win32-x64)
    get https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip f.zip && unzip -q "$TMP/f.zip" -d "$TMP" && pick && { echo "ffmpeg ok (gyan.dev)"; exit 0; }
    rm -rf "$TMP"/*
    get https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip f.zip && unzip -q "$TMP/f.zip" -d "$TMP" && pick && { echo "ffmpeg ok (BtbN)"; exit 0; } ;;
  darwin-arm64)
    get https://ffmpeg.martin-riedl.de/redirect/latest/macos/arm64/release/ffmpeg.zip f.zip && unzip -q "$TMP/f.zip" -d "$TMP" && pick && { echo "ffmpeg ok (martin-riedl)"; exit 0; } ;;
  darwin-x64)
    get https://ffmpeg.martin-riedl.de/redirect/latest/macos/amd64/release/ffmpeg.zip f.zip && unzip -q "$TMP/f.zip" -d "$TMP" && pick && { echo "ffmpeg ok (martin-riedl)"; exit 0; }
    rm -rf "$TMP"/*
    get https://evermeet.cx/ffmpeg/getrelease/zip f.zip && unzip -q "$TMP/f.zip" -d "$TMP" && pick && { echo "ffmpeg ok (evermeet)"; exit 0; } ;;
esac

echo "Could not get ffmpeg from any place" >&2
exit 1
