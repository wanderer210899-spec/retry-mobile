import {
    BACKEND_PLUGIN_ID,
    EXTENSION_ID,
    EXTENSION_NAME,
    LOG_PREFIX,
    PANEL_ID,
    POLL_INTERVAL_MS,
    REPOSITORY_URL,
    RUN_MODE,
    RUN_STATE,
    SLASH_COMMAND_PREFIX,
    VALIDATION_MODE,
} from './constants.js';
import { createLogger } from './logger.js';
import { readSettings, writeSettings } from './settings.js';
import {
    focusPanelDrawer,
    getChatIdentity,
    getContext,
    registerSlashCommand,
    showToast,
} from './st-context.js';
import {
    cancelBackendJob,
    fetchActiveJob,
    fetchCapabilities,
    fetchJobStatus,
    fetchReleaseInfo,
    getStructuredErrorFromApi,
    startBackendJob,
} from './backend-api.js';
import { runDiagnostics } from './diagnostics.js';
import { getQuickReplyStatus, setQuickReplyAttached } from './quick-reply.js';
import { syncRemoteStatus } from './chat-sync.js';
import { createStateMachine } from './state-machine.js';
import { createArmCaptureSession } from './st-capture.js';
import { waitForNativeCompletion } from './st-lifecycle.js';
import { isSameChat, reloadCurrentChatSafe } from './st-chat.js';
import { createStructuredError, formatStructuredError, normalizeStructuredError } from './retry-error.js';

const log = createLogger(LOG_PREFIX.APP);
const backendLog = createLogger(LOG_PREFIX.BACKEND);
const qrLog = createLogger(LOG_PREFIX.QR);

const runtime = {
    settings: null,
    diagnostics: null,
    panel: null,
    statusText: null,
    stats: null,
    retryLogContainer: null,
    releaseInfoContainer: null,
    errorBox: null,
    noteBox: null,
    actionToggleButton: null,
    quickReplyStatusLine: null,
    quickReplyToggleButton: null,
    mainPane: null,
    systemPane: null,
    machine: createStateMachine(),
    captureSession: null,
    activeJobId: null,
    activeJobStatus: null,
    quickReplyStatus: null,
    pollHandle: 0,
    lastAppliedVersion: 0,
    manualStopRequested: false,
    mountRetryHandle: 0,
    hostObserver: null,
    quickReplyRefreshHandle: 0,
    capturedRequest: null,
    fingerprint: null,
    assistantMessageIndex: null,
    termuxAvailable: false,
    releaseInfo: null,
    showRetryLog: false,
    activeTab: 'main',
};

export function bootRetryMobile() {
    runtime.settings = readSettings(getContext());
    mountPanel();
    bindHostObserver();
    registerCommands();
    void refreshDiagnostics();
    refreshQuickReplyState({ quiet: true });
    scheduleQuickReplyRefresh();
    void restoreActiveJob();
    void fetchCapabilities().then((caps) => {
        runtime.termuxAvailable = Boolean(caps?.termux);
        render();
    });
    void refreshReleaseInfo();
}

function mountPanel() {
    if (document.getElementById(PANEL_ID)) {
        return;
    }

    const host = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
    if (!host) {
        scheduleMountRetry();
        return;
    }

    if (runtime.mountRetryHandle) {
        window.clearTimeout(runtime.mountRetryHandle);
        runtime.mountRetryHandle = 0;
    }

    const drawer = document.createElement('div');
    drawer.id = PANEL_ID;
    drawer.className = 'inline-drawer';
    drawer.innerHTML = `
        <div class="inline-drawer-toggle inline-drawer-header">
            <b>${EXTENSION_NAME}</b>
            <div class="inline-drawer-icon fa-solid fa-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">
            <div class="rm-panel__body">
                <!-- ── TAB BAR + STATUS ROW ───────────────────── -->
                <div class="rm-topbar">
                    <nav class="rm-tabbar" aria-label="Retry Mobile panels">
                        <button class="menu_button rm-tab" data-action="show-tab" data-tab="main" type="button">Main</button>
                        <button class="menu_button rm-tab" data-action="show-tab" data-tab="system" type="button">System</button>
                    </nav>
                    <div class="rm-status-pill" data-role="state-pill" data-state="${RUN_STATE.IDLE}">Idle</div>
                </div>

                <!-- ── STATS STRIP ───────────────────────────────── -->
                <div class="rm-stats-strip" data-role="stats"></div>

                <!-- ── MAIN PANE ─────────────────────────────────── -->
                <div class="rm-panel__pane" data-role="main-pane">

                    <!-- Configuration -->
                    <section class="rm-fieldset">
                        <div class="rm-fieldset__title">Configuration</div>

                        <!-- Run mode -->
                        <div class="rm-inline-row">
                            <span class="rm-inline-row__label">Run mode</span>
                            <div class="rm-mode-toggle" role="radiogroup" aria-label="Retry Mobile run mode">
                                <label class="rm-mode-toggle__option">
                                    <input type="radio" name="${EXTENSION_ID}-run-mode" value="${RUN_MODE.SINGLE}" />
                                    <span>Single</span>
                                </label>
                                <label class="rm-mode-toggle__option">
                                    <input type="radio" name="${EXTENSION_ID}-run-mode" value="${RUN_MODE.TOGGLE}" />
                                    <span>Toggle</span>
                                </label>
                            </div>
                        </div>

                        <!-- Number inputs -->
                        <div class="rm-number-rows">
                            <div class="rm-inline-row">
                                <label class="rm-inline-row__label" for="${EXTENSION_ID}-target">Accepted outputs goal</label>
                                <input id="${EXTENSION_ID}-target" class="rm-number-input" type="number" min="1" step="1" />
                            </div>
                            <div class="rm-inline-row">
                                <label class="rm-inline-row__label" for="${EXTENSION_ID}-attempts">Maximum attempts</label>
                                <input id="${EXTENSION_ID}-attempts" class="rm-number-input" type="number" min="1" step="1" />
                            </div>
                            <div class="rm-inline-row">
                                <label class="rm-inline-row__label" for="${EXTENSION_ID}-timeout">Attempt timeout (s)</label>
                                <input id="${EXTENSION_ID}-timeout" class="rm-number-input" type="number" min="1" step="1" />
                            </div>
                        </div>

                        <!-- Acceptance hard block -->
                        <div class="rm-field rm-field--wide">
                            <label class="rm-field__label">Min. length block</label>
                            <div class="rm-block-grid" role="radiogroup" aria-label="Retry Mobile acceptance hard block">
                                <label class="rm-block-option">
                                    <input type="radio" name="${EXTENSION_ID}-validation-mode" value="${VALIDATION_MODE.CHARACTERS}" />
                                    <span>Characters</span>
                                </label>
                                <label class="rm-block-option">
                                    <input type="radio" name="${EXTENSION_ID}-validation-mode" value="${VALIDATION_MODE.TOKENS}" />
                                    <span>Tokens</span>
                                </label>
                            </div>
                            <div class="rm-number-rows">
                                <div class="rm-inline-row">
                                    <label class="rm-inline-row__label" for="${EXTENSION_ID}-characters">Minimum characters</label>
                                    <input id="${EXTENSION_ID}-characters" class="rm-number-input" type="number" min="0" step="1" />
                                </div>
                                <div class="rm-inline-row">
                                    <label class="rm-inline-row__label" for="${EXTENSION_ID}-tokens">Minimum tokens</label>
                                    <input id="${EXTENSION_ID}-tokens" class="rm-number-input" type="number" min="0" step="1" />
                                </div>
                            </div>
                        </div>
                    </section>

                    <!-- Notifications -->
                    <section class="rm-fieldset">
                        <div class="rm-fieldset__title">Notifications</div>
                        <div class="rm-field">
                            <label for="${EXTENSION_ID}-notification-template">Termux notification template</label>
                            <textarea id="${EXTENSION_ID}-notification-template" rows="2" placeholder="Leave blank for default."></textarea>
                        </div>
                        <div class="rm-checkbox-grid">
                            <label class="rm-checkbox">
                                <input data-setting="notifyOnSuccess" type="checkbox" />
                                <span>Notify on accepted</span>
                            </label>
                            <label class="rm-checkbox">
                                <input data-setting="notifyOnComplete" type="checkbox" />
                                <span>Notify on complete</span>
                            </label>
                            <label class="rm-checkbox">
                                <input data-setting="vibrateOnSuccess" type="checkbox" />
                                <span>Vibrate on accepted</span>
                            </label>
                            <label class="rm-checkbox">
                                <input data-setting="vibrateOnComplete" type="checkbox" />
                                <span>Vibrate on complete</span>
                            </label>
                        </div>
                    </section>

                    <!-- Quick Replies -->
                    <section class="rm-fieldset">
                        <div class="rm-inline-row">
                            <span class="rm-inline-row__label">Quick Replies</span>
                            <button class="menu_button rm-qr-toggle" data-action="toggle-qr">Inject</button>
                        </div>
                        <div class="rm-qr-status" data-role="qr-status"></div>
                    </section>

                    <!-- Actions -->
                    <button class="menu_button rm-button--primary rm-button--full" data-action="toggle-run">Start</button>

                    <div class="rm-error" data-role="error-box" hidden></div>
                </div>

                <!-- ── SYSTEM PANE ────────────────────────────────── -->
                <div class="rm-panel__pane" data-role="system-pane" hidden>

                    <!-- Diagnostics -->
                    <section class="rm-fieldset">
                        <div class="rm-fieldset__title rm-section-row">
                            <span>Diagnostics</span>
                            <button class="menu_button rm-button--inline" data-action="diagnostics">Run</button>
                        </div>
                        <div class="rm-diagnostics-output" data-role="diagnostics-output">
                            <div class="rm-diagnostics__line">No diagnostics have run yet.</div>
                        </div>
                    </section>

                    <!-- Install & Update -->
                    <section class="rm-fieldset">
                        <div class="rm-fieldset__title rm-section-row">
                            <span>Install &amp; Update</span>
                            <a class="rm-github-link" href="${REPOSITORY_URL}" target="_blank" rel="noopener noreferrer"><i class="fa-brands fa-github"></i> GitHub</a>
                        </div>
                        <div class="rm-release-card" data-role="release-info">Checking...</div>
                    </section>

                    <!-- Retry Log -->
                    <section class="rm-fieldset">
                        <div class="rm-fieldset__title rm-section-row">
                            <span>Retry Log</span>
                            <div class="rm-header-actions">
                                <button class="menu_button rm-button--inline" data-action="toggle-log">Show</button>
                                <button class="menu_button rm-button--inline" data-action="copy-log">Copy</button>
                            </div>
                        </div>
                        <div class="rm-log-window" data-role="retry-log-shell" hidden>
                            <div data-role="retry-log-box"></div>
                        </div>
                    </section>
                </div>
            </div>
        </div>
    `;

    host.prepend(drawer);
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

    bindPanelEvents(drawer);
    hydrateForm();
    render();
}

async function refreshReleaseInfo() {
    try {
        runtime.releaseInfo = await fetchReleaseInfo();
    } catch (error) {
        backendLog.warn('Could not fetch release info.', error);
        runtime.releaseInfo = {
            repositoryUrl: REPOSITORY_URL,
            git: {
                canCheck: false,
                hasUpdate: false,
                message: 'Git tracking unavailable for this install.',
            },
            update: {
                canCheck: false,
                hasUpdate: false,
                message: error?.message || 'Retry Mobile could not reach the backend release endpoint.',
            },
            installed: {
                backend: { installed: true, version: '' },
                frontend: { installed: false, version: '', scope: 'missing' },
            },
            latest: {
                backendVersion: '',
                frontendVersion: '',
            },
            instructions: {
                updateNow: 'From your local SillyTavern directory, run the Retry Mobile bootstrap installer and choose Install / Update now.',
                addProfile: 'From your local SillyTavern directory, run the Retry Mobile bootstrap installer and choose Install / Update now to add another profile or install for everyone.',
            },
        };
    }

    render();
}

function bindPanelEvents(drawer) {
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
            if (isRunningLikeState(getCurrentState())) {
                await stopPlugin();
            } else {
                await armPluginFromUi();
            }
            return;
        }

        if (action === 'diagnostics') {
            await refreshDiagnostics(true);
            runtime.activeTab = 'system';
            render();
            return;
        }

        if (action === 'toggle-qr') {
            await toggleQuickRepliesFromUi();
            return;
        }

        if (action === 'show-tab') {
            runtime.activeTab = event.target?.closest?.('[data-tab]')?.dataset?.tab === 'system'
                ? 'system'
                : 'main';
            if (runtime.activeTab === 'system') {
                void refreshReleaseInfo();
            }
            render();
            return;
        }

        if (action === 'toggle-log') {
            runtime.showRetryLog = !runtime.showRetryLog;
            runtime.activeTab = 'system';
            render();
            return;
        }

        if (action === 'copy-log') {
            await copyRetryLogFromUi();
        }
    });

    drawer.addEventListener('change', (event) => {
        const runMode = event.target?.name === `${EXTENSION_ID}-run-mode`
            ? String(event.target.value || '')
            : '';
        if (runMode) {
            runtime.settings.runMode = runMode === RUN_MODE.TOGGLE ? RUN_MODE.TOGGLE : RUN_MODE.SINGLE;
            persistSettings();
            render();
            return;
        }

        const validationMode = event.target?.name === `${EXTENSION_ID}-validation-mode`
            ? String(event.target.value || '')
            : '';
        if (validationMode) {
            runtime.settings.validationMode = validationMode === VALIDATION_MODE.TOKENS
                ? VALIDATION_MODE.TOKENS
                : VALIDATION_MODE.CHARACTERS;
            persistSettings();
            render();
            return;
        }

        const field = event.target?.dataset?.setting;
        if (field) {
            runtime.settings[field] = Boolean(event.target.checked);
            persistSettings();
            render();
            return;
        }

        if (event.target?.id === `${EXTENSION_ID}-target`) {
            runtime.settings.targetAcceptedCount = clampWholeNumber(event.target.value, 1, runtime.settings.targetAcceptedCount);
            persistSettings();
            render();
            return;
        }

        if (event.target?.id === `${EXTENSION_ID}-attempts`) {
            runtime.settings.maxAttempts = clampWholeNumber(event.target.value, 1, runtime.settings.maxAttempts);
            persistSettings();
            render();
            return;
        }

        if (event.target?.id === `${EXTENSION_ID}-timeout`) {
            runtime.settings.attemptTimeoutSeconds = clampWholeNumber(event.target.value, 1, runtime.settings.attemptTimeoutSeconds);
            persistSettings();
            render();
            return;
        }

        if (event.target?.id === `${EXTENSION_ID}-characters`) {
            runtime.settings.minCharacters = clampWholeNumber(event.target.value, 0, runtime.settings.minCharacters);
            persistSettings();
            render();
            return;
        }

        if (event.target?.id === `${EXTENSION_ID}-tokens`) {
            runtime.settings.minTokens = clampWholeNumber(event.target.value, 0, runtime.settings.minTokens);
            persistSettings();
            render();
            return;
        }

        if (event.target?.id === `${EXTENSION_ID}-notification-template`) {
            runtime.settings.notificationMessageTemplate = String(event.target.value || '');
            persistSettings();
            render();
        }
    });
}

function hydrateForm() {
    const drawer = runtime.panel;
    if (!drawer) {
        return;
    }

    drawer.querySelector(`#${EXTENSION_ID}-target`).value = String(runtime.settings.targetAcceptedCount);
    drawer.querySelector(`#${EXTENSION_ID}-attempts`).value = String(runtime.settings.maxAttempts);
    drawer.querySelector(`#${EXTENSION_ID}-timeout`).value = String(runtime.settings.attemptTimeoutSeconds);
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
    syncValidationControls(drawer);
}

function persistSettings() {
    writeSettings(getContext(), runtime.settings);
}

async function armPluginFromUi() {
    await armPlugin({
        showToastMessage: 'Retry Mobile is armed for the next qualifying generation in this chat.',
    });
}

async function armPlugin(options = {}) {
    if (!runtime.diagnostics?.startEnabled) {
        applyErrorState(createStructuredError(
            'capture_missing_payload',
            'Retry Mobile is blocked by missing SillyTavern capabilities. Run diagnostics first.',
        ));
        return;
    }

    const context = getContext();
    const identity = getChatIdentity(context);
    if (!identity?.chatId) {
        applyErrorState(createStructuredError(
            'capture_chat_changed',
            'No active chat was found. Open a chat before arming Retry Mobile.',
        ));
        return;
    }

    if (runtime.settings.maxAttempts < runtime.settings.targetAcceptedCount) {
        applyErrorState(createStructuredError(
            'handoff_request_failed',
            'Maximum attempts must be at least as large as the accepted outputs goal.',
        ));
        return;
    }

    const runConfigError = getRunConfigError(runtime.settings);
    if (runConfigError) {
        applyErrorState(runConfigError);
        return;
    }

    if (isRunningLikeState(getCurrentState())) {
        applyErrorState(createStructuredError(
            'handoff_request_failed',
            'Retry Mobile is already armed or running for this browser session.',
        ));
        return;
    }

    stopCaptureSession();
    clearPolling();
    resetRunBuffers({ preserveStatus: false });
    runtime.manualStopRequested = false;

    const snapshot = runtime.machine.startRun({ chatIdentity: identity });
    runtime.machine.clearError();
    runtime.machine.recordEvent('ui', 'armed', 'User armed Retry Mobile.');

    const runId = snapshot.runId;
    runtime.captureSession = createArmCaptureSession({
        chatIdentity: identity,
        onCapture: (result) => {
            void handleCaptureResult(runId, result);
        },
        onCancel: (error) => {
            if (!runtime.machine.isCurrentRun(runId)) {
                return;
            }

            void applyTerminalState(runId, RUN_STATE.CANCELLED, {
                error,
                toastKind: 'warning',
                toastMessage: error.message,
            });
        },
        onEvent: (name, summary) => {
            if (!runtime.machine.isCurrentRun(runId)) {
                return;
            }

            runtime.machine.setNativeEvent(name, summary);
            runtime.machine.recordEvent('st', name, summary);
            render();
        },
    });

    render();
    if (options.showToastMessage) {
        showToast('info', EXTENSION_NAME, options.showToastMessage);
    }
}

async function handleCaptureResult(runId, result) {
    if (!runtime.machine.isCurrentRun(runId)) {
        return;
    }

    if (!result?.ok) {
        const structured = normalizeStructuredError(
            result?.error,
            'capture_missing_payload',
            'Retry Mobile could not capture the native request payload.',
        );
        await applyTerminalState(runId, RUN_STATE.FAILED, {
            error: structured,
            toastKind: 'warning',
            toastMessage: formatStructuredError(structured),
        });
        return;
    }

    runtime.capturedRequest = result.capturedRequest;
    runtime.fingerprint = result.fingerprint;
    runtime.assistantMessageIndex = null;

    runtime.machine.clearError();
    runtime.machine.transition(RUN_STATE.WAITING_FOR_NATIVE);
    runtime.machine.setNativeEvent('CHAT_COMPLETION_SETTINGS_READY', `Captured ${result.requestType || 'normal'} request for user turn ${result.fingerprint.userMessageIndex}.`);
    runtime.machine.recordEvent('st', 'capture_confirmed', 'Captured a qualifying ST request and switched to native wait.');
    render();
    showToast('info', EXTENSION_NAME, 'Retry Mobile captured this generation. SillyTavern is creating the first reply.');

    try {
        const nativeResult = await waitForNativeCompletion({
            chatIdentity: runtime.machine.getSnapshot().chatIdentity,
            fingerprint: runtime.fingerprint,
            onEvent: (name, summary) => {
                if (!runtime.machine.isCurrentRun(runId)) {
                    return;
                }

                runtime.machine.setNativeEvent(name, summary);
                runtime.machine.recordEvent('st', name, summary);
                render();
            },
        });

        if (!runtime.machine.isCurrentRun(runId)) {
            return;
        }

        runtime.assistantMessageIndex = nativeResult.assistantMessageIndex;
        runtime.machine.transition(RUN_STATE.HANDING_OFF);
        runtime.machine.recordEvent(
            'st',
            'native_confirmed',
            `Confirmed native assistant turn ${nativeResult.assistantMessageIndex}.`,
        );
        render();
        await handoffToBackend(runId, nativeResult);
    } catch (error) {
        if (!runtime.machine.isCurrentRun(runId)) {
            return;
        }

        const structured = normalizeStructuredError(
            error,
            'native_wait_timeout',
            'Retry Mobile could not confirm the native assistant turn.',
        );
        await applyTerminalState(runId, RUN_STATE.FAILED, {
            error: structured,
            toastKind: 'warning',
            toastMessage: formatStructuredError(structured),
        });
    }
}

async function handoffToBackend(runId, nativeResult) {
    if (!runtime.machine.isCurrentRun(runId)) {
        return;
    }

    const snapshot = runtime.machine.getSnapshot();
    const body = {
        schemaVersion: 2,
        runId,
        chatIdentity: snapshot.chatIdentity,
        runConfig: {
            targetAcceptedCount: runtime.settings.targetAcceptedCount,
            maxAttempts: runtime.settings.maxAttempts,
            attemptTimeoutSeconds: runtime.settings.attemptTimeoutSeconds,
            validationMode: runtime.settings.validationMode,
            minTokens: runtime.settings.minTokens,
            minCharacters: runtime.settings.minCharacters,
            notifyOnSuccess: runtime.settings.notifyOnSuccess,
            notifyOnComplete: runtime.settings.notifyOnComplete,
            vibrateOnSuccess: runtime.settings.vibrateOnSuccess,
            vibrateOnComplete: runtime.settings.vibrateOnComplete,
            notificationMessageTemplate: runtime.settings.notificationMessageTemplate,
        },
        capturedRequest: runtime.capturedRequest,
        targetFingerprint: runtime.fingerprint,
        assistantMessageIndex: nativeResult.assistantMessageIndex,
        captureMeta: {
            capturedAt: runtime.fingerprint?.capturedAt || new Date().toISOString(),
            assistantName: snapshot.chatIdentity?.assistantName || 'Assistant',
        },
    };

    try {
        const result = await startBackendJob(body);
        if (!runtime.machine.isCurrentRun(runId)) {
            return;
        }

        runtime.activeJobId = result.jobId;
        runtime.activeJobStatus = result.job ?? null;
        runtime.lastAppliedVersion = 0;
        runtime.machine.setOwnsTurn(true);
        runtime.machine.setBackendEvent('handoff_started', `Started backend job ${result.jobId}.`);
        runtime.machine.recordEvent('backend', 'handoff_started', `Started backend job ${result.jobId}.`);
        runtime.machine.transition(RUN_STATE.RUNNING);
        startPolling(runId);
        render();
        showToast('success', EXTENSION_NAME, 'Retry Mobile is now handling retry generations for this turn.');
    } catch (error) {
        const structured = getStructuredErrorFromApi(error, 'Retry Mobile could not hand this turn off to the backend.');
        await applyTerminalState(runId, RUN_STATE.FAILED, {
            error: structured,
            toastKind: 'warning',
            toastMessage: formatStructuredError(structured),
        });
    }
}

async function stopPlugin() {
    runtime.manualStopRequested = true;
    const snapshot = runtime.machine.getSnapshot();
    const runId = snapshot.activeRunId || snapshot.runId;

    stopCaptureSession();
    clearPolling();

    if (runtime.activeJobId) {
        try {
            await cancelBackendJob(runtime.activeJobId);
            runtime.machine.recordEvent('backend', 'cancel_requested', `Requested cancellation for backend job ${runtime.activeJobId}.`);
        } catch (error) {
            backendLog.warn('Cancel request failed.', error);
        }
    }

    if (runId) {
        await applyTerminalState(runId, RUN_STATE.CANCELLED, {
            toastKind: 'info',
            toastMessage: 'Retry Mobile stopped.',
        });
    } else {
        runtime.machine.transition(RUN_STATE.CANCELLED);
        runtime.machine.releaseRun();
        render();
        showToast('info', EXTENSION_NAME, 'Retry Mobile stopped.');
    }
}

function startPolling(runId) {
    clearPolling();
    const pollSessionId = runtime.machine.startPollSession();
    runtime.pollHandle = window.setInterval(() => {
        void pollStatus(runId, pollSessionId);
    }, POLL_INTERVAL_MS);
    void pollStatus(runId, pollSessionId);
}

function clearPolling() {
    if (runtime.pollHandle) {
        window.clearInterval(runtime.pollHandle);
        runtime.pollHandle = 0;
    }

    runtime.machine.clearPollSession(runtime.machine.getSnapshot().pollSessionId);
}

async function pollStatus(runId, pollSessionId) {
    if (!runtime.machine.isCurrentRun(runId) || !runtime.machine.isCurrentPollSession(pollSessionId) || !runtime.activeJobId) {
        return;
    }

    const requestedJobId = runtime.activeJobId;
    try {
        const status = await fetchJobStatus(requestedJobId);
        if (!runtime.machine.isCurrentRun(runId) || !runtime.machine.isCurrentPollSession(pollSessionId)) {
            runtime.machine.recordEvent('backend', 'stale_poll_ignored', `Ignored stale status response for ${requestedJobId}.`);
            render();
            return;
        }

        if (status?.runId && status.runId !== runId) {
            runtime.machine.recordEvent('backend', 'stale_poll_ignored', `Ignored status for a different run id (${status.runId}).`);
            render();
            return;
        }

        const previousAccepted = Number(runtime.activeJobStatus?.acceptedCount) || 0;
        runtime.activeJobStatus = status;
        runtime.machine.setBackendEvent(status.phase || status.state || 'status', `Backend reported ${status.state || 'unknown'}.`);
        runtime.machine.recordEvent('backend', 'status', `Backend reported ${status.state || 'unknown'} (${status.acceptedCount || 0}/${status.targetAcceptedCount || 0}).`);

        const refreshed = await syncRemoteStatus(status, runtime);
        if (refreshed) {
            runtime.machine.recordEvent('backend', 'chat_reloaded', 'Reloaded the native chat after a new accepted swipe.');
        }

        if (Number(status.acceptedCount) > previousAccepted && runtime.settings.notifyOnSuccess) {
            showToast('success', EXTENSION_NAME, `Retry Mobile accepted ${status.acceptedCount}/${status.targetAcceptedCount} generations.`);
        }

        if (status.state === 'completed') {
            await applyTerminalState(runId, RUN_STATE.COMPLETED, {
                toastKind: 'success',
                toastMessage: 'Retry Mobile finished this turn.',
            });
            return;
        }

        if (status.state === 'failed') {
            const structured = status.structuredError || createStructuredError(
                'backend_write_failed',
                status.lastError || 'The backend job failed.',
            );
            await applyTerminalState(runId, RUN_STATE.FAILED, {
                error: structured,
                toastKind: 'warning',
                toastMessage: formatStructuredError(structured),
            });
            return;
        }

        if (status.state === 'cancelled') {
            await applyTerminalState(runId, RUN_STATE.CANCELLED, {
                toastKind: 'info',
                toastMessage: 'Retry Mobile stopped.',
            });
            return;
        }

        render();
    } catch (error) {
        backendLog.warn('Status poll failed.', error);
        runtime.machine.recordEvent('backend', 'poll_failed', error?.message || 'Status poll failed.');
        if (error?.status === 404 && runtime.machine.isCurrentRun(runId) && runtime.activeJobId === requestedJobId) {
            await reloadCurrentChatSafe();
            await applyTerminalState(runId, RUN_STATE.FAILED, {
                error: createStructuredError(
                    'backend_job_missing',
                    'Retry Mobile lost the backend job while polling. The backend process may have restarted or been suspended.',
                ),
                toastKind: 'warning',
                toastMessage: 'Retry Mobile lost the backend job while polling.',
            });
            return;
        }
        render();
    }
}

async function applyTerminalState(runId, nextState, options = {}) {
    if (runId && !runtime.machine.isCurrentRun(runId) && runtime.machine.getSnapshot().runId !== runId) {
        return;
    }

    stopCaptureSession();
    clearPolling();

    const normalizedError = options.error
        ? normalizeStructuredError(options.error, 'unknown_error', options.error.message || 'Retry Mobile failed.')
        : null;

    if (normalizedError) {
        runtime.machine.setError(normalizedError);
    } else {
        runtime.machine.clearError();
    }

    runtime.machine.setOwnsTurn(false);
    runtime.machine.transition(nextState);
    runtime.machine.releaseRun();

    if (nextState !== RUN_STATE.RUNNING) {
        runtime.activeJobId = null;
    }

    render();

    if (options.toastMessage) {
        showToast(options.toastKind || 'info', EXTENSION_NAME, options.toastMessage);
    }

    await maybeAutoRearmAfterRun(nextState);
}

async function refreshDiagnostics(showFeedback = false) {
    runtime.diagnostics = await runDiagnostics(getContext());
    if (showFeedback) {
        showToast(runtime.diagnostics.startEnabled ? 'success' : 'warning', EXTENSION_NAME, runtime.diagnostics.startEnabled
            ? 'Diagnostics passed. Retry Mobile can arm for capture.'
            : 'Diagnostics found missing capabilities. Start stays fail-closed.');
    }

    render();
}

async function restoreActiveJob() {
    const identity = getChatIdentity(getContext());
    if (!identity?.chatId) {
        return;
    }

    try {
        const status = await fetchActiveJob(identity);
        if (!status?.jobId) {
            await reloadCurrentChatSafe();
            return;
        }

        runtime.machine.startRun({
            runId: status.runId || status.jobId,
            chatIdentity: status.chatIdentity || identity,
        });
        runtime.machine.transition(normalizeServerState(status.state));
        runtime.machine.setOwnsTurn(status.state === 'running');
        runtime.machine.setBackendEvent('restored', `Restored backend job ${status.jobId}.`);
        runtime.machine.recordEvent('backend', 'restored', `Restored backend job ${status.jobId}.`);
        runtime.activeJobId = status.jobId;
        runtime.activeJobStatus = status;
        runtime.lastAppliedVersion = 0;

        if (status.state === 'running') {
            startPolling(status.runId || status.jobId);
        } else {
            runtime.machine.releaseRun();
        }

        render();
    } catch (error) {
        backendLog.warn('Could not restore active job.', error);
    }
}

function registerCommands() {
    const context = getContext();
    if (!context) {
        return;
    }

    registerSlashCommand(context, {
        name: `${SLASH_COMMAND_PREFIX}-start`,
        callback: async () => {
            await armPluginFromUi();
        },
        helpString: 'Arm Retry Mobile for the next qualifying generation request.',
    });
    registerSlashCommand(context, {
        name: `${SLASH_COMMAND_PREFIX}-stop`,
        callback: async () => {
            await stopPlugin();
        },
        helpString: 'Stop the armed or running Retry Mobile job.',
    });
    registerSlashCommand(context, {
        name: `${SLASH_COMMAND_PREFIX}-panel`,
        callback: async () => {
            focusPanelDrawer(runtime.panel);
        },
        helpString: 'Focus the Retry Mobile settings panel.',
    });
    registerSlashCommand(context, {
        name: `${SLASH_COMMAND_PREFIX}-diagnostics`,
        callback: async () => {
            await refreshDiagnostics(true);
        },
        helpString: 'Run Retry Mobile diagnostics.',
    });
}

function refreshQuickReplyState(options = {}) {
    runtime.quickReplyStatus = getQuickReplyStatus();
    if (!options.quiet && !runtime.quickReplyStatus?.ok) {
        qrLog.warn('Quick Reply sync unavailable.', runtime.quickReplyStatus);
    }
    render();
}

function scheduleQuickReplyRefresh() {
    if (runtime.quickReplyRefreshHandle) {
        window.clearTimeout(runtime.quickReplyRefreshHandle);
    }

    runtime.quickReplyRefreshHandle = window.setTimeout(() => {
        runtime.quickReplyRefreshHandle = 0;
        refreshQuickReplyState({ quiet: true });
    }, 1800);
}

async function toggleQuickRepliesFromUi() {
    const currentStatus = runtime.quickReplyStatus?.ok
        ? runtime.quickReplyStatus
        : getQuickReplyStatus();
    const shouldAttach = !currentStatus?.attached;
    const result = setQuickReplyAttached(shouldAttach);
    runtime.quickReplyStatus = result.ok ? result : getQuickReplyStatus();

    if (!result.ok) {
        applyErrorState(createStructuredError(
            'capture_missing_payload',
            result.reason || 'Quick Reply controls are unavailable in this SillyTavern session.',
        ));
        return;
    }

    runtime.machine.clearError();
    showToast(
        'success',
        EXTENSION_NAME,
        shouldAttach
            ? 'Retry Mobile Quick Replies were injected into the active toolbar.'
            : 'Retry Mobile Quick Replies were uninjected from the active toolbar.',
    );
    render();
}

async function copyRetryLogFromUi() {
    const text = formatRetryLogText(runtime.activeJobStatus);
    if (!text.trim()) {
        showToast('info', EXTENSION_NAME, 'No retry log is available yet.');
        return;
    }

    try {
        await navigator.clipboard.writeText(text);
        showToast('success', EXTENSION_NAME, 'Retry log copied to clipboard.');
    } catch (error) {
        backendLog.warn('Retry log copy failed.', error);
        showToast('warning', EXTENSION_NAME, 'Retry log copy failed in this browser session.');
    }
}

function stopCaptureSession() {
    if (!runtime.captureSession) {
        return;
    }

    try {
        runtime.captureSession.stop?.();
    } catch (error) {
        log.warn('Capture session cleanup failed.', error);
    }
    runtime.captureSession = null;
}

function resetRunBuffers(options = {}) {
    runtime.capturedRequest = null;
    runtime.fingerprint = null;
    runtime.assistantMessageIndex = null;
    runtime.lastAppliedVersion = 0;
    if (!options.preserveStatus) {
        runtime.activeJobId = null;
        runtime.activeJobStatus = null;
    }
}

function scheduleMountRetry() {
    if (runtime.mountRetryHandle) {
        return;
    }

    runtime.mountRetryHandle = window.setTimeout(() => {
        runtime.mountRetryHandle = 0;
        mountPanel();
    }, 900);
}

function bindHostObserver() {
    if (runtime.hostObserver || !document.body) {
        return;
    }

    runtime.hostObserver = new MutationObserver(() => {
        if (!document.getElementById(PANEL_ID)) {
            mountPanel();
        }
    });

    runtime.hostObserver.observe(document.body, {
        childList: true,
        subtree: true,
    });
}

function render() {
    if (!runtime.panel) {
        return;
    }

    const snapshot = runtime.machine.getSnapshot();
    const state = snapshot.state;
    const activeStatus = runtime.activeJobStatus;
    const errorText = formatStructuredError(snapshot.error);

    runtime.statusText.textContent = formatStateLabel(state);
    runtime.statusText.dataset.state = state;

    runtime.stats.innerHTML = [
        renderStat('Accepted', activeStatus?.acceptedCount ?? 0),
        renderStat('Attempts', activeStatus?.attemptCount ?? 0),
        renderStat('Target', runtime.settings.targetAcceptedCount),
        renderStat('Timeout', `${runtime.settings.attemptTimeoutSeconds}s`),
    ].join('');

    runtime.errorBox.hidden = !errorText;
    runtime.errorBox.textContent = errorText;
    if (runtime.quickReplyStatusLine) {
        runtime.quickReplyStatusLine.textContent = renderQuickReplyStatusLine(runtime.quickReplyStatus);
    }
    if (runtime.releaseInfoContainer) {
        runtime.releaseInfoContainer.innerHTML = renderReleaseInfo();
    }
    if (runtime.retryLogContainer) {
        runtime.retryLogContainer.textContent = formatRetryLogText(runtime.activeJobStatus);
    }
    if (runtime.retryLogShell) {
        runtime.retryLogShell.hidden = !runtime.showRetryLog;
    }
    if (runtime.diagnosticsOutput) {
        runtime.diagnosticsOutput.innerHTML = renderDiagnostics();
    }
    if (runtime.mainPane && runtime.systemPane) {
        const showSystem = runtime.activeTab === 'system';
        runtime.mainPane.hidden = showSystem;
        runtime.systemPane.hidden = !showSystem;
    }
    runtime.panel.querySelectorAll('.rm-tab').forEach((button) => {
        const tab = button.dataset.tab === 'system' ? 'system' : 'main';
        button.classList.toggle('rm-tab--active', runtime.activeTab === tab);
    });
    syncValidationControls(runtime.panel);

    if (runtime.actionToggleButton) {
        const stopMode = isRunningLikeState(state);
        runtime.actionToggleButton.textContent = stopMode ? 'Stop' : 'Start';
        runtime.actionToggleButton.classList.toggle('rm-button--danger', stopMode);
        runtime.actionToggleButton.classList.toggle('rm-button--primary', !stopMode);
    }
    if (runtime.quickReplyToggleButton) {
        const attached = Boolean(runtime.quickReplyStatus?.attached);
        runtime.quickReplyToggleButton.textContent = attached ? 'Uninject' : 'Inject';
        runtime.quickReplyToggleButton.classList.toggle('rm-qr-toggle--active', attached);
    }
    const toggleLogButton = runtime.panel.querySelector('[data-action="toggle-log"]');
    if (toggleLogButton) {
        toggleLogButton.textContent = runtime.showRetryLog ? 'Hide' : 'Show';
    }
}

function renderStat(title, value) {
    return `
        <div class="rm-stat-card">
            <strong>${escapeHtml(title)}</strong>
            <span>${escapeHtml(String(value))}</span>
        </div>
    `;
}

function renderDiagnostics() {
    if (!runtime.diagnostics) {
        return `
            <div class="rm-diagnostics__title">Diagnostics</div>
            <div class="rm-diagnostics__line">No diagnostics have run yet.</div>
        `;
    }

    const capabilities = runtime.diagnostics.capabilities;
    const eventItems = capabilities.requiredEvents.map((event) => `
        <li class="rm-diagnostics__item" data-icon="${event.present ? '•' : '×'}">
            <span>${escapeHtml(event.name)}: ${event.present ? 'present' : 'missing'}</span>
        </li>
    `).join('');

    return `
        <div class="rm-diagnostics__title">Diagnostics</div>
        <div class="rm-diagnostics__line">Start is ${runtime.diagnostics.startEnabled ? 'enabled' : 'blocked'} by the current capability checks.</div>
        <ul class="rm-diagnostics__list">
            <li class="rm-diagnostics__item" data-icon="${capabilities.hasContext ? '•' : '×'}">
                <span><code>SillyTavern.getContext()</code>: ${capabilities.hasContext ? 'available' : 'missing'}</span>
            </li>
            <li class="rm-diagnostics__item" data-icon="${capabilities.hasGenerate ? '•' : '×'}">
                <span><code>generate()</code>: ${capabilities.hasGenerate ? 'available' : 'missing'}</span>
            </li>
            <li class="rm-diagnostics__item" data-icon="${capabilities.hasStopGeneration ? '•' : '×'}">
                <span><code>stopGeneration()</code>: ${capabilities.hasStopGeneration ? 'available' : 'missing'}</span>
            </li>
            <li class="rm-diagnostics__item" data-icon="${capabilities.hasQuickReplyApi ? '•' : '×'}">
                <span>Quick Reply API: ${capabilities.hasQuickReplyApi ? 'available' : 'missing'}</span>
            </li>
            <li class="rm-diagnostics__item" data-icon="${runtime.diagnostics.dryRun.ok ? '•' : '×'}">
                <span>Dry-run generation probe: ${runtime.diagnostics.dryRun.ok ? 'passed' : escapeHtml(runtime.diagnostics.dryRun.reason || 'failed')}</span>
            </li>
        </ul>
        <div class="rm-diagnostics__line">Required native events:</div>
        <ul class="rm-diagnostics__list">${eventItems}</ul>
    `;
}

function renderReleaseInfo() {
    if (!runtime.releaseInfo) {
        return '<div class="rm-release-card__line">Checking Retry Mobile install status...</div>';
    }

    const info = runtime.releaseInfo;
    const gitInfo = info.git || {};
    const backendVersion = info.installed?.backend?.version || 'unknown';
    const frontendVersion = info.installed?.frontend?.installed
        ? info.installed?.frontend?.version || 'unknown'
        : 'not installed';
    const latestBackend = info.latest?.backendVersion || 'unknown';
    const latestFrontend = info.latest?.frontendVersion || 'unknown';
    const updateMessage = info.update?.message || 'Update information unavailable.';
    const hasUpdate = Boolean(info.update?.hasUpdate || gitInfo?.hasUpdate);
    const updateStateClass = hasUpdate ? 'rm-release-card__status--warning' : 'rm-release-card__status--ok';
    const updateLabel = hasUpdate ? 'Update available' : 'Up to date';
    const profileScope = info.installed?.frontend?.scope || 'missing';
    const profileLabel = profileScope === 'current-profile'
        ? 'Installed for this profile'
        : profileScope === 'global'
            ? 'Installed globally for all profiles'
            : 'Not installed for this profile';
    const gitLabel = gitInfo.canCheck
        ? (gitInfo.hasUpdate ? 'Behind origin' : 'Synced to origin')
        : 'Git unavailable';
    const gitMessage = gitInfo.message || 'Git tracking unavailable for this install.';

    return `
        <div class="rm-release-card__header">
            <span class="rm-release-card__status ${updateStateClass}">${escapeHtml(updateLabel)}</span>
        </div>
        <div class="rm-release-card__line">${escapeHtml(updateMessage)}</div>
        <div class="rm-release-card__line">${escapeHtml(gitMessage)}</div>
        <div class="rm-release-card__grid">
            <div><strong>Backend</strong><span>${escapeHtml(backendVersion)} → ${escapeHtml(latestBackend)}</span></div>
            <div><strong>Frontend</strong><span>${escapeHtml(frontendVersion)} → ${escapeHtml(latestFrontend)}</span></div>
            <div><strong>Scope</strong><span>${escapeHtml(profileLabel)}</span></div>
            <div><strong>Git</strong><span>${escapeHtml(gitLabel)}</span></div>
        </div>
    `;
}

function renderDebugPanel(snapshot) {
    const backendStatus = runtime.activeJobStatus;
    const events = (snapshot.debugEvents || []).map((entry) => `
        <li class="rm-diagnostics__item" data-icon="•">
            <span><code>${escapeHtml(entry.source)}</code> ${escapeHtml(entry.event)}: ${escapeHtml(entry.summary)}</span>
        </li>
    `).join('');

    return `
        <div class="rm-diagnostics__title">Run Debug</div>
        <div class="rm-diagnostics__line">Run id: <code>${escapeHtml(shortRunId(snapshot.runId))}</code></div>
        <div class="rm-diagnostics__line">Active chat: ${escapeHtml(formatChatIdentity(snapshot.chatIdentity))}</div>
        <div class="rm-diagnostics__line">Last native event: ${escapeHtml(formatEventSummary(snapshot.lastNativeEvent))}</div>
        <div class="rm-diagnostics__line">Last backend event: ${escapeHtml(formatEventSummary(snapshot.lastBackendEvent))}</div>
        <div class="rm-diagnostics__line">Backend phase: ${escapeHtml(backendStatus?.phase || 'none')}</div>
        <div class="rm-diagnostics__line">Target message version: ${escapeHtml(String(backendStatus?.targetMessageVersion ?? 0))}</div>
        <div class="rm-diagnostics__line">Last backend error: ${escapeHtml(backendStatus?.lastError || 'none')}</div>
        <div class="rm-diagnostics__line">Current owner: ${snapshot.ownsTurn ? 'Retry Mobile' : 'SillyTavern/native'}</div>
        <div class="rm-diagnostics__line">Last error: ${escapeHtml(snapshot.error ? formatStructuredError(snapshot.error) : 'none')}</div>
        <ul class="rm-diagnostics__list">${events || '<li class="rm-diagnostics__item" data-icon="•"><span>No run events recorded yet.</span></li>'}</ul>
    `;
}

function renderRetryLogPanel() {
    return `
        <div class="rm-diagnostics__title">Retry Log</div>
        <div class="rm-diagnostics__line">Copy-friendly backend attempt history.</div>
        <textarea class="rm-retry-log" readonly>${escapeHtml(formatRetryLogText(runtime.activeJobStatus))}</textarea>
    `;
}

function buildNoteText(snapshot) {
    const modeLine = runtime.settings.runMode === RUN_MODE.TOGGLE
        ? 'Toggle mode re-arms after each finished run in the same chat.'
        : 'Single mode handles one captured turn and then stops.';
    const validationLine = `Length rule: ${formatValidationSummary(runtime.settings)}. Anything shorter is rejected and does not count as an accept. Character mode counts visible non-whitespace characters, so Chinese can be tuned directly with its own character target.`;
    const timeoutLine = `Timeout rule: each attempt has ${runtime.settings.attemptTimeoutSeconds} seconds to return a response before Retry Mobile marks that attempt failed and retries.`;

    const ownerLine = snapshot.ownsTurn
        ? 'Retry Mobile currently owns retry generations for this turn.'
        : 'SillyTavern owns the current native turn until handoff happens.';

    return `${modeLine} ${validationLine} ${timeoutLine} ${ownerLine}`;
}

function applyErrorState(error) {
    runtime.machine.setError(normalizeStructuredError(error));
    runtime.machine.transition(RUN_STATE.FAILED);
    runtime.machine.releaseRun();
    render();
}

function getCurrentState() {
    return runtime.machine.getSnapshot().state;
}

function normalizeServerState(state) {
    switch (state) {
        case 'running':
            return RUN_STATE.RUNNING;
        case 'completed':
            return RUN_STATE.COMPLETED;
        case 'failed':
            return RUN_STATE.FAILED;
        case 'cancelled':
            return RUN_STATE.CANCELLED;
        default:
            return RUN_STATE.IDLE;
    }
}

function formatStateLabel(state) {
    switch (state) {
        case RUN_STATE.ARMED:
            return 'Armed for next qualifying request';
        case RUN_STATE.WAITING_FOR_NATIVE:
            return 'Waiting for native completion';
        case RUN_STATE.HANDING_OFF:
            return 'Handing off to backend';
        case RUN_STATE.RUNNING:
            return 'Retry loop active';
        case RUN_STATE.COMPLETED:
            return 'Completed';
        case RUN_STATE.FAILED:
            return 'Failed';
        case RUN_STATE.CANCELLED:
            return 'Cancelled';
        default:
            return 'Idle';
    }
}

function isRunningLikeState(state) {
    return state === RUN_STATE.ARMED
        || state === RUN_STATE.WAITING_FOR_NATIVE
        || state === RUN_STATE.HANDING_OFF
        || state === RUN_STATE.RUNNING;
}

async function maybeAutoRearmAfterRun(resultState) {
    if (runtime.settings.runMode !== RUN_MODE.TOGGLE || runtime.manualStopRequested) {
        return;
    }

    if (resultState !== RUN_STATE.COMPLETED && resultState !== RUN_STATE.FAILED) {
        return;
    }

    const previousChat = runtime.machine.getSnapshot().chatIdentity;
    const liveIdentity = getChatIdentity(getContext());
    if (!previousChat || !isSameChat(previousChat, liveIdentity)) {
        runtime.machine.recordEvent('state', 'toggle_rearm_skipped', 'Skipped toggle re-arm because the active chat changed.');
        render();
        return;
    }

    await armPlugin({
        showToastMessage: 'Toggle mode re-armed Retry Mobile for the next qualifying generation in the active chat.',
    });
}

function syncValidationControls(drawer) {
    if (!drawer) {
        return;
    }

    const charactersInput = drawer.querySelector(`#${EXTENSION_ID}-characters`);
    const tokensInput = drawer.querySelector(`#${EXTENSION_ID}-tokens`);
    if (charactersInput) {
        charactersInput.disabled = runtime.settings.validationMode !== VALIDATION_MODE.CHARACTERS;
    }
    if (tokensInput) {
        tokensInput.disabled = runtime.settings.validationMode !== VALIDATION_MODE.TOKENS;
    }
}

function getRunConfigError(settings) {
    const timeoutSeconds = Number(settings.attemptTimeoutSeconds) || 0;
    if (timeoutSeconds <= 0) {
        return createStructuredError(
            'validation_config_invalid',
            'Attempt timeout must be greater than 0 seconds.',
        );
    }

    const minimum = settings.validationMode === VALIDATION_MODE.TOKENS
        ? Number(settings.minTokens) || 0
        : Number(settings.minCharacters) || 0;

    if (minimum > 0) {
        return null;
    }

    return createStructuredError(
        'validation_config_invalid',
        settings.validationMode === VALIDATION_MODE.TOKENS
            ? 'Minimum tokens must be greater than 0 when token-count blocking is active.'
            : 'Minimum characters must be greater than 0 when character-count blocking is active.',
    );
}

function formatValidationSummary(settings) {
    const minimum = settings.validationMode === VALIDATION_MODE.TOKENS
        ? Number(settings.minTokens) || 0
        : Number(settings.minCharacters) || 0;

    if (settings.validationMode === VALIDATION_MODE.TOKENS) {
        return `Tokens >= ${minimum}`;
    }

    return `Characters >= ${minimum}`;
}

function formatQuickReplyBadge(status) {
    if (!status) {
        return 'Checking';
    }

    if (!status.ok) {
        return 'Unavailable';
    }

    return status.attached ? 'Injected' : 'Detached';
}

function renderQuickReplyStatusLine(status) {
    if (!status?.ok) {
        return 'Quick Reply API unavailable in this session.';
    }

    if (status.attached) {
        return `Injected (${status.buttonCount}/4 Retry Mobile buttons detected in the set).`;
    }

    if (status.setExists) {
        return `Detached (${status.buttonCount}/4 Retry Mobile buttons saved in the set).`;
    }

    return 'No Retry Mobile Quick Reply set exists yet.';
}

function clampWholeNumber(value, minimum, fallback) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed < minimum) {
        return fallback;
    }

    return parsed;
}

function shortRunId(runId) {
    const value = String(runId || '');
    if (!value) {
        return 'none';
    }

    return value.length > 8
        ? value.slice(0, 8)
        : value;
}

function formatChatIdentity(identity) {
    if (!identity?.chatId) {
        return 'No chat bound';
    }

    return identity.groupId
        ? `${identity.chatId} (group ${identity.groupId})`
        : identity.chatId;
}

function formatEventSummary(eventRecord) {
    if (!eventRecord?.name) {
        return 'none';
    }

    return eventRecord.summary
        ? `${eventRecord.name}: ${eventRecord.summary}`
        : eventRecord.name;
}

function formatRetryLogText(status) {
    if (!status) {
        return 'No backend job is active.';
    }

    const lines = [
        `runId: ${status.runId || 'none'}`,
        `jobId: ${status.jobId || 'none'}`,
        `state: ${status.state || 'unknown'}`,
        `phase: ${status.phase || 'unknown'}`,
        `accepted: ${Number(status.acceptedCount) || 0}/${Number(status.targetAcceptedCount) || 0}`,
        `attempts: ${Number(status.attemptCount) || 0}/${Number(status.maxAttempts) || 0}`,
        `targetMessageVersion: ${Number(status.targetMessageVersion) || 0}`,
        `lastError: ${status.lastError || 'none'}`,
        '',
        'Attempts:',
    ];

    const attempts = Array.isArray(status.attemptLog) ? status.attemptLog : [];
    if (attempts.length === 0) {
        lines.push('No attempts recorded yet.');
        return lines.join('\n');
    }

    for (const entry of attempts) {
        lines.push(formatAttemptLogEntry(entry));
    }

    return lines.join('\n');
}

function formatAttemptLogEntry(entry) {
    const parts = [
        `#${Number(entry?.attemptNumber) || 0}`,
        entry?.outcome || 'unknown',
    ];

    if (entry?.phase) {
        parts.push(`phase=${entry.phase}`);
    }
    if (entry?.reason) {
        parts.push(`reason=${entry.reason}`);
    }
    if (entry?.characterCount != null) {
        parts.push(`chars=${entry.characterCount}`);
    }
    if (entry?.tokenCount != null) {
        parts.push(`tokens=${entry.tokenCount}`);
    }
    if (entry?.targetMessageVersion != null) {
        parts.push(`version=${entry.targetMessageVersion}`);
    }
    if (entry?.targetMessageIndex != null) {
        parts.push(`index=${entry.targetMessageIndex}`);
    }
    if (entry?.startedAt) {
        parts.push(`started=${entry.startedAt}`);
    }
    if (entry?.finishedAt) {
        parts.push(`finished=${entry.finishedAt}`);
    }
    if (entry?.message) {
        parts.push(`message=${entry.message}`);
    }

    return parts.join(' | ');
}

function escapeHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}
