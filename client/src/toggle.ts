import type { PluginDeps } from './deps';

const SETTING_ENABLED = 'enableWebAudioGapless';
const BUTTON_CLASS = 'gaplessToggleButton';
const LOG_PREFIX = '[GaplessPlayer]';

// Captured from the player instance so a live toggle can restart the queue on
// the other player. Not available until the gapless player has been used once.
let deps: PluginDeps | null = null;

export function setToggleDeps(value: PluginDeps): void {
    deps = value;
}

function isEnabled(): boolean {
    // appSettings stores under the raw localStorage key, so this matches what
    // the player reads in canPlayItem().
    const value = localStorage.getItem(SETTING_ENABLED);
    return value == null ? true : value === 'true';
}

function setEnabled(value: boolean): void {
    localStorage.setItem(SETTING_ENABLED, String(value));
}

function showToast(message: string): void {
    const el = document.createElement('div');
    el.textContent = message;
    el.style.cssText = [
        'position:fixed', 'bottom:8em', 'left:50%', 'transform:translateX(-50%)',
        'background:rgba(0,0,0,0.85)', 'color:#fff', 'padding:0.6em 1em',
        'border-radius:0.3em', 'z-index:10000', 'font-size:0.9em',
        'transition:opacity 0.4s', 'pointer-events:none'
    ].join(';');
    document.body.appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; }, 1800);
    setTimeout(() => { el.remove(); }, 2300);
}

function updateButton(button: HTMLElement): void {
    const enabled = isEnabled();
    button.title = enabled ? 'Gapless playback: on' : 'Gapless playback: off';
    button.style.opacity = enabled ? '1' : '0.4';
    const icon = button.querySelector('.material-icons');
    if (icon) {
        icon.textContent = 'all_inclusive';
    }
}

/**
 * Removes the gapless-only stream source so the normal player resolves a fresh
 * media source when the queue is restarted with gapless disabled.
 */
function stripPresetSource(item: Record<string, unknown>): Record<string, unknown> {
    const clone = { ...item };
    delete clone.PresetMediaSource;
    delete clone.Url;
    return clone;
}

async function restartCurrentQueue(enabled: boolean): Promise<boolean> {
    const pm = deps?.playbackManager as unknown as Record<string, (...args: unknown[]) => unknown> | undefined;
    if (!pm) {
        return false;
    }

    try {
        if (typeof pm.isPlaying === 'function' && !pm.isPlaying()) {
            return false;
        }

        const raw = typeof pm.getPlaylist === 'function' ? await (pm.getPlaylist() as Promise<unknown[]>) : null;
        if (!Array.isArray(raw) || raw.length === 0) {
            return false;
        }

        // When switching to the normal player, strip the gapless preset source
        // so it resolves a fresh media source instead of the raw stream URL.
        const items = enabled ? raw : raw.map(it => stripPresetSource(it as Record<string, unknown>));

        const index = typeof pm.getCurrentPlaylistIndex === 'function' ? Number(pm.getCurrentPlaylistIndex()) : 0;
        const positionMs = typeof pm.currentTime === 'function' ? Number(pm.currentTime()) : 0;

        await (pm.play({
            items,
            startIndex: Math.max(0, index),
            startPositionTicks: Math.max(0, Math.round(positionMs * 10000)),
            enableWebAudioGapless: enabled
        }) as Promise<unknown>);
        return true;
    } catch (err) {
        console.warn(`${LOG_PREFIX} live toggle restart failed; applies on next playback`, err);
        return false;
    }
}

function onClick(button: HTMLElement): void {
    const enabled = !isEnabled();
    setEnabled(enabled);
    updateButton(button);

    void restartCurrentQueue(enabled).then((restarted) => {
        const base = enabled ? 'Gapless playback enabled' : 'Gapless playback disabled';
        showToast(restarted ? base : `${base} (applies on next playback)`);
    });
}

function createButton(): HTMLElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `${BUTTON_CLASS} paper-icon-button-light mediaButton`;
    button.setAttribute('is', 'paper-icon-button-light');
    button.innerHTML = '<span class="material-icons" aria-hidden="true">all_inclusive</span>';
    button.addEventListener('click', () => onClick(button));
    updateButton(button);
    return button;
}

function injectInto(container: Element): void {
    if (container.querySelector(`.${BUTTON_CLASS}`)) {
        return;
    }

    const button = createButton();
    const anchor = container.querySelector('.btnToggleContextMenu');
    if (anchor) {
        container.insertBefore(button, anchor);
    } else {
        container.appendChild(button);
    }
}

/**
 * Adds a gapless on/off button to the now-playing bar. The bar is created and
 * destroyed as playback starts/stops, so a MutationObserver re-injects it.
 */
export function initToggleUi(): void {
    const tryInject = () => {
        document.querySelectorAll('.nowPlayingBarRight').forEach(injectInto);
    };

    tryInject();
    const observer = new MutationObserver(tryInject);
    observer.observe(document.body, { childList: true, subtree: true });
}
