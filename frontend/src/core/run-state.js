import { JOB_PHASE, RUN_STATE } from '../constants.js';

export function resolveRunStateFromStatus(status) {
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

export function formatStateLabel(state) {
    switch (state) {
        case JOB_PHASE.ARMED:
        case 'armed':
            return 'Armed for next qualifying request';
        case 'capturing':
            return 'Capturing request and starting backend handoff';
        case JOB_PHASE.RESERVING:
            return 'Reserving backend job';
        case JOB_PHASE.WAITING_NATIVE:
            return 'Waiting for native first reply';
        case JOB_PHASE.BACKEND_RUNNING:
        case 'running':
            return 'Retry loop active';
        case JOB_PHASE.STOPPING:
            return 'Stopping';
        case JOB_PHASE.COMPLETING:
            return 'Finishing UI';
        case JOB_PHASE.RECOVERING:
            return 'Recovering';
        case JOB_PHASE.COMPLETED:
            return 'Completed';
        case JOB_PHASE.FAILED:
            return 'Failed';
        case JOB_PHASE.CANCELLED:
            return 'Cancelled';
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

export function formatVisibleStateLabel(state, status, transport = 'healthy') {
    if (state === 'capturing') {
        return formatStateLabel(state);
    }

    if ((state === JOB_PHASE.RECOVERING || state === JOB_PHASE.BACKEND_RUNNING)
        && transport !== 'healthy') {
        return 'Reconnecting to backend';
    }

    if (state === JOB_PHASE.RECOVERING && !status) {
        return 'Reattaching to backend run';
    }

    if (!status) {
        return formatStateLabel(state);
    }

    switch (state) {
        case JOB_PHASE.RESERVING:
        case JOB_PHASE.WAITING_NATIVE:
        case JOB_PHASE.BACKEND_RUNNING:
        case JOB_PHASE.STOPPING:
        case JOB_PHASE.RECOVERING:
        case RUN_STATE.CAPTURED_PENDING_NATIVE:
        case RUN_STATE.NATIVE_CONFIRMED:
        case RUN_STATE.NATIVE_ABANDONED:
        case RUN_STATE.BACKEND_RUNNING:
            return status.phaseText || formatStateLabel(state);
        case JOB_PHASE.COMPLETED:
        case RUN_STATE.COMPLETED:
            return status.state === 'completed'
                ? (status.phaseText || formatStateLabel(state))
                : formatStateLabel(state);
        case JOB_PHASE.FAILED:
        case RUN_STATE.FAILED:
            return status.state === 'failed'
                ? (status.phaseText || formatStateLabel(state))
                : formatStateLabel(state);
        case JOB_PHASE.CANCELLED:
        case RUN_STATE.CANCELLED:
            return status.state === 'cancelled'
                ? (status.phaseText || formatStateLabel(state))
                : formatStateLabel(state);
        default:
            return formatStateLabel(state);
    }
}

export function isRunningLikeState(state) {
    return state === JOB_PHASE.ARMED
        || state === 'armed'
        || state === 'capturing'
        || state === 'running'
        || state === JOB_PHASE.RESERVING
        || state === JOB_PHASE.WAITING_NATIVE
        || state === JOB_PHASE.BACKEND_RUNNING
        || state === JOB_PHASE.STOPPING
        || state === JOB_PHASE.RECOVERING
        || state === JOB_PHASE.COMPLETING
        || state === RUN_STATE.ARMED
        || state === RUN_STATE.CAPTURED_PENDING_NATIVE
        || state === RUN_STATE.NATIVE_CONFIRMED
        || state === RUN_STATE.NATIVE_ABANDONED
        || state === RUN_STATE.BACKEND_RUNNING;
}
