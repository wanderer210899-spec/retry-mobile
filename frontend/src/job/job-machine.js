import { getChatIdentity, getContext } from '../st-context.js';
import { createInitialJobState, reduceJobState } from './job-reducer.js';
import { syncActiveRunBindingFromState } from './run-binding.js';

export function createJobMachine({ runtime, render }) {
    let state = createInitialJobState();
    let effects = null;
    let queued = [];
    let processing = false;

    return {
        attachEffects,
        getState,
        getSnapshot,
        dispatch,
        setError,
        clearError,
        recordEvent,
    };

    function attachEffects(nextEffects) {
        effects = nextEffects;
    }

    function getState() {
        return state;
    }

    function getSnapshot() {
        return state;
    }

    function dispatch(event) {
        queued.push(normalizeEvent(event));
        if (processing) {
            return;
        }

        processing = true;
        try {
            while (queued.length > 0) {
                const nextEvent = queued.shift();
                const before = state;
                const result = reduceJobState(state, nextEvent, createReducerEnv(runtime));
                if (!result.ignored) {
                    state = appendTransitionEvent(result.state, nextEvent, before);
                    syncRuntimeMirror(runtime, state);
                    render?.();
                    effects?.run(result.commands || []);
                } else {
                    state = appendDebugEvent(state, {
                        source: 'job',
                        event: 'ignored_event',
                        summary: `Ignored ${nextEvent.type} in ${state.phase}.`,
                        detail: nextEvent.payload || null,
                    });
                    syncRuntimeMirror(runtime, state);
                }
            }
        } finally {
            processing = false;
        }
    }

    function setError(error) {
        state = appendDebugEvent({
            ...state,
            error,
        }, {
            source: 'job',
            event: 'error',
            summary: error?.message || 'Retry Mobile failed.',
            detail: error || null,
        });
        syncRuntimeMirror(runtime, state);
        render?.();
    }

    function clearError() {
        state = {
            ...state,
            error: null,
        };
        syncRuntimeMirror(runtime, state);
        render?.();
    }

    function recordEvent(source, eventName, summary, detail = null) {
        state = appendDebugEvent(state, {
            source,
            event: eventName,
            summary,
            detail,
        });
        syncRuntimeMirror(runtime, state);
    }
}

function appendTransitionEvent(state, event, previousState) {
    const next = appendDebugEvent(state, {
        source: 'job',
        event: event.type,
        summary: `${previousState.phase} -> ${state.phase}`,
        detail: event.payload || null,
    });
    return next;
}

function appendDebugEvent(state, record) {
    const entry = {
        at: new Date().toISOString(),
        phase: state.phase,
        source: String(record.source || 'job'),
        event: String(record.event || 'event'),
        summary: String(record.summary || ''),
        detail: record.detail ?? null,
    };
    return {
        ...state,
        sequence: Number(state.sequence || 0) + 1,
        debugEvents: [entry, ...(state.debugEvents || [])].slice(0, 24),
    };
}

function syncRuntimeMirror(runtime, state) {
    runtime.activeJobId = state.jobId || null;
    runtime.activeJobStatus = state.activeStatus || null;
    runtime.activeJobStatusObservedAt = state.activeStatus?.updatedAt || null;
    runtime.lastAppliedVersion = Number(state.lastAppliedVersion) || 0;
    runtime.activeRunBinding = syncActiveRunBindingFromState(state);
}

function createReducerEnv(runtime) {
    return {
        runtime,
        createRunId() {
            if (globalThis.crypto?.randomUUID) {
                return globalThis.crypto.randomUUID();
            }
            return `rm-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
        },
        createPollSessionId(runId) {
            return `${runId || 'runless'}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
        },
        getContext,
        getChatIdentity,
        getSessionId() {
            return runtime.sessionId || '';
        },
    };
}

function normalizeEvent(event) {
    return {
        type: String(event?.type || 'unknown'),
        payload: event?.payload || {},
    };
}
