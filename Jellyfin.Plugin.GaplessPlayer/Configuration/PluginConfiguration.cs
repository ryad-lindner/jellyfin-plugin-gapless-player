using MediaBrowser.Model.Plugins;

namespace Jellyfin.Plugin.GaplessPlayer.Configuration;

/// <summary>
/// Server-side plugin configuration.
/// </summary>
public class PluginConfiguration : BasePluginConfiguration
{
    /// <summary>
    /// Gets or sets a value indicating whether the client bundle is injected
    /// into the served web client. Acts as a server-wide kill switch; when
    /// disabled the feature is fully off regardless of per-browser settings.
    /// Per-browser enable/disable is handled client-side (see the client bundle).
    /// </summary>
    public bool Enabled { get; set; } = true;

    /// <summary>
    /// Gets or sets a value indicating whether verbose client-side debug logging
    /// is turned on by default for new browsers. The client can still override
    /// this locally.
    /// </summary>
    public bool DebugLogging { get; set; }
}
