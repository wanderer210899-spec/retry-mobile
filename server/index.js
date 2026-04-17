const crypto = require('node:crypto');

const { confirmNativeAssistant, runJob } = require('./job-runner');
const { isTermuxAvailable, debugNotifier } = require('./notifier');
const { PLUGIN_ID, PLUGIN_NAME } = require('./plugin-meta');
const { createStructuredError, toStructuredError } = require('./retry-error');
const { getReleaseInfo } = require('./update-info');
const { buildChatKey, createJob, getJob, getJobByChat, serializeJob, touchJob } = require('./state');
const { validateRunConfig } = require('./validation');

const NATIVE_PENDING_GRACE_MS = 15000;

function init(router, config) {
    const app = router;
    const environment = {
        baseUrl: `http://127.0.0.1:${config?.port || 8000}`,
    };

    app.get('/capabilities', (_request, response) => {
        return response.send({
            termux: isTermuxAvailable(),
        });
    });

    app.get('/debug-notifier', async (_request, response) => {
        try {
            const includeProbes = _request.query?.includeProbes !== 'false';
            const result = await debugNotifier({ includeProbes });
            return response.send(result);
        } catch (error) {
            return response.status(500).send({ error: error.message });
        }
    });

    app.get('/release-info', async (request, response) => {
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

    app.post('/start', async (request, response) => {
        try {
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

            const targetAcceptedCount = Number(request.body.runConfig.targetAcceptedCount) || 1;
            const maxAttempts = Number(request.body.runConfig.maxAttempts) || 1;
            if (maxAttempts < targetAcceptedCount) {
                const structuredError = toStructuredError(createStructuredError(
                    'handoff_request_failed',
                    'Maximum attempts must be at least as large as the accepted outputs goal.',
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

            const existing = getJobByChat(request.body.chatIdentity);
            if (existing) {
                const structuredError = toStructuredError(createStructuredError(
                    'handoff_request_failed',
                    'A Retry Mobile job is already running for this chat.',
                ));
                return response.status(409).send({
                    error: structuredError.message,
                    structuredError,
                    job: serializeJob(existing),
                });
            }

            const targetFingerprint = normalizeFingerprint(request.body.targetFingerprint, request.body.chatIdentity);
            const assistantMessageIndex = Number(request.body.assistantMessageIndex);
            const hasConfirmedAssistant = Number.isFinite(assistantMessageIndex) && assistantMessageIndex >= 0;
            if (!targetFingerprint) {
                const structuredError = toStructuredError(createStructuredError(
                    'handoff_request_failed',
                    'The backend did not receive a valid captured target turn for this run.',
                ));
                return response.status(400).send({
                    error: structuredError.message,
                    structuredError,
                });
            }

            const job = createJob({
                jobId: crypto.randomUUID(),
                runId: typeof request.body.runId === 'string' && request.body.runId
                    ? request.body.runId
                    : crypto.randomUUID(),
                chatKey: buildChatKey(request.body.chatIdentity),
                chatIdentity: request.body.chatIdentity,
                targetAcceptedCount,
                maxAttempts,
                acceptedCount: 0,
                runConfig: normalizeRunConfig(request.body.runConfig, targetAcceptedCount, maxAttempts, runConfigValidation.mode),
                capturedRequest: request.body.capturedRequest,
                captureMeta: request.body.captureMeta || {},
                assistantMessageIndex: hasConfirmedAssistant ? assistantMessageIndex : null,
                targetFingerprint,
                nativeState: hasConfirmedAssistant ? 'confirmed' : 'pending',
                phase: hasConfirmedAssistant ? 'native_confirmed' : 'pending_native',
                recoveryMode: hasConfirmedAssistant ? 'top_up_existing' : '',
                captureConfirmedAt: new Date().toISOString(),
                nativeGraceDeadline: new Date(Date.now() + NATIVE_PENDING_GRACE_MS).toISOString(),
                userContext: {
                    handle: request.user.profile.handle,
                    directories: request.user.directories,
                },
                authHeaders: buildAuthHeaders(request),
            });

            void runJob(job, environment);
            return response.send({
                ok: true,
                jobId: job.jobId,
                job: serializeJob(job),
                termux: isTermuxAvailable(),
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

    app.post('/confirm-native/:jobId', async (request, response) => {
        try {
            const job = getJob(request.params.jobId);
            if (!job) {
                const structuredError = toStructuredError(createStructuredError(
                    'handoff_request_failed',
                    'Job not found.',
                ));
                return response.status(404).send({
                    error: structuredError.message,
                    structuredError,
                });
            }

            if (typeof request.body?.runId === 'string' && request.body.runId && request.body.runId !== job.runId) {
                const structuredError = toStructuredError(createStructuredError(
                    'handoff_request_failed',
                    'The native confirmation did not match the active Retry Mobile run.',
                ));
                return response.status(409).send({
                    error: structuredError.message,
                    structuredError,
                    job: serializeJob(job),
                });
            }

            if (job.state !== 'running') {
                const structuredError = toStructuredError(createStructuredError(
                    'handoff_request_failed',
                    'The backend job is no longer running.',
                ));
                return response.status(409).send({
                    error: structuredError.message,
                    structuredError,
                    job: serializeJob(job),
                });
            }

            if (job.nativeState === 'abandoned') {
                const structuredError = toStructuredError(createStructuredError(
                    'handoff_request_failed',
                    'The backend already recovered this native turn before frontend confirmation arrived.',
                ));
                return response.status(409).send({
                    error: structuredError.message,
                    structuredError,
                    job: serializeJob(job),
                });
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

    app.get('/status/:jobId', async (request, response) => {
        const job = getJob(request.params.jobId);
        if (!job) {
            const structuredError = toStructuredError(createStructuredError(
                'handoff_request_failed',
                'Job not found.',
            ));
            return response.status(404).send({
                error: structuredError.message,
                structuredError,
            });
        }

        return response.send(serializeJob(job));
    });

    app.post('/cancel/:jobId', async (request, response) => {
        const job = getJob(request.params.jobId);
        if (!job) {
            const structuredError = toStructuredError(createStructuredError(
                'handoff_request_failed',
                'Job not found.',
            ));
            return response.status(404).send({
                error: structuredError.message,
                structuredError,
            });
        }

        touchJob(job, {
            cancelRequested: true,
            state: 'cancelled',
            phase: 'cancel_requested',
        });
        return response.send({ ok: true, job: serializeJob(job) });
    });

    app.get('/active', async (request, response) => {
        const identity = {
            kind: request.query.groupId ? 'group' : 'character',
            chatId: String(request.query.chatId || ''),
            groupId: request.query.groupId ? String(request.query.groupId) : null,
        };
        const job = getJobByChat(identity);
        return response.send(job ? serializeJob(job) : {});
    });
}

function buildAuthHeaders(request) {
    const headers = {};
    const cookie = request.headers?.cookie;
    const csrf = request.headers?.['x-csrf-token'];

    if (cookie) {
        headers.Cookie = cookie;
    }

    if (csrf) {
        headers['x-csrf-token'] = csrf;
    }

    return headers;
}

function normalizeFingerprint(fingerprint, chatIdentity) {
    if (!fingerprint || typeof fingerprint !== 'object') {
        return null;
    }

    const userMessageIndex = Number(fingerprint.userMessageIndex);
    const userMessageText = typeof fingerprint.userMessageText === 'string'
        ? fingerprint.userMessageText
        : '';
    if (!Number.isFinite(userMessageIndex) || userMessageIndex < 0 || !userMessageText) {
        return null;
    }

    return {
        chatIdentity,
        userMessageIndex,
        userMessageText,
        capturedAt: typeof fingerprint.capturedAt === 'string' ? fingerprint.capturedAt : new Date().toISOString(),
        requestType: typeof fingerprint.requestType === 'string' ? fingerprint.requestType : '',
        messageIdHint: Number.isFinite(Number(fingerprint.messageIdHint)) ? Number(fingerprint.messageIdHint) : null,
    };
}

function normalizeRunConfig(runConfig = {}, targetAcceptedCount, maxAttempts, validationMode) {
    return {
        targetAcceptedCount,
        maxAttempts,
        attemptTimeoutSeconds: Math.max(1, Number(runConfig.attemptTimeoutSeconds) || 0),
        validationMode,
        minCharacters: Math.max(0, Number(runConfig.minCharacters ?? runConfig.minWords) || 0),
        minTokens: Math.max(0, Number(runConfig.minTokens) || 0),
        notifyOnSuccess: Boolean(runConfig.notifyOnSuccess),
        notifyOnComplete: Boolean(runConfig.notifyOnComplete),
        vibrateOnSuccess: Boolean(runConfig.vibrateOnSuccess),
        vibrateOnComplete: Boolean(runConfig.vibrateOnComplete),
        notificationMessageTemplate: typeof runConfig.notificationMessageTemplate === 'string'
            ? runConfig.notificationMessageTemplate
            : '',
    };
}

module.exports = {
    init,
    info: {
        id: PLUGIN_ID,
        name: PLUGIN_NAME,
        description: 'Backend retry loop for captured SillyTavern requests.',
    },
};

