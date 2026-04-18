import {
    EXTENSION_ID,
    PANEL_ID,
    RUN_MODE,
    VALIDATION_MODE,
} from '../constants.js';
import { buildPanelTemplate } from './panel-template.js';

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
    drawer.innerHTML = buildPanelTemplate();

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

export function syncValidationControls(drawer, settings) {
    if (!drawer) {
        return;
    }

    const charactersInput = drawer.querySelector(`#${EXTENSION_ID}-characters`);
    const tokensInput = drawer.querySelector(`#${EXTENSION_ID}-tokens`);
    if (charactersInput) {
        charactersInput.disabled = settings.validationMode !== VALIDATION_MODE.CHARACTERS;
    }
    if (tokensInput) {
        tokensInput.disabled = settings.validationMode !== VALIDATION_MODE.TOKENS;
    }
}

function cachePanelElements(runtime, drawer) {
    runtime.panel = drawer;
    runtime.statusText = drawer.querySelector('[data-role="state-pill"]');
    runtime.stats = drawer.querySelector('[data-role="stats"]');
    runtime.diagnosticsOutput = drawer.querySelector('[data-role="diagnostics-output"]');
    runtime.retryLogShell = drawer.querySelector('[data-role="retry-log-shell"]');
    runtime.retryLogContainer = drawer.querySelector('[data-role="retry-log-box"]');
    runtime.releaseInfoContainer = drawer.querySelector('[data-role="release-info"]');
    runtime.errorBox = drawer.querySelector('[data-role="error-box"]');
    runtime.actionToggleButton = drawer.querySelector('[data-action="toggle-run"]');
    runtime.quickReplyStatusLine = drawer.querySelector('[data-role="qr-status"]');
    runtime.quickReplyToggleButton = drawer.querySelector('[data-action="toggle-qr"]');
    runtime.mainPane = drawer.querySelector('[data-role="main-pane"]');
    runtime.systemPane = drawer.querySelector('[data-role="system-pane"]');
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
                drawer.classList.toggle('inline-drawer-closed');
            }
            return;
        }

        if (action === 'toggle-run') {
            await actions.onToggleRun?.();
            return;
        }

        if (action === 'diagnostics') {
            await actions.onDiagnostics?.();
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
        }
    });

    drawer.addEventListener('change', (event) => {
        const changed = updateSettingsFromChange(event.target, runtime.settings);
        if (!changed) {
            return;
        }

        persistSettings();
        render();
    });
}

function hydrateForm(runtime) {
    const drawer = runtime.panel;
    if (!drawer) {
        return;
    }

    drawer.querySelector(`#${EXTENSION_ID}-target`).value = String(runtime.settings.targetAcceptedCount);
    drawer.querySelector(`#${EXTENSION_ID}-attempts`).value = String(runtime.settings.maxAttempts);
    drawer.querySelector(`#${EXTENSION_ID}-timeout`).value = String(runtime.settings.attemptTimeoutSeconds);
    drawer.querySelector(`#${EXTENSION_ID}-native-grace`).value = String(runtime.settings.nativeGraceSeconds);
    drawer.querySelector(`#${EXTENSION_ID}-characters`).value = String(runtime.settings.minCharacters);
    drawer.querySelector(`#${EXTENSION_ID}-tokens`).value = String(runtime.settings.minTokens);
    drawer.querySelector(`#${EXTENSION_ID}-notification-template`).value = runtime.settings.notificationMessageTemplate || '';
    drawer.querySelectorAll(`input[name="${EXTENSION_ID}-run-mode"]`).forEach((element) => {
        element.checked = element.value === runtime.settings.runMode;
    });
    drawer.querySelectorAll(`input[name="${EXTENSION_ID}-validation-mode"]`).forEach((element) => {
        element.checked = element.value === runtime.settings.validationMode;
    });
    drawer.querySelectorAll('[data-setting]').forEach((element) => {
        element.checked = Boolean(runtime.settings[element.dataset.setting]);
    });
    syncValidationControls(drawer, runtime.settings);
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

    if (target?.id === `${EXTENSION_ID}-characters`) {
        settings.minCharacters = clampWholeNumber(target.value, 0, settings.minCharacters);
        return true;
    }

    if (target?.id === `${EXTENSION_ID}-tokens`) {
        settings.minTokens = clampWholeNumber(target.value, 0, settings.minTokens);
        return true;
    }

    if (target?.id === `${EXTENSION_ID}-notification-template`) {
        settings.notificationMessageTemplate = String(target.value || '');
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
