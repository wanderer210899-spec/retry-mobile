import {
    cancelBackendJob,
    confirmNativeJob,
    fetchActiveJob,
    fetchChatState,
    fetchJobStatus,
    getStructuredErrorFromApi,
    reportFrontendPresence,
    reportNativeFailure,
    startBackendJob,
} from '../backend-api.js';
import {
    POLL_INTERVAL_FAST_MS,
    POLL_INTERVAL_SLOW_MS,
    POLL_INTERVAL_STEADY_MS,
    PROTOCOL_VERSION,
} from '../constants.js';
import { createArmCaptureSession } from '../st-capture.js';
import { getChatIdentity, getContext, showToast } from '../st-context.js';
import { waitForNativeCompletion } from '../st-lifecycle.js';
import { clearRetryLog, sendFrontendLogEvent, syncRetryLogForStatus } from '../logs/retry-log.js';
import { createStructuredError, normalizeStructuredError } from '../retry-error.js';
import { reloadSessionUi, applyAcceptedOutput, finishTerminalUi } from '../render/st-operations.js';
import { chooseOperationalChatIdentity, resolveExpectedPreviousGeneration } from '../start-payload.js';
import { isTerminalStatus } from './job-reducer.js';
import { recoverBoundStatus } from './run-binding.js';

export function createJobEffects({ runtime, machine, render }) {
    const familyControllers = {
        poll: null,
        native: null,
        render: null,
        recovery: null,
    };
    const inFlightRequests = new Map();
    let captureSession = null;
    let lastToastedRunId = null;

    return {
        run,
        teardown,
    };

    function run(commands = []) {
        commands.forEach((command) => {
            void execute(command);
        });
    }

    function teardown() {
        Object.keys(familyControllers).forEach((key) => abortFamily(key, 'teardown'));
        if (captureSession?.stop) {
            captureSession.stop();
        }
        captureSession = null;
    }

    async function execute(command) {
        switch (command?.type) {
            case 'st.start_capture_session':
                startCaptureSession(command.payload);
                return;
            case 'st.stop_capture_session':
                stopCaptureSession();
                return;
            case 'backend.reserve_job':
                await runBackendRequest('reserve_job', command.payload.runId, async () => {
                    const requestPayload = await buildReservePayload(command.payload);
                    try {
                        const result = await startBackendJob(requestPayload);
                        await syncRetryLogForStatus(runtime, result.job ?? null, {
                            force: true,
                            clearWhenMissing: false,
                        });
                        machine.dispatch({
                            type: 'backend.reserve_succeeded',
                            payload: {
                                jobId: result.jobId,
                                status: result.job ?? null,
                            },
                        });
                    } catch (error) {
                        if (error?.status === 409 && error?.payload?.reason === 'job_running' && error?.payload?.job?.jobId) {
                            machine.dispatch({
                                type: 'backend.reserve_conflict_attached',
                                payload: {
                                    jobId: error.payload.job.jobId,
                                    status: error.payload.job,
                                },
                            });
                            return;
                        }
                        machine.dispatch({
                            type: 'backend.reserve_failed',
                            payload: {
                                error: getStructuredErrorFromApi(error, 'Retry Mobile could not reserve the backend job.'),
                            },
                        });
                    }
                });
                return;
            case 'backend.start_poll':
                startPollLoop(command.payload);
                return;
            case 'backend.stop_poll':
                abortFamily('poll', 'stop_poll');
                return;
            case 'native.await_readiness':
                startNativeReadiness(command.payload);
                return;
            case 'backend.confirm_native':
                await runBackendRequest('confirm_native', command.payload.runId, async () => {
                    try {
                        const result = await confirmNativeJob(command.payload.jobId, {
                            runId: command.payload.runId,
                            sessionId: runtime.sessionId || '',
                            assistantMessageIndex: command.payload.assistantMessageIndex,
                        });
                        machine.dispatch({
                            type: 'backend.native_confirm_succeeded',
                            payload: {
                                status: result.job ?? null,
                            },
                        });
                    } catch (error) {
                        machine.dispatch({
                            type: 'backend.native_confirm_failed',
                            payload: {
                                error: getStructuredErrorFromApi(error, 'Retry Mobile could not confirm the native assistant turn.'),
                                recoverable: true,
                                isConflict: error?.status === 409,
                            },
                        });
                    }
                });
                return;
            case 'backend.report_native_failure':
                await runBackendRequest('report_native_failure', command.payload.runId, async () => {
                    try {
                        const result = await reportNativeFailure(command.payload.jobId, {
                            runId: command.payload.runId,
                            sessionId: runtime.sessionId || '',
                            reason: command.payload.reason,
                            detail: command.payload.detail,
                        });
                        machine.dispatch({
                            type: 'backend.native_failure_reported',
                            payload: {
                                status: result.job ?? null,
                            },
                        });
                    } catch (error) {
                        machine.dispatch({
                            type: 'backend.native_confirm_failed',
                            payload: {
                                error: getStructuredErrorFromApi(error, 'Retry Mobile could not report the native wait outcome.'),
                                recoverable: true,
                            },
                        });
                    }
                });
                return;
            case 'backend.report_frontend_presence':
                await runBackendRequest('report_frontend_presence', command.payload.runId, async () => {
                    try {
                        const result = await reportFrontendPresence(command.payload.jobId, {
                            runId: command.payload.runId,
                            sessionId: runtime.sessionId || '',
                            visibilityState: command.payload.visibilityState,
                            at: command.payload.at || new Date().toISOString(),
                        });
                        if (result?.job) {
                            machine.dispatch({
                                type: 'backend.presence_acknowledged',
                                payload: {
                                    status: result.job,
                                },
                            });
                        }
                    } catch (error) {
                        machine.recordEvent(
                            'effects',
                            'frontend_presence_failed',
                            'Retry Mobile could not report frontend presence to the backend.',
                            getStructuredErrorFromApi(error, 'Retry Mobile could not report frontend presence.'),
                        );
                    }
                });
                return;
            case 'backend.cancel_job':
                await runBackendRequest('cancel_job', command.payload.runId, async () => {
                    try {
                        await cancelBackendJob(command.payload.jobId);
                    } catch (error) {
                        machine.dispatch({
                            type: 'backend.cancel_failed',
                            payload: {
                                error: getStructuredErrorFromApi(error, 'Retry Mobile could not send the backend cancel request.'),
                            },
                        });
                    }
                });
                return;
            case 'render.apply_accepted_output':
                await runRenderCommand('render', async (signal) => {
                    const result = await applyAcceptedOutput({
                        chatIdentity: command.payload.chatIdentity,
                        status: command.payload.status,
                        signal,
                    });
                    if (signal.aborted) return;
                    machine.dispatch({
                        type: result.ok ? 'render.accepted_output_applied' : 'render.accepted_output_failed',
                        payload: result.ok
                            ? {
                                jobId: result.jobId,
                                status: result.status,
                                targetMessageVersion: result.targetMessageVersion,
                            }
                            : {
                                error: result.error,
                                recoveryRequired: result.recoveryRequired,
                                status: command.payload.status,
                            },
                    });
                });
                return;
            case 'render.finish_terminal_ui':
                await runRenderCommand('render', async (signal) => {
                    const state = machine.getState();
                    const result = await finishTerminalUi({
                        outcome: command.payload.outcome,
                        status: command.payload.status,
                        chatIdentity: state.chatIdentity,
                        signal,
                    });
                    if (signal.aborted) return;
                    if (result.ok) {
                        if (lastToastedRunId !== command.payload.runId) {
                            lastToastedRunId = command.payload.runId;
                            showTerminalToast(command.payload.outcome);
                        }
                        machine.dispatch({
                            type: 'render.terminal_ui_finished',
                            payload: {
                                outcome: command.payload.outcome,
                            },
                        });
                        return;
                    }
                    machine.dispatch({
                        type: 'render.terminal_ui_failed',
                        payload: {
                            error: result.error,
                            recoveryRequired: result.recoveryRequired,
                            status: command.payload.status,
                        },
                    });
                });
                return;
            case 'recover.reconnect_status':
                await runRecoveryCommand(async (signal) => {
                    try {
                        const status = await recoverStatus(command.payload.chatIdentity, signal);
                        if (!status) {
                            clearRetryLog(runtime);
                            machine.dispatch(
                                command.payload.runId
                                    ? {
                                        type: 'recovery.failed',
                                        payload: {
                                            error: createStructuredError(
                                                'backend_job_missing',
                                                'Retry Mobile could not reattach to the active backend job.',
                                            ),
                                        },
                                    }
                                    : {
                                        type: 'recovery.empty',
                                        payload: {},
                                    },
                            );
                            return;
                        }

                        await syncRetryLogForStatus(runtime, status, {
                            force: true,
                            clearWhenMissing: false,
                        });
                        machine.dispatch({
                            type: 'recovery.completed',
                            payload: {
                                status,
                            },
                        });
                    } catch (error) {
                        if (signal.aborted) return;
                        machine.dispatch({
                            type: 'recovery.failed',
                            payload: {
                                error: normalizeStructuredError(error, 'handoff_request_failed'),
                            },
                        });
                    }
                });
                return;
            case 'render.refresh_chat':
                await runRenderCommand('render', async (signal) => {
                    const ok = await reloadSessionUi(signal);
                    if (signal.aborted) {
                        return;
                    }

                    if (!ok) {
                        machine.dispatch({
                            type: 'render.chat_refresh_failed',
                            payload: {
                                error: createStructuredError(
                                    'backend_write_failed',
                                    'Retry Mobile could not repair the chat view with a canonical reload.',
                                ),
                            },
                        });
                        return;
                    }

                    const context = getContext();
                    context?.activateSendButtons?.();
                    context?.swipe?.refresh?.(true);

                    if (command.payload.mode === 'terminal_ui') {
                        if (lastToastedRunId !== command.payload.runId) {
                            lastToastedRunId = command.payload.runId;
                            showTerminalToast(command.payload.outcome);
                        }
                        machine.dispatch({
                            type: 'render.terminal_ui_finished',
                            payload: {
                                outcome: command.payload.outcome,
                            },
                        });
                        return;
                    }

                    machine.dispatch({
                        type: 'render.chat_refresh_applied',
                        payload: {
                            status: command.payload.status || null,
                            targetMessageVersion: Number(command.payload.status?.targetMessageVersion) || 0,
                        },
                    });
                });
                return;
            default:
                return;
        }
    }

    function startCaptureSession(payload) {
        stopCaptureSession();
        captureSession = createArmCaptureSession({
            chatIdentity: payload.chatIdentity,
            onCapture: (result) => {
                machine.dispatch({
                    type: result?.ok ? 'capture.completed' : 'capture.failed',
                    payload: result?.ok
                        ? {
                            capturedRequest: result.capturedRequest,
                            fingerprint: result.fingerprint,
                            requestType: result.requestType,
                        }
                        : {
                            error: result?.error || createStructuredError('capture_missing_payload', 'Retry Mobile could not capture the native request payload.'),
                        },
                });
            },
            onCancel: (error) => {
                machine.dispatch({
                    type: 'capture.failed',
                    payload: {
                        error,
                    },
                });
            },
            onEvent: (event, summary) => {
                machine.recordEvent('st', event, summary);
            },
        });
    }

    function stopCaptureSession() {
        if (captureSession?.stop) {
            captureSession.stop();
        }
        captureSession = null;
    }

    function startPollLoop(payload) {
        abortFamily('poll', 'start_poll');
        const controller = createFamilyController('poll');
        const delayMs = cadenceToMs(payload.cadence);
        void (async () => {
            while (!controller.signal.aborted) {
                if (delayMs > 0) {
                    await delay(delayMs, controller.signal);
                }
                if (controller.signal.aborted) {
                    return;
                }

                try {
                    const status = await fetchJobStatus(payload.jobId);
                    await syncRetryLogForStatus(runtime, status, {
                        force: false,
                        clearWhenMissing: false,
                    });
                    if (controller.signal.aborted) {
                        return;
                    }
                    machine.dispatch({
                        type: 'backend.status_received',
                        payload: {
                            status,
                            pollSessionId: payload.pollSessionId,
                            runId: payload.runId,
                        },
                    });
                    if (isTerminalStatus(status)) {
                        return;
                    }
                } catch (error) {
                    if (controller.signal.aborted) {
                        return;
                    }
                    const kind = classifyPollFailure(error);
                    if (kind !== 'fatal') {
                        void logSoftWarning(
                            runtime,
                            'status_poll_warning',
                            'Frontend lost direct status polling and is trying to recover backend truth.',
                            {
                                kind,
                                jobId: payload.jobId,
                                message: error?.message || 'Retry Mobile status polling failed.',
                            },
                        );
                    }
                    machine.dispatch({
                        type: 'backend.status_failed',
                        payload: {
                            error: getStructuredErrorFromApi(error, 'Retry Mobile status polling failed.'),
                            kind,
                            pollSessionId: payload.pollSessionId,
                            runId: payload.runId,
                        },
                    });
                    return;
                }
            }
        })();
    }

    function startNativeReadiness(payload) {
        abortFamily('native', 'native_await_readiness');
        const controller = createFamilyController('native');
        void (async () => {
            try {
                const result = await waitForNativeCompletion({
                    fingerprint: payload.fingerprint,
                    nativeGraceSeconds: payload.nativeGraceSeconds,
                    signal: controller.signal,
                    onEvent: (event, summary) => {
                        machine.recordEvent('st', event, summary);
                    },
                });
                if (controller.signal.aborted) {
                    return;
                }
                if (result?.outcome === 'succeeded') {
                    machine.dispatch({
                        type: 'native.ready',
                        payload: {
                            assistantMessageIndex: result.assistantMessageIndex,
                            source: 'st-lifecycle',
                        },
                    });
                    return;
                }

                machine.dispatch({
                    type: 'native.failed',
                    payload: {
                        error: createStructuredError(
                            result?.reason || 'native_wait_timeout',
                            result?.message || 'Retry Mobile could not confirm the native assistant turn.',
                            result?.detail || '',
                        ),
                    },
                });
            } catch (error) {
                if (controller.signal.aborted) {
                    return;
                }
                machine.dispatch({
                    type: 'native.failed',
                    payload: {
                        error: normalizeStructuredError(error, 'native_wait_timeout'),
                    },
                });
            }
        })();
    }

    async function recoverStatus(identity, signal) {
        const result = await recoverBoundStatus({
            chatIdentity: identity,
            sessionId: runtime.sessionId || '',
            fetchStatus: fetchJobStatus,
            fetchActive: fetchActiveJob,
        });
        if (signal.aborted) {
            return null;
        }
        return result.status || null;
    }

    async function buildReservePayload(payload) {
        const context = getContext();
        const chatIdentity = chooseOperationalChatIdentity(
            payload.chatIdentity,
            payload.target?.chatIdentity,
            payload.targetFingerprint?.chatIdentity,
            getChatIdentity(context),
        );
        const chatState = await resolveExpectedPreviousGeneration(fetchChatState, chatIdentity);
        return {
            clientProtocolVersion: PROTOCOL_VERSION,
            runId: payload.runId,
            sessionId: runtime.sessionId || '',
            chatIdentity,
            runConfig: payload.runConfig,
            expectedPreviousGeneration: Number(chatState?.currentGeneration) || 0,
            nativeGraceSeconds: payload.nativeGraceSeconds,
            visibilityState: payload.visibilityState || document.visibilityState || 'visible',
            capturedChatIntegrity: String(context?.chatMetadata?.integrity || ''),
            capturedChatLength: Array.isArray(context?.chat) ? context.chat.length : 0,
            tokenizerDescriptor: buildTokenizerDescriptor(context),
            capturedRequest: payload.capturedRequest,
            targetFingerprint: payload.targetFingerprint,
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

    async function runBackendRequest(commandType, runId, fn) {
        const key = `${runId || 'runless'}:${commandType}`;
        if (inFlightRequests.has(key)) {
            machine.recordEvent('effects', 'deduped_command', `Skipped duplicate ${commandType} request.`, {
                commandType,
                runId,
            });
            return;
        }

        const promise = Promise.resolve().then(fn).finally(() => {
            inFlightRequests.delete(key);
        });
        inFlightRequests.set(key, promise);
        await promise;
    }

    async function runRenderCommand(family, fn) {
        abortFamily(family, 'render_preempt');
        const controller = createFamilyController(family);
        await fn(controller.signal);
    }

    async function runRecoveryCommand(fn) {
        abortFamily('recovery', 'recover_status');
        const controller = createFamilyController('recovery');
        await fn(controller.signal);
    }

    function createFamilyController(family) {
        const controller = new AbortController();
        familyControllers[family] = controller;
        return controller;
    }

    function abortFamily(family, reason = 'preempted') {
        const current = familyControllers[family];
        if (current) {
            current.abort();
            machine.recordEvent('effects', 'preempted_effect', `Preempted ${family} effect.`, {
                family,
                reason,
            });
        }
        familyControllers[family] = null;
    }
}

function classifyPollFailure(error) {
    const status = Number(error?.status);
    if (!Number.isFinite(status)) {
        return 'transient';
    }

    if (status === 429 || status === 502 || status === 503 || status === 504) {
        return 'transient';
    }

    if (status === 400 || status === 401 || status === 403 || status === 404) {
        return 'fatal';
    }

    return 'deferred';
}

function cadenceToMs(cadence) {
    switch (cadence) {
        case 'slow':
            return POLL_INTERVAL_SLOW_MS;
        case 'steady':
            return POLL_INTERVAL_STEADY_MS;
        default:
            return POLL_INTERVAL_FAST_MS;
    }
}

async function delay(ms, signal) {
    await new Promise((resolve) => {
        const handle = window.setTimeout(resolve, ms);
        signal?.addEventListener('abort', () => {
            window.clearTimeout(handle);
            resolve();
        }, { once: true });
    });
}

function showTerminalToast(outcome) {
    if (outcome === 'completed') {
        showToast('success', 'Retry Mobile', 'Retry Mobile finished this turn.');
        return;
    }
    if (outcome === 'cancelled') {
        showToast('info', 'Retry Mobile', 'Retry Mobile stopped.');
        return;
    }
    showToast('warning', 'Retry Mobile', 'Retry Mobile failed.');
}

async function logSoftWarning(runtime, event, summary, detail) {
    await sendFrontendLogEvent(runtime, {
        event,
        summary,
        detail,
    });
}
