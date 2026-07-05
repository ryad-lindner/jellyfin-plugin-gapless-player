using MediaBrowser.Controller;
using MediaBrowser.Controller.Plugins;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.DependencyInjection;

namespace Jellyfin.Plugin.GaplessPlayer;

/// <summary>
/// Registers plugin services with the host DI container.
/// </summary>
public class PluginServiceRegistrator : IPluginServiceRegistrator
{
    /// <inheritdoc />
    public void RegisterServices(IServiceCollection serviceCollection, IServerApplicationHost applicationHost)
    {
        // Injects the client bundle into web-client responses at runtime; no
        // write access to the web root required.
        serviceCollection.AddTransient<IStartupFilter, GaplessInjectionStartupFilter>();
    }
}
