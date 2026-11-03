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
- Jellyfin 10.11 is **frozen and unsupported**: its last build is 0.1.0.5
  (needs 10.11.11 or later) and it gets no further features or fixes.
- A browser with Web Audio support (all current browsers).
- The web client served by the same server (default deployments).

## Installation

Two ways: from the plugin repository (recommended, gets updates) or manually
from a release zip. Both need one server restart and a hard refresh of the web
client. Injection itself is live (response rewriting): only the initial plugin
load needs a server restart; later enable/disable changes need a web-client
reload.

### From the plugin repository

1. In Jellyfin: **Dashboard → Plugins → Manage Repositories → New Repository**.
2. Add the manifest URL that matches your server (any name works):

   | Jellyfin | Manifest URL |
   |----------|--------------|
   | 12.x ([minimum version](#requirements)) | `https://raw.githubusercontent.com/ryad-lindner/jellyfin-plugin-repo/main/manifest.json` |
   | 10.11.11 or later 10.11.x (frozen at 0.1.0.5) | `https://raw.githubusercontent.com/ryad-lindner/jellyfin-plugin-repo/main/manifest-10.json` |

   Use the raw URL exactly as shown, not the GitHub page of the repository.
3. **Dashboard → Plugins**, search for *Gapless Player* (or filter
   *Available*), open it and click **Install**.
4. **Restart the server** once, so Jellyfin loads the plugin assembly.
5. [Hard-refresh the web client](#hard-refresh-the-web-client).

Each Jellyfin major has its own build and its own manifest, so a server only
ever sees a compatible version.

### Manual install

1. Download the zip for your server from the
   [releases](https://github.com/ryad-lindner/jellyfin-plugin-gapless-player/releases):
   the latest `gapless-player_<version>-jf12.zip` for Jellyfin 12.x (see
   [Requirements](#requirements)), `gapless-player_0.1.0.5-jf10.zip` from the
   [v0.1.0.5 release](https://github.com/ryad-lindner/jellyfin-plugin-gapless-player/releases/tag/v0.1.0.5)
   for Jellyfin 10.11.11 or later 10.11.x.
2. Create a folder for it, for example `GaplessPlayer_<version>`, in the
   `plugins` directory inside Jellyfin's data directory. Common locations:
   - Docker (official image): `/config/plugins`
   - Docker (linuxserver.io image): `/config/data/plugins`
   - Debian/Ubuntu package: `/var/lib/jellyfin/plugins`
   - Windows installer: `C:\ProgramData\Jellyfin\Server\plugins`
3. Unzip `Jellyfin.Plugin.GaplessPlayer.dll` and `meta.json` into that folder.
   The files must be readable by the user Jellyfin runs as.
4. **Restart the server**. **Dashboard → Plugins** now lists Gapless Player.
5. [Hard-refresh the web client](#hard-refresh-the-web-client).

Manual installs do not update themselves: to upgrade, delete the old folder,
add the new version the same way and restart. To get updates in the dashboard
instead, add the repository as above.

### Hard refresh the web client

The browser caches the web client, so it keeps running without the plugin
until the cached `index.html` and `config.json` are reloaded. After installing
(or uninstalling), clear the cache for your Jellyfin site and reload, for
example with **Ctrl+Shift+R** (**Cmd+Shift+R** on macOS), or in Chrome with
DevTools open: right-click the reload button → **Empty cache and hard reload**.

### Troubleshooting

- **"An error occurred while getting the plugin details from the repository"**
  on the Gapless Player plugin page: no configured repository lists the
  plugin, typically after a manual install. It is harmless; the plugin still
  works. To clear it (and get updates), add the matching manifest URL from the
  [table above](#from-the-plugin-repository). If you already added one, check
  it is the raw URL, not the GitHub page of the repository.
- **Installed, but tracks still have gaps**: hard-refresh the web client (see
  above), check that **Enabled** is on in the plugin
  [settings](#configuration), that the ∞ toggle in the now-playing bar is on,
  and that the queue is [eligible](#how-it-works).

### Uninstalling

Uninstall from **Dashboard → Plugins** (or delete the plugin folder for a
manual install), restart the server and reload the web client. Nothing is
written to the web root, so there is nothing to clean up.

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
