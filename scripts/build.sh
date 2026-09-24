#!/usr/bin/env bash
#
# Builds and packages the plugin for every supported Jellyfin major into
# ./artifacts as gapless-player_<version>-jf<major>.zip (DLL + meta.json), and
# prints the manifest fields (sourceUrl, checksum, timestamp) for each zip.
#
# Usage:
#   CHANGELOG="..." scripts/build.sh
#
# Environment:
#   CHANGELOG    required; meta.json changelog (whole feature set while in the
#                stabilization phase, see AGENTS.md "Release policy")
#   VERSION      defaults to <AssemblyVersion> in the csproj
#   MAJORS       space-separated subset of majors to build (default: all)
#   OUT          output directory (default: ./artifacts)
#   ALLOW_DIRTY  set to 1 to build with uncommitted changes (never for a release)
#
# Builds from `git archive HEAD` (what is committed is what ships), each matrix
# row in its matching .NET SDK container, so no local dotnet is needed and
# root-owned bin/obj left by earlier container runs cannot break the build.
# The client bundle (Web/gaplessPlayer.js) is a committed artifact; rebuild it
# with `cd client && npm ci && npm run build` when the TypeScript changes.
#
# Requires: git, docker, and `zip` or python3 on the host.
set -euo pipefail

cd "$(dirname "$0")/.."

PROJECT="Jellyfin.Plugin.GaplessPlayer/Jellyfin.Plugin.GaplessPlayer.csproj"
DLL="Jellyfin.Plugin.GaplessPlayer.dll"
RELEASE_URL="https://github.com/ryad-lindner/jellyfin-plugin-gapless-player/releases/download"
OUT="$(realpath -m "${OUT:-artifacts}")"

VERSION="${VERSION:-$(sed -n 's:.*<AssemblyVersion>\(.*\)</AssemblyVersion>.*:\1:p' "$PROJECT")}"
: "${CHANGELOG:?set CHANGELOG to the release changelog text}"
[ -n "$VERSION" ] || { echo "could not read AssemblyVersion from $PROJECT" >&2; exit 1; }

# major | tfm | jellyfin ABI (nuget) | targetAbi (manifest) | SDK image tag
MATRIX=(
    "12|net10.0|12.0.0-rc2|12.0.0.0|10.0"
    "10|net9.0|10.11.11|10.11.11.0|9.0"
)

if [ "${ALLOW_DIRTY:-0}" != "1" ] && [ -n "$(git status --porcelain)" ]; then
    echo "working tree is dirty; commit first (or ALLOW_DIRTY=1 for a test build)" >&2
    exit 1
fi

for f in build.yaml build.10.yaml; do
    grep -q "^version: \"$VERSION\"" "$f" || echo "warning: $f version differs from $VERSION" >&2
done

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

for row in "${MATRIX[@]}"; do
    IFS='|' read -r major tfm abiNuget targetAbi sdk <<< "$row"
    if [ -n "${MAJORS:-}" ] && [[ " $MAJORS " != *" $major "* ]]; then
        continue
    fi

    echo ">> building jf$major ($tfm, ABI $targetAbi, sdk:$sdk)"
    stage="$OUT/stage-$major"
    rm -rf "$stage"; mkdir -p "$stage"

    docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -e DOTNET_CLI_TELEMETRY_OPTOUT=1 \
        -v "$src":/src.tar:ro -v "$stage":/out \
        "mcr.microsoft.com/dotnet/sdk:$sdk" sh -ec "
            mkdir /tmp/w && tar -xf /src.tar -C /tmp/w && cd /tmp/w
            dotnet publish '$PROJECT' -c Release -p:JellyfinTfm=$tfm -p:JellyfinAbiVersion=$abiNuget \
                -o /tmp/pub >/tmp/publish.log 2>&1 || { cat /tmp/publish.log; exit 1; }
            cp '/tmp/pub/$DLL' /out/"

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

    zipname="gapless-player_${VERSION}-jf${major}.zip"
    rm -f "$OUT/$zipname"
    (cd "$stage" && make_zip "$OUT/$zipname" meta.json "$DLL")
    md5="$(md5sum "$OUT/$zipname" | cut -d' ' -f1)"
    echo "   -> $OUT/$zipname"
    echo "      targetAbi $targetAbi"
    echo "      sourceUrl $RELEASE_URL/v$VERSION/$zipname"
    echo "      checksum  $md5"
    echo "      timestamp $ts"
done

rm -f "$src"
echo "Done. Artifacts in $OUT/"
