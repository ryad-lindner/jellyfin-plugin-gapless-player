using System.Text;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.GaplessPlayer;

/// <summary>
/// Injects the gapless player into the served web client by rewriting the
/// index.html and config.json responses in-memory, and serving the client
/// bundle from the plugin assembly.
///
/// This runs entirely in the response pipeline, so it needs no write access to
/// the web root (the official container image ships it read-only to the runtime
/// user) and no File Transformation dependency. Enable/disable is live because
/// the plugin config is checked per request.
/// </summary>
public class GaplessInjectionMiddleware
{
    private const string WindowKey = "GaplessPlayer";
    private const string ScriptMarker = "id=\"gapless-player-plugin\"";
    private const string ScriptTag =
        "<script " + ScriptMarker + " src=\"GaplessPlayer/gaplessPlayer.js\"></script>";
    private const string ClientResource = "Jellyfin.Plugin.GaplessPlayer.Web.gaplessPlayer.js";
    private const string ClientPathSuffix = "/GaplessPlayer/gaplessPlayer.js";

    private static byte[]? _clientBundle;

    private readonly RequestDelegate _next;
    private readonly ILogger<GaplessInjectionMiddleware> _logger;

    /// <summary>
    /// Initializes a new instance of the <see cref="GaplessInjectionMiddleware"/> class.
    /// </summary>
    /// <param name="next">Next middleware in the pipeline.</param>
    /// <param name="logger">Logger.</param>
    public GaplessInjectionMiddleware(RequestDelegate next, ILogger<GaplessInjectionMiddleware> logger)
    {
        _next = next;
        _logger = logger;
    }

    /// <summary>
    /// Processes a request.
    /// </summary>
    /// <param name="context">The HTTP context.</param>
    /// <returns>A task.</returns>
    public async Task InvokeAsync(HttpContext context)
    {
        if (Plugin.Instance?.Configuration.Enabled == false)
        {
            await _next(context);
            return;
        }

        var path = context.Request.Path.Value ?? string.Empty;

        if (path.EndsWith(ClientPathSuffix, StringComparison.OrdinalIgnoreCase))
        {
            await ServeBundleAsync(context);
            return;
        }

        var isConfig = path.EndsWith("/config.json", StringComparison.OrdinalIgnoreCase);
        var isCandidate = isConfig
            || path.EndsWith("/index.html", StringComparison.OrdinalIgnoreCase)
            || path.Equals("/", StringComparison.Ordinal)
            || path.Equals("/web", StringComparison.OrdinalIgnoreCase)
            || path.Equals("/web/", StringComparison.OrdinalIgnoreCase);

        if (!isCandidate)
        {
            await _next(context);
            return;
        }

        // Force a full, uncompressed 200 so the body can be rewritten as text.
        context.Request.Headers.Remove("Accept-Encoding");
        context.Request.Headers.Remove("If-None-Match");
        context.Request.Headers.Remove("If-Modified-Since");

        var originalBody = context.Response.Body;
        using var buffer = new MemoryStream();
        context.Response.Body = buffer;
        try
        {
            await _next(context);
        }
        finally
        {
            context.Response.Body = originalBody;
        }

        buffer.Seek(0, SeekOrigin.Begin);
        var contentType = context.Response.ContentType ?? string.Empty;
        var text = await new StreamReader(buffer).ReadToEndAsync();

        string result = text;
        if (isConfig && contentType.Contains("json", StringComparison.OrdinalIgnoreCase))
        {
            result = InjectConfig(text);
        }
        else if (contentType.Contains("text/html", StringComparison.OrdinalIgnoreCase))
        {
            result = InjectIndex(text);
        }

        var outBytes = Encoding.UTF8.GetBytes(result);
        context.Response.ContentLength = outBytes.Length;
        context.Response.Headers.Remove("ETag");
        await originalBody.WriteAsync(outBytes);
    }

    private async Task ServeBundleAsync(HttpContext context)
    {
        var bundle = _clientBundle ??= LoadBundle();
        if (bundle is null)
        {
            _logger.LogError("Gapless Player: embedded client bundle '{Resource}' missing", ClientResource);
            context.Response.StatusCode = StatusCodes.Status404NotFound;
            return;
        }

        context.Response.ContentType = "application/javascript; charset=utf-8";
        context.Response.ContentLength = bundle.Length;
        await context.Response.Body.WriteAsync(bundle);
    }

    private static byte[]? LoadBundle()
    {
        using var stream = typeof(Plugin).Assembly.GetManifestResourceStream(ClientResource);
        if (stream is null)
        {
            return null;
        }

        using var ms = new MemoryStream();
        stream.CopyTo(ms);
        return ms.ToArray();
    }

    private string InjectIndex(string html)
    {
        if (html.Contains(ScriptMarker, StringComparison.Ordinal))
        {
            return html;
        }

        var idx = html.IndexOf("</head>", StringComparison.OrdinalIgnoreCase);
        if (idx < 0)
        {
            return html;
        }

        _logger.LogDebug("Gapless Player: injected script tag into index.html response");
        return html.Insert(idx, ScriptTag);
    }

    private string InjectConfig(string json)
    {
        try
        {
            if (JsonNode.Parse(json) is not JsonObject root)
            {
                return json;
            }

            if (root["plugins"] is not JsonArray plugins)
            {
                plugins = new JsonArray();
                root["plugins"] = plugins;
            }

            if (plugins.Any(n => n?.GetValue<string>() == WindowKey))
            {
                return json;
            }

            plugins.Add(WindowKey);
            _logger.LogDebug("Gapless Player: registered '{Key}' in config.json response", WindowKey);
            return root.ToJsonString();
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Gapless Player: failed to patch config.json response");
            return json;
        }
    }
}
