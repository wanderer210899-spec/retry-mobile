import {
    BACKEND_PLUGIN_ID,
    EXTENSION_ID,
    EXTENSION_NAME,
    LOG_PREFIX,
    POLL_INTERVAL_FAST_MS,
    POLL_INTERVAL_SLOW_MS,
    POLL_INTERVAL_STEADY_MS,
    PROTOCOL_VERSION,
    PANEL_ID,
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
    subscribeEvent,
} from './st-context.js';
import {
    cancelBackendJob,
    confirmNativeJob,
    fetchChatState,
    fetchActiveJob,
    fetchCapabilities,
    fetchJobOrphans,
    fetchJobStatus,
    fetchReleaseInfo,
    getStructuredErrorFromApi,
    reportNativeFailure,
    startBackendJob,
} from './backend-api.js';
import { runDiagnostics } from './diagnostics.js';
import { getQuickReplyStatus, setQuickReplyAttached } from './quick-reply.js';
import { clearCommittedReloads, syncRemoteStatus, syncRestoredStatus } from './chat-sync.js';
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
    chatState: null,
    lastRunLog: null,
    quickReplyStatus: null,
    pollHandle: 0,
    pollUnchangedCount: 0,
    pollTransientFailures: 0,
    pollUnexpectedServerFailures: 0,
    pollSignature: '',
    committedReloadKeys: new Set(),
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
    nativeFailureCompatWarned: false,
    nativeFailureReported: false,
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
    void refreshChatState();
    bindChatStateRefresh();
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
                            <div class="rm-inline-row">
                                <label class="rm-inline-row__label" for="${EXTENSION_ID}-native-grace">Native silence window (s)</label>
                                <input id="${EXTENSION_ID}-native-grace" class="rm-number-input" type="number" min="10" step="1" />
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
            branch: 'unknown',
            update: {
                canCheck: false,
                hasUpdate: false,
                message: error?.message || 'Retry Mobile could not reach the backend release endpoint.',
            },
            installed: {
                version: '',
                branch: 'unknown',
                commit: '',
            },
            latest: {
                version: '',
                branch: 'unknown',
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

        if (event.target?.id === `${EXTENSION_ID}-native-grace`) {
            runtime.settings.nativeGraceSeconds = clampWholeNumber(event.target.value, 10, runtime.settings.nativeGraceSeconds);
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

    await refreshChatState(identity);

    if (runtime.settings.runMode === RUN_MODE.TOGGLE && runtime.chatState?.toggleBlocked) {
        applyErrorState(createStructuredError(
            'toggle_blocked',
            'Retry Mobile toggle mode is temporarily blocked for this chat after repeated failures. Start a single run or wait until the next successful run resets the breaker.',
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
        runtime.machine.recordEvent('ui', 'start_ignored', 'Ignored start because Retry Mobile is already armed or running.');
        render();
        showToast('info', EXTENSION_NAME, 'Retry Mobile is already armed or running in this browser session.');
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
    runtime.machine.setNativeEvent('CHAT_COMPLETION_SETTINGS_READY', `Captured ${result.requestType || 'normal'} request for user turn ${result.fingerprint.userMessageIndex}.`);
    runtime.machine.recordEvent('st', 'capture_confirmed', 'Captured a qualifying ST request.');

    const reserved = await reserveBackendJob(runId);
    if (!reserved || !runtime.machine.isCurrentRun(runId)) {
        return;
    }

    runtime.nativeFailureReported = false;

    render();
    showToast('info', EXTENSION_NAME, 'Retry Mobile captured this generation. SillyTavern is creating the first reply.');

    try {
        const nativeResult = await waitForNativeCompletion({
            fingerprint: runtime.fingerprint,
            nativeGraceSeconds: runtime.settings.nativeGraceSeconds,
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

        if (nativeResult?.outcome === 'failed') {
            await reportRecoverableNativeFailure(runId, nativeResult);
            return;
        }

        runtime.assistantMessageIndex = nativeResult.assistantMessageIndex;
        runtime.machine.transition(RUN_STATE.NATIVE_CONFIRMED);
        runtime.machine.recordEvent(
            'st',
            'native_confirmed',
            `Confirmed native assistant turn ${nativeResult.assistantMessageIndex}.`,
        );
        render();
        await confirmNativeHandoff(runId, nativeResult);
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

async function reserveBackendJob(runId) {
    if (!runtime.machine.isCurrentRun(runId)) {
        return false;
    }

    const snapshot = runtime.machine.getSnapshot();
    const context = getContext();
    const body = {
        clientProtocolVersion: PROTOCOL_VERSION,
        runId,
        chatIdentity: snapshot.chatIdentity,
        runConfig: {
            runMode: runtime.settings.runMode,
            targetAcceptedCount: runtime.settings.targetAcceptedCount,
            maxAttempts: runtime.settings.maxAttempts,
            attemptTimeoutSeconds: runtime.settings.attemptTimeoutSeconds,
            validationMode: runtime.settings.validationMode,
            minTokens: runtime.settings.minTokens,
            minCharacters: runtime.settings.minCharacters,
            allowHeuristicTokenFallback: runtime.settings.allowHeuristicTokenFallback,
            notifyOnSuccess: runtime.settings.notifyOnSuccess,
            notifyOnComplete: runtime.settings.notifyOnComplete,
            vibrateOnSuccess: runtime.settings.vibrateOnSuccess,
            vibrateOnComplete: runtime.settings.vibrateOnComplete,
            notificationMessageTemplate: runtime.settings.notificationMessageTemplate,
        },
        expectedPreviousGeneration: Number(runtime.chatState?.currentGeneration) || 0,
        nativeGraceSeconds: runtime.settings.nativeGraceSeconds,
        capturedChatIntegrity: String(context?.chatMetadata?.integrity || context?.chat_metadata?.integrity || ''),
        capturedChatLength: Array.isArray(context?.chat) ? context.chat.length : 0,
        tokenizerDescriptor: buildTokenizerDescriptor(context),
        capturedRequest: runtime.capturedRequest,
        targetFingerprint: runtime.fingerprint,
        captureMeta: {
            capturedAt: runtime.fingerprint?.capturedAt || new Date().toISOString(),
            assistantName: snapshot.chatIdentity?.assistantName || 'Assistant',
            userName: String(context?.name1 || context?.user_name || 'You'),
            userAvatar: String(context?.user_avatar || ''),
        },
    };

    try {
        const result = await startBackendJob(body);
        if (!runtime.machine.isCurrentRun(runId)) {
            return false;
        }

        runtime.activeJobId = result.jobId;
        runtime.activeJobStatus = result.job ?? null;
        clearCommittedReloads(runtime);
        runtime.chatState = {
            ...(runtime.chatState || {}),
            chatKey: result.job?.chatKey || runtime.chatState?.chatKey || '',
            currentGeneration: Number(result.currentGeneration) || Number(runtime.chatState?.currentGeneration) || 0,
            toggleFailureCount: Number(result.toggleFailureCount) || 0,
            toggleBlocked: Boolean(result.toggleBlocked),
            termux: Boolean(result.termux),
            termuxCheckedAt: result.termuxCheckedAt || null,
        };
        runtime.lastAppliedVersion = 0;
        runtime.machine.setOwnsTurn(false);
        runtime.machine.setBackendEvent('pending_native', `Reserved backend job ${result.jobId} while native generation tries the first reply.`);
        runtime.machine.recordEvent('backend', 'pending_native', `Reserved backend job ${result.jobId} while native generation is pending.`);
        runtime.machine.transition(RUN_STATE.CAPTURED_PENDING_NATIVE);
        startPolling(runId);
        render();
        return true;
    } catch (error) {
        if (error?.status === 409 && error?.payload?.reason === 'job_running' && error?.payload?.job?.jobId) {
            runtime.activeJobId = error.payload.job.jobId;
            runtime.activeJobStatus = error.payload.job;
            clearCommittedReloads(runtime);
            runtime.machine.setOwnsTurn(false);
            runtime.machine.setBackendEvent('attached', 'Attached to an existing backend run for this chat.');
            runtime.machine.recordEvent('backend', 'attached', 'Attached to an existing backend run for this chat.');
            runtime.machine.transition(resolveRunStateFromStatus(error.payload.job) || RUN_STATE.CAPTURED_PENDING_NATIVE);
            startPolling(runId);
            render();
            showToast('info', EXTENSION_NAME, 'Attached to the existing Retry Mobile run for this chat.');
            return true;
        }

        if (error?.status === 409 && error?.payload?.reason === 'rearm_race') {
            const structured = getStructuredErrorFromApi(error, 'Another tab already re-armed this chat before this browser could.');
            await applyTerminalState(runId, RUN_STATE.FAILED, {
                error: structured,
                toastKind: 'info',
                toastMessage: 'Another tab already re-armed this chat.',
            });
            return false;
        }

        const structured = getStructuredErrorFromApi(error, 'Retry Mobile could not reserve the backend recovery job for this turn.');
        await applyTerminalState(runId, RUN_STATE.FAILED, {
            error: structured,
            toastKind: 'warning',
            toastMessage: formatStructuredError(structured),
        });
        return false;
    }
}

async function confirmNativeHandoff(runId, nativeResult) {
    if (!runtime.machine.isCurrentRun(runId) || !runtime.activeJobId) {
        return;
    }

    if (runtime.nativeFailureReported) {
        runtime.machine.recordEvent('backend', 'native_confirm_skipped', 'Ignored a late native confirmation because a native failure hint was already sent.');
        render();
        return;
    }

    try {
        const result = await confirmNativeJob(runtime.activeJobId, {
            runId,
            assistantMessageIndex: nativeResult.assistantMessageIndex,
        });

        if (!runtime.machine.isCurrentRun(runId)) {
            return;
        }

        runtime.activeJobStatus = result.job ?? runtime.activeJobStatus;
        syncRuntimeStateFromStatus(runId, runtime.activeJobStatus, {
            previousStatus: null,
            announceTransitions: false,
        });
        runtime.machine.setBackendEvent('native_confirmed', `Backend confirmed native assistant turn ${nativeResult.assistantMessageIndex}.`);
        runtime.machine.recordEvent('backend', 'native_confirmed', `Backend confirmed native assistant turn ${nativeResult.assistantMessageIndex}.`);
        render();
        showToast('success', EXTENSION_NAME, 'Retry Mobile confirmed the native first reply. Backend retries are ready for this turn.');
    } catch (error) {
        if (error?.status === 409) {
            runtime.machine.recordEvent('backend', 'native_confirm_conflict', error?.message || 'Backend reported a native confirmation conflict.');
            render();
            await adoptBackendStatus(runId, error, {
                announceTransitions: true,
            });
            return;
        }

        const recovered = await adoptBackendStatus(runId, error, {
            announceTransitions: true,
        });
        if (recovered) {
            return;
        }

        const structured = getStructuredErrorFromApi(error, 'Retry Mobile could not confirm the native assistant turn with the backend.');
        await applyTerminalState(runId, RUN_STATE.FAILED, {
            error: structured,
            toastKind: 'warning',
            toastMessage: formatStructuredError(structured),
        });
    }
}

async function reportRecoverableNativeFailure(runId, nativeResult) {
    if (!runtime.machine.isCurrentRun(runId) || !runtime.activeJobId) {
        return;
    }

    runtime.nativeFailureReported = true;
    runtime.machine.recordEvent('st', nativeResult.reason || 'native_wait_failed', nativeResult.message || 'Retry Mobile stopped waiting for native completion.');
    render();

    try {
        const result = await reportNativeFailure(runtime.activeJobId, {
            runId,
            reason: nativeResult.reason,
            detail: nativeResult.detail || nativeResult.message || '',
        });

        if (!runtime.machine.isCurrentRun(runId)) {
            return;
        }

        runtime.activeJobStatus = result.job ?? runtime.activeJobStatus;
        syncRuntimeStateFromStatus(runId, runtime.activeJobStatus, {
            previousStatus: null,
            announceTransitions: true,
        });
        runtime.machine.setBackendEvent('native_failed', `Backend accepted native failure hint: ${nativeResult.reason || 'unknown'}.`);
        runtime.machine.recordEvent('backend', 'native_failed', `Backend accepted native failure hint: ${nativeResult.reason || 'unknown'}.`);
        render();
    } catch (error) {
        if (!runtime.machine.isCurrentRun(runId)) {
            return;
        }

        if (error?.status === 404) {
            if (!runtime.nativeFailureCompatWarned) {
                runtime.nativeFailureCompatWarned = true;
                runtime.machine.recordEvent('backend', 'native_failed_unsupported', 'The backend does not support /native-failed yet. Waiting for grace-expiry recovery via status polling.');
                showToast('warning', EXTENSION_NAME, 'This backend is older and cannot accept native failure hints yet. Retry Mobile will keep polling backend status.');
                render();
            }
            return;
        }

        const adopted = await adoptBackendStatus(runId, error, {
            announceTransitions: true,
        });
        if (adopted) {
            return;
        }

        const structured = getStructuredErrorFromApi(error, 'Retry Mobile could not report the native wait outcome to the backend.');
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
    runtime.pollUnchangedCount = 0;
    runtime.pollTransientFailures = 0;
    runtime.pollUnexpectedServerFailures = 0;
    runtime.pollSignature = '';
    runtime.pollHandle = window.setTimeout(() => {
        void pollStatus(runId, pollSessionId);
    }, 0);
}

function clearPolling() {
    if (runtime.pollHandle) {
        window.clearTimeout(runtime.pollHandle);
        runtime.pollHandle = 0;
    }

    runtime.pollUnchangedCount = 0;
    runtime.pollTransientFailures = 0;
    runtime.pollUnexpectedServerFailures = 0;
    runtime.pollSignature = '';
    runtime.machine.clearPollSession(runtime.machine.getSnapshot().pollSessionId);
}

function scheduleNextPoll(runId, pollSessionId, delayMs) {
    clearScheduledPollOnly();
    if (!runtime.machine.isCurrentRun(runId) || !runtime.machine.isCurrentPollSession(pollSessionId)) {
        return;
    }

    const jitterMultiplier = 0.85 + (Math.random() * 0.3);
    runtime.pollHandle = window.setTimeout(() => {
        void pollStatus(runId, pollSessionId);
    }, Math.round(delayMs * jitterMultiplier));
}

function clearScheduledPollOnly() {
    if (!runtime.pollHandle) {
        return;
    }

    window.clearTimeout(runtime.pollHandle);
    runtime.pollHandle = 0;
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

        const previousStatus = runtime.activeJobStatus;
        const previousAccepted = Number(previousStatus?.acceptedCount) || 0;
        runtime.activeJobStatus = status;
        const signatureChanged = updatePollSignature(status);
        runtime.pollTransientFailures = 0;
        runtime.pollUnexpectedServerFailures = 0;
        runtime.pollUnchangedCount = signatureChanged ? 0 : (runtime.pollUnchangedCount + 1);
        syncRuntimeStateFromStatus(runId, status, {
            previousStatus,
            announceTransitions: true,
        });
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
        scheduleNextPoll(runId, pollSessionId, getNextPollDelay());
    } catch (error) {
        backendLog.warn('Status poll failed.', error);
        if (!runtime.machine.isCurrentRun(runId) || !runtime.machine.isCurrentPollSession(pollSessionId) || runtime.activeJobId !== requestedJobId) {
            return;
        }
        runtime.machine.recordEvent('backend', 'poll_failed', error?.message || 'Status poll failed.');
        const failureKind = classifyPollFailure(error);
        if (failureKind === 'fatal') {
            await reloadCurrentChatSafe();
            await applyTerminalState(runId, RUN_STATE.FAILED, {
                error: createStructuredError(
                    'backend_job_missing',
                    error?.status === 404
                        ? 'Retry Mobile lost the backend job while polling. The backend process may have restarted or been suspended.'
                        : 'Retry Mobile hit a fatal backend polling error and stopped instead of guessing.',
                ),
                toastKind: 'warning',
                toastMessage: error?.status === 404
                    ? 'Retry Mobile lost the backend job while polling.'
                    : 'Retry Mobile stopped after a fatal backend polling error.',
            });
            return;
        }

        if (failureKind === 'unexpected_5xx') {
            runtime.pollUnexpectedServerFailures += 1;
            if (runtime.pollUnexpectedServerFailures >= 3) {
                await applyTerminalState(runId, RUN_STATE.FAILED, {
                    error: createStructuredError(
                        'backend_polling_failed',
                        'Retry Mobile stopped after repeated unexpected backend server errors while polling status.',
                    ),
                    toastKind: 'warning',
                    toastMessage: 'Retry Mobile stopped after repeated backend polling errors.',
                });
                return;
            }
        } else {
            runtime.pollTransientFailures += 1;
            runtime.pollUnexpectedServerFailures = 0;
        }

        render();
        scheduleNextPoll(runId, pollSessionId, getNextPollDelay());
    }
}

function syncRuntimeStateFromStatus(runId, status, options = {}) {
    if (!runtime.machine.isCurrentRun(runId) || !status?.jobId) {
        return;
    }

    const previousStatus = options.previousStatus || null;
    const nextState = resolveRunStateFromStatus(status);
    const snapshot = runtime.machine.getSnapshot();

    if (nextState && snapshot.state !== nextState) {
        runtime.machine.transition(nextState);
    }

    runtime.machine.setOwnsTurn(Boolean(status.nativeState && status.nativeState !== 'pending'));

    if (!options.announceTransitions) {
        return;
    }

    const previousNativeState = previousStatus?.nativeState || '';
    const nextNativeState = status.nativeState || '';
    if (previousNativeState === nextNativeState) {
        return;
    }

    runtime.machine.recordEvent('backend', 'native_state', `Backend native state changed: ${previousNativeState || 'none'} -> ${nextNativeState || 'none'}.`);

    if (nextNativeState === 'abandoned') {
        const message = status.recoveryMode === 'reuse_empty_placeholder'
            ? 'Native first reply was abandoned. Retry Mobile reused the empty native placeholder.'
            : 'Native first reply was abandoned. Retry Mobile created the missing assistant turn.';
        showToast('info', EXTENSION_NAME, message);
        return;
    }

    if (previousNativeState === 'pending' && nextNativeState === 'confirmed') {
        showToast('info', EXTENSION_NAME, 'Native first reply was confirmed. Retry Mobile will handle the remaining retries.');
    }
}

function resolveRunStateFromStatus(status) {
    if (!status || status.state !== 'running') {
        return null;
    }

    if (status.nativeState === 'pending') {
        return RUN_STATE.CAPTURED_PENDING_NATIVE;
    }

    if (status.nativeState === 'confirmed') {
        return Number(status.attemptCount) > 0 || Number(status.acceptedCount) > 0
            ? RUN_STATE.BACKEND_RUNNING
            : RUN_STATE.NATIVE_CONFIRMED;
    }

    if (status.nativeState === 'abandoned') {
        return Number(status.attemptCount) > 0 || Number(status.acceptedCount) > 0
            ? RUN_STATE.BACKEND_RUNNING
            : RUN_STATE.NATIVE_ABANDONED;
    }

    return RUN_STATE.BACKEND_RUNNING;
}

async function adoptBackendStatus(runId, sourceError = null, options = {}) {
    const requestedJobId = runtime.activeJobId;
    if (!requestedJobId) {
        return false;
    }

    let status = sourceError?.payload?.job || null;
    if (!status) {
        try {
            status = await fetchJobStatus(requestedJobId);
        } catch {
            return false;
        }
    }

    if (!status?.jobId || !runtime.machine.isCurrentRun(runId) || runtime.activeJobId !== requestedJobId) {
        return false;
    }

    const previousStatus = runtime.activeJobStatus;
    runtime.activeJobStatus = status;
    syncRuntimeStateFromStatus(runId, status, {
        previousStatus,
        announceTransitions: Boolean(options.announceTransitions),
    });
    render();

    if (status.state === 'completed') {
        await applyTerminalState(runId, RUN_STATE.COMPLETED, {
            toastKind: 'success',
            toastMessage: 'Retry Mobile finished this turn.',
        });
        return true;
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
        return true;
    }

    if (status.state === 'cancelled') {
        await applyTerminalState(runId, RUN_STATE.CANCELLED, {
            toastKind: 'info',
            toastMessage: 'Retry Mobile stopped.',
        });
        return true;
    }

    return status.state === 'running';
}

async function applyTerminalState(runId, nextState, options = {}) {
    if (runId && !runtime.machine.isCurrentRun(runId) && runtime.machine.getSnapshot().runId !== runId) {
        return;
    }

    const previousChatIdentity = runtime.machine.getSnapshot().chatIdentity;
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
    if (runtime.activeJobStatus?.jobId && Number(runtime.activeJobStatus?.orphanedAcceptedPreview?.count) > 0) {
        try {
            const orphanResult = await fetchJobOrphans(runtime.activeJobStatus.jobId);
            if (orphanResult?.items) {
                runtime.activeJobStatus.orphanedAcceptedResults = orphanResult.items;
            }
        } catch (error) {
            backendLog.warn('Could not fetch orphaned accepted outputs.', error);
        }
    }
    rememberRunLog();

    runtime.activeJobId = null;
    runtime.nativeFailureReported = false;
    clearCommittedReloads(runtime);
    await refreshChatState(previousChatIdentity || getChatIdentity(getContext()));

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

async function refreshChatState(identity = getChatIdentity(getContext())) {
    if (!identity?.chatId) {
        runtime.chatState = null;
        render();
        return null;
    }

    try {
        runtime.chatState = await fetchChatState(identity);
    } catch (error) {
        backendLog.warn('Could not fetch Retry Mobile chat state.', error);
    }

    render();
    return runtime.chatState;
}

function bindChatStateRefresh() {
    const context = getContext();
    const eventTypes = context?.eventTypes;
    if (!eventTypes?.CHAT_CHANGED) {
        return;
    }

    subscribeChatStateEvent(eventTypes.CHAT_CHANGED);
}

function subscribeChatStateEvent(eventName) {
    subscribeEvent(eventName, () => {
        clearCommittedReloads(runtime);
        void refreshChatState();
    }, getContext());
}

async function restoreActiveJob() {
    const identity = getChatIdentity(getContext());
    if (!identity?.chatId) {
        return;
    }

    await refreshChatState(identity);

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
        syncRuntimeStateFromStatus(status.runId || status.jobId, status, {
            previousStatus: null,
            announceTransitions: false,
        });
        runtime.machine.setBackendEvent('restored', `Restored backend job ${status.jobId}.`);
        runtime.machine.recordEvent('backend', 'restored', `Restored backend job ${status.jobId}.`);
        runtime.activeJobId = status.jobId;
        runtime.activeJobStatus = status;
        clearCommittedReloads(runtime);
        runtime.lastAppliedVersion = 0;
        await syncRestoredStatus(status, runtime);

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
    const logContext = getRetryLogContext();
    const text = formatRetryLogText(logContext.status, logContext.snapshot);
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
    runtime.nativeFailureCompatWarned = false;
    clearCommittedReloads(runtime);
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

    runtime.statusText.textContent = formatVisibleStateLabel(state, activeStatus);
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
        const logContext = getRetryLogContext(snapshot);
        runtime.retryLogContainer.textContent = formatRetryLogText(logContext.status, logContext.snapshot);
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
    const localVersion = info.installed?.version || 'unknown';
    const latestVersion = info.latest?.version || 'unknown';
    const branch = info.installed?.branch || info.branch || 'unknown';
    const commit = typeof info.installed?.commit === 'string' && info.installed.commit
        ? info.installed.commit.slice(0, 12)
        : '';
    const updateMessage = info.update?.message || 'Update information unavailable.';
    const hasUpdate = Boolean(info.update?.hasUpdate);
    const updateStateClass = hasUpdate ? 'rm-release-card__status--warning' : 'rm-release-card__status--ok';
    const updateLabel = hasUpdate ? 'Update available' : 'Up to date';

    return `
        <div class="rm-release-card__header">
            <span class="rm-release-card__status ${updateStateClass}">${escapeHtml(updateLabel)}</span>
        </div>
        <div class="rm-release-card__line">${escapeHtml(updateMessage)}</div>
        <div class="rm-release-card__grid">
            <div><strong>Version</strong><span>${escapeHtml(localVersion)} → ${escapeHtml(latestVersion)}</span></div>
            <div><strong>Branch</strong><span>${escapeHtml(branch)}${commit ? ` @ ${escapeHtml(commit)}` : ''}</span></div>
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
        <div class="rm-diagnostics__line">Backend phase text: ${escapeHtml(backendStatus?.phaseText || 'none')}</div>
        <div class="rm-diagnostics__line">Native state: ${escapeHtml(backendStatus?.nativeState || 'none')}</div>
        <div class="rm-diagnostics__line">Native resolution cause: ${escapeHtml(backendStatus?.nativeResolutionCause || 'none')}</div>
        <div class="rm-diagnostics__line">Native failure hinted at: ${escapeHtml(backendStatus?.nativeFailureHintedAt || 'none')}</div>
        <div class="rm-diagnostics__line">Recovery mode: ${escapeHtml(formatRecoveryMode(backendStatus?.recoveryMode))}</div>
        <div class="rm-diagnostics__line">Native grace deadline: ${escapeHtml(formatGraceDeadline(backendStatus?.nativeGraceDeadline))}</div>
        <div class="rm-diagnostics__line">Target message version: ${escapeHtml(String(backendStatus?.targetMessageVersion ?? 0))}</div>
        <div class="rm-diagnostics__line">Last backend error: ${escapeHtml(backendStatus?.lastError || 'none')}</div>
        <div class="rm-diagnostics__line">Current owner: ${snapshot.ownsTurn ? 'Retry Mobile' : 'SillyTavern/native'}</div>
        <div class="rm-diagnostics__line">Last error: ${escapeHtml(snapshot.error ? formatStructuredError(snapshot.error) : 'none')}</div>
        <ul class="rm-diagnostics__list">${events || '<li class="rm-diagnostics__item" data-icon="•"><span>No run events recorded yet.</span></li>'}</ul>
    `;
}

function renderRetryLogPanel() {
    const logContext = getRetryLogContext();
    return `
        <div class="rm-diagnostics__title">Retry Log</div>
        <div class="rm-diagnostics__line">Copy-friendly backend attempt history.</div>
        <textarea class="rm-retry-log" readonly>${escapeHtml(formatRetryLogText(logContext.status, logContext.snapshot))}</textarea>
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
        : 'SillyTavern still owns the native first-reply attempt for this turn.';

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

function formatVisibleStateLabel(state, status) {
    if (!status) {
        return formatStateLabel(state);
    }

    switch (state) {
        case RUN_STATE.CAPTURED_PENDING_NATIVE:
        case RUN_STATE.NATIVE_CONFIRMED:
        case RUN_STATE.NATIVE_ABANDONED:
        case RUN_STATE.BACKEND_RUNNING:
            return status.phaseText || formatStateLabel(state);
        case RUN_STATE.COMPLETED:
            return status.state === 'completed'
                ? (status.phaseText || formatStateLabel(state))
                : formatStateLabel(state);
        case RUN_STATE.FAILED:
            return status.state === 'failed'
                ? (status.phaseText || formatStateLabel(state))
                : formatStateLabel(state);
        case RUN_STATE.CANCELLED:
            return status.state === 'cancelled'
                ? (status.phaseText || formatStateLabel(state))
                : formatStateLabel(state);
        default:
            return formatStateLabel(state);
    }
}

function formatStateLabel(state) {
    switch (state) {
        case RUN_STATE.ARMED:
            return 'Armed for next qualifying request';
        case RUN_STATE.CAPTURED_PENDING_NATIVE:
            return 'Waiting for native first reply';
        case RUN_STATE.NATIVE_CONFIRMED:
            return 'Native first reply confirmed';
        case RUN_STATE.NATIVE_ABANDONED:
            return 'Native abandoned, backend recovered the turn';
        case RUN_STATE.BACKEND_RUNNING:
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
        || state === RUN_STATE.CAPTURED_PENDING_NATIVE
        || state === RUN_STATE.NATIVE_CONFIRMED
        || state === RUN_STATE.NATIVE_ABANDONED
        || state === RUN_STATE.BACKEND_RUNNING;
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

    await refreshChatState(liveIdentity);
    if (runtime.chatState?.toggleBlocked) {
        runtime.machine.recordEvent('state', 'toggle_rearm_blocked', 'Skipped toggle re-arm because the backend circuit breaker is active for this chat.');
        render();
        showToast('warning', EXTENSION_NAME, 'Toggle mode paused after repeated failures in this chat.');
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

function formatRecoveryMode(recoveryMode) {
    switch (recoveryMode) {
        case 'top_up_existing':
            return 'Top up existing assistant turn';
        case 'reuse_empty_placeholder':
            return 'Reuse empty native placeholder';
        case 'create_missing_turn':
            return 'Create missing assistant turn';
        default:
            return 'none';
    }
}

function formatGraceDeadline(value) {
    return value || 'none';
}

function formatRetryPhase(status) {
    if (!status) {
        return 'No backend job is active.';
    }

    return status.phaseText || formatStateLabel(resolveRunStateFromStatus(status) || RUN_STATE.IDLE);
}

function getRetryLogContext(currentSnapshot = runtime.machine.getSnapshot()) {
    const shouldUseLastRun = (!runtime.activeJobStatus && isIdleLikeState(currentSnapshot?.state))
        && runtime.lastRunLog?.snapshot;

    if (shouldUseLastRun) {
        return runtime.lastRunLog;
    }

    return {
        status: runtime.activeJobStatus,
        snapshot: currentSnapshot,
    };
}

function rememberRunLog() {
    runtime.lastRunLog = {
        status: cloneValue(runtime.activeJobStatus),
        snapshot: cloneValue(runtime.machine.getSnapshot()),
    };
}

function isIdleLikeState(state) {
    return state === RUN_STATE.IDLE || state === RUN_STATE.ARMED;
}

function formatRetryLogText(status, snapshot = runtime.machine.getSnapshot()) {
    const lines = [
        `runId: ${status?.runId || snapshot?.runId || 'none'}`,
        `frontendState: ${snapshot?.state || 'unknown'}`,
        `frontendLabel: ${formatVisibleStateLabel(snapshot?.state || RUN_STATE.IDLE, status)}`,
        `activeChat: ${formatChatIdentity(snapshot?.chatIdentity)}`,
        `ownsTurn: ${snapshot?.ownsTurn ? 'retry-mobile' : 'native'}`,
        `lastFrontendError: ${snapshot?.error ? formatStructuredError(snapshot.error) : 'none'}`,
        `lastNativeEvent: ${formatEventSummary(snapshot?.lastNativeEvent)}`,
        `lastBackendEvent: ${formatEventSummary(snapshot?.lastBackendEvent)}`,
        '',
    ];

    if (!status) {
        lines.push('backend: no backend job was reserved or restorable for this run.');
        lines.push('');
        lines.push('Recent Events:');
        return appendDebugEventLines(lines, snapshot);
    }

    lines.push(
        `jobId: ${status.jobId || 'none'}`,
        `state: ${status.state || 'unknown'}`,
        `phase: ${status.phase || 'unknown'}`,
        `phaseText: ${formatRetryPhase(status)}`,
        `nativeState: ${status.nativeState || 'unknown'}`,
        `nativeResolutionCause: ${status.nativeResolutionCause || 'none'}`,
        `nativeFailureHintedAt: ${status.nativeFailureHintedAt || 'none'}`,
        `recoveryMode: ${formatRecoveryMode(status.recoveryMode)}`,
        `nativeGraceDeadline: ${formatGraceDeadline(status.nativeGraceDeadline)}`,
        `assistantMessageIndex: ${status.assistantMessageIndex == null ? 'none' : (Number.isFinite(Number(status.assistantMessageIndex)) ? Number(status.assistantMessageIndex) : 'none')}`,
        `accepted: ${Number(status.acceptedCount) || 0}/${Number(status.targetAcceptedCount) || 0}`,
        `attempts: ${Number(status.attemptCount) || 0}/${Number(status.maxAttempts) || 0}`,
        `targetMessageVersion: ${Number(status.targetMessageVersion) || 0}`,
        `lastError: ${status.lastError || 'none'}`,
        '',
        'Attempts:',
    );

    const attempts = Array.isArray(status.attemptLog) ? status.attemptLog : [];
    if (attempts.length === 0) {
        lines.push('No attempts recorded yet.');
    } else {
        for (const entry of attempts) {
            lines.push(formatAttemptLogEntry(entry));
        }
    }

    if (Array.isArray(status.orphanedAcceptedResults) && status.orphanedAcceptedResults.length > 0) {
        lines.push('');
        lines.push('Orphaned Accepted Outputs:');
        status.orphanedAcceptedResults.forEach((entry, index) => {
            lines.push(`orphan#${index + 1} | chars=${Number(entry?.characterCount) || 0} | tokens=${Number(entry?.tokenCount) || 0} | text=${String(entry?.text || '').slice(0, 200)}`);
        });
    } else if (status.orphanedAcceptedPreview?.count > 0) {
        lines.push('');
        lines.push(`Orphaned Accepted Outputs: ${status.orphanedAcceptedPreview.count} stored on backend.`);
    }

    lines.push('');
    lines.push('Recent Events:');
    return appendDebugEventLines(lines, snapshot);
}

function updatePollSignature(status) {
    const nextSignature = JSON.stringify({
        updatedAt: status?.updatedAt || '',
        state: status?.state || '',
        phase: status?.phase || '',
        nativeState: status?.nativeState || '',
        acceptedCount: Number(status?.acceptedCount) || 0,
        attemptCount: Number(status?.attemptCount) || 0,
        attemptLogLength: Array.isArray(status?.attemptLog) ? status.attemptLog.length : 0,
        targetMessageVersion: Number(status?.targetMessageVersion) || 0,
        cancelRequested: Boolean(status?.cancelRequested),
        structuredErrorCode: status?.structuredError?.code || '',
    });
    const changed = runtime.pollSignature !== nextSignature;
    runtime.pollSignature = nextSignature;
    return changed;
}

function getNextPollDelay() {
    if (runtime.pollUnexpectedServerFailures > 0 || runtime.pollTransientFailures >= 3 || runtime.pollUnchangedCount >= 15) {
        return POLL_INTERVAL_SLOW_MS;
    }

    if (runtime.pollUnchangedCount >= 5) {
        return POLL_INTERVAL_STEADY_MS;
    }

    return POLL_INTERVAL_FAST_MS;
}

function classifyPollFailure(error) {
    const status = Number(error?.status);
    if (!Number.isFinite(status)) {
        return 'transient';
    }

    if (status === 429 || status === 502 || status === 503 || status === 504) {
        return 'transient';
    }

    if (status === 500 || status >= 505) {
        return 'unexpected_5xx';
    }

    if (status === 400 || status === 401 || status === 403 || status === 404) {
        return 'fatal';
    }

    return 'transient';
}

function buildTokenizerDescriptor(context) {
    return {
        tokenizerMode: runtime.settings.validationMode,
        tokenizerKey: String(context?.chatCompletionModel || context?.mainApi || context?.api || ''),
        model: String(context?.chatCompletionModel || context?.model || ''),
        apiFamily: String(context?.mainApi || context?.api || ''),
        chatCompletionSource: String(runtime.capturedRequest?.chat_completion_source || ''),
    };
}

function appendDebugEventLines(lines, snapshot) {
    const events = Array.isArray(snapshot?.debugEvents) ? snapshot.debugEvents : [];
    if (events.length === 0) {
        lines.push('No frontend run events recorded yet.');
        return lines.join('\n');
    }

    for (const entry of events) {
        lines.push(formatDebugEventLine(entry));
    }

    return lines.join('\n');
}

function formatDebugEventLine(entry) {
    const parts = [
        entry?.at || 'unknown-time',
        entry?.source || 'state',
        entry?.event || 'event',
    ];

    if (entry?.phase) {
        parts.push(`phase=${entry.phase}`);
    }
    if (entry?.summary) {
        parts.push(`summary=${entry.summary}`);
    }

    return parts.join(' | ');
}

function cloneValue(value) {
    return value == null
        ? value
        : JSON.parse(JSON.stringify(value));
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
