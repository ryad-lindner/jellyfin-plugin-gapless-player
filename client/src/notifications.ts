import type { PluginDeps } from './deps';
import { getServerConfig } from './serverConfig';

const LOG_PREFIX = '[GaplessPlayer]';
const NOTIFICATION_TAG = 'gapless-player-now-playing';
const ICON_MAX_HEIGHT = 256;
// A restart of the same item shortly after it was announced (live gapless
// toggle, superseded play) must not notify twice.
const DUPLICATE_WINDOW_MS = 5000;

interface NowPlayingItem {
    Id?: string | null;
    Name?: string | null;
    MediaType?: string | null;
    Album?: string | null;
    AlbumId?: string | null;
    AlbumPrimaryImageTag?: string | null;
    AlbumArtist?: string | null;
    Artists?: string[] | null;
    ArtistItems?: { Name?: string | null }[] | null;
    ImageTags?: Record<string, string> | null;
    ServerId?: string | null;
}

interface ApiClientLike {
    getScaledImageUrl?(itemId: string, options: Record<string, unknown>): string;
}

interface ServerConnectionsLike {
    getApiClient?(itemOrServerId: unknown): ApiClientLike | null | undefined;
}

let initialized = false;
let permissionRequest: Promise<NotificationPermission> | null = null;
let lastNotified: { id: string; at: number } | null = null;

function isSupported(): boolean {
    return typeof window.Notification !== 'undefined';
}

function artistLine(item: NowPlayingItem): string {
    const names = item.ArtistItems?.map(a => a.Name).filter((n): n is string => !!n);
    if (names?.length) {
        return names.join(', ');
    }
    if (item.Artists?.length) {
        return item.Artists.join(', ');
    }
    return item.AlbumArtist || '';
}

function imageUrl(deps: PluginDeps, item: NowPlayingItem): string | undefined {
    let id: string | null | undefined;
    let tag: string | null | undefined;
    if (item.AlbumId && item.AlbumPrimaryImageTag) {
        id = item.AlbumId;
        tag = item.AlbumPrimaryImageTag;
    } else if (item.Id && item.ImageTags?.Primary) {
        id = item.Id;
        tag = item.ImageTags.Primary;
    }
    if (!id || !tag) {
        return undefined;
    }

    try {
        const apiClient = (deps.ServerConnections as ServerConnectionsLike | undefined)?.getApiClient?.(item);
        return apiClient?.getScaledImageUrl?.(id, { type: 'Primary', tag, maxHeight: ICON_MAX_HEIGHT });
    } catch {
        return undefined;
    }
}

async function show(deps: PluginDeps, item: NowPlayingItem): Promise<void> {
    const title = item.Name || 'Now playing';
    // renotify is missing from some TS DOM lib versions; it needs a tag and
    // makes a replaced notification alert again instead of updating silently.
    const options: NotificationOptions & { renotify?: boolean } = {
        body: [artistLine(item), item.Album].filter(Boolean).join(' — '),
        icon: imageUrl(deps, item),
        tag: NOTIFICATION_TAG,
        renotify: true,
        // The music is the sound; a notification chime over it is not wanted.
        silent: true
    };

    try {
        const notification = new Notification(title, options);
        notification.onclick = () => {
            window.focus();
            notification.close();
        };
        return;
    } catch {
        // Android Chrome forbids the constructor ("Illegal constructor");
        // notifications must go through a service worker registration there.
    }

    try {
        const registration = await navigator.serviceWorker?.getRegistration();
        await registration?.showNotification(title, options);
    } catch (err) {
        console.warn(`${LOG_PREFIX} could not show now-playing notification`, err);
    }
}

/**
 * Asks for notification permission. Browsers only prompt with recent user
 * activation; playbackstart usually follows the play click closely enough.
 * While the answer is still "default" (no activation, prompt dismissed) a
 * later playback start asks again.
 */
function requestPermission(): Promise<NotificationPermission> {
    if (!permissionRequest) {
        // Old Safari only supports the callback form and returns undefined.
        permissionRequest = Promise.resolve(Notification.requestPermission())
            .then(() => Notification.permission)
            .catch(() => Notification.permission)
            .finally(() => { permissionRequest = null; });
    }
    return permissionRequest;
}

function onPlaybackStart(deps: PluginDeps, state: { NowPlayingItem?: NowPlayingItem | null } | undefined): void {
    const config = getServerConfig();
    if (!config.notifications || !isSupported()) {
        return;
    }

    const item = state?.NowPlayingItem;
    if (!item || item.MediaType !== 'Audio') {
        return;
    }

    const now = Date.now();
    if (item.Id && lastNotified?.id === item.Id && now - lastNotified.at < DUPLICATE_WINDOW_MS) {
        return;
    }

    const notify = () => {
        if (config.notificationsBackgroundOnly && !document.hidden && document.hasFocus()) {
            return;
        }
        lastNotified = item.Id ? { id: item.Id, at: now } : null;
        void show(deps, item);
    };

    if (Notification.permission === 'granted') {
        notify();
    } else if (Notification.permission === 'default') {
        void requestPermission().then((permission) => {
            if (permission === 'granted') {
                notify();
            }
        });
    }
}

/**
 * Shows a browser notification for each audio track that starts, on any
 * player (gapless or the stock HTML one), when enabled in the plugin settings.
 * Listens on playbackManager's playbackstart, which fires per item.
 */
export function initNotifications(deps: PluginDeps): void {
    if (initialized) {
        return;
    }
    initialized = true;

    deps.events.on(deps.playbackManager, 'playbackstart', (...args: unknown[]) => {
        // Events handlers receive (event, player, state).
        onPlaybackStart(deps, args[2] as { NowPlayingItem?: NowPlayingItem | null } | undefined);
    });
}
