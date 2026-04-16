import { DEBUG_EVENT_LIMIT, RUN_STATE } from './constants.js';

export function createStateMachine() {
    let transitionCounter = 0;
    let snapshot = createSnapshot();

    return {
        getSnapshot,
        startRun,
        transition,
        releaseRun,
        setError,
        clearError,
        setNativeEvent,
        setBackendEvent,
        setOwnsTurn,
        startPollSession,
        clearPollSession,
        isCurrentRun,
        isCurrentPollSession,
        recordEvent,
    };

    function getSnapshot() {
        return snapshot;
    }

    function startRun(patch = {}) {
        const runId = patch.runId || createRunId();
        const debugEvents = [];
        snapshot = {
            ...createSnapshot(),
            runId,
            activeRunId: runId,
            state: RUN_STATE.ARMED,
            chatIdentity: patch.chatIdentity ?? null,
            debugEvents,
            createdAt: new Date().toISOString(),
        };
        recordEvent('state', 'run_started', 'Retry Mobile armed for the next qualifying generation.', {
            runId,
        });
        return snapshot;
    }

    function transition(nextState, patch = {}) {
        const previousState = snapshot.state;
        snapshot = {
            ...snapshot,
            ...patch,
            state: nextState,
        };
        transitionCounter += 1;
        recordEvent('state', 'transition', `${previousState} -> ${nextState}`, {
            transition: transitionCounter,
        });
        return snapshot;
    }

    function releaseRun() {
        snapshot = {
            ...snapshot,
            activeRunId: null,
            pollSessionId: null,
            ownsTurn: false,
        };
        return snapshot;
    }

    function setError(error, patch = {}) {
        snapshot = {
            ...snapshot,
            ...patch,
            error,
        };
        if (error) {
            recordEvent('state', 'error', `${error.code}: ${error.message}`, {
                detail: error.detail || '',
            });
        }
        return snapshot;
    }

    function clearError() {
        snapshot = {
            ...snapshot,
            error: null,
        };
        return snapshot;
    }

    function setNativeEvent(name, summary = '') {
        snapshot = {
            ...snapshot,
            lastNativeEvent: {
                name: String(name || ''),
                summary: String(summary || ''),
                at: new Date().toISOString(),
            },
        };
        return snapshot;
    }

    function setBackendEvent(name, summary = '') {
        snapshot = {
            ...snapshot,
            lastBackendEvent: {
                name: String(name || ''),
                summary: String(summary || ''),
                at: new Date().toISOString(),
            },
        };
        return snapshot;
    }

    function setOwnsTurn(value) {
        snapshot = {
            ...snapshot,
            ownsTurn: Boolean(value),
        };
        return snapshot;
    }

    function startPollSession() {
        const pollSessionId = `${snapshot.runId || 'runless'}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
        snapshot = {
            ...snapshot,
            pollSessionId,
        };
        recordEvent('state', 'poll_started', 'Started backend polling session.', {
            pollSessionId,
        });
        return pollSessionId;
    }

    function clearPollSession(pollSessionId = snapshot.pollSessionId) {
        if (!pollSessionId || snapshot.pollSessionId !== pollSessionId) {
            return snapshot;
        }

        snapshot = {
            ...snapshot,
            pollSessionId: null,
        };
        recordEvent('state', 'poll_stopped', 'Stopped backend polling session.', {
            pollSessionId,
        });
        return snapshot;
    }

    function isCurrentRun(runId) {
        return Boolean(runId) && snapshot.activeRunId === runId;
    }

    function isCurrentPollSession(pollSessionId) {
        return Boolean(pollSessionId) && snapshot.pollSessionId === pollSessionId;
    }

    function recordEvent(source, eventName, summary, detail = null) {
        const nextRecord = {
            at: new Date().toISOString(),
            runId: snapshot.runId || null,
            phase: snapshot.state,
            source: String(source || 'state'),
            event: String(eventName || 'event'),
            summary: String(summary || ''),
            detail,
        };

        snapshot = {
            ...snapshot,
            debugEvents: [
                nextRecord,
                ...(snapshot.debugEvents || []),
            ].slice(0, DEBUG_EVENT_LIMIT),
        };
        return nextRecord;
    }
}

function createSnapshot() {
    return {
        state: RUN_STATE.IDLE,
        runId: null,
        activeRunId: null,
        pollSessionId: null,
        chatIdentity: null,
        ownsTurn: false,
        error: null,
        lastNativeEvent: null,
        lastBackendEvent: null,
        debugEvents: [],
        createdAt: null,
    };
}

function createRunId() {
    if (globalThis.crypto?.randomUUID) {
        return globalThis.crypto.randomUUID();
    }

    return `rm-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}
