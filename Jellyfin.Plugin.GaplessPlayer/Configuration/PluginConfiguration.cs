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

    /// <summary>
    /// Gets or sets a value indicating whether the web client shows a browser
    /// notification when an audio track starts. Each browser still asks the
    /// user for notification permission before the first one is shown.
    /// </summary>
    public bool NotificationsEnabled { get; set; }

    /// <summary>
    /// Gets or sets a value indicating whether notifications are suppressed
    /// while the Jellyfin tab is visible and focused.
    /// </summary>
    public bool NotificationsBackgroundOnly { get; set; } = true;
}
