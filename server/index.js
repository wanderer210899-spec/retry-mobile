const crypto = require('node:crypto');

const {
    confirmNativeAssistant,
    resolvePendingNativeState,
    runJob,
    waitForNativeResolutionIdle,
} = require('./job-runner');
const { inspectRecoverySnapshot } = require('./chat-writer');
const { debugNotifier, getTermuxStatus, refreshTermuxStatusForStart } = require('./notifier');
const { PLUGIN_ID, PLUGIN_NAME } = require('./plugin-meta');
const { createStructuredError, toStructuredError } = require('./retry-error');
const {
    advanceGeneration,
    configureJobStore,
    getCircuitBreakerState,
    getCurrentGeneration,
    loadPersistedJobSnapshots,
    pruneTerminalJobUnits,
    writeJobSnapshot,
} = require('./job-store');
const {
    getCompatibilitySnapshot,
    getUserDirectories,
    getUserDirectoriesList,
    initializeStRuntime,
} = require('./st-runtime');
const { getReleaseInfo } = require('./update-info');
const {
    buildChatKey,
    createJob,
    getJob,
    getJobByChat,
    getLatestJobByChat,
    serializeJob,
    setPersistenceHandler,
    touchJob,
} = require('./state');
const { validateRunConfig } = require('./validation');

const PROTOCOL_VERSION = 4;
const MIN_SUPPORTED_PROTOCOL_VERSION = 4;
const NATIVE_RESOLUTION_WAIT_MS = 2500;
const ALLOWED_NATIVE_FAILURE_REASONS = new Set([
    'hidden_timeout',
    'native_wait_timeout',
    'native_wait_stalled',
    'rendered_without_end',
    'grace_expired',
]);

const bootState = {
    ready: false,
    promise: null,
};

async function init(router) {
    await ensureBackendReady();

    router.get('/capabilities', (_request, response) => {
        const termux = getTermuxStatus();
        const compatibility = getCompatibilitySnapshot();
        return response.send({
            protocolVersion: PROTOCOL_VERSION,
            minSupportedProtocolVersion: MIN_SUPPORTED_PROTOCOL_VERSION,
            nativeSaveSupport: compatibility.nativeSaveSupport,
            nativeSaveCompatibilityDetail: compatibility.detail,
            compatibilityCheckedAt: compatibility.checkedAt,
            userDirectorySupport: compatibility.userDirectorySupport,
            userDirectoryScanSupport: compatibility.userDirectoryScanSupport,
            termux: Boolean(termux.available),
            termuxCheckedAt: termux.checkedAt,
        });
    });

    router.get('/state', async (request, response) => {
        try {
            const identity = getChatIdentityFromRequest(request);
            if (!identity?.chatId) {
                return response.status(400).send({
                    error: 'Missing chat identity query.',
                });
            }

            const { handle, directories } = getUserContext(request);
            const chatKey = buildChatKey(identity);
            const generation = getCurrentGeneration(handle, directories, chatKey);
            const breaker = getCircuitBreakerState(handle, directories, chatKey);
            const termux = getTermuxStatus();
            return response.send({
                chatKey,
                currentGeneration: generation,
                toggleFailureCount: breaker.count,
                toggleBlocked: breaker.blocked,
                termux: Boolean(termux.available),
                termuxCheckedAt: termux.checkedAt,
            });
        } catch (error) {
            return response.status(500).send({
                error: error instanceof Error ? error.message : String(error),
            });
        }
    });

    router.get('/active', (request, response) => {
        const identity = getChatIdentityFromRequest(request);
        if (!identity?.chatId) {
            return response.send({});
        }

        const existing = getJobByChat(identity);
        return response.send(existing ? serializeJob(existing) : {});
    });

    router.get('/latest', (request, response) => {
        const identity = getChatIdentityFromRequest(request);
        if (!identity?.chatId) {
            return response.send({});
        }

        const latest = getLatestJobByChat(identity);
        return response.send(latest ? serializeJob(latest) : {});
    });

    router.get('/status/:jobId', (request, response) => {
        const job = getJob(request.params.jobId);
        if (!job) {
            const structuredError = toStructuredError(createStructuredError(
                'backend_job_missing',
                'Retry Mobile could not find the requested backend job.',
            ));
            return response.status(404).send({
                error: structuredError.message,
                structuredError,
            });
        }

        return response.send(serializeJob(job));
    });

    router.get('/orphans/:jobId', (request, response) => {
        const job = getJob(request.params.jobId);
        if (!job) {
            const structuredError = toStructuredError(createStructuredError(
                'backend_job_missing',
                'Retry Mobile could not find the requested backend job.',
            ));
            return response.status(404).send({
                error: structuredError.message,
                structuredError,
            });
        }

        return response.send({
            jobId: job.jobId,
            count: Array.isArray(job.orphanedAcceptedResults) ? job.orphanedAcceptedResults.length : 0,
            items: Array.isArray(job.orphanedAcceptedResults) ? job.orphanedAcceptedResults : [],
        });
    });

    router.get('/debug-notifier', async (request, response) => {
        try {
            const includeProbes = request.query?.includeProbes !== 'false';
            const result = await debugNotifier({ includeProbes });
            return response.send(result);
        } catch (error) {
            return response.status(500).send({ error: error.message });
        }
    });

    router.get('/release-info', async (request, response) => {
        try {
            const info = await getReleaseInfo(request);
            return response.send(info);
        } catch (error) {
            console.error('[retry-mobile:backend] Release info failed:', error);
            return response.status(500).send({
                error: error instanceof Error ? error.message : String(error),
            });
        }
    });

    router.post('/start', async (request, response) => {
        try {
            const protocolValidation = validateProtocol(request.body?.clientProtocolVersion);
            if (!protocolValidation.ok) {
                return response.status(409).send(protocolValidation.payload);
            }

            const compatibility = getCompatibilitySnapshot();
            if (!compatibility.nativeSaveSupport) {
                const structuredError = toStructuredError(createStructuredError(
                    'native_save_unavailable',
                    'Retry Mobile cannot start because SillyTavern chat-save compatibility is unavailable.',
                    compatibility.detail,
                ));
                return response.status(409).send({
                    error: structuredError.message,
                    structuredError,
                });
            }

            if (!request.body?.chatIdentity || !request.body?.capturedRequest || !request.body?.runConfig || !request.body?.targetFingerprint) {
                const structuredError = toStructuredError(createStructuredError(
                    'handoff_request_failed',
                    'Missing required start payload fields.',
                ));
                return response.status(400).send({
                    error: structuredError.message,
                    structuredError,
                });
            }

            const runConfigValidation = validateRunConfig(request.body.runConfig);
            if (!runConfigValidation.ok) {
                const structuredError = toStructuredError(createStructuredError(
                    runConfigValidation.code,
                    runConfigValidation.message,
                ));
                return response.status(400).send({
                    error: structuredError.message,
                    structuredError,
                });
            }

            const identity = request.body.chatIdentity;
            const chatKey = buildChatKey(identity);
            const { handle, directories } = getUserContext(request);
            const currentGeneration = getCurrentGeneration(handle, directories, chatKey);
            const existing = getJobByChat(identity);

            if (existing) {
                const structuredError = toStructuredError(createStructuredError(
                    'handoff_request_failed',
                    'A Retry Mobile job is already running for this chat.',
                ));
                return response.status(409).send({
                    error: structuredError.message,
                    structuredError,
                    reason: 'job_running',
                    job: serializeJob(existing),
                });
            }

            const expectedPreviousGeneration = Number.isFinite(Number(request.body.expectedPreviousGeneration))
                ? Number(request.body.expectedPreviousGeneration)
                : 0;
            if (expectedPreviousGeneration !== currentGeneration) {
                const structuredError = toStructuredError(createStructuredError(
                    'handoff_request_failed',
                    'Another Retry Mobile session already advanced this chat to a newer generation.',
                ));
                return response.status(409).send({
                    error: structuredError.message,
                    structuredError,
                    reason: 'rearm_race',
                    currentGeneration,
                    job: null,
                });
            }

            const breaker = getCircuitBreakerState(handle, directories, chatKey);
            const normalizedRunConfig = normalizeRunConfig(request.body.runConfig);
            const generationNumber = advanceGeneration(handle, directories, chatKey);
            const termux = refreshTermuxStatusForStart();
            const nativeGraceSeconds = normalizeNativeGraceSeconds(request.body.nativeGraceSeconds);
            const job = createJob({
                jobId: crypto.randomUUID(),
                runId: typeof request.body.runId === 'string' && request.body.runId
                    ? request.body.runId
                    : crypto.randomUUID(),
                chatIdentity: identity,
                chatKey,
                targetAcceptedCount: normalizedRunConfig.targetAcceptedCount,
                maxAttempts: normalizedRunConfig.maxAttempts,
                runConfig: normalizedRunConfig,
                capturedRequest: request.body.capturedRequest,
                captureMeta: request.body.captureMeta || {},
                targetFingerprint: request.body.targetFingerprint,
                acceptedCount: 0,
                attemptCount: 0,
                generationNumber,
                expectedPreviousGeneration,
                nativeState: 'pending',
                phase: 'pending_native',
                nativeGraceSeconds,
                nativeGraceDeadline: new Date(Date.now() + (nativeGraceSeconds * 1000)).toISOString(),
                capturedChatIntegrity: typeof request.body.capturedChatIntegrity === 'string'
                    ? request.body.capturedChatIntegrity
                    : '',
                capturedChatLength: Number.isFinite(Number(request.body.capturedChatLength))
                    ? Number(request.body.capturedChatLength)
                    : 0,
                tokenizerDescriptor: request.body.tokenizerDescriptor ?? null,
                userContext: {
                    handle,
                    directories,
                },
                lastError: breaker.blocked && normalizedRunConfig.runMode === 'toggle'
                    ? 'Toggle mode circuit breaker is active for this chat.'
                    : '',
            });

            void runJob(job, {
                baseUrl: getRequestBaseUrl(request),
            });

            return response.send({
                ok: true,
                jobId: job.jobId,
                job: serializeJob(job),
                protocolVersion: PROTOCOL_VERSION,
                currentGeneration: generationNumber,
                toggleFailureCount: breaker.count,
                toggleBlocked: breaker.blocked,
                termux: Boolean(termux.available),
                termuxCheckedAt: termux.checkedAt,
            });
        } catch (error) {
            console.error('[retry-mobile:backend] Start failed:', error);
            const structuredError = toStructuredError(error, 'handoff_request_failed', 'Retry Mobile could not start the backend job.');
            return response.status(500).send({
                error: structuredError.message,
                structuredError,
            });
        }
    });

    router.post('/confirm-native/:jobId', async (request, response) => {
        try {
            const job = getJob(request.params.jobId);
            if (!job) {
                return response.status(404).send(buildMissingJobResponse());
            }

            const runIdMismatch = getRunIdMismatchError(job, request.body?.runId, 'The native confirmation did not match the active Retry Mobile run.');
            if (runIdMismatch) {
                return response.status(409).send(runIdMismatch);
            }

            if (job.state !== 'running') {
                return response.status(409).send(buildConflictResponse(
                    job,
                    'The backend job is no longer running.',
                ));
            }

            if (job.nativeResolutionInProgress) {
                const resolved = await waitForNativeResolutionIdle(job, NATIVE_RESOLUTION_WAIT_MS);
                if (job.nativeState === 'confirmed') {
                    return response.send({
                        ok: true,
                        job: serializeJob(job),
                    });
                }

                if (job.nativeState === 'abandoned') {
                    return response.status(409).send(buildConflictResponse(
                        job,
                        'The backend already recovered this native turn before frontend confirmation arrived.',
                    ));
                }

                if (!resolved && job.nativeResolutionInProgress) {
                    return response.status(409).send(buildConflictResponse(
                        job,
                        'Native resolution is still in progress. Retry Mobile will reconcile this run from backend status.',
                    ));
                }
            }

            if (job.nativeState === 'abandoned') {
                return response.status(409).send(buildConflictResponse(
                    job,
                    'The backend already recovered this native turn before frontend confirmation arrived.',
                ));
            }

            if (job.nativeState === 'confirmed') {
                return response.send({
                    ok: true,
                    job: serializeJob(job),
                });
            }

            await confirmNativeAssistant(job, request.body?.assistantMessageIndex);
            return response.send({
                ok: true,
                job: serializeJob(job),
            });
        } catch (error) {
            console.error('[retry-mobile:backend] Native confirm failed:', error);
            const structuredError = toStructuredError(error, 'handoff_request_failed', 'Retry Mobile could not confirm the native turn on the backend.');
            return response.status(500).send({
                error: structuredError.message,
                structuredError,
            });
        }
    });

    router.post('/native-failed/:jobId', async (request, response) => {
        try {
            const job = getJob(request.params.jobId);
            if (!job) {
                return response.status(404).send(buildMissingJobResponse());
            }

            const runIdMismatch = getRunIdMismatchError(job, request.body?.runId, 'The native failure hint did not match the active Retry Mobile run.');
            if (runIdMismatch) {
                return response.status(409).send(runIdMismatch);
            }

            if (job.state !== 'running') {
                return response.status(409).send(buildConflictResponse(
                    job,
                    'The backend job is no longer running.',
                ));
            }

            const reason = String(request.body?.reason || '').trim();
            if (!ALLOWED_NATIVE_FAILURE_REASONS.has(reason)) {
                const structuredError = toStructuredError(createStructuredError(
                    'handoff_request_failed',
                    'Retry Mobile received an unknown native failure reason.',
                    reason,
                ));
                return response.status(400).send({
                    error: structuredError.message,
                    structuredError,
                });
            }

            touchJob(job, {
                nativeResolutionCause: reason,
                nativeFailureHintedAt: new Date().toISOString(),
            });
            await resolvePendingNativeState(job, reason);
            return response.send({
                ok: true,
                job: serializeJob(job),
            });
        } catch (error) {
            console.error('[retry-mobile:backend] Native failure hint failed:', error);
            const structuredError = toStructuredError(error, 'handoff_request_failed', 'Retry Mobile could not process the native failure hint.');
            return response.status(500).send({
                error: structuredError.message,
                structuredError,
            });
        }
    });

    router.post('/cancel/:jobId', async (request, response) => {
        const job = getJob(request.params.jobId);
        if (!job) {
            return response.status(404).send(buildMissingJobResponse());
        }

        touchJob(job, {
            cancelRequested: true,
            lastError: 'Retry Mobile cancellation requested.',
        });
        job.jobController?.abort?.();
        return response.send({
            ok: true,
            job: serializeJob(job),
        });
    });
}

async function ensureBackendReady() {
    if (bootState.ready) {
        return;
    }

    if (bootState.promise) {
        await bootState.promise;
        return;
    }

    bootState.promise = (async () => {
        const compatibility = await initializeStRuntime();
        configureJobStore({
            getUserDirectories,
            getUserDirectoriesList,
        });
        setPersistenceHandler(writeJobSnapshot);
        if (compatibility.userDirectoryScanSupport) {
            await restorePersistedJobs();
        } else {
            console.warn('[retry-mobile:backend] Persisted-job restore scanning is unavailable:', compatibility.detail);
        }
        bootState.ready = true;
        bootState.promise = null;
    })();

    await bootState.promise;
}

async function restorePersistedJobs() {
    const snapshots = await loadPersistedJobSnapshots();
    for (const snapshot of snapshots) {
        const job = createJob({
            ...snapshot,
            skipPersist: true,
        });

        if (job.state !== 'running') {
            continue;
        }

        const recovery = inspectRecoverySnapshot(job);
        const completed = recovery.reason === 'completed_on_recovery';
        const structuredError = completed
            ? null
            : toStructuredError(createStructuredError(
                recovery.reason,
                getRecoveryMessage(recovery.reason),
                recovery.detail,
            ));

        touchJob(job, {
            state: completed ? 'completed' : 'failed',
            phase: recovery.reason,
            acceptedCount: Number.isFinite(Number(recovery.acceptedCount))
                ? Number(recovery.acceptedCount)
                : job.acceptedCount,
            lastError: completed ? '' : structuredError.message,
            structuredError,
        });
        pruneTerminalJobUnits(job.userContext.handle, job.userContext.directories);
    }
}

function getRecoveryMessage(reason) {
    switch (reason) {
        case 'completed_on_recovery':
            return 'Retry Mobile recovered a completed run after backend restart.';
        case 'partial_on_recovery':
            return 'Retry Mobile recovered accepted swipes after backend restart, but the run did not finish.';
        case 'recovery_ambiguous':
            return 'Retry Mobile could not reconcile the recovered run cleanly after backend restart.';
        default:
            return 'Retry Mobile restarted before the run could be reconciled safely.';
    }
}

function getRequestBaseUrl(request) {
    const protocol = request.protocol || 'http';
    const host = request.get('host') || '127.0.0.1:8000';
    return `${protocol}://${host}`;
}

function getUserContext(request) {
    const handle = request?.user?.profile?.handle;
    const directories = request?.user?.directories || (handle ? getUserDirectories(handle) : null);
    if (!handle || !directories) {
        throw new Error('Retry Mobile could not resolve the active SillyTavern user profile.');
    }

    return { handle, directories };
}

function getChatIdentityFromRequest(request) {
    const chatId = typeof request.query?.chatId === 'string'
        ? request.query.chatId
        : '';
    const groupId = typeof request.query?.groupId === 'string' && request.query.groupId
        ? request.query.groupId
        : null;
    if (!chatId) {
        return null;
    }

    return {
        kind: groupId ? 'group' : 'character',
        chatId,
        fileName: chatId,
        groupId,
    };
}

function validateProtocol(clientProtocolVersion) {
    const version = Number(clientProtocolVersion);
    if (Number.isFinite(version) && version >= MIN_SUPPORTED_PROTOCOL_VERSION && version <= PROTOCOL_VERSION) {
        return { ok: true };
    }

    const structuredError = toStructuredError(createStructuredError(
        'protocol_version_mismatch',
        'Retry Mobile frontend/backend versions are incompatible.',
        `Frontend protocol ${clientProtocolVersion ?? 'missing'}, backend protocol ${PROTOCOL_VERSION}.`,
    ));
    return {
        ok: false,
        payload: {
            error: structuredError.message,
            structuredError,
            protocolVersion: PROTOCOL_VERSION,
            minSupportedProtocolVersion: MIN_SUPPORTED_PROTOCOL_VERSION,
        },
    };
}

function normalizeRunConfig(runConfig = {}) {
    return {
        runMode: runConfig.runMode === 'toggle' ? 'toggle' : 'single',
        targetAcceptedCount: Math.max(1, Number(runConfig.targetAcceptedCount) || 1),
        maxAttempts: Math.max(1, Number(runConfig.maxAttempts) || 1),
        attemptTimeoutSeconds: Math.max(1, Number(runConfig.attemptTimeoutSeconds) || 1),
        validationMode: runConfig.validationMode === 'tokens' ? 'tokens' : 'characters',
        minTokens: Math.max(0, Number(runConfig.minTokens) || 0),
        minCharacters: Math.max(0, Number(runConfig.minCharacters) || 0),
        notifyOnSuccess: runConfig.notifyOnSuccess === true,
        notifyOnComplete: runConfig.notifyOnComplete === true,
        vibrateOnSuccess: runConfig.vibrateOnSuccess === true,
        vibrateOnComplete: runConfig.vibrateOnComplete === true,
        notificationMessageTemplate: typeof runConfig.notificationMessageTemplate === 'string'
            ? runConfig.notificationMessageTemplate
            : '',
        allowHeuristicTokenFallback: runConfig.allowHeuristicTokenFallback === true,
    };
}

function normalizeNativeGraceSeconds(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
        return 30;
    }

    return Math.min(300, Math.max(10, Math.round(parsed)));
}

function getRunIdMismatchError(job, runId, message) {
    if (!runId || runId === job.runId) {
        return null;
    }

    const structuredError = toStructuredError(createStructuredError(
        'handoff_request_failed',
        message,
        `Expected run ${job.runId}, received ${runId}.`,
    ));
    return {
        error: structuredError.message,
        structuredError,
        job: serializeJob(job),
    };
}

function buildConflictResponse(job, message) {
    const structuredError = toStructuredError(createStructuredError(
        'handoff_request_failed',
        message,
    ));
    return {
        error: structuredError.message,
        structuredError,
        job: serializeJob(job),
    };
}

function buildMissingJobResponse() {
    const structuredError = toStructuredError(createStructuredError(
        'backend_job_missing',
        'Retry Mobile could not find the requested backend job.',
    ));
    return {
        error: structuredError.message,
        structuredError,
    };
}

module.exports = {
    info: {
        id: PLUGIN_ID,
        name: PLUGIN_NAME,
        description: 'Backend coordination for Retry Mobile.',
    },
    init,
};
