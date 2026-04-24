const STATE_LABELS = Object.freeze({
    armed: 'Armed for next qualifying request',
    capturing: 'Capturing request and starting backend handoff',
    reserving: 'Reserving backend job',
    waiting_native: 'Waiting for native first reply',
    running: 'Retry loop active',
    backend_running: 'Retry loop active',
    stopping: 'Stopping',
    completing: 'Finishing UI',
    recovering: 'Recovering',
    completed: 'Completed',
    failed: 'Failed',
    cancelled: 'Cancelled',
    captured_pending_native: 'Waiting for native first reply',
    native_confirmed: 'Native first reply confirmed',
    native_abandoned: 'Native abandoned, backend recovered the turn',
});

export function resolveRunStateFromStatus(status) {
    if (!status || status.state !== 'running') {
        return null;
    }

    if (status.nativeState === 'pending') {
        return 'captured_pending_native';
    }

    if (status.nativeState === 'confirmed') {
        return Number(status.attemptCount) > 0 || Number(status.acceptedCount) > 0
            ? 'backend_running'
            : 'native_confirmed';
    }

    if (status.nativeState === 'abandoned') {
        return Number(status.attemptCount) > 0 || Number(status.acceptedCount) > 0
            ? 'backend_running'
            : 'native_abandoned';
    }

    return 'backend_running';
}

export function formatStateLabel(state) {
    return STATE_LABELS[String(state || '').trim()] || 'Idle';
}

export function formatVisibleStateLabel(state, status, transport = 'healthy') {
    if (state === 'capturing') {
        return formatStateLabel(state);
    }

    if ((state === 'recovering' || state === 'running' || state === 'backend_running')
        && transport !== 'healthy') {
        return 'Reconnecting to backend';
    }

    if (state === 'recovering' && !status) {
        return 'Reattaching to backend run';
    }

    if (!status) {
        return formatStateLabel(state);
    }

    switch (state) {
        case 'reserving':
        case 'waiting_native':
        case 'running':
        case 'backend_running':
        case 'stopping':
        case 'recovering':
        case 'captured_pending_native':
        case 'native_confirmed':
        case 'native_abandoned':
            return status.phaseText || formatStateLabel(state);
        case 'completed':
        case 'failed':
        case 'cancelled':
            return status.state === state
                ? (status.phaseText || formatStateLabel(state))
                : formatStateLabel(state);
        default:
            return formatStateLabel(state);
    }
}

export function isRunningLikeState(state) {
    return state === 'armed'
        || state === 'capturing'
        || state === 'running'
        || state === 'reserving'
        || state === 'waiting_native'
        || state === 'backend_running'
        || state === 'stopping'
        || state === 'recovering'
        || state === 'completing'
        || state === 'captured_pending_native'
        || state === 'native_confirmed'
        || state === 'native_abandoned';
}
