#!/usr/bin/env bash
# Downloads the OBS engine (obs-studio-node, the engine Streamlabs Desktop uses) into node_modules,
# unpacked the way Streamlabs installs it. The app ships it next to itself (see "extraResources").
# Usage: bash scripts/get-obs-engine.sh [x64]   (x64 = Intel Mac; nothing = this computer's kind)
set -euo pipefail
OSN_VERSION=0.27.33
NWR_VERSION=1.0.22
OSN_URL=https://s3-us-west-2.amazonaws.com/obsstudionodes3.streamlabs.com
NWR_URL=https://slobs-node-window-rendering.s3-us-west-2.amazonaws.com

case "$(uname -s)" in
  Darwin)
    if [ "${1:-}" = "x64" ]; then arch=-x86_64; else arch=-arm64; fi
    osn="osn-${OSN_VERSION}-release-osx${arch}.tar.gz"
    nwr="node-window-rendering-${NWR_VERSION}-osx${arch}.tar.gz" ;;
  MINGW*|MSYS*|CYGWIN*|Windows_NT)
    osn="osn-${OSN_VERSION}-release-win64.tar.gz"
    nwr="" ;;
  *)
    echo "No OBS engine for this system; the app works without it."; exit 0 ;;
esac

cd "$(dirname "$0")/../node_modules"
rm -rf obs-studio-node node-window-rendering
get() {
  for i in 1 2 3; do curl -sSfL --retry 3 -o "$2" "$1" && return 0; echo "download failed, trying again ($i)"; sleep 5; done
  return 1
}
echo "Getting $osn"
get "$OSN_URL/$osn" osn.tgz && tar -xzf osn.tgz && rm osn.tgz
if [ -n "$nwr" ]; then
  echo "Getting $nwr"
  get "$NWR_URL/$nwr" nwr.tgz && tar -xzf nwr.tgz && rm nwr.tgz
fi
test -f obs-studio-node/package.json
du -sh obs-studio-node
