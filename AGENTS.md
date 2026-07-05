# AGENTS.md

Context for coding agents working on this repo. No secrets or deployment
specifics belong here (this repo is mirrored publicly).

## What this is

A Jellyfin **server plugin** that adds a gapless Web Audio player to the Jellyfin
**web client**, without forking jellyfin-web. It was ported from a jellyfin-web
fork where the player lived at `src/plugins/webAudioGaplessPlayer/plugin.ts`.

Two moving parts:

1. `client/` — TypeScript, bundled by esbuild into a single IIFE
   (`Web/gaplessPlayer.js`, a committed artifact) that registers
   `window.GaplessPlayer`. This is the ported player.
2. `Jellyfin.Plugin.GaplessPlayer/` — C# server plugin that, on startup,
   patches the served web client so the bundle loads.

## How integration works

Stock jellyfin-web loads a plugin named on `window` if `config.json`'s `plugins`
array contains its name:

```js
const factory = await window[name];      // our async () => PluginClass
const PluginClass = await factory();
new PluginClass({ events, appSettings, playbackManager, appHost, ... });
```

So the server plugin must, against the served web assets:
- add `<script src="GaplessPlayer/gaplessPlayer.js">` to `index.html`,
- add `"GaplessPlayer"` to `config.json` `plugins`,
- place the bundle at `<webroot>/GaplessPlayer/gaplessPlayer.js`.

This is done by **in-memory response rewriting**, not a disk patch:
`GaplessInjectionMiddleware` (inserted via `GaplessInjectionStartupFilter`, an
`IStartupFilter` registered in `PluginServiceRegistrator`) intercepts the
`index.html` and `config.json` responses and rewrites them, and serves the
bundle from the embedded resource at `/.../GaplessPlayer/gaplessPlayer.js`.

History: the first attempt disk-patched the web root on startup. That fails on
the official container image — the web dir is read-only to the runtime user
(`UnauthorizedAccessException` creating `<webroot>/GaplessPlayer`). The middleware
approach needs no write access and is what File Transformation does generically;
FT itself has no Jellyfin 12 build yet, so we do the specific rewrite ourselves.
Enable/disable is live because the middleware checks `Plugin.Instance.Configuration.Enabled`
per request (a web-client reload applies it; no server restart).

Middleware notes: it strips `Accept-Encoding`/conditional headers on the
intercepted requests to force a full uncompressed 200, buffers the response,
rewrites by content-type (`text/html` → inject `<script>` before `</head>`;
`config.json` → add `"GaplessPlayer"` to `plugins`), then fixes Content-Length
and drops ETag. Requires `<FrameworkReference Include="Microsoft.AspNetCore.App" />`.

## Player invariants — DO NOT BREAK

The player is index-keyed into parallel maps and is subtle. The full invariant
list lives in the source comments and in the jellyfin-web fork's `HANDOFF.md`.
The load-bearing ones:

1. Decode results are validated by `_decoding` map identity, **not** by
   `_playbackId` (which `_startFrom` bumps after preloads are dispatched).
2. Boundary-miss recovery stays in-plugin (`_recoverAtIndex` → `_startFrom`);
   `playbackManager.play` handoff is last resort only, guarded by `_playbackId`.
3. Every playlist mutation goes through `_handlePlaylistMutation`, which re-keys
   the current track's map entries and rebinds its `onended` closure.
4. Units: `currentTime()`/`duration()` are milliseconds; `seek()` takes ticks.
5. Seek while paused must not unpause.
6. `AbortError` means "superseded", never a real failure.
7. `_nextIndex` centralizes repeat-mode successor logic.

When porting fixes from the jellyfin-web fork, the player logic is identical
except that fork module imports (`Events`, `appSettings`, `playbackManager`,
`appHost`, `htmlMediaHelper`, `PluginType`, `randomInt`) are replaced by
constructor-injected deps (`client/src/deps.ts`) or inlined helpers, and the
fork-only `appSettings.enableWebAudioGapless()` becomes a localStorage read that
defaults to enabled.

## Build matrix

Different Jellyfin majors need different .NET SDKs. One source tree, per-target
MSBuild properties:

| Jellyfin | .NET SDK | `-p:JellyfinTfm` | `-p:JellyfinAbiVersion` | manifest targetAbi |
|----------|----------|------------------|-------------------------|--------------------|
| 12.0.x   | net10.0  | net10.0 (default)| 12.0.0-rc2              | 12.0.0.0           |
| 10.11.x  | net9.0   | net9.0           | 10.11.11                | 10.11.11.0         |

`-p:TargetFramework` does NOT work for overriding (MSBuild strips a global
`TargetFramework` in the outer build); the intermediate `JellyfinTfm` property
is why it works. Do not "simplify" it back.

### Verifying in containers (no local dotnet/node assumed)

```sh
# client
docker run --rm -u 1000:1000 -e HOME=/tmp -v "$PWD":/work -w /work/client \
  node:24-bookworm sh -lc 'npm ci && npm run typecheck && npm run build'

# C# jf12
docker run --rm -u 1000:1000 -e HOME=/tmp -v "$PWD":/work -w /work \
  mcr.microsoft.com/dotnet/sdk:10.0 sh -lc \
  'dotnet build Jellyfin.Plugin.GaplessPlayer/Jellyfin.Plugin.GaplessPlayer.csproj -c Release'

# C# jf10.11 (clean obj/bin first — TFM differs)
docker run --rm -u 1000:1000 -e HOME=/tmp -v "$PWD":/work -w /work \
  mcr.microsoft.com/dotnet/sdk:9.0 sh -lc \
  'rm -rf Jellyfin.Plugin.GaplessPlayer/obj Jellyfin.Plugin.GaplessPlayer/bin && \
   dotnet build Jellyfin.Plugin.GaplessPlayer/Jellyfin.Plugin.GaplessPlayer.csproj -c Release \
   -p:JellyfinTfm=net9.0 -p:JellyfinAbiVersion=10.11.11'
```

## Distribution

Source of truth is a private git host, mirrored to a public GitHub repo that the
Jellyfin plugin installer can fetch anonymously. One manifest per Jellyfin major
(`manifest.json` = 12, `manifest-10.json` = 10.11) so a server only sees a
compatible build. `scripts/build.sh` produces the per-major zips and their md5
checksums for the manifest. Manifest hosting/URLs are deployment config and are
kept out of this repo.

## Release policy

Only the latest release is kept — each version bump deletes the previous
release + tag (GitHub and Gitea) and the manifests list a single version. Because
there is no version history on the release page, the GitHub release notes and the
manifest `changelog` field describe the **whole feature set**, not the delta from
the previous version. Update both when cutting a release.

## Not done yet / TODO

- In-player quick-toggle button (DOM injection into the now-playing bar). Design
  it against the running web client's DOM, not from guesswork. Until then the
  localStorage `enableWebAudioGapless` key is the toggle.
- CI (build both majors, package, publish release + manifest to the mirror).
- Runtime verification on a real server (see the fork HANDOFF's test matrix:
  album switch mid-play, repeat One/All at boundaries, shuffle mid-play,
  queue-next / remove-current / reorder, throttled-network boundary recovery).
- Optional File Transformation path once it ships for the Jellyfin 12 ABI.
