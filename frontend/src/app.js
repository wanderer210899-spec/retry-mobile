import { fetchCapabilities, fetchChatState, getStructuredErrorFromApi } from './backend-api.js';
import { sendFrontendLogEvent, syncRetryLogForStatus } from './logs/retry-log.js';
import { createStructuredError } from './retry-error.js';
import { writeSettings, readSettings } from './settings.js';
import {
    createStPort,
    getCapabilityReport,
    getChatIdentity,
    getContext,
    getEventTypes,
    showToast,
    subscribeEvent,
} from './st-bridge/index.js';
import { COUNTER_MODE, PROTOCOL_VERSION, VALIDATION_MODE, resolveCounterMode } from './constants.js';
import { createRuntime } from './core/runtime.js';
import { isRunningLikeState } from './core/run-state.js';
import { createRenderer } from './ui/render.js';
import { mountPanel } from './ui/panel-bindings.js';
import { createSystemController } from './controllers/system-controller.js';
import { getFrontendSessionId } from './job/run-binding.js';
import { createIntentPort } from './intent.js';
import { createRetryFsm, RetryState } from './retry-fsm.js';
import { createBackendPort } from './backend-client.js';
import { createAppPorts } from './app-ports.js';
import { projectRuntime, writeStatusMirror } from './core/projector.js';
import { chooseOperationalChatIdentity, resolveExpectedPreviousGeneration } from './start-payload.js';
import { initializeI18n, setLanguage, t } from './i18n.js';
import { shouldToastPluginOff, shouldToastPluginOn } from './plugin-toggle-toast.js';
import {
    createRestoreController,
    resolveCaptureTarget,
    resolveCaptureSubscriptionChatIdentity,
} from './app-recovery.js';
import { applyInstallVersionGate } from './install-version-gate.js';
import { bindPageObservers, unbindPageObservers } from './app-page-lifecycle.js';
import { createResumeCoordinator } from './app-resume-coordinator.js';

const runtime = createRuntime();

export async function bootRetryMobile() {
    const context = getContext();
    const hadStoredLanguage = hasStoredUiLanguage(context);
    runtime.settings = readSettings(context);
    await initializeI18n(runtime.settings.uiLanguage || 'en');
    runtime.sessionId = getFrontendSessionId();
    runtime.controlError = null;
    runtime.pendingNativeOutcome = null;

    const render = createRenderer({ runtime });
    const intentPort = createIntentPort({ getContext });
    const baseBackendPort = createBackendPort();
    let backendPort = null;
    let stPort = null;
    let retryFsm = null;

    const persistSettings = () => {
        writeSettings(getContext(), runtime.settings);
    };

    backendPort = createAppPorts({
        baseBackendPort,
        getRetryFsm: () => retryFsm,
        updateActiveJob,
        syncRuntimeFromFsm: (fsm) => projectRuntime(runtime, fsm.getContext()),
        render,
        buildStartPayload,
        flushPendingNativeOutcome,
        // Sync the log panel on every poll tick when it is visible.
        // syncRetryLogForStatus uses a cursor (logEntryCount + logUpdatedAt) so
        // it only makes an HTTP request when new entries have been appended.
        onStatusPolled: async (status) => {
            if (!runtime.log.show || runtime.ui.activeTab !== 'system') {
                return;
            }
            await syncRetryLogForStatus(runtime, status);
            render();
        },
    });

    stPort = createStPort({
        onCapture(result) {
            if (!result?.ok) {
                runtime.controlError = result?.error || createStructuredError(
                    'capture_missing_payload',
                    'Retry Mobile could not capture the native request payload.',
                );
                const current = retryFsm.getContext();
                if (retryFsm.getState() === RetryState.ARMED) {
                    const chatIdentity = resolveCaptureSubscriptionChatIdentity(
                        current,
                        getChatIdentity(getContext()),
                    );
                    if (chatIdentity) {
                        stPort.subscribeCapture({
                            runId: current.runId,
                            chatIdentity,
                            target: current.target,
                        });
                    }
                }
                render();
                return;
            }

            runtime.controlError = null;
            showToast('info', t('toasts.title'), t('toasts.capturedStarting'));
            const current = retryFsm.getContext();
            const chatIdentity = getChatIdentity(getContext());
            const captureTarget = resolveCaptureTarget(
                current,
                result.fingerprint,
                chatIdentity,
            );
            if (current.intent?.mode === 'single' && captureTarget) {
                intentPort.saveSingleTarget?.(captureTarget);
            }
            retryFsm.capture({
                chatIdentity,
                request: result.capturedRequest,
                fingerprint: result.fingerprint,
                target: captureTarget,
            });
            syncRuntime();
            render();
        },
        onCaptureCancelled(error) {
            const current = retryFsm.getContext();
            if (retryFsm.getState() === RetryState.ARMED) {
                const chatIdentity = resolveCaptureSubscriptionChatIdentity(
                    current,
                    getChatIdentity(getContext()),
                );
                if (!chatIdentity) {
                    runtime.controlError = error || createStructuredError(
                        'capture_missing_payload',
                        'Retry Mobile could not re-arm capture because the chat identity is missing.',
                    );
                    render();
                    return;
                }
                stPort.subscribeCapture({
                    runId: current.runId,
                    chatIdentity,
                    target: current.target,
                });
                render();
                return;
            }

            runtime.controlError = error || createStructuredError(
                'capture_missing_payload',
                'Retry Mobile could not capture the native request payload.',
            );
            render();
        },
        onCaptureEvent(event, summary) {
            void window.__rmLogEvent?.(event, summary, null);
        },
        onNativeReady(result) {
            void handleNativeReady(result);
        },
        onNativeFailed(error) {
            void handleNativeFailed(error);
        },
        onNativeEvent(event, summary) {
            void window.__rmLogEvent?.(event, summary, null);
        },
    });

    retryFsm = createRetryFsm({
        intentPort,
        stPort,
        backendPort,
        logger: {
            error(detail) {
                console.error('[retry-mobile:fsm]', detail);
            },
        },
        logEvent: (event, summary, detail) => window.__rmLogEvent?.(event, summary, detail),
    });
    runtime.retryFsm = retryFsm;
    const syncRuntime = () => projectRuntime(runtime, retryFsm.getContext());
    syncRuntime();

    const armPluginFromUi = async () => {
        const previousState = retryFsm.getState();
        const validationError = getArmValidationError(runtime);
        if (validationError) {
            runtime.controlError = validationError;
            render();
            return;
        }

        runtime.controlError = null;
        retryFsm.arm({
            chatIdentity: getChatIdentity(getContext()),
        });
        if (retryFsm.getState() !== RetryState.ARMED) {
            runtime.controlError = retryFsm.getContext().terminalError || createStructuredError(
                'retry_arm_failed',
                'Retry Mobile could not arm the retry loop due to an invalid intent mode.',
            );
        }
        syncRuntime();
        if (shouldToastPluginOn(previousState, retryFsm.getState())) {
            showToast('success', t('toasts.title'), t('toasts.pluginOn'));
        }
        render();
    };

    const stopPlugin = async () => {
        const previousState = retryFsm.getState();
        retryFsm.userStop({});
        runtime.controlError = null;
        runtime.pendingNativeOutcome = null;
        syncRuntime();
        if (shouldToastPluginOff(previousState, retryFsm.getState())) {
            showToast('info', t('toasts.title'), t('toasts.pluginOff'));
        }
        render();
    };

    const ensurePanelMounted = () => mountPanel(runtime, {
        render,
        persistSettings,
        onMissingHost: () => scheduleMountRetry(ensurePanelMounted),
        actions: {
            onToggleRun: async () => {
                const phase = runtime.retryFsm?.getState?.() || RetryState.IDLE;
                if (isRunningLikeState(phase)) {
                    await stopPlugin();
                    return;
                }
                await armPluginFromUi();
            },
            onToggleQuickReplies: async () => {
                await systemController.toggleQuickRepliesFromUi();
            },
            onShowTab: async (tab) => {
                systemController.showTab(tab);
            },
            onToggleLog: async () => {
                systemController.toggleRetryLog();
            },
            onCopyLog: async () => {
                await systemController.copyRetryLogFromUi();
            },
            onDownloadLog: async () => {
                await systemController.downloadRetryLogFromUi();
            },
            onSyncStatus: async () => {
                await reloadChatFromUi();
            },
        },
    });

    const systemController = createSystemController({
        runtime,
        render,
        setJobError: (error) => {
            runtime.controlError = error;
            render();
        },
        clearJobError: () => {
            runtime.controlError = null;
            render();
        },
        armPluginFromUi,
        stopPlugin,
    });
    const restoreController = createRestoreController({
        runtime,
        retryFsm,
        intentPort,
        baseBackendPort,
        stPort,
        updateActiveJob,
        render,
        syncRuntimeFromFsm: (fsm) => projectRuntime(runtime, fsm.getContext()),
        getCurrentChatIdentity: () => getChatIdentity(getContext()),
        toStructuredError,
        subscribeEvent,
        eventTypes: getEventTypes(getContext()),
        logEvent: (event, summary, detail) => window.__rmLogEvent?.(event, summary, detail),
    });
    const resumeCoordinator = createResumeCoordinator({
        retryFsm,
        runtime,
        backendPort,
        stPort,
        restoreController,
        ensurePanelMounted,
        syncRuntimeFromFsm: syncRuntime,
        updateActiveJob,
        render,
        getCurrentChatIdentity: () => getChatIdentity(getContext()),
        toStructuredError,
        logEvent: (event, summary, detail) => window.__rmLogEvent?.(event, summary, detail),
        windowRef: window,
    });

    window.__rmTeardown?.();
    window.__rmTeardown = () => {
        stPort?.unsubscribeCapture?.();
        stPort?.unsubscribeNativeObserver?.();
        const pollingToken = retryFsm?.getContext?.()?.pollingToken || null;
        if (pollingToken) {
            backendPort?.stopPolling?.(pollingToken);
        }
        if (runtime.hostObserver) {
            clearInterval(runtime.hostObserver);
            runtime.hostObserver = 0;
        }
        restoreController.unsubscribeChatChangedRestore?.();
        unbindPageObservers(runtime);
        resumeCoordinator.teardown?.();
    };
    window.__rmDispatch = (type, payload) => {
        resumeCoordinator.dispatch(type, payload);
    };
    window.__rmLogEvent = (event, summary, detail) => sendFrontendLogEvent(runtime, { event, summary, detail });

    ensurePanelMounted();
    bindHostObserver(ensurePanelMounted);
    bindPageObservers(runtime);
    systemController.registerCommands();

    void systemController.refreshDiagnostics();
    systemController.refreshQuickReplyState({ quiet: true });
    systemController.scheduleQuickReplyRefresh();

    // Capabilities tell us the backend's installed plugin version. We must
    // resolve the install-version gate BEFORE subscribing to CHAT_CHANGED
    // restore or running the initial restoreControlState() — both of those
    // paths will re-arm from intent.engaged, which is exactly the state we
    // need to clear after an update.
    const caps = await fetchCapabilities().catch(() => null);
    if (caps) {
        runtime.capabilities = {
            ...runtime.capabilities,
            ...caps,
        };
        runtime.termuxAvailable = Boolean(caps?.termux);
    }
    const versionGate = applyInstallVersionGate({
        installedVersion: caps?.installedVersion || '',
        intentPort,
    });
    if (versionGate.changed) {
        void window.__rmLogEvent?.(
            'install_version_changed',
            `Cleared armed state because installed version changed: ${versionGate.previous} → ${versionGate.current}.`,
            { previous: versionGate.previous, current: versionGate.current, clearedBindings: versionGate.clearedBindings },
        );
    }

    restoreController.subscribeChatChangedRestore();
    void systemController.refreshReleaseInfo().then((info) => {
        if (hadStoredLanguage) {
            return;
        }
        const suggestedLanguage = String(info?.installed?.uiLanguage || '').trim().toLowerCase();
        if (suggestedLanguage !== 'en' && suggestedLanguage !== 'zh') {
            return;
        }
        runtime.settings.uiLanguage = suggestedLanguage;
        setLanguage(suggestedLanguage);
        persistSettings();
        ensurePanelMounted();
        render();
    });
    render();
    if (getChatIdentity(getContext())?.chatId) {
        void restoreController.restoreControlState();
    }

    async function handleNativeReady(result) {
        const context = retryFsm.getContext();
        if (!context.jobId) {
            runtime.pendingNativeOutcome = {
                kind: 'ready',
                payload: result,
            };
            return;
        }

        try {
            // Flush ST's chat to disk before posting frontend_confirmed.
            // ST's saveReply/generation path is async; the .jsonl may not yet
            // contain the native assistant turn when the backend's disk inspector
            // runs. saveChat() is a best-effort pre-flush — the backend already
            // retries with FRONTEND_CONFIRMED_PERSIST_DELAYS_MS, but flushing
            // first reduces the chance of hitting those retries.
            const stCtx = getContext();
            if (typeof stCtx?.saveChat === 'function') {
                try { await stCtx.saveChat(); } catch {}
            }
            await backendPort.confirmNative(context.jobId, {
                runId: context.runId,
                assistantMessageIndex: result?.assistantMessageIndex ?? null,
            });
        } catch (error) {
            runtime.controlError = toStructuredError(error, 'Retry Mobile could not confirm the native assistant turn.');
            render();
        }
    }

    async function handleNativeFailed(error) {
        const context = retryFsm.getContext();
        if (!context.jobId) {
            runtime.pendingNativeOutcome = {
                kind: 'failed',
                payload: error,
            };
            return;
        }

        try {
            await backendPort.reportNativeFailure(context.jobId, {
                runId: context.runId,
                reason: error?.code || 'native_wait_timeout',
                detail: error?.detail || error?.message || '',
            });
        } catch (requestError) {
            // Non-fatal: the backend can still recover native state from persisted chat.
            console.warn('[retry-mobile:native-failed] Backend rejected native failure hint:', requestError);
            showToast('warning', t('toasts.title'), t('toasts.nativeOutcomeReportFailed'));
        }
    }

    async function flushPendingNativeOutcome() {
        if (!runtime.pendingNativeOutcome) {
            return;
        }

        const pending = runtime.pendingNativeOutcome;
        runtime.pendingNativeOutcome = null;
        if (pending.kind === 'ready') {
            await handleNativeReady(pending.payload);
            return;
        }
        await handleNativeFailed(pending.payload);
    }

    async function reloadChatFromUi() {
        ensurePanelMounted();
        // The user-facing "reload" action must force a full SillyTavern chat
        // reload, then re-sync Retry Mobile state so completed output renders.
        await stPort?.guardedReload?.().catch(() => {});

        const state = retryFsm.getState();
        if (state === RetryState.RUNNING) {
            const jobId = retryFsm.getContext().jobId;
            if (jobId) {
                const fresh = await backendPort.pollStatus?.(jobId).catch(() => null);
                if (fresh && retryFsm.getState() === RetryState.RUNNING && retryFsm.getContext().jobId === jobId) {
                    await updateActiveJob(fresh, jobId);
                    syncRuntime();
                    render();
                }
            }
            return;
        }
        const latestResult = await restoreController.reconcileLatestForCurrentChat({
            reason: 'manual_sync',
            force: true,
            allowReload: false,
        });
        if (latestResult?.ok) {
            syncRuntime();
            render();
            return;
        }
        if (state === RetryState.IDLE) {
            await restoreController.restoreControlState();
        }
        syncRuntime();
        render();
    }

    async function updateActiveJob(status, fallbackJobId = '') {
        void fallbackJobId;
        if (!status) {
            return false;
        }
        writeStatusMirror(runtime, status);
        await retryFsm?.observeBackendStatus?.(status);
        return true;
    }

    async function buildStartPayload(payload) {
        const context = getContext();
        const chatIdentity = chooseOperationalChatIdentity(
            payload.chatIdentity,
            payload.target?.chatIdentity,
            payload.targetFingerprint?.chatIdentity,
            getChatIdentity(context),
        );
        const chatState = await resolveExpectedPreviousGeneration(fetchChatState, chatIdentity);

        return {
            ...payload,
            chatIdentity,
            clientProtocolVersion: PROTOCOL_VERSION,
            sessionId: runtime.sessionId || '',
            expectedPreviousGeneration: Number(chatState?.currentGeneration) || 0,
            visibilityState: document.visibilityState || 'visible',
            capturedChatIntegrity: String(context?.chatMetadata?.integrity || ''),
            capturedChatLength: Array.isArray(context?.chat) ? context.chat.length : 0,
            tokenizerDescriptor: buildTokenizerDescriptor(context),
            captureMeta: {
                ...(payload.captureMeta && typeof payload.captureMeta === 'object' ? payload.captureMeta : {}),
                frontendStateLookup: chatState.meta,
                clientTimeZone: getClientTimeZone(),
                clientTimezoneOffsetMinutes: new Date().getTimezoneOffset(),
            },
        };
    }

    function buildTokenizerDescriptor(context) {
        const source = context?.chatMetadata?.tokenizer || context?.chatMetadata?.tokenizer_name || '';
        return source ? { source: String(source) } : null;
    }

}

function toStructuredError(error, fallbackMessage) {
    if (error?.code && error?.message) {
        return error;
    }

    return getStructuredErrorFromApi(error, fallbackMessage);
}

function getClientTimeZone() {
    try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone || '';
    } catch {
        return '';
    }
}

function getArmValidationError(runtime) {
    const diagnostics = runtime.diagnostics || buildSynchronousDiagnostics();
    if (!runtime.diagnostics && diagnostics) {
        runtime.diagnostics = diagnostics;
    }

    if (!diagnostics?.startEnabled) {
        const diagnosticsDetail = formatDiagnosticsBlock(diagnostics);
        return createStructuredError(
            'capture_missing_payload',
            [
                'Retry Mobile is blocked by missing SillyTavern capabilities.',
                diagnosticsDetail ? `\n${diagnosticsDetail}` : '',
                '\nIf you are reporting a bug, include this full error text in your report.',
            ].join(''),
        );
    }

    if (Number(runtime.settings?.maxAttempts) < Number(runtime.settings?.targetAcceptedCount)) {
        return createStructuredError(
            'validation_config_invalid',
            'Maximum attempts must be at least as large as the accepted outputs goal.',
        );
    }

    const timeoutSeconds = Number(runtime.settings?.attemptTimeoutSeconds) || 0;
    if (timeoutSeconds <= 0) {
        return createStructuredError(
            'validation_config_invalid',
            'Attempt timeout must be greater than 0 seconds.',
        );
    }

    const settings = runtime.settings || {};
    let minimum;
    let invalidMessage;
    if (settings.validationMode === VALIDATION_MODE.TOKENS) {
        minimum = Number(settings.minTokens) || 0;
        invalidMessage = 'Minimum tokens must be greater than 0 when token-count blocking is active.';
    } else {
        const counter = resolveCounterMode(settings.counterMode, settings.uiLanguage);
        if (counter === COUNTER_MODE.WORDS) {
            minimum = Number(settings.minWords) || 0;
            invalidMessage = 'Minimum words must be greater than 0 when word-count blocking is active.';
        } else {
            minimum = Number(settings.minCharacters) || 0;
            invalidMessage = 'Minimum characters must be greater than 0 when character-count blocking is active.';
        }
    }

    if (minimum > 0) {
        return null;
    }

    return createStructuredError('validation_config_invalid', invalidMessage);
}

function buildSynchronousDiagnostics() {
    const capabilities = getCapabilityReport(getContext());
    return {
        timestamp: new Date().toISOString(),
        capabilities,
        dryRun: null,
        startEnabled: capabilities.hasContext
            && capabilities.hasEventSource
            && capabilities.hasGenerate
            && capabilities.requiredEvents.every((item) => item.present),
    };
}

function formatDiagnosticsBlock(diagnostics) {
    if (!diagnostics) {
        return 'Diagnostics have not completed yet. Try again in a moment.';
    }

    const caps = diagnostics.capabilities;
    if (!caps) {
        return 'Diagnostics did not return a capability report.';
    }

    const missing = [];
    if (!caps.hasContext) missing.push('SillyTavern.getContext() missing');
    if (!caps.hasEventSource) missing.push('eventSource missing');
    if (!caps.hasGenerate) missing.push('generate() missing');

    const missingEvents = Array.isArray(caps.requiredEvents)
        ? caps.requiredEvents.filter((event) => !event?.present).map((event) => String(event?.name || '').trim()).filter(Boolean)
        : [];
    if (missingEvents.length > 0) {
        missing.push(`requiredEvents missing: ${missingEvents.join(', ')}`);
    }

    const dryRun = diagnostics.dryRun;
    const dryRunLine = dryRun?.ok
        ? 'dryRun: passed'
        : `dryRun: failed (${String(dryRun?.reason || 'unknown reason')})`;

    return [
        'Diagnostics summary:',
        `- startEnabled: ${diagnostics.startEnabled ? 'true' : 'false'}`,
        `- ${dryRunLine}`,
        missing.length > 0 ? `- missing: ${missing.join(' | ')}` : '- missing: (none reported)',
    ].join('\n');
}

function bindHostObserver(ensurePanelMounted) {
    if (runtime.hostObserver || !document.body) {
        return;
    }

    runtime.hostObserver = window.setInterval(() => {
        if (!document.getElementById('retry-mobile-panel')) {
            ensurePanelMounted();
        }
    }, 2000);
}

function scheduleMountRetry(ensurePanelMounted) {
    if (runtime.mountRetryHandle) {
        return;
    }

    runtime.mountRetryHandle = window.setTimeout(() => {
        runtime.mountRetryHandle = 0;
        ensurePanelMounted();
    }, 900);
}

function hasStoredUiLanguage(context) {
    const value = context?.extensionSettings?.retryMobile?.uiLanguage;
    return value === 'en' || value === 'zh';
}
