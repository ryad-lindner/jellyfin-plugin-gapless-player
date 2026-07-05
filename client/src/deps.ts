/**
 * Minimal shapes of the dependencies the Jellyfin web client injects into a
 * window-registered plugin. The web client calls:
 *
 *   const PluginClass = await window.GaplessPlayer();
 *   new PluginClass({ events, loading, appSettings, playbackManager, globalize,
 *                     appHost, appRouter, inputManager, toast, confirm,
 *                     dashboard, ServerConnections });
 *
 * Only the members actually used by the player are typed; the rest are left
 * open so the contract stays loose against different web-client versions.
 */

export interface EventsApi {
    trigger(target: unknown, name: string, args?: unknown[]): void;
    on(target: unknown, name: string, handler: (...args: unknown[]) => void): void;
    off(target: unknown, name: string, handler: (...args: unknown[]) => void): void;
}

export interface AppSettingsApi {
    get(key: string): string | null | undefined;
    set(key: string, value: string): void;
}

export interface PlaybackManagerApi {
    play(options: unknown): Promise<unknown>;
}

export interface AppHostApi {
    getDeviceProfile?(item?: unknown): unknown;
}

export interface PluginDeps {
    events: EventsApi;
    appSettings: AppSettingsApi;
    playbackManager: PlaybackManagerApi;
    appHost: AppHostApi;
    [key: string]: unknown;
}
