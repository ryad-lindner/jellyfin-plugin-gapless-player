using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using MediaBrowser.Controller;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.GaplessPlayer;

/// <summary>
/// Injects the gapless player client bundle into the served web client on
/// startup by patching the on-disk web assets.
///
/// This is intentionally a disk patch rather than a File Transformation
/// dependency: File Transformation has no build for this server ABI yet, and on
/// an immutable container image the web root resets to pristine on every
/// recreate, so a startup patch is self-healing and never accumulates drift.
/// The patches are idempotent, so re-running on every start is safe.
/// </summary>
public class WebInjectionService : IHostedService
{
    private const string WindowKey = "GaplessPlayer";
    private const string ScriptMarker = "id=\"gapless-player-plugin\"";
    private const string ScriptTag =
        "<script " + ScriptMarker + " src=\"GaplessPlayer/gaplessPlayer.js\"></script>";
    private const string ClientResourceName =
        "Jellyfin.Plugin.GaplessPlayer.Web.gaplessPlayer.js";
    private const string ClientRelativePath = "GaplessPlayer/gaplessPlayer.js";

    private readonly IServerApplicationPaths _paths;
    private readonly ILogger<WebInjectionService> _logger;

    /// <summary>
    /// Initializes a new instance of the <see cref="WebInjectionService"/> class.
    /// </summary>
    /// <param name="paths">Server application paths.</param>
    /// <param name="logger">Logger.</param>
    public WebInjectionService(IServerApplicationPaths paths, ILogger<WebInjectionService> logger)
    {
        _paths = paths;
        _logger = logger;
    }

    /// <inheritdoc />
    public Task StartAsync(CancellationToken cancellationToken)
    {
        try
        {
            Inject();
        }
        catch (Exception ex)
        {
            // Never take the server down over a web-injection failure.
            _logger.LogError(ex, "Gapless Player: failed to inject client bundle");
        }

        return Task.CompletedTask;
    }

    /// <inheritdoc />
    public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;

    private void Inject()
    {
        if (Plugin.Instance?.Configuration.Enabled == false)
        {
            _logger.LogInformation("Gapless Player: disabled in configuration; skipping injection");
            return;
        }

        var webPath = _paths.WebPath;
        if (string.IsNullOrEmpty(webPath) || !Directory.Exists(webPath))
        {
            _logger.LogWarning(
                "Gapless Player: web path '{WebPath}' not found; cannot inject. "
                + "This is expected on headless/API-only deployments.",
                webPath);
            return;
        }

        WriteClientBundle(webPath);
        PatchIndexHtml(webPath);
        PatchConfigJson(webPath);
    }

    private void WriteClientBundle(string webPath)
    {
        var asm = typeof(Plugin).Assembly;
        using var stream = asm.GetManifestResourceStream(ClientResourceName);
        if (stream is null)
        {
            _logger.LogError("Gapless Player: embedded client bundle '{Resource}' missing", ClientResourceName);
            return;
        }

        var target = Path.Combine(webPath, ClientRelativePath);
        Directory.CreateDirectory(Path.GetDirectoryName(target)!);

        // Always overwrite so a plugin upgrade replaces the bundle.
        using var file = File.Create(target);
        stream.CopyTo(file);
        _logger.LogInformation("Gapless Player: wrote client bundle to {Target}", target);
    }

    private void PatchIndexHtml(string webPath)
    {
        var indexPath = Path.Combine(webPath, "index.html");
        if (!File.Exists(indexPath))
        {
            _logger.LogWarning("Gapless Player: index.html not found at {Path}", indexPath);
            return;
        }

        var html = File.ReadAllText(indexPath);
        if (html.Contains(ScriptMarker, StringComparison.Ordinal))
        {
            return;
        }

        var headClose = html.IndexOf("</head>", StringComparison.OrdinalIgnoreCase);
        if (headClose < 0)
        {
            _logger.LogWarning("Gapless Player: no </head> in index.html; cannot inject script tag");
            return;
        }

        html = html.Insert(headClose, ScriptTag);
        File.WriteAllText(indexPath, html);
        _logger.LogInformation("Gapless Player: injected script tag into index.html");
    }

    private void PatchConfigJson(string webPath)
    {
        var configPath = Path.Combine(webPath, "config.json");
        if (!File.Exists(configPath))
        {
            _logger.LogWarning("Gapless Player: config.json not found at {Path}", configPath);
            return;
        }

        var node = JsonNode.Parse(File.ReadAllText(configPath));
        if (node is not JsonObject root)
        {
            _logger.LogWarning("Gapless Player: config.json is not a JSON object");
            return;
        }

        if (root["plugins"] is not JsonArray plugins)
        {
            plugins = new JsonArray();
            root["plugins"] = plugins;
        }

        if (plugins.Any(n => n?.GetValue<string>() == WindowKey))
        {
            return;
        }

        plugins.Add(WindowKey);
        var json = root.ToJsonString(new JsonSerializerOptions { WriteIndented = true });
        File.WriteAllText(configPath, json, new UTF8Encoding(false));
        _logger.LogInformation("Gapless Player: registered '{Key}' in config.json plugins", WindowKey);
    }
}
