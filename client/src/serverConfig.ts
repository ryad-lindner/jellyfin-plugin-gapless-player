/**
 * Server-wide plugin settings, delivered by the injection middleware as
 * data attributes on the injected <script> tag (non-admin users cannot read
 * the plugin configuration endpoint). Read per call: cheap, and it keeps the
 * tag the single source of truth for this page load.
 */
const SCRIPT_ID = 'gapless-player-plugin';

export interface ServerConfig {
    debugLogging: boolean;
    notifications: boolean;
    notificationsBackgroundOnly: boolean;
}

export function getServerConfig(): ServerConfig {
    const data = document.getElementById(SCRIPT_ID)?.dataset ?? {};
    return {
        debugLogging: data.debugLogging === 'true',
        notifications: data.notifications === 'true',
        // Default on: a notification for the tab you are looking at is noise.
        notificationsBackgroundOnly: data.notificationsBackgroundOnly !== 'false'
    };
}
