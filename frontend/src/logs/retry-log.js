import {
    POLL_INTERVAL_SLOW_MS,
    PROTOCOL_VERSION,
    RUN_STATE,
} from '../constants.js';
import { formatStructuredError, normalizeStructuredError } from '../retry-error.js';
import {
    formatStateLabel,
    formatVisibleStateLabel,
    isRunningLikeState,
    resolveRunStateFromStatus,
} from '../core/run-state.js';

export function getRetryLogContext(runtime, currentSnapshot = runtime.machine.getSnapshot()) {
    const shouldUseLastRun = (!runtime.activeJobStatus && isIdleLikeState(currentSnapshot?.state))
        && runtime.lastRunLog?.snapshot;

    if (shouldUseLastRun) {
        return runtime.lastRunLog;
    }

    return buildRetryLogContext(runtime, currentSnapshot);
}

export function rememberRunLog(runtime) {
    runtime.lastRunLog = buildRetryLogContext(runtime, runtime.machine.getSnapshot());
}

export function restoreLatestRunLog(runtime, status, fallbackIdentity) {
    runtime.activeJobId = null;
    runtime.activeJobStatus = null;
    runtime.activeJobStatusSource = 'none';
    runtime.activeJobStatusObservedAt = null;
    const restoredSource = status?.state === 'running'
        ? 'latest_restored_active'
        : 'latest_restored_terminal';
    runtime.lastRunLog = {
        status: cloneValue(status),
        snapshot: buildRestoredLogSnapshot(runtime, status, fallbackIdentity),
        statusSource: restoredSource,
        statusObservedAt: getStatusObservedAt(status),
        capabilities: cloneValue(runtime.capabilities),
        chatState: cloneValue(runtime.chatState),
    };
}

export function buildRetryLogFileName(status, snapshot = null) {
    const timestamp = sanitizeTimestampForFileName(
        status?.updatedAt
        || status?.createdAt
        || snapshot?.createdAt
        || new Date().toISOString(),
    );
    return `retry-mobile-log-${timestamp}.txt`;
}

export function formatRetryLogText(runtime, logContext = getRetryLogContext(runtime)) {
    const status = logContext?.status || null;
    const snapshot = logContext?.snapshot || buildLogSnapshot(runtime);
    const capabilities = logContext?.capabilities || runtime.capabilities || {};
    const chatState = logContext?.chatState || runtime.chatState || null;
    const statusSource = logContext?.statusSource || 'none';
    const statusObservedAt = logContext?.statusObservedAt || null;
    const diagnosis = buildRetryLogDiagnosis({
        status,
        snapshot,
        statusSource,
        statusObservedAt,
        capabilities,
        chatState,
    });
    const warnings = collectRetryLogWarnings({
        status,
        snapshot,
        statusSource,
        statusObservedAt,
        capabilities,
        chatState,
    });
    const latestAttempt = getLatestAttempt(status);
    const latestAttemptDuration = getAttemptDurationMs(latestAttempt);
    const orphanCount = Array.isArray(status?.orphanedAcceptedResults)
        ? status.orphanedAcceptedResults.length
        : Number(status?.orphanedAcceptedPreview?.count) || 0;
    const lines = [
        'Diagnosis:',
        `diagnosisCode: ${diagnosis.code}`,
        `diagnosis: ${diagnosis.message}`,
        `statusSource: ${statusSource}`,
        `statusObservedAt: ${statusObservedAt || 'none'}`,
        `statusAge: ${formatStatusAge(statusObservedAt)}`,
        `consistency: ${diagnosis.consistency}`,
        `frontendVisibility: ${snapshot?.frontendVisibility || 'unknown'}`,
        `frontendOnline: ${snapshot?.frontendOnline || 'unknown'}`,
        `lastTransportError: ${formatTransportErrorSummary(snapshot)}`,
        `transportErrorContext: ${formatTransportErrorContext(snapshot)}`,
        '',
        'Frontend Snapshot:',
        `runId: ${status?.runId || snapshot?.runId || 'none'}`,
        `frontendState: ${snapshot?.state || 'unknown'}`,
        `frontendLabel: ${formatVisibleStateLabel(snapshot?.state || RUN_STATE.IDLE, status)}`,
        `activeChat: ${formatChatIdentity(snapshot?.chatIdentity)}`,
        `ownsTurn: ${snapshot?.ownsTurn ? 'retry-mobile' : 'native'}`,
        `toggleMode: ${snapshot?.toggleMode || 'unknown'}`,
        `lastFrontendError: ${snapshot?.error ? formatStructuredError(snapshot.error) : 'none'}`,
        `lastNativeEvent: ${formatEventSummary(snapshot?.lastNativeEvent)}`,
        `lastBackendEvent: ${formatEventSummary(snapshot?.lastBackendEvent)}`,
        `frontendVisibility: ${snapshot?.frontendVisibility || 'unknown'}`,
        `frontendOnline: ${snapshot?.frontendOnline || 'unknown'}`,
        `lastTransportError: ${formatTransportErrorSummary(snapshot)}`,
        `transportErrorContext: ${formatTransportErrorContext(snapshot)}`,
        `disconnectPolicy: ${snapshot?.disconnectPolicy || 'none'}`,
        '',
        'Backend Snapshot:',
    ];

    if (!status) {
        lines.push('backend: no backend status is currently available for this run.');
    } else {
        lines.push(
            `jobId: ${status.jobId || 'none'}`,
            `state: ${status.state || 'unknown'}`,
            `phase: ${status.phase || 'unknown'}`,
            `phaseText: ${formatRetryPhase(status)}`,
            `accepted: ${Number(status.acceptedCount) || 0}/${Number(status.targetAcceptedCount) || 0}`,
            `attempts: ${Number(status.attemptCount) || 0}/${Number(status.maxAttempts) || 0}`,
            `targetMessageVersion: ${Number(status.targetMessageVersion) || 0}`,
            `nativeState: ${status.nativeState || 'unknown'}`,
            `nativeResolutionCause: ${status.nativeResolutionCause || 'none'}`,
            `nativeFailureHintedAt: ${status.nativeFailureHintedAt || 'none'}`,
            `recoveryMode: ${formatRecoveryMode(status.recoveryMode)}`,
            `assistantMessageIndex: ${status.assistantMessageIndex == null ? 'none' : (Number.isFinite(Number(status.assistantMessageIndex)) ? Number(status.assistantMessageIndex) : 'none')}`,
            `nativeGraceDeadlineAt: ${formatGraceDeadline(status.nativeGraceDeadline)}`,
            `nativeGraceExpired: ${isGraceDeadlineExpired(status?.nativeGraceDeadline) ? 'yes' : 'no'}`,
            `protocolVersion: ${Number(capabilities?.protocolVersion) || 0}`,
            `minSupportedProtocolVersion: ${Number(capabilities?.minSupportedProtocolVersion) || 0}`,
            `toggleCircuitBreaker: failureCount=${Number(chatState?.toggleFailureCount) || 0} | blocked=${Boolean(chatState?.toggleBlocked) ? 'yes' : 'no'}`,
            `nativeResolutionState: phase=${status.phase || 'unknown'} | inProgress=${status.phase === 'native_confirming_persisted' ? 'yes' : 'no'} | inspectionCount=${Number(status.inspectionAttempts) || 0} | graceDeadlineExpired=${isGraceDeadlineExpired(status?.nativeGraceDeadline) ? 'yes' : 'no'}`,
            `lastError: ${status.lastError || 'none'}`,
        );
    }

    lines.push(
        '',
        'Runtime Compatibility:',
        `nativeSaveSupport: ${Boolean(capabilities?.nativeSaveSupport) ? 'yes' : 'no'}`,
        `nativeSaveCompatibilityDetail: ${capabilities?.nativeSaveCompatibilityDetail || 'none'}`,
        `compatibilityCheckedAt: ${capabilities?.compatibilityCheckedAt || 'none'}`,
        `userDirectorySupport: ${capabilities?.userDirectorySupport == null ? 'unknown' : (capabilities.userDirectorySupport ? 'yes' : 'no')}`,
        `userDirectoryScanSupport: ${capabilities?.userDirectoryScanSupport == null ? 'unknown' : (capabilities.userDirectoryScanSupport ? 'yes' : 'no')}`,
        `termux: ${Boolean(capabilities?.termux) ? 'yes' : 'no'}`,
        `termuxCheckedAt: ${capabilities?.termuxCheckedAt || 'none'}`,
        '',
        'Attempt Summary:',
    );

    if (!latestAttempt) {
        lines.push('No attempts recorded yet.');
    } else {
        lines.push(
            `latestAttemptNumber: ${Number(latestAttempt?.attemptNumber) || 0}`,
            `outcome: ${latestAttempt?.outcome || 'unknown'}`,
            `reason: ${latestAttempt?.reason || 'none'}`,
            `message: ${latestAttempt?.message || 'none'}`,
            `attemptDurationMs: ${latestAttemptDuration == null ? 'none' : latestAttemptDuration}`,
            `characterCount: ${latestAttempt?.characterCount == null ? 'none' : latestAttempt.characterCount}`,
            `tokenCount: ${latestAttempt?.tokenCount == null ? 'none' : latestAttempt.tokenCount}`,
            `phase: ${latestAttempt?.phase || 'unknown'}`,
            `targetMessageVersion: ${latestAttempt?.targetMessageVersion == null ? 'none' : latestAttempt.targetMessageVersion}`,
            `timeoutFamily: ${classifyTimeoutFamily(latestAttempt, snapshot)}`,
        );
    }

    lines.push('', 'Attempts:');
    const attempts = Array.isArray(status?.attemptLog) ? status.attemptLog : [];
    if (attempts.length === 0) {
        lines.push('No attempts recorded yet.');
    } else {
        for (const entry of attempts) {
            lines.push(formatAttemptLogEntry(entry));
        }
    }

    lines.push('', 'Orphaned Accepted Outputs:');
    if (Array.isArray(status?.orphanedAcceptedResults) && status.orphanedAcceptedResults.length > 0) {
        lines.push(`count: ${status.orphanedAcceptedResults.length}`);
        lines.push(`likelyCause: ${findOrphanCause(status)}`);
        status.orphanedAcceptedResults.forEach((entry, index) => {
            lines.push(`orphan#${index + 1} | chars=${Number(entry?.characterCount) || 0} | tokens=${Number(entry?.tokenCount) || 0} | text=${String(entry?.text || '').slice(0, 200)}`);
        });
    } else if (orphanCount > 0) {
        lines.push(`count: ${orphanCount}`);
        lines.push(`likelyCause: ${findOrphanCause(status)}`);
        lines.push('detail: full orphan contents are not loaded in this snapshot.');
    } else {
        lines.push('count: 0');
    }

    lines.push('', 'Recent Events:');
    appendDebugEventLines(lines, snapshot);

    lines.push('', 'Warnings:');
    if (warnings.length === 0) {
        lines.push('none');
    } else {
        warnings.forEach((warning) => lines.push(warning));
    }

    return lines.join('\n');
}

function buildLogSnapshot(runtime, snapshot = runtime.machine.getSnapshot()) {
    return {
        ...cloneValue(snapshot),
        toggleMode: runtime.settings?.runMode || 'unknown',
        frontendVisibility: getFrontendVisibility(),
        frontendOnline: getFrontendOnline(),
        lastTransportError: runtime.lastTransportError || 'none',
        lastTransportEndpoint: runtime.lastTransportEndpoint || 'none',
        lastTransportErrorAt: runtime.lastTransportErrorAt || null,
        transportErrorContext: cloneValue(runtime.transportErrorContext),
        disconnectPolicy: runtime.disconnectPolicy || 'none',
    };
}

function buildRetryLogContext(runtime, currentSnapshot = runtime.machine.getSnapshot()) {
    const snapshot = buildLogSnapshot(runtime, currentSnapshot);
    const resolved = resolveLogBackendStatus(runtime, snapshot);
    return {
        status: resolved.status,
        snapshot,
        statusSource: resolved.source,
        statusObservedAt: resolved.observedAt,
        capabilities: cloneValue(runtime.capabilities),
        chatState: cloneValue(runtime.chatState),
    };
}

function resolveLogBackendStatus(runtime, snapshot = runtime.machine.getSnapshot()) {
    if (runtime.activeJobStatus?.jobId && isSameRunStatus(runtime, runtime.activeJobStatus, snapshot)) {
        return {
            status: runtime.activeJobStatus,
            source: runtime.activeJobStatusSource || 'live_active',
            observedAt: runtime.activeJobStatusObservedAt || getStatusObservedAt(runtime.activeJobStatus),
        };
    }

    if (runtime.lastKnownJobStatus?.jobId && isSameRunStatus(runtime, runtime.lastKnownJobStatus, snapshot)) {
        return {
            status: runtime.lastKnownJobStatus,
            source: 'cached_same_run',
            observedAt: runtime.lastKnownJobStatusAt || getStatusObservedAt(runtime.lastKnownJobStatus),
        };
    }

    return {
        status: null,
        source: 'none',
        observedAt: null,
    };
}

function buildRestoredLogSnapshot(runtime, status, fallbackIdentity) {
    const state = resolveHistoricalRunState(status);
    const restoredAt = status?.updatedAt || status?.createdAt || new Date().toISOString();
    const structuredError = status?.state === 'failed'
        ? normalizeStructuredError(
            status?.structuredError,
            'backend_write_failed',
            status?.lastError || 'The backend job failed.',
        )
        : null;

    return {
        state,
        runId: status?.runId || status?.jobId || null,
        activeRunId: null,
        pollSessionId: null,
        chatIdentity: status?.chatIdentity || fallbackIdentity || null,
        ownsTurn: false,
        error: structuredError,
        lastNativeEvent: buildRestoredNativeEvent(status, restoredAt),
        lastBackendEvent: {
            name: 'restored',
            summary: `Restored ${status?.state || 'previous'} backend job ${status?.jobId || 'unknown'}.`,
            at: restoredAt,
        },
        debugEvents: [
            {
                at: restoredAt,
                runId: status?.runId || status?.jobId || null,
                phase: state,
                source: 'backend',
                event: 'restored',
                summary: `Restored ${status?.state || 'previous'} backend job ${status?.jobId || 'unknown'} after page refresh.`,
                detail: null,
            },
        ],
        createdAt: status?.createdAt || restoredAt,
        toggleMode: runtime.settings?.runMode || 'unknown',
        frontendVisibility: getFrontendVisibility(),
        frontendOnline: getFrontendOnline(),
        lastTransportError: runtime.lastTransportError || 'none',
        lastTransportEndpoint: runtime.lastTransportEndpoint || 'none',
        lastTransportErrorAt: runtime.lastTransportErrorAt || null,
        transportErrorContext: cloneValue(runtime.transportErrorContext),
        disconnectPolicy: runtime.disconnectPolicy || 'none',
    };
}

function resolveHistoricalRunState(status) {
    if (status?.state === 'completed') {
        return RUN_STATE.COMPLETED;
    }

    if (status?.state === 'failed') {
        return RUN_STATE.FAILED;
    }

    if (status?.state === 'cancelled') {
        return RUN_STATE.CANCELLED;
    }

    return resolveRunStateFromStatus(status) || RUN_STATE.IDLE;
}

function buildRestoredNativeEvent(status, timestamp) {
    if (!status?.nativeState || status.nativeState === 'pending') {
        return null;
    }

    return {
        name: 'restored_native_state',
        summary: `Backend restored native state ${status.nativeState}.`,
        at: timestamp,
    };
}

function buildRetryLogDiagnosis(context) {
    const status = context?.status || null;
    const snapshot = context?.snapshot || null;
    const statusSource = context?.statusSource || 'none';

    if (status?.state === 'failed' && status?.structuredError?.code) {
        return {
            code: status.structuredError.code,
            message: status.structuredError.message || status.lastError || 'The backend job failed.',
            consistency: 'frontend and backend agree on a terminal backend failure',
        };
    }

    const latestAttempt = getLatestAttempt(status);
    if (latestAttempt?.reason === 'attempt_timeout' || latestAttempt?.outcome === 'timed_out') {
        return {
            code: 'retry_attempt_timed_out',
            message: latestAttempt.message || 'A backend retry attempt timed out.',
            consistency: statusSource === 'none'
                ? 'frontend-only timeout signal'
                : 'frontend and backend agree on retry-attempt timeout',
        };
    }

    const nativeTimeoutReason = getNativeTimeoutReason(snapshot);
    if (nativeTimeoutReason) {
        return {
            code: nativeTimeoutReason,
            message: formatNativeTimeoutMessage(nativeTimeoutReason),
            consistency: statusSource === 'none'
                ? 'frontend-only native wait signal'
                : 'frontend and backend both observed native wait trouble',
        };
    }

    if (statusSource === 'cached_same_run') {
        return {
            code: 'frontend_disconnected',
            message: 'The frontend lost live backend status and is showing the last known same-run backend snapshot.',
            consistency: 'frontend is using cached backend truth for this run',
        };
    }

    if (statusSource === 'latest_restored_terminal') {
        return {
            code: 'restored_terminal_run',
            message: 'This log is showing the last terminal backend snapshot restored after refresh.',
            consistency: 'restored backend truth from a previous page state',
        };
    }

    if (statusSource === 'latest_restored_active') {
        return {
            code: 'restored_active_run',
            message: 'This log is showing the latest backend snapshot restored for a still-active run.',
            consistency: 'restored backend truth for an active run',
        };
    }

    if (statusSource === 'none') {
        return {
            code: 'backend_snapshot_missing',
            message: 'No backend snapshot is currently available for this run.',
            consistency: 'frontend has no backend truth for this run',
        };
    }

    return {
        code: 'live_backend_ok',
        message: 'The log is using the current live backend snapshot for this run.',
        consistency: 'frontend and backend state are aligned',
    };
}

function collectRetryLogWarnings(context) {
    const status = context?.status || null;
    const snapshot = context?.snapshot || null;
    const statusSource = context?.statusSource || 'none';
    const statusObservedAt = context?.statusObservedAt || null;
    const capabilities = context?.capabilities || {};
    const chatState = context?.chatState || null;
    const warnings = [];

    if (isRunningLikeState(snapshot?.state) && statusSource === 'none') {
        warnings.push('frontend says the run is active, but no backend snapshot is available.');
    }

    if ((statusSource === 'cached_same_run' || String(statusSource).startsWith('latest_restored_')) && isStatusStale(statusObservedAt)) {
        warnings.push(`backend snapshot is stale (${formatStatusAge(statusObservedAt)} old).`);
    }

    if (Number(capabilities?.minSupportedProtocolVersion || 0) > Number(PROTOCOL_VERSION || 0)) {
        warnings.push(`frontend protocol ${PROTOCOL_VERSION} is below the backend minimum supported protocol ${capabilities.minSupportedProtocolVersion}.`);
    }

    if (chatState?.toggleBlocked) {
        warnings.push(`toggle circuit breaker is active after ${Number(chatState?.toggleFailureCount) || 0} recorded failure(s).`);
    }

    if (status?.nativeState === 'pending' && isGraceDeadlineExpired(status?.nativeGraceDeadline)) {
        warnings.push('native grace deadline expired while native resolution is still unresolved.');
    }

    if (String(statusSource).startsWith('latest_restored_') && snapshot?.state && status?.state === 'running' && !isRunningLikeState(snapshot.state)) {
        warnings.push('frontend snapshot and restored backend snapshot disagree about whether the run is still active.');
    }

    if (statusSource === 'none' && hasBackendEvidenceInEvents(snapshot)) {
        warnings.push('recent events show backend activity for this run, but no backend snapshot is currently selected.');
    }

    return warnings;
}

function getLatestAttempt(status) {
    const attempts = Array.isArray(status?.attemptLog) ? status.attemptLog : [];
    return attempts.length > 0 ? attempts[attempts.length - 1] : null;
}

function getAttemptDurationMs(entry) {
    const started = Date.parse(entry?.startedAt || '');
    const finished = Date.parse(entry?.finishedAt || '');
    if (!Number.isFinite(started) || !Number.isFinite(finished) || finished < started) {
        return null;
    }

    return finished - started;
}

function classifyTimeoutFamily(entry, snapshot) {
    if (entry?.reason === 'attempt_timeout' || entry?.outcome === 'timed_out') {
        return 'retry_attempt_timeout';
    }

    const nativeTimeoutReason = getNativeTimeoutReason(snapshot);
    if (nativeTimeoutReason) {
        return 'native_wait_timeout';
    }

    return 'none';
}

function getNativeTimeoutReason(snapshot) {
    const eventName = String(snapshot?.lastNativeEvent?.name || '');
    if (eventName === 'native_wait_timeout') {
        return 'native_wait_timed_out';
    }
    if (eventName === 'hidden_timeout') {
        return 'hidden_timeout';
    }
    if (eventName === 'native_wait_stalled') {
        return 'native_wait_stalled';
    }
    if (eventName === 'rendered_without_end') {
        return 'rendered_without_end';
    }
    return '';
}

function formatNativeTimeoutMessage(reason) {
    switch (reason) {
        case 'native_wait_timed_out':
            return 'The native first-reply wait timed out before the browser observed completion.';
        case 'hidden_timeout':
            return 'The browser stayed hidden during native completion long enough for Retry Mobile to stop waiting and defer to backend recovery.';
        case 'native_wait_stalled':
            return 'The native first-reply wait stalled without enough visible progress.';
        case 'rendered_without_end':
            return 'SillyTavern rendered the reply without emitting the expected native completion end event.';
        default:
            return 'The native first-reply wait did not finish cleanly.';
    }
}

function formatTransportErrorSummary(snapshot) {
    if (!snapshot?.lastTransportError || snapshot.lastTransportError === 'none') {
        return 'none';
    }

    const endpoint = snapshot?.lastTransportEndpoint && snapshot.lastTransportEndpoint !== 'none'
        ? ` @ ${snapshot.lastTransportEndpoint}`
        : '';
    const timestamp = snapshot?.lastTransportErrorAt ? ` @ ${snapshot.lastTransportErrorAt}` : '';
    return `${snapshot.lastTransportError}${endpoint}${timestamp}`;
}

function formatTransportErrorContext(snapshot) {
    const context = snapshot?.transportErrorContext;
    if (!context?.message) {
        return 'none';
    }

    return [
        `endpoint=${context.endpoint || 'unknown'}`,
        `message=${context.message || 'unknown'}`,
        `timestamp=${context.timestamp || 'unknown'}`,
        `visibility=${context.visibilityAtFailure || 'unknown'}`,
        `online=${context.onlineAtFailure || 'unknown'}`,
        `occurredDuring=${context.occurredDuring || 'unknown'}`,
    ].join(' | ');
}

function formatStatusAge(value) {
    const parsed = Date.parse(value || '');
    if (!Number.isFinite(parsed)) {
        return 'unknown';
    }

    return `${Math.max(0, Date.now() - parsed)}ms`;
}

function isStatusStale(value) {
    const parsed = Date.parse(value || '');
    return Number.isFinite(parsed) && (Date.now() - parsed) > (POLL_INTERVAL_SLOW_MS * 3);
}

function isGraceDeadlineExpired(value) {
    const parsed = Date.parse(value || '');
    return Number.isFinite(parsed) && parsed < Date.now();
}

function hasBackendEvidenceInEvents(snapshot) {
    const events = Array.isArray(snapshot?.debugEvents) ? snapshot.debugEvents : [];
    return events.some((entry) => entry?.source === 'backend' && entry?.event === 'status');
}

function findOrphanCause(status) {
    const attempts = Array.isArray(status?.attemptLog) ? status.attemptLog : [];
    const latestWriteFailure = [...attempts].reverse().find((entry) => entry?.reason);
    return latestWriteFailure?.reason || 'unknown';
}

function appendDebugEventLines(lines, snapshot) {
    const events = Array.isArray(snapshot?.debugEvents) ? snapshot.debugEvents : [];
    if (events.length === 0) {
        lines.push('No frontend run events recorded yet.');
        return;
    }

    for (const entry of events) {
        lines.push(formatDebugEventLine(entry));
    }
}

function formatDebugEventLine(entry) {
    const parts = [
        entry?.at || 'unknown-time',
        entry?.source || 'state',
        entry?.event || 'event',
    ];

    if (entry?.phase) {
        parts.push(`phase=${entry.phase}`);
    }
    if (entry?.summary) {
        parts.push(`summary=${entry.summary}`);
    }

    return parts.join(' | ');
}

function formatAttemptLogEntry(entry) {
    const parts = [
        `#${Number(entry?.attemptNumber) || 0}`,
        entry?.outcome || 'unknown',
    ];
    const durationMs = getAttemptDurationMs(entry);

    if (entry?.phase) {
        parts.push(`phase=${entry.phase}`);
    }
    if (entry?.reason) {
        parts.push(`reason=${entry.reason}`);
    }
    if (entry?.characterCount != null) {
        parts.push(`chars=${entry.characterCount}`);
    }
    if (entry?.tokenCount != null) {
        parts.push(`tokens=${entry.tokenCount}`);
    }
    if (entry?.targetMessageVersion != null) {
        parts.push(`version=${entry.targetMessageVersion}`);
    }
    if (entry?.targetMessageIndex != null) {
        parts.push(`index=${entry.targetMessageIndex}`);
    }
    if (entry?.startedAt) {
        parts.push(`started=${entry.startedAt}`);
    }
    if (entry?.finishedAt) {
        parts.push(`finished=${entry.finishedAt}`);
    }
    if (durationMs != null) {
        parts.push(`durationMs=${durationMs}`);
    }
    if (entry?.message) {
        parts.push(`message=${entry.message}`);
    }

    return parts.join(' | ');
}

function formatRetryPhase(status) {
    if (!status) {
        return 'No backend job is active.';
    }

    return status.phaseText || formatStateLabel(resolveRunStateFromStatus(status) || RUN_STATE.IDLE);
}

function formatRecoveryMode(recoveryMode) {
    switch (recoveryMode) {
        case 'top_up_existing':
            return 'Top up existing assistant turn';
        case 'reuse_empty_placeholder':
            return 'Reuse empty native placeholder';
        case 'create_missing_turn':
            return 'Create missing assistant turn';
        default:
            return 'none';
    }
}

function formatGraceDeadline(value) {
    return value || 'none';
}

function formatChatIdentity(identity) {
    if (!identity?.chatId) {
        return 'No chat bound';
    }

    return identity.groupId
        ? `${identity.chatId} (group ${identity.groupId})`
        : identity.chatId;
}

function formatEventSummary(eventRecord) {
    if (!eventRecord?.name) {
        return 'none';
    }

    return eventRecord.summary
        ? `${eventRecord.name}: ${eventRecord.summary}`
        : eventRecord.name;
}

function sanitizeTimestampForFileName(value) {
    const parsed = Date.parse(value || '');
    const safeIso = Number.isFinite(parsed)
        ? new Date(parsed).toISOString()
        : new Date().toISOString();
    return safeIso.replaceAll(':', '-');
}

function isSameRunStatus(runtime, status, snapshot = runtime.machine.getSnapshot()) {
    if (!status?.jobId) {
        return false;
    }

    const snapshotRunId = snapshot?.activeRunId || snapshot?.runId || '';
    return Boolean(
        (snapshotRunId && (status.runId === snapshotRunId || status.jobId === snapshotRunId))
        || (runtime.activeJobId && status.jobId === runtime.activeJobId),
    );
}

function isIdleLikeState(state) {
    return state === RUN_STATE.IDLE || state === RUN_STATE.ARMED;
}

function getFrontendVisibility() {
    return document.visibilityState === 'visible'
        ? 'visible'
        : 'hidden';
}

function getFrontendOnline() {
    if (typeof navigator?.onLine !== 'boolean') {
        return 'unknown';
    }

    return navigator.onLine ? 'online' : 'offline';
}

function getStatusObservedAt(status) {
    return status?.updatedAt || status?.createdAt || null;
}

function cloneValue(value) {
    return value == null
        ? value
        : JSON.parse(JSON.stringify(value));
}
