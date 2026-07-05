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

- Jellyfin server **10.11.x** or **12.0.x** (separate builds per major).
- A browser with Web Audio support (all current browsers).
- The web client served by the same server (default deployments).

## Installation

Install from a plugin repository, then restart the server so the startup
injection runs.

1. In Jellyfin: **Dashboard → Plugins → Repositories → +**
2. Add the manifest URL that matches your server major:
   - Jellyfin **12.x**: `<your-repo-base>/manifest.json`
   - Jellyfin **10.11.x**: `<your-repo-base>/manifest-10.json`
3. **Dashboard → Plugins → Catalog → Gapless Player → Install**.
4. **Restart the server** once, so Jellyfin loads the plugin assembly.
5. Hard-refresh the web client (clear cache) so the rewritten `index.html` and
   `config.json` are reloaded.

Injection itself is live (response rewriting); only the initial plugin load and
later enable/disable toggles need a web-client reload, not a server restart.

Each Jellyfin major has its own build and its own manifest, so a server only
ever sees a compatible version.

### Uninstalling

Uninstall from the plugin catalog and restart. On container images the web
assets reset to pristine on the next container recreate; on bare-metal installs
the injected `<script>` tag and `config.json` entry are removed the next time a
web-client update rewrites those files, or can be removed by reinstalling the
web client.

## Usage

- Once installed it is **enabled by default** for eligible audio queues.
- Enable/disable is stored per browser (localStorage key
  `enableWebAudioGapless`). Some albums sound better gapless than others.
- Verbose client logging: set localStorage key `enableWebAudioGaplessDebug` to
  `true`.

> The in-player toggle button is not wired yet (see [Limitations](#limitations));
> for now toggle via the localStorage key above.

## Configuration

**Dashboard → Plugins → Gapless Player**:

- **Enabled** — server-wide master switch. When off, the web client is not
  modified at all. Takes effect on server restart (injection runs at startup).
- **Debug logging** — default verbose client logging for new browsers.

## Building from source

The client bundle is a committed artifact (`Web/gaplessPlayer.js`); rebuild it
only when the TypeScript changes. The C# plugin builds against a different .NET
SDK per Jellyfin major.

```sh
# 1. client bundle (Node)
cd client && npm ci && npm run build && cd ..

# 2a. Jellyfin 12 build (needs .NET 10 SDK)
dotnet publish Jellyfin.Plugin.GaplessPlayer/Jellyfin.Plugin.GaplessPlayer.csproj \
  -c Release -p:JellyfinTfm=net10.0 -p:JellyfinAbiVersion=12.0.0-rc2

# 2b. Jellyfin 10.11 build (needs .NET 9 SDK)
dotnet publish Jellyfin.Plugin.GaplessPlayer/Jellyfin.Plugin.GaplessPlayer.csproj \
  -c Release -p:JellyfinTfm=net9.0 -p:JellyfinAbiVersion=10.11.11
```

`scripts/build.sh` runs the full matrix and produces packaged zips plus their
manifest checksums in `artifacts/`.

| Jellyfin | .NET SDK | targetAbi     |
|----------|----------|---------------|
| 12.0.x   | net10.0  | 12.0.0.0      |
| 10.11.x  | net9.0   | 10.11.11.0    |

## Limitations

- Audio only; video/photo/book are handled by the stock players.
- Repeat and shuffle are supported; playback rate and crossfade are not.
- RepeatOne restarts the track at the boundary (near-gapless, not
  sample-accurate looping).
- The in-player quick-toggle button is not implemented yet; use the localStorage
  setting.
- Plugins are compatible with a single Jellyfin major; a server upgrade needs a
  matching plugin release.

## License

GPLv3. See [LICENSE](LICENSE).
