import {
    EXTENSION_NAME,
    LOG_PREFIX,
    PROTOCOL_VERSION,
    RUN_MODE,
    RUN_STATE,
    VALIDATION_MODE,
} from '../constants.js';
import { createLogger } from '../logger.js';
import {
    getStructuredErrorFromApi,
    startBackendJob,
    confirmNativeJob,
    reportNativeFailure,
    cancelBackendJob,
} from '../backend-api.js';
import { clearCommittedReloads } from '../chat-sync.js';
import {
    getChatIdentity,
    getContext,
    showToast,
} from '../st-context.js';
import { createArmCaptureSession } from '../st-capture.js';
import { waitForNativeCompletion } from '../st-lifecycle.js';
import { isSameChat, reloadCurrentChatSafe } from '../st-chat.js';
import {
    createStructuredError,
    formatStructuredError,
    normalizeStructuredError,
} from '../retry-error.js';
import { syncRetryLogForStatus } from '../logs/retry-log.js';
import { isRunningLikeState, resolveRunStateFromStatus } from '../core/run-state.js';

const log = createLogger(LOG_PREFIX.APP);
const backendLog = createLogger(LOG_PREFIX.BACKEND);

export function createRunController({ runtime, render, statusController }) {
    return {
        armPluginFromUi,
        armPlugin,
        stopPlugin,
        maybeAutoRearmAfterRun,
    };

    async function armPluginFromUi() {
        await armPlugin({
            showToastMessage: 'Retry Mobile is armed for the next qualifying generation in this chat.',
        });
    }

    async function armPlugin(options = {}) {
        if (!runtime.diagnostics?.startEnabled) {
            statusController.applyErrorState(createStructuredError(
                'capture_missing_payload',
                'Retry Mobile is blocked by missing SillyTavern capabilities. Run diagnostics first.',
            ));
            return;
        }

        const context = getContext();
        const identity = getChatIdentity(context);
        if (!identity?.chatId) {
            statusController.applyErrorState(createStructuredError(
                'capture_chat_changed',
                'No active chat was found. Open a chat before arming Retry Mobile.',
            ));
            return;
        }

        await statusController.refreshChatState(identity);

        if (runtime.settings.runMode === RUN_MODE.TOGGLE && runtime.chatState?.toggleBlocked) {
            statusController.applyErrorState(createStructuredError(
                'toggle_blocked',
                'Retry Mobile toggle mode is temporarily blocked for this chat after repeated failures. Start a single run or wait until the next successful run resets the breaker.',
            ));
            return;
        }

        if (runtime.settings.maxAttempts < runtime.settings.targetAcceptedCount) {
            statusController.applyErrorState(createStructuredError(
                'handoff_request_failed',
                'Maximum attempts must be at least as large as the accepted outputs goal.',
            ));
            return;
        }

        const runConfigError = getRunConfigError(runtime.settings);
        if (runConfigError) {
            statusController.applyErrorState(runConfigError);
            return;
        }

        if (isRunningLikeState(statusController.getCurrentState())) {
            runtime.machine.recordEvent('ui', 'start_ignored', 'Ignored start because Retry Mobile is already armed or running.');
            render();
            showToast('info', EXTENSION_NAME, 'Retry Mobile is already armed or running in this browser session.');
            return;
        }

        stopCaptureSession();
        statusController.clearPolling();
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

                void statusController.applyTerminalState(runId, RUN_STATE.CANCELLED, {
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

    async function stopPlugin() {
        runtime.manualStopRequested = true;
        const snapshot = runtime.machine.getSnapshot();
        const runId = snapshot.activeRunId || snapshot.runId;

        stopCaptureSession();
        statusController.clearPolling();

        if (runtime.activeJobId) {
            try {
                await cancelBackendJob(runtime.activeJobId);
                runtime.machine.recordEvent('backend', 'cancel_requested', `Requested cancellation for backend job ${runtime.activeJobId}.`);
            } catch (error) {
                backendLog.warn('Cancel request failed.', error);
                statusController.noteTransportError(error, 'backend', 'cancel_failed', 'Retry Mobile could not send the backend cancel request.', {
                    endpoint: '/cancel',
                    occurredDuring: 'cancel',
                });
            }
        }

        if (runId) {
            await statusController.applyTerminalState(runId, RUN_STATE.CANCELLED, {
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

        await statusController.refreshChatState(liveIdentity);
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
            await statusController.applyTerminalState(runId, RUN_STATE.FAILED, {
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
            await statusController.applyTerminalState(runId, RUN_STATE.FAILED, {
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
            capturedChatIntegrity: String(context?.chatMetadata?.integrity || ''),
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
            statusController.setActiveBackendStatus(result.job ?? null, 'live_active');
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
            await syncRetryLogForStatus(runtime, runtime.activeJobStatus, {
                force: true,
                clearWhenMissing: false,
            });
            statusController.startPolling(runId);
            render();
            return true;
        } catch (error) {
            if (error?.status === 409 && error?.payload?.reason === 'job_running' && error?.payload?.job?.jobId) {
                runtime.activeJobId = error.payload.job.jobId;
                statusController.setActiveBackendStatus(error.payload.job, 'live_active');
                clearCommittedReloads(runtime);
                runtime.machine.setOwnsTurn(false);
                runtime.machine.setBackendEvent('attached', 'Attached to an existing backend run for this chat.');
                runtime.machine.recordEvent('backend', 'attached', 'Attached to an existing backend run for this chat.');
                runtime.machine.transition(resolveRunStateFromStatus(error.payload.job) || RUN_STATE.CAPTURED_PENDING_NATIVE);
                await syncRetryLogForStatus(runtime, runtime.activeJobStatus, {
                    force: true,
                    clearWhenMissing: false,
                });
                statusController.startPolling(runId);
                render();
                showToast('info', EXTENSION_NAME, 'Attached to the existing Retry Mobile run for this chat.');
                return true;
            }

            if (error?.status === 409 && error?.payload?.reason === 'rearm_race') {
                const structured = getStructuredErrorFromApi(error, 'Another tab already re-armed this chat before this browser could.');
                await statusController.applyTerminalState(runId, RUN_STATE.FAILED, {
                    error: structured,
                    toastKind: 'info',
                    toastMessage: 'Another tab already re-armed this chat.',
                });
                return false;
            }

            const structured = getStructuredErrorFromApi(error, 'Retry Mobile could not reserve the backend recovery job for this turn.');
            await statusController.applyTerminalState(runId, RUN_STATE.FAILED, {
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

            statusController.setActiveBackendStatus(result.job ?? runtime.activeJobStatus, 'live_active');
            statusController.syncRuntimeStateFromStatus(runId, runtime.activeJobStatus, {
                previousStatus: null,
                announceTransitions: false,
            });
            runtime.machine.setBackendEvent('native_confirmed', `Backend confirmed native assistant turn ${nativeResult.assistantMessageIndex}.`);
            runtime.machine.recordEvent('backend', 'native_confirmed', `Backend confirmed native assistant turn ${nativeResult.assistantMessageIndex}.`);
            await syncRetryLogForStatus(runtime, runtime.activeJobStatus, {
                force: false,
                clearWhenMissing: false,
            });
            render();
            showToast('success', EXTENSION_NAME, 'Retry Mobile confirmed the native first reply. Backend retries are ready for this turn.');
        } catch (error) {
            statusController.noteTransportError(error, 'backend', 'native_confirm_failed', 'Retry Mobile could not confirm the native assistant turn with the backend.', {
                endpoint: '/confirm-native',
                occurredDuring: 'native_confirmation',
            });
            if (error?.status === 409) {
                runtime.machine.recordEvent('backend', 'native_confirm_conflict', error?.message || 'Backend reported a native confirmation conflict.');
                render();
                await statusController.adoptBackendStatus(runId, error, {
                    announceTransitions: true,
                });
                return;
            }

            const recovered = await statusController.adoptBackendStatus(runId, error, {
                announceTransitions: true,
            });
            if (recovered) {
                return;
            }

            if (statusController.shouldDeferBackendDisconnect(error)) {
                statusController.deferBackendDisconnect(
                    runId,
                    'native_confirm_deferred',
                    'Frontend lost contact while confirming native completion. Retry Mobile will recover backend status when the page becomes active again.',
                );
                return;
            }

            const structured = getStructuredErrorFromApi(error, 'Retry Mobile could not confirm the native assistant turn with the backend.');
            await statusController.applyTerminalState(runId, RUN_STATE.FAILED, {
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

            statusController.setActiveBackendStatus(result.job ?? runtime.activeJobStatus, 'live_active');
            statusController.syncRuntimeStateFromStatus(runId, runtime.activeJobStatus, {
                previousStatus: null,
                announceTransitions: true,
            });
            runtime.machine.setBackendEvent('native_failed', `Backend accepted native failure hint: ${nativeResult.reason || 'unknown'}.`);
            runtime.machine.recordEvent('backend', 'native_failed', `Backend accepted native failure hint: ${nativeResult.reason || 'unknown'}.`);
            await syncRetryLogForStatus(runtime, runtime.activeJobStatus, {
                force: false,
                clearWhenMissing: false,
            });
            render();
        } catch (error) {
            if (!runtime.machine.isCurrentRun(runId)) {
                return;
            }

            statusController.noteTransportError(error, 'backend', 'native_failure_report_failed', 'Retry Mobile could not report the native wait outcome to the backend.', {
                endpoint: '/native-failed',
                occurredDuring: 'hidden_timeout_report',
            });

            if (error?.status === 404) {
                if (!runtime.nativeFailureCompatWarned) {
                    runtime.nativeFailureCompatWarned = true;
                    runtime.machine.recordEvent('backend', 'native_failed_unsupported', 'The backend does not support /native-failed yet. Waiting for grace-expiry recovery via status polling.');
                    showToast('warning', EXTENSION_NAME, 'This backend is older and cannot accept native failure hints yet. Retry Mobile will keep polling backend status.');
                    render();
                }
                return;
            }

            const adopted = await statusController.adoptBackendStatus(runId, error, {
                announceTransitions: true,
            });
            if (adopted) {
                return;
            }

            if (statusController.shouldDeferBackendDisconnect(error)) {
                statusController.deferBackendDisconnect(
                    runId,
                    'native_failure_deferred',
                    'Frontend lost contact while reporting the hidden-tab native outcome. Retry Mobile will recover backend status when the page becomes active again.',
                );
                return;
            }

            const structured = getStructuredErrorFromApi(error, 'Retry Mobile could not report the native wait outcome to the backend.');
            await statusController.applyTerminalState(runId, RUN_STATE.FAILED, {
                error: structured,
                toastKind: 'warning',
                toastMessage: formatStructuredError(structured),
            });
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
        runtime.lastTransportError = null;
        runtime.lastTransportEndpoint = '';
        runtime.lastTransportErrorAt = null;
        runtime.transportErrorContext = null;
        runtime.disconnectPolicy = 'none';
        clearCommittedReloads(runtime);
        if (!options.preserveStatus) {
            runtime.activeJobId = null;
            statusController.clearActiveBackendStatus();
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

    function buildTokenizerDescriptor(context) {
        const tokenizerModel = typeof context?.getTokenizerModel === 'function'
            ? context.getTokenizerModel()
            : '';
        const capturedModel = runtime.capturedRequest?.model;
        return {
            tokenizerMode: runtime.settings.validationMode,
            tokenizerKey: String(tokenizerModel || capturedModel || context?.mainApi || ''),
            model: String(capturedModel || tokenizerModel || ''),
            apiFamily: String(context?.mainApi || ''),
            chatCompletionSource: String(runtime.capturedRequest?.chat_completion_source || ''),
        };
    }
}
