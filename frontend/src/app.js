import { fetchCapabilities, fetchChatState, getStructuredErrorFromApi } from './backend-api.js';
import { sendFrontendLogEvent } from './logs/retry-log.js';
import { createStructuredError } from './retry-error.js';
import { writeSettings, readSettings } from './settings.js';
import { getChatIdentity, getContext, showToast } from './st-context.js';
import { PROTOCOL_VERSION } from './constants.js';
import { createRuntime } from './core/runtime.js';
import { isRunningLikeState } from './core/run-state.js';
import { createRenderer } from './ui/render.js';
import { mountPanel } from './ui/panel-bindings.js';
import { createSystemController } from './controllers/system-controller.js';
import { getFrontendSessionId } from './job/run-binding.js';
import { createIntentPort } from './intent.js';
import { createRetryFsm, RetryState } from './retry-fsm.js';
import { createStPort } from './st-adapter.js';
import { createBackendPort } from './backend-client.js';
import { createAppPorts } from './app-ports.js';
import { syncRuntimeFromFsm } from './app-runtime-sync.js';
import { chooseOperationalChatIdentity, resolveExpectedPreviousGeneration } from './start-payload.js';
import {
    createRestoreController,
    resolveCaptureTarget,
    resolveCaptureSubscriptionChatIdentity,
} from './app-recovery.js';

const runtime = createRuntime();

export function bootRetryMobile() {
    runtime.settings = readSettings(getContext());
    runtime.sessionId = getFrontendSessionId();
    runtime.controlError = null;
    runtime.pendingNativeOutcome = null;
    runtime.toast.lastJobId = '';
    runtime.toast.lastAttemptCount = null;
    runtime.toast.lastAcceptedCount = null;
    runtime.toast.lastTerminalState = '';

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
        syncRuntimeFromFsm: (fsm) => syncRuntimeFromFsm(runtime, fsm),
        render,
        buildStartPayload,
        flushPendingNativeOutcome,
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
            showToast('info', 'Retry Mobile', 'Captured request. Starting backend retry job…');
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
    });
    runtime.retryFsm = retryFsm;
    const syncRuntime = () => syncRuntimeFromFsm(runtime, retryFsm);
    syncRuntime();

    const armPluginFromUi = async () => {
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
            runtime.controlError = retryFsm.getContext().error || createStructuredError(
                'retry_arm_failed',
                'Retry Mobile could not arm the retry loop due to an invalid intent mode.',
            );
        }
        syncRuntime();
        render();
    };

    const stopPlugin = async () => {
        retryFsm.userStop({});
        runtime.controlError = null;
        runtime.pendingNativeOutcome = null;
        syncRuntime();
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
        updateActiveJob,
        render,
        syncRuntimeFromFsm: (fsm) => syncRuntimeFromFsm(runtime, fsm),
        getCurrentChatIdentity: () => getChatIdentity(getContext()),
        toStructuredError,
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
        unbindPageObservers(runtime);
    };
    window.__rmDispatch = (type, payload) => {
        handleExternalSignal(type, payload);
    };
    window.__rmLogEvent = (event, summary, detail) => sendFrontendLogEvent(runtime, { event, summary, detail });

    ensurePanelMounted();
    bindHostObserver(ensurePanelMounted);
    bindPageObservers(runtime);
    systemController.registerCommands();

    void systemController.refreshDiagnostics();
    systemController.refreshQuickReplyState({ quiet: true });
    systemController.scheduleQuickReplyRefresh();
    void fetchCapabilities().then((caps) => {
        runtime.capabilities = {
            ...runtime.capabilities,
            ...caps,
        };
        runtime.termuxAvailable = Boolean(caps?.termux);
        render();
    });
    void systemController.refreshReleaseInfo();
    render();
    void restoreController.restoreControlState();

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
            showToast('warning', 'Retry Mobile', 'Could not report native wait outcome to backend (non-fatal).');
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

    function handleExternalSignal(type, payload = {}) {
        const state = retryFsm.getState();
        if (type === 'page.hidden') {
            const context = retryFsm.getContext();
            if (state === RetryState.RUNNING && context.jobId) {
                void backendPort.reportFrontendPresence(context.jobId, {
                    reason: 'page.hidden',
                    visibilityState: 'hidden',
                    chatIdentity: cloneValue(context.chatIdentity),
                });
            }
            return;
        }

        if (type === 'page.visible' || type === 'window.focused' || type === 'network.online') {
            if (state === RetryState.RUNNING) {
                const context = retryFsm.getContext();
                retryFsm.resume({
                    reason: type,
                    isVisible: Boolean(stPort.isVisible?.()),
                    chatIdentity: resolveCaptureSubscriptionChatIdentity(context),
                    pendingVisibleRender: context.pendingVisibleRender,
                });
                syncRuntime();
                render();
            }
        }
    }

    function updateActiveJob(status, fallbackJobId = '') {
        if (status) {
            const statusChanged = buildActiveJobStatusRenderKey(runtime.activeJobStatus)
                !== buildActiveJobStatusRenderKey(status);
            runtime.activeJobStatus = status;
            runtime.activeJobId = status.jobId || fallbackJobId || runtime.activeJobId || null;
            runtime.activeJobStatusObservedAt = status.updatedAt || new Date().toISOString();
            maybeToastJobProgress(runtime, status);
            return statusChanged;
        }

        if (fallbackJobId) {
            runtime.activeJobId = fallbackJobId;
        }
        return false;
    }

    function maybeToastJobProgress(runtime, status) {
        if (!status || typeof status !== 'object') {
            return;
        }

        const jobId = String(status.jobId || runtime.activeJobId || '');
        const state = String(status.state || '').trim();
        const attemptCount = Number.isFinite(Number(status.attemptCount)) ? Number(status.attemptCount) : null;
        const maxAttempts = Number.isFinite(Number(status.maxAttempts)) ? Number(status.maxAttempts) : null;
        const acceptedCount = Number.isFinite(Number(status.acceptedCount)) ? Number(status.acceptedCount) : null;
        const targetAcceptedCount = Number.isFinite(Number(status.targetAcceptedCount)) ? Number(status.targetAcceptedCount) : null;

        if (jobId && runtime.toast.lastJobId && runtime.toast.lastJobId !== jobId) {
            runtime.toast.lastAttemptCount = null;
            runtime.toast.lastAcceptedCount = null;
            runtime.toast.lastTerminalState = '';
        }
        runtime.toast.lastJobId = jobId || runtime.toast.lastJobId || '';

        if (state === 'running') {
            if (attemptCount != null
                && maxAttempts != null
                && runtime.toast.lastAttemptCount !== attemptCount) {
                runtime.toast.lastAttemptCount = attemptCount;
                showToast('info', 'Retry Mobile', `Retry attempt ${attemptCount}/${maxAttempts}.`);
            }

            if (acceptedCount != null
                && targetAcceptedCount != null
                && runtime.toast.lastAcceptedCount !== acceptedCount
                && acceptedCount > 0) {
                runtime.toast.lastAcceptedCount = acceptedCount;
                showToast('success', 'Retry Mobile', `Accepted ${acceptedCount}/${targetAcceptedCount}.`);
            }

            return;
        }

        if (state === 'completed' || state === 'failed' || state === 'cancelled') {
            if (runtime.toast.lastTerminalState === state) {
                return;
            }
            runtime.toast.lastTerminalState = state;

            const summaryParts = [];
            if (acceptedCount != null && targetAcceptedCount != null) {
                summaryParts.push(`${acceptedCount}/${targetAcceptedCount} accepted`);
            }
            if (attemptCount != null && maxAttempts != null) {
                summaryParts.push(`${attemptCount}/${maxAttempts} attempts`);
            }
            const summary = summaryParts.length ? ` (${summaryParts.join(', ')})` : '';

            if (state === 'completed') {
                showToast('success', 'Retry Mobile', `Job complete${summary}.`);
                return;
            }
            if (state === 'cancelled') {
                showToast('warning', 'Retry Mobile', `Job cancelled${summary}.`);
                return;
            }

            const message = status?.structuredError?.message
                || status?.lastError
                || 'Retry Mobile failed.';
            showToast('error', 'Retry Mobile', `${message}${summary}`);
        }
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

function getArmValidationError(runtime) {
    if (!runtime.diagnostics?.startEnabled) {
        const diagnosticsDetail = formatDiagnosticsBlock(runtime.diagnostics);
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

    const minimum = runtime.settings?.validationMode === 'tokens'
        ? Number(runtime.settings?.minTokens) || 0
        : Number(runtime.settings?.minCharacters) || 0;

    if (minimum > 0) {
        return null;
    }

    return createStructuredError(
        'validation_config_invalid',
        runtime.settings?.validationMode === 'tokens'
            ? 'Minimum tokens must be greater than 0 when token-count blocking is active.'
            : 'Minimum characters must be greater than 0 when character-count blocking is active.',
    );
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

export function bindPageObservers(runtime, {
    documentRef = document,
    windowRef = window,
    dispatch = (type, payload) => windowRef.__rmDispatch?.(type, payload),
    logEvent = (event, summary, detail) => windowRef.__rmLogEvent?.(event, summary, detail),
} = {}) {
    if (runtime.pageObserverHandles) {
        return runtime.pageObserverHandles;
    }

    const onVisibilityChange = () => {
        const hidden = documentRef.visibilityState === 'hidden';
        dispatch(hidden ? 'page.hidden' : 'page.visible', {});
        void logEvent('visibility_changed', `Frontend visibility changed to ${documentRef.visibilityState}.`, {
            visibilityState: documentRef.visibilityState,
        });
    };
    const onFocus = () => {
        dispatch('window.focused', {});
        void logEvent('window_focus', 'Frontend window regained focus.', null);
    };
    const onOnline = () => {
        dispatch('network.online', {});
        void logEvent('browser_online', 'Frontend browser reported an online transition.', null);
    };

    documentRef.addEventListener('visibilitychange', onVisibilityChange);
    windowRef.addEventListener('focus', onFocus);
    windowRef.addEventListener('online', onOnline);
    runtime.pageObserverHandles = {
        documentRef,
        windowRef,
        onVisibilityChange,
        onFocus,
        onOnline,
    };
    return runtime.pageObserverHandles;
}

export function unbindPageObservers(runtime) {
    const handles = runtime.pageObserverHandles;
    if (!handles) {
        return false;
    }

    handles.documentRef.removeEventListener('visibilitychange', handles.onVisibilityChange);
    handles.windowRef.removeEventListener('focus', handles.onFocus);
    handles.windowRef.removeEventListener('online', handles.onOnline);
    runtime.pageObserverHandles = null;
    return true;
}

function buildActiveJobStatusRenderKey(status) {
    if (!status) {
        return '';
    }

    return JSON.stringify({
        jobId: String(status.jobId || ''),
        runId: String(status.runId || ''),
        state: String(status.state || ''),
        acceptedCount: Number(status.acceptedCount || 0),
        attemptCount: Number(status.attemptCount || 0),
        targetMessageVersion: Number(status.targetMessageVersion || 0),
        targetMessageIndex: Number(status.targetMessageIndex ?? -1),
        structuredError: status.structuredError
            ? {
                code: String(status.structuredError.code || ''),
                message: String(status.structuredError.message || ''),
                detail: String(status.structuredError.detail || ''),
            }
            : null,
    });
}

function cloneValue(value) {
    if (value == null) {
        return value ?? null;
    }

    if (typeof globalThis.structuredClone === 'function') {
        return globalThis.structuredClone(value);
    }

    return JSON.parse(JSON.stringify(value));
}
