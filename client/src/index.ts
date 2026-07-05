import WebAudioGaplessPlayer from './plugin';
import { initToggleUi } from './toggle';

/**
 * The Jellyfin web client loads a plugin registered on `window` by:
 *
 *   const pluginDefinition = await window[name];   // must be a function
 *   const PluginClass = await pluginDefinition();   // returns the class
 *   new PluginClass({ events, appSettings, playbackManager, appHost, ... });
 *
 * So the global must be an (async) function returning the plugin class. The
 * name here (`GaplessPlayer`) must match the entry added to config.json's
 * `plugins` array by the server-side injection.
 */
declare global {
    interface Window {
        GaplessPlayer?: () => Promise<typeof WebAudioGaplessPlayer>;
    }
}

window.GaplessPlayer = async () => WebAudioGaplessPlayer;

// The now-playing bar toggle is independent of the player instance, so wire it
// up as soon as the bundle loads.
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initToggleUi);
} else {
    initToggleUi();
}
