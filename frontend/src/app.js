import { fetchCapabilities, fetchChatState, getStructuredErrorFromApi } from './backend-api.js';
import { sendFrontendLogEvent } from './logs/retry-log.js';
import { createStructuredError } from './retry-error.js';
import { writeSettings, readSettings } from './settings.js';
import { getChatIdentity, getContext } from './st-context.js';
import { PROTOCOL_VERSION } from './constants.js';
import { createRuntime } from './core/runtime.js';
import { isRunningLikeState } from './core/run-state.js';
import { createRenderer } from './ui/render.js';
import { mountPanel } from './ui/panel-bindings.js';
import { createSystemController } from './controllers/system-controller.js';
import {
    clearActiveRunBinding,
    findLatestActiveRunBinding,
    getFrontendSessionId,
    recoverBoundStatus,
    writeActiveRunBinding,
} from './job/run-binding.js';
import { createIntentPort } from './intent.js';
import { createRetryFsm, RetryState } from './retry-fsm.js';
import { createStPort } from './st-adapter.js';
import { createBackendPort } from './backend-client.js';
import { chooseOperationalChatIdentity, resolveExpectedPreviousGeneration } from './start-payload.js';
import {
    buildBootArmPayload,
    buildRestoreTarget,
    collectBootRestoreChatIdentities,
    getAttachedJobStatusFromStartError,
    resolveCaptureTarget,
    resolveCaptureSubscriptionChatIdentity,
    shouldAttachRunningConflict,
} from './app-recovery.js';

const runtime = createRuntime();

export function bootRetryMobile() {
    runtime.settings = readSettings(getContext());
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

    backendPort = {
        ...baseBackendPort,
        startJob(payload) {
            void buildStartPayload(payload)
                .then((startPayload) => baseBackendPort.startJob(startPayload))
                .then((result) => {
                    if (!result?.jobId) {
                        throw createStructuredError(
                            'handoff_request_failed',
                            'Retry Mobile backend start did not return a job id.',
                        );
                    }

                    updateActiveJob(result.job || null, result.jobId);
                    retryFsm.jobStarted({
                        runId: payload.runId,
                        jobId: result.jobId,
                        chatIdentity: payload.chatIdentity,
                        target: payload.target,
                    });
                    syncRuntimeFromFsm(retryFsm);
                    render();
                    void flushPendingNativeOutcome();
                })
                .catch((error) => {
                    const attachedStatus = getAttachedJobStatusFromStartError(error);
                    if (attachedStatus?.jobId) {
                        const current = retryFsm.getContext();
                        if (shouldAttachRunningConflict(
                            retryFsm.getState(),
                            current.runId,
                            payload.runId,
                        )) {
                            updateActiveJob(attachedStatus, attachedStatus.jobId);
                            retryFsm.restoreRunning({
                                status: attachedStatus,
                                runId: attachedStatus.runId || payload.runId,
                                jobId: attachedStatus.jobId,
                                chatIdentity: attachedStatus.chatIdentity || current.chatIdentity || payload.chatIdentity,
                                target: buildRestoreTarget(attachedStatus, current.target),
                            });
                            syncRuntimeFromFsm(retryFsm);
                            render();
                            void flushPendingNativeOutcome();
                        }
                        return;
                    }

                    retryFsm.jobFailed({
                        chatIdentity: payload.chatIdentity,
                        error: toStructuredError(error, 'Retry Mobile could not start the backend retry job.'),
                    });
                    syncRuntimeFromFsm(retryFsm);
                    render();
                });
        },
        startPolling(jobId, onStatus, onError) {
            return baseBackendPort.startPolling(
                jobId,
                async (status) => {
                    updateActiveJob(status || null, jobId);
                    render();
                    await onStatus?.(status);
                    syncRuntimeFromFsm(retryFsm);
                    render();
                },
                async (error) => {
                    await onError?.(toStructuredError(error, 'Retry Mobile backend polling failed.'));
                    syncRuntimeFromFsm(retryFsm);
                    render();
                },
            );
        },
        async confirmNative(jobId, payload) {
            const result = await baseBackendPort.confirmNative(jobId, payload);
            updateActiveJob(result?.job || null, jobId);
            render();
            return result;
        },
        async reportNativeFailure(jobId, payload) {
            const result = await baseBackendPort.reportNativeFailure(jobId, payload);
            updateActiveJob(result?.job || null, jobId);
            render();
            return result;
        },
        async reportFrontendPresence(jobId, payload) {
            const result = await baseBackendPort.reportFrontendPresence(jobId, payload);
            if (result?.job) {
                updateActiveJob(result.job, jobId);
                render();
            }
            return result;
        },
        async cancelJob(jobId, payload) {
            const result = await baseBackendPort.cancelJob(jobId, payload);
            render();
            return result;
        },
    };

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
            syncRuntimeFromFsm(retryFsm);
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
    syncRuntimeFromFsm(retryFsm);

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
        syncRuntimeFromFsm(retryFsm);
        render();
    };

    const stopPlugin = async () => {
        retryFsm.userStop({});
        runtime.controlError = null;
        runtime.pendingNativeOutcome = null;
        syncRuntimeFromFsm(retryFsm);
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
            onDiagnostics: async () => {
                await systemController.refreshDiagnostics(true);
                systemController.showTab('system');
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
    };
    window.__rmDispatch = (type, payload) => {
        handleExternalSignal(type, payload);
    };
    window.__rmLogEvent = (event, summary, detail) => sendFrontendLogEvent(runtime, { event, summary, detail });

    ensurePanelMounted();
    bindHostObserver(ensurePanelMounted);
    bindPageObservers();
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
    void restoreControlState();

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
            runtime.controlError = toStructuredError(requestError, 'Retry Mobile could not report the native wait outcome.');
            render();
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
                syncRuntimeFromFsm(retryFsm);
                render();
            }
        }
    }

    function updateActiveJob(status, fallbackJobId = '') {
        if (status) {
            runtime.activeJobStatus = status;
            runtime.activeJobId = status.jobId || fallbackJobId || runtime.activeJobId || null;
            runtime.activeJobStatusObservedAt = status.updatedAt || new Date().toISOString();
            return;
        }

        if (fallbackJobId) {
            runtime.activeJobId = fallbackJobId;
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

    function syncRuntimeFromFsm(fsm) {
        const context = fsm.getContext();
        const terminalStatus = context.lastTerminalResult?.status || null;
        runtime.controlError = context.error || null;

        if (context.jobId) {
            runtime.activeJobId = context.jobId;
        } else if (context.lastTerminalResult?.jobId) {
            runtime.activeJobId = context.lastTerminalResult.jobId;
        }

        if (terminalStatus) {
            runtime.activeJobStatus = terminalStatus;
        }

        syncActiveRunBinding(context);

        if (context.state !== RetryState.RUNNING) {
            runtime.pendingNativeOutcome = null;
        }
    }

    function scheduleRestoreRetry() {
        if (runtime.restoreRetryHandle) {
            return;
        }

        runtime.restoreRetryHandle = window.setTimeout(() => {
            runtime.restoreRetryHandle = 0;
            void restoreControlState();
        }, 250);
    }

    async function restoreControlState() {
        if (retryFsm.getState() !== RetryState.IDLE) {
            return;
        }

        const currentChatIdentity = getChatIdentity(getContext());
        const intent = intentPort.readIntent?.() || null;
        const activeRunBinding = findLatestActiveRunBinding(runtime.sessionId);
        const restoreIdentities = collectBootRestoreChatIdentities({
            currentChatIdentity,
            singleTarget: intent?.singleTarget || null,
            activeRunBinding,
        });

        try {
            for (const chatIdentity of restoreIdentities) {
                const recovered = await recoverBoundStatus({
                    chatIdentity,
                    sessionId: runtime.sessionId || '',
                    fetchStatus: baseBackendPort.pollStatus,
                    fetchActive: baseBackendPort.fetchActiveJob,
                });
                if (retryFsm.getState() !== RetryState.IDLE) {
                    return;
                }
                const status = recovered?.status || null;
                if (status?.jobId && String(status.state || '') === 'running') {
                    updateActiveJob(status, status.jobId);
                    retryFsm.restoreRunning({
                        status,
                        runId: status.runId,
                        jobId: status.jobId,
                        chatIdentity: status.chatIdentity || chatIdentity,
                        target: buildRestoreTarget(status, intent?.singleTarget || null),
                    });
                    syncRuntimeFromFsm(retryFsm);
                    render();
                    return;
                }
            }

            if (intent?.engaged
                && intent?.mode === 'toggle'
                && !currentChatIdentity?.chatId) {
                scheduleRestoreRetry();
                return;
            }

            if (intent?.engaged
                && intent?.mode === 'single'
                && !intent?.singleTarget?.chatIdentity) {
                runtime.controlError = createStructuredError(
                    'single_target_missing',
                    'Retry Mobile could not restore single mode because the durable target identity is missing.',
                );
                render();
                return;
            }

            const armPayload = buildBootArmPayload(intent, currentChatIdentity);
            if (armPayload && retryFsm.getState() === RetryState.IDLE) {
                retryFsm.arm(armPayload);
                if (retryFsm.getState() !== RetryState.ARMED) {
                    runtime.controlError = retryFsm.getContext().error || createStructuredError(
                        'retry_arm_failed',
                        'Retry Mobile could not restore armed mode from saved settings.',
                    );
                }
                syncRuntimeFromFsm(retryFsm);
                render();
            }
        } catch (error) {
            runtime.controlError = toStructuredError(
                error,
                'Retry Mobile could not restore backend state during boot.',
            );
            render();
        }
    }

    function syncActiveRunBinding(context) {
        const bindingChatIdentity = resolveCaptureSubscriptionChatIdentity(context);
        if (context.state === RetryState.RUNNING
            && context.jobId
            && context.runId
            && bindingChatIdentity
            && runtime.sessionId) {
            runtime.activeRunBinding = writeActiveRunBinding({
                runId: context.runId,
                jobId: context.jobId,
                sessionId: runtime.sessionId,
                chatIdentity: cloneValue(bindingChatIdentity),
                lastKnownTargetMessageVersion: Number(runtime.activeJobStatus?.targetMessageVersion || 0),
                lastKnownState: String(runtime.activeJobStatus?.state || context.state || 'unknown'),
                updatedAt: runtime.activeJobStatus?.updatedAt || new Date().toISOString(),
            });
            return;
        }

        const staleChatIdentity = runtime.activeRunBinding?.chatIdentity || bindingChatIdentity || null;
        if (staleChatIdentity) {
            clearActiveRunBinding(staleChatIdentity);
        }
        runtime.activeRunBinding = null;
    }

    function toStructuredError(error, fallbackMessage) {
        if (error?.code && error?.message) {
            return error;
        }

        return getStructuredErrorFromApi(error, fallbackMessage);
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
}

function getArmValidationError(runtime) {
    if (!runtime.diagnostics?.startEnabled) {
        return createStructuredError(
            'capture_missing_payload',
            'Retry Mobile is blocked by missing SillyTavern capabilities. Run diagnostics first.',
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

function bindPageObservers() {
    if (window.__rmPageObserversBound) {
        return;
    }
    window.__rmPageObserversBound = true;

    document.addEventListener('visibilitychange', () => {
        const hidden = document.visibilityState === 'hidden';
        window.__rmDispatch?.(hidden ? 'page.hidden' : 'page.visible', {});
        void window.__rmLogEvent?.('visibility_changed', `Frontend visibility changed to ${document.visibilityState}.`, {
            visibilityState: document.visibilityState,
        });
    });

    window.addEventListener('focus', () => {
        window.__rmDispatch?.('window.focused', {});
        void window.__rmLogEvent?.('window_focus', 'Frontend window regained focus.', null);
    });

    window.addEventListener('online', () => {
        window.__rmDispatch?.('network.online', {});
        void window.__rmLogEvent?.('browser_online', 'Frontend browser reported an online transition.', null);
    });
}
