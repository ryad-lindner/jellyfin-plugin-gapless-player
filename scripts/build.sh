#!/usr/bin/env bash
#
# Builds and packages the plugin for every supported Jellyfin major into
# ./artifacts as <name>_<version>-jf<major>.zip (DLL + meta.json), and prints
# the md5 checksum needed for the plugin manifest.
#
# Requires: dotnet SDK for each target framework, and `zip`. The client bundle
# (Web/gaplessPlayer.js) is a committed artifact; rebuild it with
# `cd client && npm ci && npm run build` when the TypeScript changes.
#
# Because different Jellyfin majors need different .NET SDKs, run each matrix
# row in the matching SDK container (see AGENTS.md), or use a CI image per row.
set -euo pipefail

cd "$(dirname "$0")/.."

PROJECT="Jellyfin.Plugin.GaplessPlayer/Jellyfin.Plugin.GaplessPlayer.csproj"
DLL="Jellyfin.Plugin.GaplessPlayer.dll"
VERSION="0.1.0.0"
OUT="artifacts"

# major | tfm | jellyfin ABI (nuget) | targetAbi (manifest)
MATRIX=(
    "12|net10.0|12.0.0-rc2|12.0.0.0"
    "10|net9.0|10.11.11|10.11.11.0"
)

# Only build the row whose SDK is present unless BUILD_ALL=1.
mkdir -p "$OUT"

for row in "${MATRIX[@]}"; do
    IFS='|' read -r major tfm abiNuget targetAbi <<< "$row"

    if [ "${BUILD_ALL:-0}" != "1" ] && ! dotnet --list-sdks | grep -q "^${tfm#net}\." 2>/dev/null; then
        # crude SDK presence check; skip rows whose SDK is absent
        if ! dotnet build "$PROJECT" -c Release -p:JellyfinTfm="$tfm" -p:JellyfinAbiVersion="$abiNuget" \
             -t:GetTargetPath >/dev/null 2>&1; then
            echo ">> skipping jf$major ($tfm): SDK not available"
            continue
        fi
    fi

    echo ">> building jf$major ($tfm, ABI $targetAbi)"
    rm -rf Jellyfin.Plugin.GaplessPlayer/obj Jellyfin.Plugin.GaplessPlayer/bin
    dotnet publish "$PROJECT" -c Release \
        -p:JellyfinTfm="$tfm" -p:JellyfinAbiVersion="$abiNuget" \
        -o "$OUT/stage-$major"

    stage="$OUT/meta-$major"
    rm -rf "$stage"; mkdir -p "$stage"
    cp "$OUT/stage-$major/$DLL" "$stage/"

    ts="$(date -u +%Y-%m-%dT%H:%M:%S.0000000Z)"
    cat > "$stage/meta.json" <<EOF
{
    "category": "General",
    "changelog": "Initial release.",
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
    (cd "$stage" && zip -q -r "../$zipname" .)
    md5="$(md5sum "$OUT/$zipname" | cut -d' ' -f1)"
    echo "   -> $OUT/$zipname  (targetAbi $targetAbi, md5 $md5)"
done

echo "Done. Artifacts in $OUT/"
