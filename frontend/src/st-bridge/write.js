// st-bridge/write.js
// Applies accepted-output writes onto the live SillyTavern chat host.
// Phase 3: swipes are appended directly into the in-memory chat array and
// persisted via context.saveChat() — no foreground saveReply, no DOM mutation,
// no scroll, no MESSAGE_RECEIVED / CHARACTER_MESSAGE_RENDERED emission.
// The user's current swipe position is never touched.

import { createStructuredError } from '../retry-error.js';
import { getChatIdentity, getContext } from './internal/ctx.js';
import { isSameChat, reloadCurrentChatSafe } from './inspect.js';
import {
    readMessageText,
    waitForMessageElement,
    waitForUiSettled,
} from './internal/dom-readiness.js';
import {
    RENDER_MESSAGE_RETRY_WAIT_MS,
    TERMINAL_UI_SETTLE_RETRY_TIMEOUT_MS,
} from '../constants.js';

export async function applyAcceptedOutput({ chatIdentity, status, signal }) {
    const context = getContext();
    const liveIdentity = getChatIdentity(context);
    if (!context || !isSameChat(chatIdentity, liveIdentity)) {
        return {
            ok: false,
            recoveryRequired: false,
            error: createStructuredError(
                'client_chat_changed',
                'Retry Mobile could not apply an accepted output because the active chat changed.',
            ),
        };
    }

    const targetMessageVersion = Number(status?.targetMessageVersion) || 0;
    const targetMessage = cloneValue(status?.targetMessage);
    const targetAssistantAnchorId = String(
        status?.targetAssistantAnchorId
        || targetMessage?.extra?.retryMobileAssistantAnchorId
        || '',
    ).trim();
    const liveChat = Array.isArray(context?.chat) ? context.chat : null;
    if (!targetMessage || !liveChat || liveChat.length === 0 || !targetAssistantAnchorId) {
        return {
            ok: false,
            recoveryRequired: true,
            error: createStructuredError(
                'client_target_missing',
                'Retry Mobile could not find a valid accepted output to apply.',
            ),
        };
    }

    // The target assistant turn must be the live last row; anchor matching guards against drift.
    const lastIndex = liveChat.length - 1;
    const lastMessage = liveChat[lastIndex];
    if (!lastMessage || lastMessage.is_user === true || targetMessage.is_user === true) {
        return {
            ok: false,
            recoveryRequired: true,
            error: createStructuredError(
                'client_patch_unsafe',
                'Retry Mobile could not safely patch the target assistant turn.',
            ),
        };
    }

    if (!assistantTargetMatches(lastMessage, targetMessage, targetAssistantAnchorId)) {
        return {
            ok: false,
            recoveryRequired: true,
            error: createStructuredError(
                'client_anchor_mismatch',
                'Retry Mobile refused to patch a live assistant turn whose anchor no longer matches backend truth.',
            ),
        };
    }

    // Detect structural drift: if we've applied before (liveVersion > 0) but we're
    // more than one backend write behind (targetMessageVersion > liveVersion + 1),
    // the live message content may have drifted (e.g. user-edited swipe). Force
    // a recovery reconcile rather than silently patching on a stale base.
    const liveVersion = Number(lastMessage?.extra?.retryMobileTargetVersion) || 0;
    if (liveVersion > 0 && targetMessageVersion > 0 && liveVersion < targetMessageVersion - 1) {
        return {
            ok: false,
            recoveryRequired: true,
            error: createStructuredError(
                'client_target_version_drift',
                'Retry Mobile detected a version gap on the live assistant turn indicating mid-run drift.',
            ),
        };
    }

    const element = await waitForPatchedMessageElement(lastIndex, signal);
    if (!element) {
        return {
            ok: false,
            recoveryRequired: true,
            error: createStructuredError(
                'client_target_dom_missing',
                'Retry Mobile could not find the target assistant message in the live chat.',
            ),
        };
    }

    ensureSwipeShape(lastMessage);
    stampAnchorOnLiveRow(lastMessage, targetAssistantAnchorId);

    const backendSwipes = Array.isArray(targetMessage.swipes) ? targetMessage.swipes : [];
    const liveSwipeCount = lastMessage.swipes.length;
    const missingSwipes = backendSwipes
        .slice(liveSwipeCount)
        .map((swipe) => String(swipe ?? ''));

    if (missingSwipes.length === 0) {
        stampVersionOnLiveRow(lastMessage, targetMessageVersion);
        return {
            ok: true,
            jobId: String(status?.jobId || ''),
            status,
            targetMessageVersion,
        };
    }

    try {
        // Append swipes directly into memory without touching swipe_id or mes.
        // saveReply({type:'swipe'}) is a foreground API — it overwrites mes and
        // calls addOneMessage which scrolls and re-renders, jumping the user to
        // the new slot on every iteration. Direct push + saveChat() keeps the
        // user's current swipe position intact (silent background append).
        for (const swipeText of missingSwipes) {
            if (signal?.aborted) {
                return {
                    ok: false,
                    recoveryRequired: false,
                    error: createStructuredError(
                        'client_chat_changed',
                        'Retry Mobile aborted swipe replay because the operation was cancelled.',
                    ),
                };
            }

            lastMessage.swipes.push(swipeText);
            lastMessage.swipe_info.push({
                send_date: new Date().toISOString(),
                gen_started: null,
                gen_finished: new Date().toISOString(),
                extra: { retryMobileAssistantAnchorId: targetAssistantAnchorId },
            });
        }

        stampAnchorOnLiveRow(lastMessage, targetAssistantAnchorId);
        stampVersionOnLiveRow(lastMessage, targetMessageVersion);

        // Persist the in-memory swipes array to disk via ST's normal save path.
        await context.saveChat?.();

        return {
            ok: true,
            jobId: String(status?.jobId || ''),
            status,
            targetMessageVersion,
        };
    } catch (error) {
        return {
            ok: false,
            recoveryRequired: true,
            error: createStructuredError(
                'client_patch_failed',
                error instanceof Error ? error.message : 'Retry Mobile could not patch the accepted output.',
            ),
        };
    }
}

export function assistantTargetMatches(message, targetMessage, expectedAnchorId) {
    const liveAnchorId = getAssistantAnchorId(message);
    if (liveAnchorId) {
        return liveAnchorId === expectedAnchorId
            || canAdoptPreviouslyAnchoredSeedTurn(message, targetMessage);
    }

    return canAdoptUnanchoredSeedTurn(message, targetMessage);
}

function ensureSwipeShape(message) {
    if (!Array.isArray(message.swipes)) {
        const seedText = String(message.mes ?? '');
        message.swipes = seedText ? [seedText] : [];
    }
    if (!Array.isArray(message.swipe_info)) {
        message.swipe_info = message.swipes.map(() => ({}));
    }
    while (message.swipe_info.length < message.swipes.length) {
        message.swipe_info.push({});
    }
    if (!Number.isInteger(message.swipe_id) || message.swipe_id < 0 || message.swipe_id >= message.swipes.length) {
        message.swipe_id = message.swipes.length > 0 ? Math.max(0, message.swipes.length - 1) : 0;
    }
    if (!message.extra || typeof message.extra !== 'object') {
        message.extra = {};
    }
}

function stampVersionOnLiveRow(message, version) {
    if (!message.extra || typeof message.extra !== 'object') {
        message.extra = {};
    }
    message.extra.retryMobileTargetVersion = Number(version) || 0;
}

function stampAnchorOnLiveRow(message, anchorId) {
    if (!message.extra || typeof message.extra !== 'object') {
        message.extra = {};
    }
    message.extra.retryMobileAssistantAnchorId = anchorId;
    if (!Array.isArray(message.swipe_info)) {
        return;
    }
    for (const info of message.swipe_info) {
        if (!info || typeof info !== 'object') {
            continue;
        }
        if (!info.extra || typeof info.extra !== 'object') {
            info.extra = {};
        }
        info.extra.retryMobileAssistantAnchorId = anchorId;
    }
}

function getAssistantAnchorId(message) {
    const direct = String(message?.extra?.retryMobileAssistantAnchorId || '').trim();
    if (direct) {
        return direct;
    }

    const swipeInfo = Array.isArray(message?.swipe_info) ? message.swipe_info : [];
    for (const row of swipeInfo) {
        const candidate = String(row?.extra?.retryMobileAssistantAnchorId || '').trim();
        if (candidate) {
            return candidate;
        }
    }

    return '';
}

function canAdoptUnanchoredSeedTurn(message, targetMessage) {
    if (!messageHasMeaningfulContent(message)) {
        return true;
    }

    if (String(targetMessage?.extra?.retryMobileAssistantAnchorId || '').trim()) {
        return true;
    }

    const visibleText = normalizeComparableText(message?.mes);
    if (!visibleText) {
        return true;
    }

    if (visibleText === normalizeComparableText(targetMessage?.mes)) {
        return true;
    }

    const targetSwipes = Array.isArray(targetMessage?.swipes) ? targetMessage.swipes : [];
    return targetSwipes.some((swipe) => normalizeComparableText(swipe) === visibleText);
}

function canAdoptPreviouslyAnchoredSeedTurn(message, targetMessage) {
    if (!messageHasMeaningfulContent(message)) {
        return true;
    }

    const liveSwipes = getMeaningfulSwipes(message);
    const targetSwipes = getMeaningfulSwipes(targetMessage);
    if (liveSwipes.length > 0) {
        if (targetSwipes.length < liveSwipes.length) {
            return false;
        }

        return liveSwipes.every((swipe, index) => swipe === targetSwipes[index]);
    }

    const visibleText = normalizeComparableText(message?.mes);
    if (!visibleText) {
        return true;
    }

    if (visibleText === normalizeComparableText(targetMessage?.mes)) {
        return true;
    }

    return targetSwipes.some((swipe) => swipe === visibleText);
}

function getMeaningfulSwipes(message) {
    const swipes = Array.isArray(message?.swipes) ? message.swipes : [];
    return swipes
        .map((swipe) => normalizeComparableText(swipe))
        .filter(Boolean);
}

function messageHasMeaningfulContent(message) {
    if (normalizeComparableText(message?.mes)) {
        return true;
    }

    const swipes = Array.isArray(message?.swipes) ? message.swipes : [];
    return swipes.some((swipe) => Boolean(normalizeComparableText(swipe)));
}

function normalizeText(value) {
    return String(value ?? '')
        .replace(/\r\n/g, '\n')
        .trim();
}

function normalizeComparableText(value) {
    let text = normalizeText(value);
    const contentBlocks = [...text.matchAll(/<content\b[^>]*>([\s\S]*?)<\/content>/giu)]
        .map((match) => normalizeText(match[1]))
        .filter(Boolean);
    if (contentBlocks.length > 0) {
        text = contentBlocks.join('\n\n');
    }

    return normalizeText(text
        .replace(/<(thinking|reasoning|analysis)\b[^>]*>[\s\S]*?<\/\1>/giu, '')
        .replace(/<report\b[^>]*>[\s\S]*?<\/report>/giu, '')
        .replace(/<\/?content\b[^>]*>/giu, '')
        .replace(/<\/?[^>]+>/gu, ''));
}

export async function finishTerminalUi({ outcome, status, chatIdentity, signal }) {
    const applyResult = await applyFinalMessageIfNeeded({ chatIdentity, status, signal });
    try {
        const settled = await waitForTerminalUiWithRetry(signal);
        if (!settled) {
            return {
                ok: false,
                recoveryRequired: true,
                error: createStructuredError(
                    'client_terminal_settle_failed',
                    'Retry Mobile could not settle SillyTavern UI after the run ended.',
                ),
            };
        }

        return {
            ok: true,
            outcome,
            appliedVersion: applyResult.appliedVersion,
        };
    } catch (error) {
        return {
            ok: false,
            recoveryRequired: true,
            error: createStructuredError(
                'client_terminal_cleanup_failed',
                error instanceof Error ? error.message : 'Retry Mobile could not finish terminal UI cleanup.',
            ),
        };
    }
}

export async function reloadSessionUi(signal) {
    const ok = await reloadCurrentChatSafe();
    if (signal?.aborted) {
        return false;
    }

    return ok;
}

async function applyFinalMessageIfNeeded({ chatIdentity, status, signal }) {
    const targetMessageIndex = Number(status?.targetMessageIndex);
    const targetMessage = cloneValue(status?.targetMessage);
    if (!Number.isInteger(targetMessageIndex) || targetMessageIndex < 0 || !targetMessage) {
        return { appliedVersion: 0 };
    }

    const element = await waitForPatchedMessageElement(targetMessageIndex, signal);
    if (!element) {
        return { appliedVersion: 0 };
    }

    const expectedText = String(targetMessage.extra?.display_text ?? targetMessage.mes ?? '').trim();
    if (!expectedText) {
        return { appliedVersion: Number(status?.targetMessageVersion) || 0 };
    }

    const currentText = readMessageText(element);
    if (currentText === expectedText) {
        return { appliedVersion: Number(status?.targetMessageVersion) || 0 };
    }

    const result = await applyAcceptedOutput({ chatIdentity, status, signal });
    if (!result.ok) {
        throw new Error(result.error?.message || 'Could not update the final assistant message.');
    }

    return {
        appliedVersion: result.targetMessageVersion,
    };
}

function cloneValue(value) {
    if (value == null) {
        return null;
    }

    if (typeof structuredClone === 'function') {
        return structuredClone(value);
    }

    return JSON.parse(JSON.stringify(value));
}

async function waitForPatchedMessageElement(targetMessageIndex, signal) {
    const element = await waitForMessageElement(targetMessageIndex, { signal });
    if (element) {
        return element;
    }

    return waitForMessageElement(targetMessageIndex, {
        signal,
        timeoutMs: RENDER_MESSAGE_RETRY_WAIT_MS,
    });
}

async function waitForTerminalUiWithRetry(signal) {
    let settled = await waitForUiSettled({ signal });
    if (settled) {
        return true;
    }

    settled = await waitForUiSettled({
        signal,
        timeoutMs: TERMINAL_UI_SETTLE_RETRY_TIMEOUT_MS,
    });
    return settled;
}
