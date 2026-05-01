import {
    COUNTER_MODE,
    EXTENSION_ID,
    PANEL_ID,
    RUN_MODE,
    VALIDATION_MODE,
    resolveCounterMode,
} from '../constants.js';
import { buildPanelTemplate } from './panel-template.js';
import { setLanguage } from '../i18n.js';

export function mountPanel(runtime, {
    render,
    persistSettings,
    actions,
    onMissingHost,
}) {
    const existingDrawer = document.getElementById(PANEL_ID);
    if (existingDrawer) {
        cachePanelElements(runtime, existingDrawer);
        bindPanelEvents(existingDrawer, runtime, {
            render,
            persistSettings,
            actions,
        });
        hydrateForm(runtime);
        render();
        return existingDrawer;
    }

    const host = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
    if (!host) {
        onMissingHost?.();
        return null;
    }

    if (runtime.mountRetryHandle) {
        window.clearTimeout(runtime.mountRetryHandle);
        runtime.mountRetryHandle = 0;
    }

    const drawer = document.createElement('div');
    drawer.id = PANEL_ID;
    drawer.className = 'inline-drawer';
    drawer.innerHTML = buildPanelTemplate({
        counterMode: runtime.settings.counterMode,
        uiLanguage: runtime.settings.uiLanguage,
    });

    host.prepend(drawer);
    cachePanelElements(runtime, drawer);
    bindPanelEvents(drawer, runtime, {
        render,
        persistSettings,
        actions,
    });
    hydrateForm(runtime);
    render();
    return drawer;
}

export function syncValidationControls(runtime, settings) {
    if (!runtime?.ui?.panel) {
        return;
    }

    const counterInput = runtime.ui.counterInput;
    const tokensInput = runtime.ui.tokensInput;
    if (counterInput) {
        counterInput.disabled = settings.validationMode !== VALIDATION_MODE.CHARACTERS;
    }
    if (tokensInput) {
        tokensInput.disabled = settings.validationMode !== VALIDATION_MODE.TOKENS;
    }
}

function cachePanelElements(runtime, drawer) {
    runtime.ui.panel = drawer;
    runtime.ui.statusText = drawer.querySelector('[data-role="state-pill"]');
    runtime.ui.stats = drawer.querySelector('[data-role="stats"]');
    runtime.ui.retryLogShell = drawer.querySelector('[data-role="retry-log-shell"]');
    runtime.ui.retryLogContainer = drawer.querySelector('[data-role="retry-log-box"]');
    runtime.ui.releaseInfoContainer = drawer.querySelector('[data-role="release-info"]');
    runtime.ui.errorBox = drawer.querySelector('[data-role="error-box"]');
    runtime.ui.actionToggleButton = drawer.querySelector('[data-action="toggle-run"]');
    runtime.ui.quickReplyStatusLine = drawer.querySelector('[data-role="qr-status"]');
    runtime.ui.quickReplyToggleButton = drawer.querySelector('[data-action="toggle-qr"]');
    runtime.ui.mainPane = drawer.querySelector('[data-role="main-pane"]');
    runtime.ui.systemPane = drawer.querySelector('[data-role="system-pane"]');
    runtime.ui.tabButtons = Array.from(drawer.querySelectorAll('.rm-tab'));
    runtime.ui.toggleLogButton = drawer.querySelector('[data-action="toggle-log"]');
    runtime.ui.syncStatusButton = drawer.querySelector('[data-action="sync-status"]');
    runtime.ui.counterInput = drawer.querySelector('[data-role="counter-input"]');
    runtime.ui.tokensInput = drawer.querySelector(`#${EXTENSION_ID}-tokens`);
    runtime.ui.counterModeSelect = drawer.querySelector(`#${EXTENSION_ID}-counter-mode`);
}

function bindPanelEvents(drawer, runtime, {
    render,
    persistSettings,
    actions,
}) {
    if (drawer.dataset.rmBound === 'true') {
        return;
    }

    drawer.dataset.rmBound = 'true';

    drawer.addEventListener('click', async (event) => {
        const action = event.target?.closest?.('[data-action]')?.dataset?.action;
        if (!action) {
            const header = event.target?.closest?.('.inline-drawer-toggle');
            if (header) {
                // Let SillyTavern's built-in inline-drawer handler manage open/close state.
                // (Toggling our own closed class can desync with ST's inline `display` styles.)
            }
            return;
        }

        if (action === 'toggle-run') {
            await actions.onToggleRun?.();
            return;
        }

        if (action === 'toggle-qr') {
            await actions.onToggleQuickReplies?.();
            return;
        }

        if (action === 'show-tab') {
            const tab = event.target?.closest?.('[data-tab]')?.dataset?.tab === 'system'
                ? 'system'
                : 'main';
            await actions.onShowTab?.(tab);
            return;
        }

        if (action === 'toggle-log') {
            await actions.onToggleLog?.();
            return;
        }

        if (action === 'copy-log') {
            await actions.onCopyLog?.();
            return;
        }

        if (action === 'download-log') {
            await actions.onDownloadLog?.();
            return;
        }

        if (action === 'sync-status') {
            await actions.onSyncStatus?.();
        }
    });

    drawer.addEventListener('change', (event) => {
        const languageChanged = event.target?.id === `${EXTENSION_ID}-ui-language`;
        const counterModeChanged = event.target?.id === `${EXTENSION_ID}-counter-mode`;
        const changed = updateSettingsFromChange(event.target, runtime.settings);
        if (!changed) {
            return;
        }

        persistSettings();
        // Both language and counter-mode changes affect the rendered counter
        // label/input on the main panel — rebuild the template so the right
        // labels, ids and helper bindings are present.
        if (languageChanged || counterModeChanged) {
            remountLocalizedPanel(drawer, runtime, {
                render,
                persistSettings,
                actions,
            });
            return;
        }
        render();
    });
}

function hydrateForm(runtime) {
    const drawer = runtime.ui.panel;
    if (!drawer) {
        return;
    }

    drawer.querySelector(`#${EXTENSION_ID}-target`).value = String(runtime.settings.targetAcceptedCount);
    drawer.querySelector(`#${EXTENSION_ID}-attempts`).value = String(runtime.settings.maxAttempts);
    drawer.querySelector(`#${EXTENSION_ID}-timeout`).value = String(runtime.settings.attemptTimeoutSeconds);
    drawer.querySelector(`#${EXTENSION_ID}-native-grace`).value = String(runtime.settings.nativeGraceSeconds);
    const counterInput = runtime.ui.counterInput;
    if (counterInput) {
        const isWordsInput = counterInput.dataset.counterMode === COUNTER_MODE.WORDS;
        counterInput.value = String(isWordsInput ? runtime.settings.minWords : runtime.settings.minCharacters);
    }
    drawer.querySelector(`#${EXTENSION_ID}-tokens`).value = String(runtime.settings.minTokens);
    drawer.querySelector(`#${EXTENSION_ID}-notification-template`).value = runtime.settings.notificationMessageTemplate || '';
    drawer.querySelector(`#${EXTENSION_ID}-ui-language`).value = String(runtime.settings.uiLanguage || 'en');
    const counterModeSelect = runtime.ui.counterModeSelect;
    if (counterModeSelect) {
        counterModeSelect.value = String(runtime.settings.counterMode || COUNTER_MODE.AUTO);
    }
    drawer.querySelectorAll(`input[name="${EXTENSION_ID}-run-mode"]`).forEach((element) => {
        element.checked = element.value === runtime.settings.runMode;
    });
    drawer.querySelectorAll(`input[name="${EXTENSION_ID}-validation-mode"]`).forEach((element) => {
        element.checked = element.value === runtime.settings.validationMode;
    });
    drawer.querySelectorAll('[data-setting]').forEach((element) => {
        element.checked = Boolean(runtime.settings[element.dataset.setting]);
    });
    syncValidationControls(runtime, runtime.settings);
}

function updateSettingsFromChange(target, settings) {
    const runMode = target?.name === `${EXTENSION_ID}-run-mode`
        ? String(target.value || '')
        : '';
    if (runMode) {
        settings.runMode = runMode === RUN_MODE.TOGGLE ? RUN_MODE.TOGGLE : RUN_MODE.SINGLE;
        return true;
    }

    const validationMode = target?.name === `${EXTENSION_ID}-validation-mode`
        ? String(target.value || '')
        : '';
    if (validationMode) {
        settings.validationMode = validationMode === VALIDATION_MODE.TOKENS
            ? VALIDATION_MODE.TOKENS
            : VALIDATION_MODE.CHARACTERS;
        return true;
    }

    const field = target?.dataset?.setting;
    if (field) {
        settings[field] = Boolean(target.checked);
        return true;
    }

    if (target?.id === `${EXTENSION_ID}-target`) {
        settings.targetAcceptedCount = clampWholeNumber(target.value, 1, settings.targetAcceptedCount);
        return true;
    }

    if (target?.id === `${EXTENSION_ID}-attempts`) {
        settings.maxAttempts = clampWholeNumber(target.value, 1, settings.maxAttempts);
        return true;
    }

    if (target?.id === `${EXTENSION_ID}-timeout`) {
        settings.attemptTimeoutSeconds = clampWholeNumber(target.value, 1, settings.attemptTimeoutSeconds);
        return true;
    }

    if (target?.id === `${EXTENSION_ID}-native-grace`) {
        settings.nativeGraceSeconds = clampWholeNumber(target.value, 10, settings.nativeGraceSeconds);
        return true;
    }

    // The counter input id varies by counter mode (-characters or -words).
    // Read the data-counter-mode attribute we stamped onto the element.
    if (target?.dataset?.role === 'counter-input') {
        const subMode = target.dataset.counterMode === COUNTER_MODE.WORDS
            ? COUNTER_MODE.WORDS
            : COUNTER_MODE.CHARACTERS;
        if (subMode === COUNTER_MODE.WORDS) {
            settings.minWords = clampWholeNumber(target.value, 0, settings.minWords);
        } else {
            settings.minCharacters = clampWholeNumber(target.value, 0, settings.minCharacters);
        }
        return true;
    }

    if (target?.id === `${EXTENSION_ID}-tokens`) {
        settings.minTokens = clampWholeNumber(target.value, 0, settings.minTokens);
        return true;
    }

    if (target?.id === `${EXTENSION_ID}-counter-mode`) {
        const value = String(target.value || '').trim().toLowerCase();
        if (value === COUNTER_MODE.WORDS || value === COUNTER_MODE.CHARACTERS) {
            settings.counterMode = value;
        } else {
            settings.counterMode = COUNTER_MODE.AUTO;
        }
        return true;
    }

    if (target?.id === `${EXTENSION_ID}-notification-template`) {
        settings.notificationMessageTemplate = String(target.value || '');
        return true;
    }

    if (target?.id === `${EXTENSION_ID}-ui-language`) {
        settings.uiLanguage = String(target.value || '').trim().toLowerCase() === 'zh' ? 'zh' : 'en';
        setLanguage(settings.uiLanguage);
        return true;
    }

    return false;
}

function clampWholeNumber(value, minimum, fallback) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed < minimum) {
        return fallback;
    }

    return parsed;
}

function remountLocalizedPanel(drawer, runtime, options) {
    drawer.dataset.rmBound = '';
    drawer.innerHTML = buildPanelTemplate({
        counterMode: runtime.settings.counterMode,
        uiLanguage: runtime.settings.uiLanguage,
    });
    cachePanelElements(runtime, drawer);
    bindPanelEvents(drawer, runtime, options);
    hydrateForm(runtime);
    options.render();
}
