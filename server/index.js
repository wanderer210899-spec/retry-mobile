const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const {
    confirmNativeAssistant,
    resolvePendingNativeState,
    runJob,
    waitForNativeResolutionIdle,
} = require('./job-runner');
const { inspectRecoverySnapshot } = require('./chat-writer');
const { debugNotifier, getTermuxStatus, refreshTermuxStatusForStart } = require('./notifier');
const { MIN_SUPPORTED_PROTOCOL_VERSION, PLUGIN_ID, PLUGIN_NAME, PROTOCOL_VERSION } = require('./plugin-meta');
const { createStructuredError, toStructuredError } = require('./retry-error');
const {
    advanceGeneration,
    configureJobStore,
    deletePersistedJobSnapshot,
    getCurrentGeneration,
    loadPersistedJobSnapshots,
    pruneTerminalJobUnits,
    rollbackGeneration,
    writeJobSnapshot,
} = require('./job-store');
const {
    appendJobLog,
    ensureJobLog,
    renderJobLog,
} = require('./job-log-store');
const {
    getCompatibilitySnapshot,
    getUserDirectories,
    getUserDirectoriesList,
    initializeStRuntime,
} = require('./st-runtime');
const { getReleaseInfo } = require('./update-info');
const { getCatalog, getSupportedLanguages, normalizeLanguage } = require('./i18n-catalog');
const { readInstallSourceFromRoot, resolvePluginRuntimeRoot } = require('./install-source');
const {
    buildChatKey,
    createJob,
    getJob,
    getJobByChat,
    getJobByChatSession,
    getLatestJobByChat,
    serializeJob,
    setPersistenceHandler,
    touchJob,
} = require('./state');
const { validateRunConfig } = require('./validation');

const NATIVE_RESOLUTION_WAIT_MS = 2500;
const ALLOWED_NATIVE_FAILURE_REASONS = new Set([
    'hidden_timeout',
    'native_wait_timeout',
    'native_wait_stalled',
    'native_attempt_timeout',
    'native_turn_mismatch',
    'native_generation_stopped',
    'capture_chat_changed',
    'native_turn_missing',
    'rendered_without_end',
    'grace_expired',
]);

const bootState = {
    ready: false,
    promise: null,
    lastError: '',
};

// init() MUST register routes unconditionally. SillyTavern's plugin loader
// awaits this call and only mounts the router under
// `/api/plugins/<id>` if init resolves; if init rejects the entire plugin
// disappears from the URL space and every request — including innocuous ones
// like `/active` and `/i18n-catalog` — falls through to ST's outer 404 handler
// (HTML "Not found" body, not JSON). That is exactly the failure shape we saw
// in the panel screenshot and is the reason the frontend rendered raw i18n
// keys: the catalog endpoint never existed, so `fetchI18nCatalog` rejected and
// the FALLBACK_CATALOG (empty) won.
//
// Boot-time recovery (persisted job replay, ST runtime probe) MUST be allowed
// to fail without taking the route table down with it. We surface the failure
// through `/capabilities.backendBootError` so it is observable from the
// frontend / system tab, but routes always come up.
async function init(router) {
    try {
        await ensureBackendReady();
    } catch (error) {
        bootState.lastError = error instanceof Error ? error.message : String(error);
        console.error('[retry-mobile:backend] Boot recovery failed; continuing with degraded boot state so plugin routes still register:', error);
    }

    router.get('/capabilities', (_request, response) => {
        const termux = getTermuxStatus();
        const compatibility = getCompatibilitySnapshot();
        const runtimeRoot = resolvePluginRuntimeRoot(__dirname);
        const installSource = readInstallSourceFromRoot(runtimeRoot, {}) || {};
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
            uiLanguage: normalizeLanguage(installSource.uiLanguage || ''),
            supportedUiLanguages: getSupportedLanguages(),
            backendBootError: bootState.lastError || '',
            backendReady: bootState.ready === true,
            installedVersion: readInstalledPluginVersion(runtimeRoot),
        });
    });

    router.get('/i18n-catalog', (_request, response) => {
        response.set('Cache-Control', 'no-store');
        return response.send({
            defaultLanguage: normalizeLanguage(getCatalog()?.meta?.defaultLanguage || 'en'),
            supportedLanguages: getSupportedLanguages(),
            strings: getCatalog(),
        });
    });

    router.get('/state', async (request, response) => {
        try {
            response.set('Cache-Control', 'no-store');
            const identity = getChatIdentityFromRequest(request);
            if (!identity?.chatId) {
                return response.status(400).send({
                    error: 'Missing chat identity query.',
                });
            }

            const { handle, directories } = getUserContext(request);
            const chatKey = buildChatKey(identity);
            const generation = getCurrentGeneration(handle, directories, chatKey);
            const termux = getTermuxStatus();
            return response.send({
                chatKey,
                currentGeneration: generation,
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
        response.set('Cache-Control', 'no-store');
        const identity = getChatIdentityFromRequest(request);
        if (!identity?.chatId) {
            return response.send({});
        }

        const sessionId = getSessionIdFromRequest(request);
        const sameSessionOnly = String(request.query?.sameSessionOnly || '').toLowerCase() === 'true';
        const existing = sameSessionOnly && sessionId
            ? getJobByChatSession(identity, sessionId)
            : getJobByChatSession(identity, sessionId) || getJobByChat(identity);
        return response.send(existing ? serializeJob(existing) : {});
    });

    router.get('/latest', (request, response) => {
        response.set('Cache-Control', 'no-store');
        const identity = getChatIdentityFromRequest(request);
        if (!identity?.chatId) {
            return response.send({});
        }

        const latest = getLatestJobByChat(identity);
        return response.send(latest ? serializeJob(latest) : {});
    });

    router.get('/status/:jobId', (request, response) => {
        response.set('Cache-Control', 'no-store');
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

        touchFrontendPresence(job, {
            at: new Date().toISOString(),
            sessionId: getSessionIdFromRequest(request),
        });
        return response.send(serializeJob(job));
    });

    router.get('/log/:jobId', (request, response) => {
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

        const compatibility = getCompatibilitySnapshot();
        const cursor = ensureJobLog(job);
        return response.send({
            jobId: job.jobId,
            runId: job.runId,
            title: cursor.title,
            updatedAt: cursor.updatedAt,
            entryCount: cursor.entryCount,
            text: renderJobLog(job, {
                compatibility,
            }),
        });
    });

    router.post('/log-event/:jobId', (request, response) => {
        const job = getJob(request.params.jobId);
        if (!job) {
            return response.status(404).send(buildMissingJobResponse());
        }

        const entry = appendJobLog(job, {
            source: 'frontend',
            event: typeof request.body?.event === 'string' && request.body.event
                ? request.body.event
                : 'frontend_event',
            summary: typeof request.body?.summary === 'string' && request.body.summary
                ? request.body.summary
                : 'Frontend reported a retry-log event.',
            detail: request.body?.detail ?? null,
            frontendStatus: request.body?.frontendStatus ?? null,
            at: typeof request.body?.at === 'string' && request.body.at
                ? request.body.at
                : new Date().toISOString(),
        });

        return response.send({
            ok: true,
            updatedAt: entry?.at || job.logUpdatedAt || null,
            entryCount: Number(job.logEntryCount) || 0,
            title: job.logTitle || '',
        });
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
        let generationRollback = null;
        let createdStartJob = null;
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

            const normalizedRunConfig = normalizeRunConfig(request.body.runConfig);
            const generationNumber = advanceGeneration(handle, directories, chatKey);
            generationRollback = {
                handle,
                directories,
                chatKey,
                fromGeneration: generationNumber,
                toGeneration: currentGeneration,
            };
            const termux = refreshTermuxStatusForStart();
            const nativeGraceSeconds = normalizeNativeGraceSeconds(request.body.nativeGraceSeconds);
            const sessionId = normalizeSessionId(request.body?.sessionId);
            const visibilityState = normalizeVisibilityState(request.body?.visibilityState);
            const seenAt = new Date().toISOString();
            const job = createJob({
                jobId: crypto.randomUUID(),
                runId: typeof request.body.runId === 'string' && request.body.runId
                    ? request.body.runId
                    : crypto.randomUUID(),
                chatIdentity: identity,
                chatKey,
                ownerSessionId: sessionId,
                targetAcceptedCount: normalizedRunConfig.targetAcceptedCount,
                maxAttempts: normalizedRunConfig.maxAttempts,
                runConfig: normalizedRunConfig,
                capturedRequest: request.body.capturedRequest,
                captureMeta: request.body.captureMeta || {},
                targetFingerprint: request.body.targetFingerprint,
                frontendVisibilityState: visibilityState,
                frontendHiddenSince: visibilityState === 'hidden' ? seenAt : null,
                lastFrontendSeenAt: seenAt,
                acceptedCount: 0,
                attemptCount: 0,
                generationNumber,
                expectedPreviousGeneration,
                nativeState: 'pending',
                phase: 'pending_native',
                nativeGraceSeconds,
                nativeGraceDeadline: '',
                targetUserAnchorId: crypto.randomUUID(),
                targetAssistantAnchorId: crypto.randomUUID(),
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
                lastError: '',
            });
            createdStartJob = job;
            ensureJobLog(job);
            appendJobLog(job, {
                source: 'backend',
                event: 'job_started',
                summary: `Reserved backend job ${job.jobId} for chat ${identity.chatId}.`,
                detail: {
                    runMode: normalizedRunConfig.runMode,
                    targetAcceptedCount: normalizedRunConfig.targetAcceptedCount,
                    maxAttempts: normalizedRunConfig.maxAttempts,
                    validationMode: normalizedRunConfig.validationMode,
                    nativeGraceSeconds,
                },
            });
            generationRollback = null;

            void runJob(job, {
                baseUrl: getRequestBaseUrl(request),
                requestAuth: extractReplayAuthContext(request),
            });

            return response.send({
                ok: true,
                jobId: job.jobId,
                job: serializeJob(job),
                protocolVersion: PROTOCOL_VERSION,
                currentGeneration: generationNumber,
                termux: Boolean(termux.available),
                termuxCheckedAt: termux.checkedAt,
            });
        } catch (error) {
            console.error('[retry-mobile:backend] Start failed:', error);
            const structuredError = toStructuredError(error, 'handoff_request_failed', 'Retry Mobile could not start the backend job.');
            if (generationRollback) {
                try {
                    rollbackGeneration(generationRollback.handle, generationRollback.directories, generationRollback.chatKey, {
                        fromGeneration: generationRollback.fromGeneration,
                        toGeneration: generationRollback.toGeneration,
                    });
                } catch (rollbackError) {
                    console.error('[retry-mobile:backend] Start generation rollback failed:', rollbackError);
                }
            }
            if (createdStartJob?.state === 'running') {
                touchJob(createdStartJob, {
                    state: 'failed',
                    phase: 'failed',
                    lastError: structuredError.message,
                    structuredError,
                });
            }
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

            touchFrontendPresence(job, {
                at: new Date().toISOString(),
                sessionId: normalizeSessionId(request.body?.sessionId),
                visibilityState: 'visible',
            });

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
            appendJobLog(job, {
                source: 'backend',
                event: 'confirm_native',
                summary: `Backend accepted native confirmation for assistant index ${request.body?.assistantMessageIndex}.`,
            });
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

            touchFrontendPresence(job, {
                at: new Date().toISOString(),
                sessionId: normalizeSessionId(request.body?.sessionId),
            });

            if (job.state !== 'running') {
                return response.status(409).send(buildConflictResponse(
                    job,
                    'The backend job is no longer running.',
                ));
            }

            const reason = String(request.body?.reason || '').trim();
            if (!isAllowedNativeFailureReason(reason)) {
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
            appendJobLog(job, {
                source: 'backend',
                event: 'native_failed_hint',
                summary: `Backend accepted native failure hint: ${reason}.`,
                detail: typeof request.body?.detail === 'string' && request.body.detail
                    ? request.body.detail
                    : null,
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

    router.post('/frontend-presence/:jobId', async (request, response) => {
        try {
            const job = getJob(request.params.jobId);
            if (!job) {
                return response.status(404).send(buildMissingJobResponse());
            }

            const runIdMismatch = getRunIdMismatchError(job, request.body?.runId, 'The frontend presence update did not match the active Retry Mobile run.');
            if (runIdMismatch) {
                return response.status(409).send(runIdMismatch);
            }

            if (job.state !== 'running') {
                return response.status(409).send(buildConflictResponse(
                    job,
                    'The backend job is no longer running.',
                ));
            }

            const previousVisibilityState = job.frontendVisibilityState || 'unknown';
            const visibilityState = normalizeVisibilityState(request.body?.visibilityState);
            touchFrontendPresence(job, {
                at: typeof request.body?.at === 'string' && request.body.at ? request.body.at : new Date().toISOString(),
                sessionId: normalizeSessionId(request.body?.sessionId),
                visibilityState,
            });
            appendJobLog(job, {
                source: 'backend',
                event: 'frontend_presence',
                summary: `Frontend presence reported ${visibilityState} (${String(request.body?.reason || 'presence').trim() || 'presence'}).`,
                detail: {
                    reason: String(request.body?.reason || '').trim() || 'presence',
                    previousVisibilityState,
                    visibilityState,
                    sessionId: normalizeSessionId(request.body?.sessionId),
                    frontendHiddenSince: job.frontendHiddenSince || null,
                    lastFrontendSeenAt: job.lastFrontendSeenAt || null,
                },
            });
            return response.send({
                ok: true,
                job: serializeJob(job),
            });
        } catch (error) {
            console.error('[retry-mobile:backend] Frontend presence failed:', error);
            const structuredError = toStructuredError(error, 'handoff_request_failed', 'Retry Mobile could not record frontend presence.');
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
        appendJobLog(job, {
            source: 'backend',
            event: 'cancel_requested',
            summary: 'Frontend requested backend cancellation for this job.',
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
        bootState.lastError = '';
        const compatibility = await initializeStRuntime();
        configureJobStore({
            getUserDirectories,
            getUserDirectoriesList,
        });
        setPersistenceHandler(writeJobSnapshot);
        if (compatibility.userDirectoryScanSupport) {
            // restorePersistedJobs() iterates persisted snapshots written by
            // previous boots. A single corrupt or schema-incompatible snapshot
            // historically rejected the whole boot promise, which (because
            // init() awaited this) tore down plugin registration. Treat the
            // restore as best-effort: the in-memory job store stays empty for
            // failed snapshots, and routes still come up.
            try {
                await restorePersistedJobs();
            } catch (error) {
                bootState.lastError = error instanceof Error ? error.message : String(error);
                console.error('[retry-mobile:backend] Persisted-job restore failed; plugin routes stay online with an empty in-memory store:', error);
            }
        } else {
            console.warn('[retry-mobile:backend] Persisted-job restore scanning is unavailable:', compatibility.detail);
        }
        bootState.ready = true;
        bootState.promise = null;
    })();

    try {
        await bootState.promise;
    } catch (error) {
        // Reset the cached promise so a future call can re-attempt boot
        // instead of permanently re-throwing the cached rejection. The
        // top-level init() try/catch ensures we don't tear down plugin
        // registration regardless.
        bootState.promise = null;
        throw error;
    }
}

async function restorePersistedJobs() {
    const snapshots = await loadPersistedJobSnapshots();
    for (const snapshot of snapshots) {
        // Per-snapshot try/catch: one corrupt or schema-incompatible snapshot
        // must not abort the whole restore. The bad snapshot is logged and
        // skipped; the remaining snapshots still get rehydrated and the
        // outer boot promise still resolves — keeping plugin routes online.
        try {
            restoreSinglePersistedJob(snapshot);
        } catch (error) {
            const jobIdentity = String(snapshot?.jobId || snapshot?.runId || 'unknown');
            console.error(`[retry-mobile:backend] Skipping unrestorable persisted job ${jobIdentity}:`, error);
        }
    }
}

function restoreSinglePersistedJob(snapshot) {
    // Terminal snapshots from a previous boot must not survive a server
    // restart. The user expectation (and what other application installers
    // do) is that restarting the server is a clean slate for retry/job
    // history. Terminal jobs were previously rehydrated into the in-memory
    // store so `/latest` could surface them after restart, but that meant
    // the frontend's boot path could pick up a stale completed/failed run
    // and treat it as the latest result. We now skip and delete those
    // snapshots; only `running` snapshots are recovered (and recovered jobs
    // immediately transition to a terminal state below).
    const persistedState = String(snapshot?.state || '').trim();
    if (persistedState && persistedState !== 'running') {
        deletePersistedJobSnapshot(snapshot);
        return;
    }

    const job = createJob({
        ...snapshot,
        skipPersist: true,
    });
    ensureJobLog(job);

    if (job.state !== 'running') {
        return;
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
    appendJobLog(job, {
        source: 'backend',
        event: 'restored_after_restart',
        summary: completed
            ? 'Retry Mobile restored this job as completed after backend restart.'
            : 'Retry Mobile restored this job as failed after backend restart.',
        detail: {
            recoveryReason: recovery.reason,
            detail: recovery.detail,
        },
    });
    pruneTerminalJobUnits(job.userContext.handle, job.userContext.directories);
}

function readInstalledPluginVersion(runtimeRoot) {
    try {
        const releasePath = path.join(runtimeRoot, 'release.json');
        if (!fs.existsSync(releasePath)) {
            return '';
        }
        const release = JSON.parse(fs.readFileSync(releasePath, 'utf8'));
        return typeof release?.version === 'string' ? release.version : '';
    } catch {
        return '';
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
    const protocol = normalizeRequestProtocol(request?.protocol);
    const host = normalizeReplayHost(request);
    return `${protocol}://${host}`;
}

function normalizeRequestProtocol(protocol) {
    const value = typeof protocol === 'string' && protocol.trim()
        ? protocol.trim().replace(/:$/u, '')
        : 'http';
    return value === 'https' ? 'https' : 'http';
}

function normalizeReplayHost(request) {
    const rawHost = typeof request?.get === 'function'
        ? normalizeHeaderValue(request.get('host'))
        : normalizeHeaderValue(request?.headers?.host);
    const host = rawHost || '127.0.0.1:8000';
    const parsed = parseHostHeader(host);
    if (!isAndroidEmulatorHost(parsed.hostname)) {
        return host;
    }

    const localPort = parsed.port || normalizeLocalPort(request?.socket?.localPort) || '8000';
    return `127.0.0.1:${localPort}`;
}

function parseHostHeader(host) {
    try {
        const url = new URL(`http://${host}`);
        return {
            hostname: String(url.hostname || '').replace(/^\[|\]$/gu, '').toLowerCase(),
            port: url.port || '',
        };
    } catch {
        return {
            hostname: String(host || '').split(':')[0].toLowerCase(),
            port: '',
        };
    }
}

function isAndroidEmulatorHost(hostname) {
    return hostname === '10.0.2.2' || hostname === '10.0.3.2';
}

function normalizeLocalPort(port) {
    const numeric = Number(port);
    if (!Number.isInteger(numeric) || numeric < 1 || numeric > 65535) {
        return '';
    }

    return String(numeric);
}

function extractReplayAuthContext(request) {
    const cookieHeader = typeof request?.get === 'function'
        ? normalizeHeaderValue(request.get('cookie'))
        : normalizeHeaderValue(request?.headers?.cookie);
    const csrfToken = typeof request?.get === 'function'
        ? normalizeHeaderValue(request.get('x-csrf-token'))
        : normalizeHeaderValue(request?.headers?.['x-csrf-token']);

    if (!cookieHeader && !csrfToken) {
        return null;
    }

    return {
        cookieHeader,
        csrfToken,
    };
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

function getSessionIdFromRequest(request) {
    return normalizeSessionId(request.query?.sessionId);
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
    let validationMode;
    if (runConfig.validationMode === 'tokens') {
        validationMode = 'tokens';
    } else if (runConfig.validationMode === 'words') {
        validationMode = 'words';
    } else {
        validationMode = 'characters';
    }

    return {
        runMode: runConfig.runMode === 'toggle' ? 'toggle' : 'single',
        targetAcceptedCount: Math.max(1, Number(runConfig.targetAcceptedCount) || 1),
        maxAttempts: Math.max(1, Number(runConfig.maxAttempts) || 1),
        attemptTimeoutSeconds: Math.max(1, Number(runConfig.attemptTimeoutSeconds) || 1),
        validationMode,
        minTokens: Math.max(0, Number(runConfig.minTokens) || 0),
        minCharacters: Math.max(0, Number(runConfig.minCharacters) || 0),
        minWords: Math.max(0, Number(runConfig.minWords) || 0),
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

function normalizeSessionId(value) {
    return typeof value === 'string' && value.trim()
        ? value.trim()
        : '';
}

function normalizeVisibilityState(value) {
    return value === 'hidden' ? 'hidden' : 'visible';
}

function touchFrontendPresence(job, input = {}) {
    if (!job) {
        return null;
    }

    const patch = {
        lastFrontendSeenAt: typeof input.at === 'string' && input.at
            ? input.at
            : new Date().toISOString(),
    };

    const sessionId = normalizeSessionId(input.sessionId);
    if (sessionId) {
        patch.ownerSessionId = sessionId;
    }

    if (typeof input.visibilityState === 'string' && input.visibilityState) {
        const visibilityState = normalizeVisibilityState(input.visibilityState);
        patch.frontendVisibilityState = visibilityState;
        patch.frontendHiddenSince = visibilityState === 'hidden'
            ? (job.frontendVisibilityState === 'hidden' && job.frontendHiddenSince
                ? job.frontendHiddenSince
                : patch.lastFrontendSeenAt)
            : null;
    }

    return touchJob(job, patch);
}

function normalizeNativeGraceSeconds(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
        return 30;
    }

    return Math.min(300, Math.max(10, Math.round(parsed)));
}

function normalizeHeaderValue(value) {
    if (Array.isArray(value)) {
        value = value.find((item) => typeof item === 'string' && item.trim().length > 0) || '';
    }

    return typeof value === 'string' && value.trim()
        ? value.trim()
        : '';
}

function getRunIdMismatchError(job, runId, message) {
    if (!runId || runId === job.runId) {
        return null;
    }

    appendJobLog(job, {
        source: 'backend',
        event: 'request_rejected',
        summary: message,
        detail: {
            reason: 'run_id_mismatch',
            expectedRunId: job.runId || '',
            receivedRunId: runId || '',
        },
    });
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
    appendJobLog(job, {
        source: 'backend',
        event: 'request_conflict',
        summary: message,
        detail: {
            reason: 'job_state_conflict',
            jobState: job?.state || 'unknown',
            jobPhase: job?.phase || 'unknown',
            nativeState: job?.nativeState || 'unknown',
            nativeResolutionCause: job?.nativeResolutionCause || '',
            targetMessageVersion: Number(job?.targetMessageVersion) || 0,
        },
    });
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

function isAllowedNativeFailureReason(reason) {
    return ALLOWED_NATIVE_FAILURE_REASONS.has(String(reason || '').trim());
}

module.exports = {
    info: {
        id: PLUGIN_ID,
        name: PLUGIN_NAME,
        description: 'Backend coordination for Retry Mobile.',
    },
    init,
    _test: {
        extractReplayAuthContext,
        getRequestBaseUrl,
        isAllowedNativeFailureReason,
        restoreSinglePersistedJob,
        restorePersistedJobsWith,
        bootState,
    },
};

// Test-only helper: lets the unit test inject both a snapshot loader and a
// per-snapshot processor so the resilience contract (one throw must not
// abort the whole loop) can be verified in isolation, without touching the
// real filesystem-backed job store.
async function restorePersistedJobsWith(loadSnapshots, processSnapshot = restoreSinglePersistedJob) {
    const snapshots = await loadSnapshots();
    for (const snapshot of snapshots) {
        try {
            processSnapshot(snapshot);
        } catch (error) {
            const jobIdentity = String(snapshot?.jobId || snapshot?.runId || 'unknown');
            console.error(`[retry-mobile:backend] Skipping unrestorable persisted job ${jobIdentity}:`, error);
        }
    }
}
