using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;

namespace Jellyfin.Plugin.GaplessPlayer;

/// <summary>
/// Inserts the injection middleware at the front of the request pipeline so it
/// can wrap the static-file responses for index.html and config.json. This is
/// the same hook the File Transformation plugin uses; it lets a plugin
/// contribute middleware without patching the web root on disk.
/// </summary>
public class GaplessInjectionStartupFilter : IStartupFilter
{
    /// <inheritdoc />
    public Action<IApplicationBuilder> Configure(Action<IApplicationBuilder> next)
    {
        return app =>
        {
            app.UseMiddleware<GaplessInjectionMiddleware>();
            next(app);
        };
    }
}
