import { createStructuredError, normalizeStructuredError } from '../retry-error.js';

export const JOB_PHASE = Object.freeze({
    IDLE: 'idle',
    ARMED: 'armed',
    RESERVING: 'reserving',
    WAITING_NATIVE: 'waiting_native',
    BACKEND_RUNNING: 'backend_running',
    STOPPING: 'stopping',
    COMPLETING: 'completing',
    RECOVERING: 'recovering',
    COMPLETED: 'completed',
    FAILED: 'failed',
    CANCELLED: 'cancelled',
});

export const RENDER_TASK = Object.freeze({
    IDLE: 'idle',
    APPLYING_OUTPUT: 'applying_output',
    FINISHING_UI: 'finishing_ui',
    RECOVERING_UI: 'recovering_ui',
});

export const VISIBILITY_STATE = Object.freeze({
    VISIBLE: 'visible',
    HIDDEN: 'hidden',
});

export const TRANSPORT_STATE = Object.freeze({
    HEALTHY: 'healthy',
    TRANSIENT_ERROR: 'transient_error',
    DEFERRED_DISCONNECT: 'deferred_disconnect',
});

export function createInitialJobState() {
    return {
        phase: JOB_PHASE.IDLE,
        chatIdentity: null,
        runId: null,
        jobId: null,
        pollSessionId: null,
        nativeDisposition: 'none',
        renderTask: RENDER_TASK.IDLE,
        visibility: typeof document !== 'undefined' && document.visibilityState === 'hidden'
            ? VISIBILITY_STATE.HIDDEN
            : VISIBILITY_STATE.VISIBLE,
        transport: TRANSPORT_STATE.HEALTHY,
        capturedRequest: null,
        captureFingerprint: null,
        assistantMessageIndex: null,
        activeStatus: null,
        lastAppliedVersion: 0,
        pendingStop: false,
        terminalOutcome: null,
        error: null,
        debugEvents: [],
        sequence: 0,
    };
}

export function isTerminalStatus(status) {
    return Boolean(status)
        && (status.state === 'completed'
            || status.state === 'failed'
            || status.state === 'cancelled');
}

export function isJobRunningLikePhase(phase) {
    return phase === JOB_PHASE.ARMED
        || phase === JOB_PHASE.RESERVING
        || phase === JOB_PHASE.WAITING_NATIVE
        || phase === JOB_PHASE.BACKEND_RUNNING
        || phase === JOB_PHASE.STOPPING
        || phase === JOB_PHASE.RECOVERING
        || phase === JOB_PHASE.COMPLETING;
}

export function reduceJobState(state, event, env) {
    const type = String(event?.type || '');
    const payload = event?.payload || {};
    const current = state || createInitialJobState();

    if (type === 'page.hidden') {
        return commit(current, current.phase, {
            visibility: VISIBILITY_STATE.HIDDEN,
        });
    }

    if (type === 'page.visible') {
        if (current.phase === JOB_PHASE.BACKEND_RUNNING && current.transport === TRANSPORT_STATE.DEFERRED_DISCONNECT) {
            return commit(current, JOB_PHASE.RECOVERING, {
                visibility: VISIBILITY_STATE.VISIBLE,
                renderTask: RENDER_TASK.RECOVERING_UI,
            }, [
                command('render.recover_session', {
                    runId: current.runId,
                    chatIdentity: current.chatIdentity,
                    reason: 'page_visible',
                }),
            ]);
        }

        return commit(current, current.phase, {
            visibility: VISIBILITY_STATE.VISIBLE,
        });
    }

    if ((type === 'window.focused' || type === 'network.online')
        && current.phase === JOB_PHASE.BACKEND_RUNNING
        && current.transport === TRANSPORT_STATE.DEFERRED_DISCONNECT) {
        return commit(current, JOB_PHASE.RECOVERING, {
            renderTask: RENDER_TASK.RECOVERING_UI,
        }, [
            command('render.recover_session', {
                runId: current.runId,
                chatIdentity: current.chatIdentity,
                reason: type,
            }),
        ]);
    }

    if (type === 'system.restore_requested') {
        const chatIdentity = payload.chatIdentity || env.getChatIdentity?.() || null;
        if (!isValidChatIdentity(chatIdentity)) {
            return ignored(current);
        }

        return commit(current, JOB_PHASE.RECOVERING, {
            chatIdentity,
            renderTask: RENDER_TASK.RECOVERING_UI,
            error: null,
        }, [
            command('render.recover_session', {
                runId: current.runId,
                chatIdentity,
                reason: payload.reason || 'boot',
            }),
        ]);
    }

    switch (current.phase) {
        case JOB_PHASE.IDLE:
        case JOB_PHASE.COMPLETED:
        case JOB_PHASE.FAILED:
        case JOB_PHASE.CANCELLED:
            if (type === 'user.arm_requested' && isValidChatIdentity(payload.chatIdentity)) {
                const runId = env.createRunId();
                return commit(current, JOB_PHASE.ARMED, {
                    chatIdentity: payload.chatIdentity,
                    runId,
                    jobId: null,
                    pollSessionId: null,
                    nativeDisposition: 'none',
                    renderTask: RENDER_TASK.IDLE,
                    transport: TRANSPORT_STATE.HEALTHY,
                    capturedRequest: null,
                    captureFingerprint: null,
                    assistantMessageIndex: null,
                    activeStatus: null,
                    lastAppliedVersion: 0,
                    pendingStop: false,
                    terminalOutcome: null,
                    error: null,
                }, [
                    command('st.start_capture_session', {
                        runId,
                        chatIdentity: payload.chatIdentity,
                    }),
                ]);
            }
            break;

        case JOB_PHASE.ARMED:
            if (type === 'capture.completed') {
                return commit(current, JOB_PHASE.RESERVING, {
                    capturedRequest: payload.capturedRequest,
                    captureFingerprint: payload.fingerprint,
                    assistantMessageIndex: null,
                    error: null,
                }, [
                    command('st.stop_capture_session', {
                        runId: current.runId,
                        reason: 'captured',
                    }),
                    command('backend.reserve_job', {
                        runId: current.runId,
                        chatIdentity: current.chatIdentity,
                        runConfig: buildRunConfig(env.runtime?.settings),
                        nativeGraceSeconds: Number(env.runtime?.settings?.nativeGraceSeconds) || 30,
                        capturedRequest: payload.capturedRequest,
                        targetFingerprint: payload.fingerprint,
                        captureMeta: buildCaptureMeta(env),
                    }),
                ]);
            }

            if (type === 'capture.failed') {
                return commit(current, JOB_PHASE.FAILED, {
                    capturedRequest: null,
                    captureFingerprint: null,
                    assistantMessageIndex: null,
                    error: normalizeStructuredError(payload.error, 'capture_missing_payload'),
                    terminalOutcome: 'failed',
                });
            }

            if (type === 'user.stop_requested') {
                return commit(current, JOB_PHASE.CANCELLED, {
                    capturedRequest: null,
                    captureFingerprint: null,
                    assistantMessageIndex: null,
                    pendingStop: false,
                    terminalOutcome: 'cancelled',
                }, [
                    command('st.stop_capture_session', {
                        runId: current.runId,
                        reason: 'cancelled',
                    }),
                ]);
            }
            break;

        case JOB_PHASE.RESERVING:
            if (type === 'backend.reserve_succeeded') {
                const pollSessionId = env.createPollSessionId(current.runId);
                return commit(current, JOB_PHASE.WAITING_NATIVE, {
                    jobId: payload.jobId,
                    activeStatus: payload.status,
                    nativeDisposition: 'pending',
                    pollSessionId,
                    error: null,
                }, [
                    command('backend.start_poll', {
                        runId: current.runId,
                        jobId: payload.jobId,
                        pollSessionId,
                        cadence: 'fast',
                    }),
                    command('native.await_readiness', {
                        runId: current.runId,
                        chatIdentity: current.chatIdentity,
                        fingerprint: current.captureFingerprint,
                        nativeGraceSeconds: Number(env.runtime?.settings?.nativeGraceSeconds) || 30,
                    }),
                ]);
            }

            if (type === 'backend.reserve_conflict_attached') {
                const pollSessionId = env.createPollSessionId(current.runId);
                return commit(current, JOB_PHASE.BACKEND_RUNNING, {
                    jobId: payload.jobId,
                    activeStatus: payload.status,
                    nativeDisposition: String(payload.status?.nativeState || 'none'),
                    pollSessionId,
                    error: null,
                }, [
                    command('backend.start_poll', {
                        runId: current.runId,
                        jobId: payload.jobId,
                        pollSessionId,
                        cadence: 'fast',
                    }),
                ]);
            }

            if (type === 'backend.reserve_failed') {
                return commit(current, JOB_PHASE.FAILED, {
                    jobId: null,
                    pollSessionId: null,
                    error: normalizeStructuredError(payload.error, 'handoff_request_failed'),
                    terminalOutcome: 'failed',
                });
            }

            if (type === 'user.stop_requested') {
                return commit(current, JOB_PHASE.STOPPING, {
                    pendingStop: true,
                });
            }
            break;

        case JOB_PHASE.WAITING_NATIVE:
            if (type === 'native.ready' && current.jobId) {
                return commit(current, JOB_PHASE.WAITING_NATIVE, {
                    assistantMessageIndex: payload.assistantMessageIndex,
                    error: null,
                }, [
                    command('backend.confirm_native', {
                        runId: current.runId,
                        jobId: current.jobId,
                        assistantMessageIndex: payload.assistantMessageIndex,
                    }),
                ]);
            }

            if (type === 'native.failed' && current.jobId) {
                const error = normalizeStructuredError(payload.error, 'native_wait_timeout');
                return commit(current, JOB_PHASE.WAITING_NATIVE, {
                    error,
                }, [
                    command('backend.report_native_failure', {
                        runId: current.runId,
                        jobId: current.jobId,
                        reason: error.code,
                        detail: error.detail || error.message,
                    }),
                ]);
            }

            if (type === 'backend.native_confirm_succeeded') {
                return commit(current, JOB_PHASE.BACKEND_RUNNING, {
                    activeStatus: payload.status,
                    nativeDisposition: 'confirmed',
                    error: null,
                });
            }

            if (type === 'backend.native_failure_reported') {
                return commit(current, JOB_PHASE.BACKEND_RUNNING, {
                    activeStatus: payload.status,
                    nativeDisposition: payload.status?.nativeState === 'abandoned' ? 'abandoned' : current.nativeDisposition,
                    error: null,
                });
            }

            if (type === 'backend.native_confirm_failed') {
                const error = normalizeStructuredError(payload.error, 'handoff_request_failed');
                return commit(current, JOB_PHASE.RECOVERING, {
                    error,
                    renderTask: RENDER_TASK.RECOVERING_UI,
                    transport: payload.recoverable ? TRANSPORT_STATE.DEFERRED_DISCONNECT : current.transport,
                }, [
                    command('backend.stop_poll', {
                        runId: current.runId,
                        pollSessionId: current.pollSessionId,
                        reason: 'native_confirm_failed',
                    }),
                    command('render.recover_session', {
                        runId: current.runId,
                        chatIdentity: current.chatIdentity,
                        reason: 'native_confirm_failed',
                    }),
                ]);
            }

            if (type === 'backend.status_received' && matchesCurrentPoll(current, payload)) {
                if (isTerminalStatus(payload.status)) {
                    return commit(current, JOB_PHASE.COMPLETING, {
                        activeStatus: payload.status,
                        nativeDisposition: String(payload.status?.nativeState || current.nativeDisposition),
                        renderTask: RENDER_TASK.FINISHING_UI,
                        terminalOutcome: payload.status.state,
                    }, [
                        command('backend.stop_poll', {
                            runId: current.runId,
                            pollSessionId: current.pollSessionId,
                            reason: 'terminal_status',
                        }),
                        command('render.finish_terminal_ui', {
                            runId: current.runId,
                            outcome: payload.status.state,
                            status: payload.status,
                            error: current.error,
                        }),
                    ]);
                }

                if (payload.status?.state === 'running'
                    && (payload.status?.nativeState === 'confirmed' || payload.status?.nativeState === 'abandoned')) {
                    return commit(current, JOB_PHASE.BACKEND_RUNNING, {
                        activeStatus: payload.status,
                        nativeDisposition: String(payload.status.nativeState),
                        error: null,
                    });
                }
            }

            if (type === 'backend.status_failed' && matchesCurrentPoll(current, payload)) {
                if (payload.kind === 'fatal' || payload.kind === 'deferred') {
                    return commit(current, JOB_PHASE.RECOVERING, {
                        error: normalizeStructuredError(payload.error, 'backend_polling_failed'),
                        transport: payload.kind === 'deferred' ? TRANSPORT_STATE.DEFERRED_DISCONNECT : current.transport,
                        renderTask: RENDER_TASK.RECOVERING_UI,
                    }, [
                        command('backend.stop_poll', {
                            runId: current.runId,
                            pollSessionId: current.pollSessionId,
                            reason: 'status_failed',
                        }),
                        command('render.recover_session', {
                            runId: current.runId,
                            chatIdentity: current.chatIdentity,
                            reason: 'status_failed',
                        }),
                    ]);
                }
            }

            if (type === 'user.stop_requested') {
                return commit(current, JOB_PHASE.STOPPING, {
                    pendingStop: true,
                }, [
                    command('backend.cancel_job', {
                        runId: current.runId,
                        jobId: current.jobId,
                    }),
                ]);
            }
            break;

        case JOB_PHASE.BACKEND_RUNNING:
            if (type === 'backend.status_received' && matchesCurrentPoll(current, payload)) {
                if (isTerminalStatus(payload.status)) {
                    return commit(current, JOB_PHASE.COMPLETING, {
                        activeStatus: payload.status,
                        nativeDisposition: String(payload.status?.nativeState || current.nativeDisposition),
                        renderTask: RENDER_TASK.FINISHING_UI,
                        terminalOutcome: payload.status.state,
                    }, [
                        command('backend.stop_poll', {
                            runId: current.runId,
                            pollSessionId: current.pollSessionId,
                            reason: 'terminal_status',
                        }),
                        command('render.finish_terminal_ui', {
                            runId: current.runId,
                            outcome: payload.status.state,
                            status: payload.status,
                            error: current.error,
                        }),
                    ]);
                }

                const targetVersion = Number(payload.status?.targetMessageVersion) || 0;
                if (targetVersion > Number(current.lastAppliedVersion || 0)) {
                    return commit(current, JOB_PHASE.BACKEND_RUNNING, {
                        activeStatus: payload.status,
                        renderTask: RENDER_TASK.APPLYING_OUTPUT,
                    }, [
                        command('render.apply_accepted_output', {
                            runId: current.runId,
                            jobId: current.jobId,
                            chatIdentity: current.chatIdentity,
                            status: payload.status,
                        }),
                    ]);
                }

                return commit(current, JOB_PHASE.BACKEND_RUNNING, {
                    activeStatus: payload.status,
                    nativeDisposition: payload.status?.nativeState
                        ? String(payload.status.nativeState)
                        : current.nativeDisposition,
                });
            }

            if (type === 'backend.status_failed' && matchesCurrentPoll(current, payload)) {
                if (payload.kind === 'transient') {
                    return commit(current, JOB_PHASE.BACKEND_RUNNING, {
                        transport: TRANSPORT_STATE.TRANSIENT_ERROR,
                    }, [
                        command('backend.start_poll', {
                            runId: current.runId,
                            jobId: current.jobId,
                            pollSessionId: current.pollSessionId,
                            cadence: 'slow',
                        }),
                    ]);
                }

                if (payload.kind === 'fatal' || payload.kind === 'deferred') {
                    return commit(current, JOB_PHASE.RECOVERING, {
                        error: normalizeStructuredError(payload.error, 'backend_polling_failed'),
                        transport: payload.kind === 'deferred'
                            ? TRANSPORT_STATE.DEFERRED_DISCONNECT
                            : current.transport,
                        renderTask: RENDER_TASK.RECOVERING_UI,
                    }, [
                        command('backend.stop_poll', {
                            runId: current.runId,
                            pollSessionId: current.pollSessionId,
                            reason: 'status_failed',
                        }),
                        command('render.recover_session', {
                            runId: current.runId,
                            chatIdentity: current.chatIdentity,
                            reason: 'status_failed',
                        }),
                    ]);
                }
            }

            if (type === 'user.stop_requested') {
                return commit(current, JOB_PHASE.STOPPING, {
                    pendingStop: true,
                }, [
                    command('backend.cancel_job', {
                        runId: current.runId,
                        jobId: current.jobId,
                    }),
                ]);
            }

            if ((type === 'page.visible' || type === 'window.focused' || type === 'network.online')
                && current.transport === TRANSPORT_STATE.DEFERRED_DISCONNECT) {
                return commit(current, JOB_PHASE.RECOVERING, {
                    renderTask: RENDER_TASK.RECOVERING_UI,
                }, [
                    command('render.recover_session', {
                        runId: current.runId,
                        chatIdentity: current.chatIdentity,
                        reason: type,
                    }),
                ]);
            }

            if (type === 'render.accepted_output_applied') {
                return commit(current, JOB_PHASE.BACKEND_RUNNING, {
                    lastAppliedVersion: Number(payload.targetMessageVersion) || current.lastAppliedVersion,
                    renderTask: RENDER_TASK.IDLE,
                    error: null,
                });
            }

            if (type === 'render.accepted_output_failed') {
                if (payload.recoveryRequired) {
                    return commit(current, JOB_PHASE.RECOVERING, {
                        error: normalizeStructuredError(payload.error, 'backend_write_failed'),
                        renderTask: RENDER_TASK.RECOVERING_UI,
                    }, [
                        command('render.recover_session', {
                            runId: current.runId,
                            chatIdentity: current.chatIdentity,
                            reason: 'accepted_output_failed',
                        }),
                    ]);
                }

                return commit(current, JOB_PHASE.BACKEND_RUNNING, {
                    error: normalizeStructuredError(payload.error, 'backend_write_failed'),
                    renderTask: RENDER_TASK.IDLE,
                });
            }
            break;

        case JOB_PHASE.STOPPING:
            if (type === 'backend.reserve_succeeded') {
                const pollSessionId = env.createPollSessionId(current.runId);
                return commit(current, JOB_PHASE.STOPPING, {
                    jobId: payload.jobId,
                    activeStatus: payload.status,
                    nativeDisposition: 'pending',
                    pollSessionId,
                    error: null,
                }, [
                    command('backend.start_poll', {
                        runId: current.runId,
                        jobId: payload.jobId,
                        pollSessionId,
                        cadence: 'fast',
                    }),
                    command('backend.cancel_job', {
                        runId: current.runId,
                        jobId: payload.jobId,
                    }),
                ]);
            }

            if (type === 'backend.reserve_conflict_attached') {
                const pollSessionId = env.createPollSessionId(current.runId);
                return commit(current, JOB_PHASE.STOPPING, {
                    jobId: payload.jobId,
                    activeStatus: payload.status,
                    nativeDisposition: String(payload.status?.nativeState || current.nativeDisposition),
                    pollSessionId,
                    error: null,
                }, [
                    command('backend.start_poll', {
                        runId: current.runId,
                        jobId: payload.jobId,
                        pollSessionId,
                        cadence: 'fast',
                    }),
                    command('backend.cancel_job', {
                        runId: current.runId,
                        jobId: payload.jobId,
                    }),
                ]);
            }

            if (type === 'backend.reserve_failed') {
                return commit(current, JOB_PHASE.CANCELLED, {
                    jobId: null,
                    pollSessionId: null,
                    renderTask: RENDER_TASK.IDLE,
                    pendingStop: false,
                    terminalOutcome: 'cancelled',
                });
            }

            if (type === 'backend.status_received' && matchesCurrentPoll(current, payload) && isTerminalStatus(payload.status)) {
                return commit(current, JOB_PHASE.COMPLETING, {
                    activeStatus: payload.status,
                    renderTask: RENDER_TASK.FINISHING_UI,
                    terminalOutcome: payload.status.state,
                    pendingStop: false,
                }, [
                    command('render.finish_terminal_ui', {
                        runId: current.runId,
                        outcome: payload.status.state,
                        status: payload.status,
                        error: current.error,
                    }),
                ]);
            }

            if (type === 'backend.status_received' && matchesCurrentPoll(current, payload)) {
                return commit(current, JOB_PHASE.STOPPING, {
                    activeStatus: payload.status,
                    nativeDisposition: payload.status?.nativeState
                        ? String(payload.status.nativeState)
                        : current.nativeDisposition,
                });
            }

            if (type === 'backend.cancel_failed' || type === 'backend.status_failed') {
                return commit(current, JOB_PHASE.RECOVERING, {
                    error: normalizeStructuredError(payload.error, 'handoff_request_failed'),
                    renderTask: RENDER_TASK.RECOVERING_UI,
                }, [
                    command('render.recover_session', {
                        runId: current.runId,
                        chatIdentity: current.chatIdentity,
                        reason: type,
                    }),
                ]);
            }
            break;

        case JOB_PHASE.RECOVERING:
            if (type === 'recovery.completed') {
                if (payload.status?.state === 'running') {
                    const pollSessionId = env.createPollSessionId(current.runId);
                    return commit(current, JOB_PHASE.BACKEND_RUNNING, {
                        activeStatus: payload.status,
                        jobId: payload.status.jobId || current.jobId,
                        nativeDisposition: String(payload.status?.nativeState || current.nativeDisposition),
                        renderTask: RENDER_TASK.IDLE,
                        error: null,
                        pollSessionId,
                    }, [
                        command('backend.start_poll', {
                            runId: current.runId,
                            jobId: payload.status.jobId || current.jobId,
                            pollSessionId,
                            cadence: 'fast',
                        }),
                    ]);
                }

                if (isTerminalStatus(payload.status)) {
                    return commit(current, JOB_PHASE.COMPLETING, {
                        activeStatus: payload.status,
                        renderTask: RENDER_TASK.FINISHING_UI,
                        terminalOutcome: payload.status.state,
                    }, [
                        command('render.finish_terminal_ui', {
                            runId: current.runId,
                            outcome: payload.status.state,
                            status: payload.status,
                            error: current.error,
                        }),
                    ]);
                }
            }

            if (type === 'recovery.empty') {
                return commit(createInitialJobState(), JOB_PHASE.IDLE, {
                    visibility: current.visibility,
                });
            }

            if (type === 'recovery.failed') {
                return commit(current, JOB_PHASE.FAILED, {
                    error: normalizeStructuredError(payload.error, 'handoff_request_failed'),
                    renderTask: RENDER_TASK.IDLE,
                    terminalOutcome: 'failed',
                });
            }
            break;

        case JOB_PHASE.COMPLETING:
            if (type === 'render.terminal_ui_finished') {
                const outcome = payload.outcome === 'cancelled'
                    ? JOB_PHASE.CANCELLED
                    : payload.outcome === 'failed'
                        ? JOB_PHASE.FAILED
                        : JOB_PHASE.COMPLETED;
                return commit(current, outcome, {
                    runId: null,
                    jobId: null,
                    pollSessionId: null,
                    capturedRequest: null,
                    captureFingerprint: null,
                    assistantMessageIndex: null,
                    renderTask: RENDER_TASK.IDLE,
                    pendingStop: false,
                    terminalOutcome: payload.outcome,
                });
            }

            if (type === 'render.terminal_ui_failed' && payload.recoveryRequired) {
                return commit(current, JOB_PHASE.RECOVERING, {
                    error: normalizeStructuredError(payload.error, 'backend_write_failed'),
                    renderTask: RENDER_TASK.RECOVERING_UI,
                }, [
                    command('render.recover_session', {
                        runId: current.runId,
                        chatIdentity: current.chatIdentity,
                        reason: 'terminal_ui_failed',
                    }),
                ]);
            }
            break;

        default:
            break;
    }

    return ignored(current);
}

function buildRunConfig(settings = {}) {
    return {
        runMode: settings.runMode,
        targetAcceptedCount: settings.targetAcceptedCount,
        maxAttempts: settings.maxAttempts,
        attemptTimeoutSeconds: settings.attemptTimeoutSeconds,
        validationMode: settings.validationMode,
        minTokens: settings.minTokens,
        minCharacters: settings.minCharacters,
        allowHeuristicTokenFallback: settings.allowHeuristicTokenFallback,
        notifyOnSuccess: settings.notifyOnSuccess,
        notifyOnComplete: settings.notifyOnComplete,
        vibrateOnSuccess: settings.vibrateOnSuccess,
        vibrateOnComplete: settings.vibrateOnComplete,
        notificationMessageTemplate: settings.notificationMessageTemplate,
    };
}

function buildCaptureMeta(env) {
    const context = env.getContext?.();
    return {
        capturedAt: new Date().toISOString(),
        assistantName: String(env.getChatIdentity?.()?.assistantName || 'Assistant'),
        userName: String(context?.name1 || context?.user_name || 'You'),
        userAvatar: String(context?.user_avatar || ''),
    };
}

function matchesCurrentPoll(state, payload) {
    if (!payload) {
        return false;
    }

    if (payload.runId && state.runId && payload.runId !== state.runId) {
        return false;
    }

    if (payload.pollSessionId && state.pollSessionId && payload.pollSessionId !== state.pollSessionId) {
        return false;
    }

    return true;
}

function isValidChatIdentity(identity) {
    return Boolean(identity?.chatId) && typeof identity?.chatId === 'string';
}

function commit(state, nextPhase, patch = {}, commands = []) {
    return {
        state: {
            ...state,
            ...patch,
            phase: nextPhase,
        },
        commands,
        ignored: false,
    };
}

function ignored(state) {
    return {
        state,
        commands: [],
        ignored: true,
    };
}

function command(type, payload) {
    return {
        type,
        payload,
    };
}
