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
approach needs no write access. File Transformation (3.x) uses the same
`IStartupFilter` technique generically; we keep our own specific rewrite so the
plugin has no dependency (FT's exact-ABI manifest also hides it on newer 12.x).
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
8. No scheduled source for `_currentIndex` means a start is in flight;
   `getCurrentTimeMs()` then returns the target position, not a running clock.

When porting fixes from the jellyfin-web fork, the player logic is identical
except that fork module imports (`Events`, `appSettings`, `playbackManager`,
`appHost`, `htmlMediaHelper`, `PluginType`, `randomInt`) are replaced by
constructor-injected deps (`client/src/deps.ts`) or inlined helpers, and the
fork-only `appSettings.enableWebAudioGapless()` becomes a localStorage read that
defaults to enabled.

## Client tests

`npm test` bundles `client/test/*.test.ts` with the real player and runs them
on `node:test`. `test/fakes.ts` provides a Web Audio context with a manual
clock (`advance()` fires `onended` in end order, one render quantum late),
`holdFetch()`/`holdDecode()` to delay a track's download or (non-abortable)
decode, `suspendUntilReleased()` to hold `resume()` like a suspended
AudioContext, tracks that fail to decode, and an events/playbackManager pair that
mirrors stock jellyfin-web (it destroys the player when it cannot play the
announced next item). Tests assert the itemstarted/itemstopped log, positions,
audible sources and handoffs. Add a test for every pairing or start/pause fix.

## Build matrix

Support policy: only the current official Jellyfin release line (12.x) is
supported. Jellyfin 10.11 is **frozen** at 0.1.0.5: no new features or fixes,
and `build.sh` does not build it (its zip stays on the v0.1.0.5 release).

Dependencies follow upstream: the Jellyfin package version floats over stable
12.x (`12.*`, as the official jellyfin-plugin-* repos do). `targetAbi` must
equal the resolved version: Jellyfin bumps its assembly versions every minor
(12.3.0 ships `MediaBrowser.Controller` 12.3.0.0), and .NET refuses to bind a
reference to a newer version than the server has loaded, so a 12.3 build fails
to load on 12.2. `build.sh` therefore derives `targetAbi` from
`obj/project.assets.json`; keep `build.yaml` in sync (the script warns).
Deviate from upstream versions only for an unfixed higher-severity CVE.

One source tree, per-target MSBuild properties:

| Jellyfin | .NET SDK | `-p:JellyfinTfm` | `-p:JellyfinAbiVersion` | manifest targetAbi | Status |
|----------|----------|------------------|-------------------------|--------------------|--------|
| 12.x     | net10.0  | net10.0 (default)| `12.*` (default)        | resolved, e.g. 12.3.0.0 | supported |
| 10.11.x  | net9.0   | net9.0           | 10.11.11                | 10.11.11.0         | frozen |

`-p:TargetFramework` does NOT work for overriding (MSBuild strips a global
`TargetFramework` in the outer build); the intermediate `JellyfinTfm` property
is why it works. Do not "simplify" it back.

### Verifying in containers (no local dotnet/node assumed)

```sh
# client
docker run --rm -u 1000:1000 -e HOME=/tmp -v "$PWD":/work -w /work/client \
  node:24-bookworm sh -lc 'npm ci && npm run typecheck && npm test && npm run build'

# C# jf12
docker run --rm -u 1000:1000 -e HOME=/tmp -v "$PWD":/work -w /work \
  mcr.microsoft.com/dotnet/sdk:10.0 sh -lc \
  'dotnet build Jellyfin.Plugin.GaplessPlayer/Jellyfin.Plugin.GaplessPlayer.csproj -c Release'

# C# jf10.11, frozen; only if ever needed (clean obj/bin first — TFM differs)
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
compatible build. `manifest-10.json` is frozen at 0.1.0.5. `scripts/build.sh`
produces the jf12 zip and its manifest fields. Manifest hosting/URLs are
deployment config and are kept out of this repo.

## Release steps

Pushes go to the private host; it push-mirrors to the public GitHub repo on
commit (tags included, usually within seconds). Release assets live on the
GitHub mirror's releases; the manifests live in a separate plugin-repo repo
(`manifest.json`, `manifest-10.json`), also mirrored to GitHub.

1. **Client bundle.** If `client/src` changed, rebuild and commit
   `Web/gaplessPlayer.js` (see the container commands above).
2. **Bump the version** (4-part, e.g. `0.1.0.6`) in the csproj
   `AssemblyVersion`/`FileVersion` and `build.yaml` (`build.10.yaml` is frozen).
   Commit `chore: release <version>` and tag annotated `v<version>` with message
   `Gapless Player <version>`. Do not push yet.
3. **Package**: `CHANGELOG="..." scripts/build.sh`. It builds the committed
   tree in an SDK container and prints `targetAbi`, `sourceUrl`, `checksum`
   (md5) and `timestamp`. If it warns that `build.yaml`'s `targetAbi` differs
   (a new Jellyfin 12.x was released), update `build.yaml` and the minimum
   server version in README.md, amend the release commit, re-tag
   (`git tag -f -a ...`) and rebuild. The changelog follows the release policy
   (whole feature set during stabilization, delta afterwards). Then push
   `main` and the tag.
4. **GitHub release** once the tag has mirrored:
   `gh release create v<version> --verify-tag --title "Gapless Player <version>"
   --notes-file <notes> artifacts/gapless-player_<version>-jf12.zip`. Notes:
   intro line, `## Features`, `## Install`, `## Downloads` (the zip with its
   targetAbi) — copy the previous release's notes and edit; list only the
   jf12 zip (drop any jf10 line carried over from v0.1.0.5).
5. **Manifests**: in the plugin-repo, set `version`, `changelog`, `targetAbi`,
   `sourceUrl`, `checksum` and `timestamp` of the manifest entry from the
   build output (`manifest.json` ← jf12 zip; `manifest-10.json` stays
   frozen). During stabilization replace the single entry; afterwards prepend
   a new one. Commit `chore: bump gapless player to <version>` and push.
   Check that the public raw manifest serves the new version and its
   `sourceUrl`s return 200.
6. **Stabilization only**: after the manifests are live (never before — the
   catalog must not point at a missing zip), delete the previous release and
   tag: `gh release delete v<old> --yes --cleanup-tag`, then
   `git push origin :refs/tags/v<old>` and `git tag -d v<old>`.
   **Never delete v0.1.0.5**: the frozen `manifest-10.json` points at its jf10
   zip.

Gotcha: bin/obj/artifacts created by older root container runs are root-owned
and not writable; `build.sh` avoids bin/obj by building from `git archive`, and
refuses an unwritable output dir (remove it, or pass `OUT=<dir>`).

## Release policy

Two phases:

**Stabilization (current).** Until there is one accepted, working release, keep
only the latest: each bump deletes the previous release + tag (GitHub and Gitea)
and `manifest.json` lists a single version. Exception: v0.1.0.5 is never
deleted, because the frozen `manifest-10.json` points at its jf10 zip.
Intermediate builds during this phase are bug-fix iterations, not milestones
worth preserving. Because there is no version history on the release page, the
GitHub release notes and the manifest `changelog` describe the **whole feature
set**, not the delta.

**Normal versioning (once a first stable release is accepted).** Stop deleting
old releases; keep version history in the manifest (append new version entries,
newest first), and let each release's notes/`changelog` describe the **changes in
that version** (delta). New features then ship as new versions alongside the
existing ones.

We are in the stabilization phase now; switch to normal versioning once the
current release is confirmed working end-to-end.

## Not done yet / TODO

- CI (build, package, publish release + manifest to the mirror).
- Runtime verification on a real server (see the fork HANDOFF's test matrix:
  album switch mid-play, repeat One/All at boundaries, shuffle mid-play,
  queue-next / remove-current / reorder, throttled-network boundary recovery).
  Also, in a real browser (the client tests cover the logic, not real decoders,
  networks or a real AudioContext suspension), the non-blocking starts: on a
  throttled network, seek into the last 30 s while the next track is still
  downloading (starts at once, gapless if the decode lands first); seek during
  the initial load (also back to exactly the start position, and after a
  remove/reorder during the load); rapid pause/unpause/seek near the end;
  pause during the initial load, a seek/next decode and a boundary recovery
  wait (must stay silent, unpause resumes at the target position). Undecodable
  tracks (must hand off once to the normal player, with one itemstopped for
  the item that was announced): as the first track, after a pause during its
  load then unpause, and via next/select; remove-current during the load.
  On a phone: pause, seek and next while the AudioContext is suspended by a
  background interruption (iOS reports `'interrupted'`, treated like
  `'suspended'` by inference, not verified on a device).
- An unpause pressed while a skip waits for a suspended AudioContext is folded
  into that skip; if the skip's target is then removed before the context
  resumes, the player stays paused on the current item.
- ReplayGain / audio normalization: the stock player applies the item's
  normalization gain; ours plays at raw level (volume-only `GainNode`). Parked
  until it is known to matter.
- Middleware edge cases: HEAD and `Range` requests on the rewritten
  `index.html`/`config.json` paths; no cache headers on the served bundle.
