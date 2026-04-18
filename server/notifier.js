const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const TERMUX_BIN_DIRS = [
    '/data/data/com.termux/files/usr/bin',
    '/data/user/0/com.termux/files/usr/bin',
];
const TERMUX_CAPABILITIES_TTL_MS = 60000;
const TERMUX_START_FRESH_WINDOW_MS = 5000;

const MAX_RECENT_ATTEMPTS = 30;
const MAX_CAPTURE_LENGTH = 500;
let notificationSequence = 0;
let commandSequence = 0;
const recentAttempts = [];
let _termuxStatus = detectTermuxStatus();

function getTermuxStatus(options = {}) {
    const maxAgeMs = Number.isFinite(Number(options.maxAgeMs)) ? Number(options.maxAgeMs) : TERMUX_CAPABILITIES_TTL_MS;
    const checkedAtMs = Date.parse(_termuxStatus.checkedAt || '') || 0;
    if (!checkedAtMs || (Date.now() - checkedAtMs) > maxAgeMs) {
        _termuxStatus = detectTermuxStatus();
    }

    return {
        available: Boolean(_termuxStatus.available),
        checkedAt: _termuxStatus.checkedAt,
        binDir: _termuxStatus.binDir,
    };
}

function refreshTermuxStatusForStart() {
    return getTermuxStatus({ maxAgeMs: TERMUX_START_FRESH_WINDOW_MS });
}

function isTermuxAvailable() {
    return Boolean(getTermuxStatus().available);
}

function resolveBin(name) {
    const status = getTermuxStatus();
    if (!status.binDir) {
        return null;
    }

    const full = path.join(status.binDir, name);
    try {
        fs.accessSync(full, fs.constants.X_OK);
        return full;
    } catch {
        return null;
    }
}

function notify(runConfig, stage, payload = {}) {
    const shouldNotify = stage === 'success'
        ? Boolean(runConfig.notifyOnSuccess)
        : stage === 'completed'
            ? Boolean(runConfig.notifyOnComplete)
            : false;
    const shouldVibrate = stage === 'success'
        ? Boolean(runConfig.vibrateOnSuccess)
        : stage === 'completed'
            ? Boolean(runConfig.vibrateOnComplete)
            : false;

    if (shouldNotify) {
        const bin = resolveBin('termux-notification');
        if (bin) {
            runTermuxCommand(bin, [
                '--id', nextNotificationId(),
                '--title', 'Retry Mobile',
                '--content', buildMessage(runConfig, stage, payload),
                '--priority', stage === 'completed' ? 'high' : 'default',
                '--sound',
                '--icon', 'ic_notification_overlay',
            ], {
                kind: 'notification',
                stage,
                variant: 'runtime_default',
                payload: buildAttemptPayload(payload),
            });
        }
    }

    if (shouldVibrate) {
        const bin = resolveBin('termux-vibrate');
        if (bin) {
            const durationMs = stage === 'completed' ? 900 : 400;
            runTermuxCommand(bin, ['-d', String(durationMs), '-f'], {
                kind: 'vibration',
                stage,
                variant: 'runtime_force',
                payload: {
                    durationMs,
                },
            });
        }
    }
}

function acquireWakeLock() {
    const bin = resolveBin('termux-wake-lock');
    if (bin) {
        runTermuxCommand(bin, [], {
            kind: 'wake-lock',
            stage: 'wake_lock',
        });
    }
}

function releaseWakeLock() {
    const bin = resolveBin('termux-wake-unlock');
    if (bin) {
        runTermuxCommand(bin, [], {
            kind: 'wake-lock',
            stage: 'wake_unlock',
        });
    }
}

function nextNotificationId() {
    notificationSequence = (notificationSequence + 1) % 1000;
    const base = Date.now() % 2147482647;
    return String(base + notificationSequence);
}

function buildMessage(runConfig, stage, payload) {
    const customMessage = renderCustomMessage(runConfig, stage, payload);
    if (customMessage) {
        return customMessage;
    }

    if (stage === 'success') {
        return `Accepted ${payload.acceptedCount}/${payload.targetAcceptedCount} - ${payload.characterCount}c - ${payload.tokenCount}t`;
    }

    if (stage === 'completed') {
        return `Done - ${payload.acceptedCount} accepted in ${payload.attemptCount} attempts.`;
    }

    return `Retry Mobile ${stage}.`;
}

function renderCustomMessage(runConfig, stage, payload) {
    const template = normalizeTemplate(runConfig?.notificationMessageTemplate);
    if (!template) {
        return '';
    }

    const values = {
        stage: stage === 'success' ? 'accepted' : stage,
        acceptedCount: stringifyTemplateValue(payload.acceptedCount),
        targetAcceptedCount: stringifyTemplateValue(payload.targetAcceptedCount),
        attemptCount: stringifyTemplateValue(payload.attemptCount),
        characterCount: stringifyTemplateValue(payload.characterCount),
        wordCount: stringifyTemplateValue(payload.characterCount),
        tokenCount: stringifyTemplateValue(payload.tokenCount),
        reason: stringifyTemplateValue(payload.reason),
        timeoutSeconds: stringifyTemplateValue(runConfig?.attemptTimeoutSeconds),
    };

    return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, key) => (
        Object.prototype.hasOwnProperty.call(values, key)
            ? values[key]
            : match
    ));
}

function normalizeTemplate(template) {
    if (typeof template !== 'string') {
        return '';
    }

    return template
        .replace(/\r?\n+/g, ' ')
        .trim();
}

function stringifyTemplateValue(value) {
    return value == null ? '' : String(value);
}

function runTermuxCommand(bin, args, meta = {}) {
    const attempt = createAttempt(path.basename(bin), args, meta);
    execFile(bin, args, { timeout: 8000 }, (error, stdout, stderr) => {
        finalizeAttempt(attempt, error, stdout, stderr);
        if (error) {
            console.warn('[retry-mobile:notifier] Termux command failed:', path.basename(bin), error.message);
        }
    });
}

function createAttempt(command, args, meta) {
    const attempt = {
        id: `${Date.now()}-${++commandSequence}`,
        command,
        args: Array.isArray(args) ? [...args] : [],
        kind: meta?.kind || command,
        stage: meta?.stage || '',
        variant: meta?.variant || '',
        payload: meta?.payload || null,
        createdAt: new Date().toISOString(),
        status: 'running',
        exitCode: null,
        signal: null,
        stdout: '',
        stderr: '',
        error: null,
        screenState: null,
        notificationSnapshot: null,
    };
    recentAttempts.unshift(attempt);
    if (recentAttempts.length > MAX_RECENT_ATTEMPTS) {
        recentAttempts.length = MAX_RECENT_ATTEMPTS;
    }
    void readScreenState().then((screenState) => {
        attempt.screenState = screenState;
    }).catch(() => {});
    return attempt;
}

function finalizeAttempt(attempt, error, stdout, stderr) {
    attempt.completedAt = new Date().toISOString();
    attempt.exitCode = Number.isInteger(error?.code) ? error.code : 0;
    attempt.signal = error?.signal ?? null;
    attempt.stdout = String(stdout || '').trim().slice(0, MAX_CAPTURE_LENGTH);
    attempt.stderr = String(stderr || '').trim().slice(0, MAX_CAPTURE_LENGTH);
    attempt.error = error ? String(error.message || error).slice(0, MAX_CAPTURE_LENGTH) : null;
    attempt.status = error
        ? (error.killed ? 'timeout' : 'error')
        : 'ok';
    if (attempt.kind === 'notification') {
        void attachNotificationSnapshot(attempt);
    }
}

function buildAttemptPayload(payload = {}) {
    return {
        acceptedCount: payload.acceptedCount ?? null,
        targetAcceptedCount: payload.targetAcceptedCount ?? null,
        attemptCount: payload.attemptCount ?? null,
        characterCount: payload.characterCount ?? null,
        tokenCount: payload.tokenCount ?? null,
        reason: payload.reason ?? null,
    };
}

function probeTermuxBin(name, args) {
    return new Promise((resolve) => {
        const bin = resolveBin(name);
        if (!bin) {
            resolve({ name, found: false, reason: 'binary not found or not executable' });
            return;
        }
        const { execFile: ef } = require('node:child_process');
        ef(bin, args, { timeout: 5000 }, (error, stdout, stderr) => {
            resolve({
                name,
                found: true,
                path: bin,
                exitCode: error?.code ?? 0,
                signal: error?.signal ?? null,
                stdout: (stdout || '').trim().slice(0, 500),
                stderr: (stderr || '').trim().slice(0, 500),
                error: error ? error.message.slice(0, 300) : null,
            });
        });
    });
}

async function debugNotifier(options = {}) {
    const includeProbes = options.includeProbes !== false;
    const debugIds = createDebugNotificationIds();
    const probes = includeProbes
        ? await Promise.all([
            probeNotificationVariant('minimal', buildDebugNotificationArgs(debugIds.minimal)),
            probeNotificationVariant('current_flags', buildDebugNotificationArgs(debugIds.current, {
                includePriority: true,
                includeSound: true,
                includeIcon: true,
            })),
            probeNotificationVariant('no_icon', buildDebugNotificationArgs(debugIds.noIcon, {
                includePriority: true,
                includeSound: true,
                includeIcon: false,
            })),
            probeTermuxBin('termux-vibrate', ['-d', '200']),
            probeTermuxBin('termux-wake-lock', []),
            probeTermuxBin('termux-wake-unlock', []),
            probeTermuxBin('termux-notification-list', []),
        ])
        : [];

    if (includeProbes) {
        await delay(500);
    }

    const notificationList = await readNotificationList();
    const termuxStatus = getTermuxStatus();
    return {
        binDir: termuxStatus.binDir,
        isTermuxAvailable: termuxStatus.available,
        termuxCheckedAt: termuxStatus.checkedAt,
        includeProbes,
        screenState: await readScreenState(),
        probes,
        recentAttempts: recentAttempts.slice(0, 12),
        notificationList,
        debugNotificationIds: debugIds,
        notificationChannelNote: 'Retry Mobile notifications are posted through Termux:API, not the persistent Termux session notification.',
    };
}

function buildDebugNotificationArgs(id, options = {}) {
    const args = [
        '--id', String(id),
        '--title', 'RM-test',
        '--content', `debug probe ${id}`,
    ];
    if (options.includePriority) {
        args.push('--priority', 'high');
    }
    if (options.includeSound) {
        args.push('--sound');
    }
    if (options.includeIcon) {
        args.push('--icon', 'ic_notification_overlay');
    }
    return args;
}

async function probeNotificationVariant(variant, args) {
    const result = await probeTermuxBin('termux-notification', args);
    return {
        ...result,
        variant,
        args,
    };
}

function createDebugNotificationIds() {
    const base = Date.now() % 2147482647;
    return {
        minimal: String(base + 11),
        current: String(base + 12),
        noIcon: String(base + 13),
    };
}

async function readNotificationList() {
    const result = await probeTermuxBin('termux-notification-list', []);
    if (!result.found) {
        return {
            available: false,
            reason: result.reason,
        };
    }

    const notifications = tryParseJson(result.stdout);
    return {
        available: true,
        exitCode: result.exitCode,
        error: result.error,
        stderr: result.stderr,
        count: Array.isArray(notifications) ? notifications.length : 0,
        notifications: Array.isArray(notifications)
            ? notifications.slice(0, 20)
            : [],
        raw: Array.isArray(notifications) ? '' : result.stdout,
    };
}

async function attachNotificationSnapshot(attempt) {
    await delay(400);
    const snapshot = await readNotificationList();
    const notificationId = readNotificationId(attempt.args);
    const notifications = Array.isArray(snapshot.notifications) ? snapshot.notifications : [];
    attempt.notificationSnapshot = {
        available: snapshot.available,
        notificationId,
        count: snapshot.count,
        match: notificationId
            ? notifications.find((entry) => String(entry?.id) === String(notificationId)) || null
            : null,
        error: snapshot.error || null,
        stderr: snapshot.stderr || '',
    };
}

function readNotificationId(args) {
    const list = Array.isArray(args) ? args : [];
    const index = list.indexOf('--id');
    if (index === -1) {
        return '';
    }
    return String(list[index + 1] || '');
}

function readScreenState() {
    return new Promise((resolve) => {
        execFile('/system/bin/dumpsys', ['power'], { timeout: 3000 }, (error, stdout, stderr) => {
            if (error) {
                resolve({
                    available: false,
                    error: String(error.message || error).slice(0, MAX_CAPTURE_LENGTH),
                    stderr: String(stderr || '').trim().slice(0, MAX_CAPTURE_LENGTH),
                });
                return;
            }

            const lines = String(stdout || '')
                .split(/\r?\n/)
                .map((line) => line.trim())
                .filter((line) => line)
                .filter((line) => /wakefulness|interactive|display power|screen state/i.test(line))
                .slice(0, 12);
            resolve({
                available: true,
                summary: lines.join(' | '),
                lines,
            });
        });
    });
}

function tryParseJson(text) {
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
}

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function detectTermuxStatus() {
    const binDir = TERMUX_BIN_DIRS.find((dir) => {
        try {
            return fs.statSync(dir).isDirectory();
        } catch {
            return false;
        }
    }) ?? null;

    return {
        available: binDir !== null,
        checkedAt: new Date().toISOString(),
        binDir,
    };
}

module.exports = {
    acquireWakeLock,
    debugNotifier,
    getTermuxStatus,
    isTermuxAvailable,
    notify,
    refreshTermuxStatusForStart,
    releaseWakeLock,
};
