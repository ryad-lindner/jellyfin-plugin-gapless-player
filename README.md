# Jellyfin Gapless Player

Experimental gapless audio playback for the Jellyfin web client.

Stock Jellyfin plays each track as a separate HTML media element, so switching
tracks can produce an audible gap (network, decode, and pipeline re-init). This
plugin adds a local **Web Audio** player that fetches, decodes, and schedules
adjacent tracks on a shared `AudioContext` timeline, so eligible queues play
without gaps. The normal HTML audio player stays as the fallback.

> Status: early / experimental. Audio only. See [Limitations](#limitations).

## How it works

- A small client bundle registers an additional local media player in the web
  client (`window.GaplessPlayer`). When a queue is eligible, the web client's
  playback manager delegates queue control to it; otherwise the stock player is
  used.
- Eligibility: local browser player, direct-playable audio the browser can
  decode with `decodeAudioData`, known finite track durations, more than one
  track in the queue.
- The server plugin injects the client bundle into the served web client by
  rewriting the `index.html` and `config.json` **responses** in-memory (ASP.NET
  middleware) and serving the bundle from the plugin. Nothing is written to the
  web root, so it works on the official image where the web directory is
  read-only to the runtime user, and enable/disable is live.

## Requirements

- Jellyfin server **12.x** (the current official release line), at least the
  version the release was built against (currently 12.3); the catalog hides it
  from older servers.
- Jellyfin 10.11 is **frozen and unsupported**: its last build is 0.1.0.5 and it
  gets no further features or fixes.
- A browser with Web Audio support (all current browsers).
- The web client served by the same server (default deployments).

## Installation

Install from a plugin repository, then restart the server once so Jellyfin
loads the plugin.

1. In Jellyfin: **Dashboard → Plugins → Repositories → +**
2. Add the manifest URL that matches your server major:
   - Jellyfin **12.x**: `<your-repo-base>/manifest.json`
   - Jellyfin **10.11.x** (frozen at 0.1.0.5): `<your-repo-base>/manifest-10.json`
3. **Dashboard → Plugins → Catalog → Gapless Player → Install**.
4. **Restart the server** once, so Jellyfin loads the plugin assembly.
5. Hard-refresh the web client (clear cache) so the rewritten `index.html` and
   `config.json` are reloaded.

Injection itself is live (response rewriting): only the initial plugin load
needs a server restart; later enable/disable changes need a web-client reload.

Each Jellyfin major has its own build and its own manifest, so a server only
ever sees a compatible version.

### Uninstalling

Uninstall from the plugin catalog, restart the server and reload the web
client. Nothing is written to the web root, so there is nothing to clean up.

## Usage

- Once installed it is **enabled by default** for eligible audio queues.
- Toggle it per browser with the **∞ button** (`all_inclusive`) in the
  now-playing bar. Toggling mid-play restarts the current queue on the other
  player at the same position. The setting is stored in localStorage
  (`enableWebAudioGapless`).
- While a track is still downloading, the now-playing bar's buffer indicator
  shows the download progress.
- Verbose client logging: set localStorage key `enableWebAudioGaplessDebug` to
  `true`.

## Configuration

**Dashboard → Plugins → Gapless Player**:

- **Enabled** — server-wide master switch. When off, the web client is not
  modified at all. Applies on the next web-client reload; no server restart.
- **Debug logging** — default verbose client logging for new browsers.
- **Now-playing notifications** — show a browser notification when a song
  starts (any audio playback in the web client, not only gapless). Each
  browser asks for notification permission first.
- **Only in background** — suppress notifications while the Jellyfin tab is
  visible and focused (default on).

## Building from source

The client bundle is a committed artifact (`Web/gaplessPlayer.js`); rebuild it
only when the TypeScript changes.

```sh
# 1. client bundle (Node)
cd client && npm ci && npm run build && cd ..

# 2. Jellyfin 12 build (needs .NET 10 SDK)
dotnet publish Jellyfin.Plugin.GaplessPlayer/Jellyfin.Plugin.GaplessPlayer.csproj -c Release
```

`CHANGELOG="..." scripts/build.sh` builds in a .NET SDK container (Docker
required, no local SDK needed) and produces the packaged zip plus its manifest
fields in `artifacts/`.

| Jellyfin | .NET SDK | Jellyfin packages | targetAbi  | Status      |
|----------|----------|-------------------|------------|-------------|
| 12.x     | net10.0  | `12.*` (latest stable) | resolved version | supported |
| 10.11.x  | net9.0   | 10.11.11          | 10.11.11.0 | frozen at 0.1.0.5, not built |

## Limitations

- Audio only; video/photo/book are handled by the stock players.
- Repeat and shuffle are supported; playback rate and crossfade are not.
- RepeatOne restarts the track at the boundary (near-gapless, not
  sample-accurate looping).
- No ReplayGain / audio normalization: tracks play at their raw level, unlike
  the stock player with normalization enabled.
- Plugins are compatible with a single Jellyfin major; a server upgrade to a new
  major needs a matching plugin release.

## License

GPLv3. See [LICENSE](LICENSE).
