#!/usr/bin/env bash
#
# Builds and packages the plugin into ./artifacts as
# gapless-player_<version>-jf12.zip (DLL + meta.json), and prints the manifest
# fields (targetAbi, sourceUrl, checksum, timestamp).
#
# Usage:
#   CHANGELOG="..." scripts/build.sh
#
# Environment:
#   CHANGELOG    required; meta.json changelog (whole feature set while in the
#                stabilization phase, see AGENTS.md "Release policy")
#   OUT          output directory (default: ./artifacts)
#   ALLOW_DIRTY  set to 1 to build with uncommitted changes (never for a release)
#
# Builds from `git archive HEAD` (what is committed is what ships) in a .NET SDK
# container, so no local dotnet is needed and root-owned bin/obj left by earlier
# container runs cannot break the build. The client bundle (Web/gaplessPlayer.js)
# is a committed artifact; rebuild it with `cd client && npm ci && npm run build`
# when the TypeScript changes.
#
# targetAbi is the Jellyfin package version the build resolved: the DLL
# references that version's assemblies, which older servers cannot load.
# The frozen Jellyfin 10.11 build is not built here; its zip stays on the
# v0.1.0.5 release.
#
# Requires: git, docker, and `zip` or python3 on the host.
set -euo pipefail

cd "$(dirname "$0")/.."

PROJECT="Jellyfin.Plugin.GaplessPlayer/Jellyfin.Plugin.GaplessPlayer.csproj"
DLL="Jellyfin.Plugin.GaplessPlayer.dll"
SDK_IMAGE="mcr.microsoft.com/dotnet/sdk:10.0"
RELEASE_URL="https://github.com/ryad-lindner/jellyfin-plugin-gapless-player/releases/download"
OUT="$(realpath -m "${OUT:-artifacts}")"

VERSION="$(sed -n 's:.*<AssemblyVersion>\(.*\)</AssemblyVersion>.*:\1:p' "$PROJECT")"
: "${CHANGELOG:?set CHANGELOG to the release changelog text}"
[ -n "$VERSION" ] || { echo "could not read AssemblyVersion from $PROJECT" >&2; exit 1; }

if [ "${ALLOW_DIRTY:-0}" != "1" ] && [ -n "$(git status --porcelain)" ]; then
    echo "working tree is dirty; commit first (or ALLOW_DIRTY=1 for a test build)" >&2
    exit 1
fi

grep -q "^version: \"$VERSION\"" build.yaml || echo "warning: build.yaml version differs from $VERSION" >&2

json_escape() {
    local s=${1//\\/\\\\}
    s=${s//\"/\\\"}
    printf '%s' "${s//$'\n'/ }"
}

make_zip() { # zip-path files... (run inside the stage dir)
    local zipfile=$1; shift
    if command -v zip >/dev/null; then
        zip -q "$zipfile" "$@"
    else
        python3 -m zipfile -c "$zipfile" "$@"
    fi
}

mkdir -p "$OUT"
if [ ! -w "$OUT" ]; then
    echo "$OUT is not writable (root-owned from an old container run? sudo rm -rf it)" >&2
    exit 1
fi
src="$OUT/src-$VERSION.tar"
git archive --format=tar -o "$src" HEAD

stage="$OUT/stage"
rm -rf "$stage"; mkdir -p "$stage"

echo ">> building jf12 ($SDK_IMAGE)"
docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -e DOTNET_CLI_TELEMETRY_OPTOUT=1 \
    -v "$src":/src.tar:ro -v "$stage":/out \
    "$SDK_IMAGE" sh -ec "
        mkdir /tmp/w && tar -xf /src.tar -C /tmp/w && cd /tmp/w
        dotnet publish '$PROJECT' -c Release -o /tmp/pub >/tmp/publish.log 2>&1 || { cat /tmp/publish.log; exit 1; }
        cp '/tmp/pub/$DLL' /out/
        cp '$(dirname "$PROJECT")/obj/project.assets.json' /out/"

jellyfin="$(sed -n 's:.*"Jellyfin\.Controller/\([0-9][0-9.]*\)".*:\1:p' "$stage/project.assets.json" | head -n1)"
rm "$stage/project.assets.json"
[[ "$jellyfin" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "unexpected resolved Jellyfin.Controller version '$jellyfin'" >&2; exit 1; }
targetAbi="$jellyfin.0"
grep -q "^targetAbi: \"$targetAbi\"" build.yaml || echo "warning: build.yaml targetAbi differs from $targetAbi" >&2

ts="$(date -u +%Y-%m-%dT%H:%M:%S.0000000Z)"
cat > "$stage/meta.json" <<EOF
{
    "category": "General",
    "changelog": "$(json_escape "$CHANGELOG")",
    "description": "Gapless Web Audio playback for eligible audio queues in the web client.",
    "guid": "399b650e-cca7-4f06-95a1-6b55f6fededc",
    "name": "Gapless Player",
    "overview": "Gapless Web Audio playback for eligible audio queues.",
    "owner": "ryad-lindner",
    "targetAbi": "$targetAbi",
    "timestamp": "$ts",
    "version": "$VERSION"
}
EOF

zipname="gapless-player_${VERSION}-jf12.zip"
rm -f "$OUT/$zipname"
(cd "$stage" && make_zip "$OUT/$zipname" meta.json "$DLL")
md5="$(md5sum "$OUT/$zipname" | cut -d' ' -f1)"

rm -f "$src"
echo "Done: $OUT/$zipname"
echo "   targetAbi $targetAbi (Jellyfin.Controller $jellyfin)"
echo "   sourceUrl $RELEASE_URL/v$VERSION/$zipname"
echo "   checksum  $md5"
echo "   timestamp $ts"
