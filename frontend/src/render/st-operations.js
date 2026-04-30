import { createStructuredError } from '../retry-error.js';
import { getChatIdentity, getContext } from '../st-context.js';
import { isSameChat, reloadCurrentChatSafe } from '../st-chat.js';
import { readMessageText, waitForMessageElement, waitForStableText, waitForUiSettled } from './readiness.js';
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

    const targetMessageIndex = Number(status?.targetMessageIndex);
    const targetMessageVersion = Number(status?.targetMessageVersion) || 0;
    const targetMessage = cloneValue(status?.targetMessage);
    const targetAssistantAnchorId = String(
        status?.targetAssistantAnchorId
        || targetMessage?.extra?.retryMobileAssistantAnchorId
        || '',
    ).trim();
    const liveChat = Array.isArray(context?.chat) ? context.chat : null;
    if (!Number.isInteger(targetMessageIndex) || targetMessageIndex < 0 || !targetMessage || !liveChat || !targetAssistantAnchorId) {
        return {
            ok: false,
            recoveryRequired: true,
            error: createStructuredError(
                'client_target_missing',
                'Retry Mobile could not find a valid accepted output to apply.',
            ),
        };
    }

    const element = await waitForPatchedMessageElement(targetMessageIndex, signal);
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

    const existing = liveChat[targetMessageIndex];
    if (!existing || existing.is_user === true || targetMessage.is_user === true) {
        return {
            ok: false,
            recoveryRequired: true,
            error: createStructuredError(
                'client_patch_unsafe',
                'Retry Mobile could not safely patch the target assistant turn.',
            ),
        };
    }

    const adoptedTargetMessage = adoptTargetMessageForVisibleHost(existing, targetMessage, targetAssistantAnchorId);
    if (!adoptedTargetMessage) {
        return {
            ok: false,
            recoveryRequired: true,
            error: createStructuredError(
                'client_anchor_mismatch',
                'Retry Mobile refused to patch a live assistant turn whose anchor no longer matches backend truth.',
            ),
        };
    }

    const patchedMessage = buildPatchedAssistantMessage(existing, adoptedTargetMessage);
    liveChat[targetMessageIndex] = patchedMessage;

    try {
        // Preserve the user's current scroll position when patching a message.
        // ST's message rerender can alter layout; we must not yank the user to the updated turn.
        const chatContainer = document.getElementById('chat') || document.querySelector('#chat');
        const prevScrollTop = chatContainer ? chatContainer.scrollTop : null;
        const prevScrollHeight = chatContainer ? chatContainer.scrollHeight : null;
        const prevClientHeight = chatContainer ? chatContainer.clientHeight : null;
        const wasNearBottom = chatContainer
            && prevScrollTop != null
            && prevScrollHeight != null
            && prevClientHeight != null
            ? (prevScrollTop + prevClientHeight >= prevScrollHeight - 12)
            : false;

        context.updateMessageBlock?.(targetMessageIndex, patchedMessage);
        context.swipe?.refresh?.(true);
        await waitForStableText(element, { signal });

        if (chatContainer && prevScrollTop != null && !wasNearBottom) {
            chatContainer.scrollTop = prevScrollTop;
        }
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

export function buildPatchedAssistantMessage(existing, targetMessage) {
    const patchedMessage = {
        ...existing,
        ...targetMessage,
    };

    preserveLiveSwipeSelection(patchedMessage, existing, targetMessage);
    return patchedMessage;
}

export function adoptTargetMessageForVisibleHost(existing, targetMessage, expectedAnchorId) {
    if (!assistantTargetMatches(existing, targetMessage, expectedAnchorId)) {
        return null;
    }

    return buildTargetMessageForVisibleHost(existing, targetMessage);
}

export function assistantTargetMatches(message, targetMessage, expectedAnchorId) {
    const liveAnchorId = getAssistantAnchorId(message);
    if (liveAnchorId) {
        return liveAnchorId === expectedAnchorId
            || canAdoptPreviouslyAnchoredSeedTurn(message, targetMessage);
    }

    return canAdoptUnanchoredSeedTurn(message, targetMessage);
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

function buildTargetMessageForVisibleHost(existing, targetMessage) {
    const nextTarget = cloneValue(targetMessage) || {};
    const liveSelectedText = normalizeComparableText(resolveSwipeText(existing, existing?.swipe_id));
    if (!liveSelectedText) {
        return nextTarget;
    }

    const targetSwipes = Array.isArray(nextTarget.swipes) ? nextTarget.swipes : [];
    const matchingIndex = targetSwipes.findIndex((swipe) => normalizeComparableText(swipe) === liveSelectedText);
    if (matchingIndex < 0) {
        return nextTarget;
    }

    nextTarget.swipe_id = matchingIndex;
    syncVisibleFieldsToSwipe(nextTarget, matchingIndex, {
        fallbackMes: resolveSwipeText(nextTarget, matchingIndex),
        fallbackExtra: nextTarget.extra || existing?.extra || {},
        fallbackTimestamp: firstString(
            existing?.send_date,
            existing?.gen_finished,
            existing?.gen_started,
            nextTarget?.send_date,
            nextTarget?.gen_finished,
            nextTarget?.gen_started,
        ),
    });
    return nextTarget;
}

function preserveLiveSwipeSelection(message, liveMessage, targetMessage) {
    const targetSwipes = Array.isArray(targetMessage?.swipes) ? targetMessage.swipes : [];
    if (targetSwipes.length === 0) {
        return;
    }

    const liveSwipeId = clampSwipeId(liveMessage?.swipe_id, targetSwipes.length);
    const liveSelectedText = normalizeComparableText(resolveSwipeText(liveMessage, liveSwipeId));
    const targetSelectedText = normalizeComparableText(resolveSwipeText(targetMessage, liveSwipeId));
    if (!liveSelectedText || liveSelectedText !== targetSelectedText) {
        return;
    }

    syncVisibleFieldsToSwipe(message, liveSwipeId, {
        fallbackMes: resolveSwipeText(targetMessage, liveSwipeId) || liveMessage?.mes || '',
        fallbackExtra: targetMessage?.extra || liveMessage?.extra || {},
        fallbackTimestamp: firstString(
            liveMessage?.send_date,
            liveMessage?.gen_finished,
            liveMessage?.gen_started,
            targetMessage?.send_date,
            targetMessage?.gen_finished,
            targetMessage?.gen_started,
        ),
    });
}

function resolveSwipeText(message, swipeId) {
    const swipes = Array.isArray(message?.swipes) ? message.swipes : [];
    if (swipeId >= 0 && swipeId < swipes.length) {
        return String(swipes[swipeId] ?? '');
    }

    return String(message?.mes ?? '');
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

function syncVisibleFieldsToSwipe(message, swipeId, options = {}) {
    const swipes = Array.isArray(message?.swipes) ? message.swipes : [];
    const resolvedSwipeId = clampSwipeId(swipeId, swipes.length);
    const activeSwipeInfo = Array.isArray(message?.swipe_info)
        ? message.swipe_info[resolvedSwipeId]
        : null;
    const activeTimestamp = firstString(
        activeSwipeInfo?.send_date,
        activeSwipeInfo?.gen_finished,
        activeSwipeInfo?.gen_started,
        options.fallbackTimestamp,
    );

    message.swipe_id = resolvedSwipeId;
    message.mes = String(swipes[resolvedSwipeId] ?? options.fallbackMes ?? '');
    message.extra = cloneValue(activeSwipeInfo?.extra || options.fallbackExtra || {});
    message.send_date = activeTimestamp;
    message.gen_started = firstString(activeSwipeInfo?.gen_started, activeTimestamp);
    message.gen_finished = firstString(activeSwipeInfo?.gen_finished, activeTimestamp);
}

function clampSwipeId(value, swipeCount) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || swipeCount <= 0) {
        return 0;
    }

    return Math.max(0, Math.min(Math.trunc(numeric), swipeCount - 1));
}

function firstString(...values) {
    for (const value of values) {
        const text = String(value ?? '').trim();
        if (text) {
            return text;
        }
    }

    return '';
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
    const context = getContext();
    try {
        context?.activateSendButtons?.();
        context?.swipe?.refresh?.(true);
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
    let element = await waitForMessageElement(targetMessageIndex, { signal });
    if (element) {
        return element;
    }

    const context = getContext();
    context?.swipe?.refresh?.(true);
    element = await waitForMessageElement(targetMessageIndex, {
        signal,
        timeoutMs: RENDER_MESSAGE_RETRY_WAIT_MS,
    });
    return element;
}

async function waitForTerminalUiWithRetry(signal) {
    let settled = await waitForUiSettled({ signal });
    if (settled) {
        return true;
    }

    const context = getContext();
    context?.activateSendButtons?.();
    context?.swipe?.refresh?.(true);
    settled = await waitForUiSettled({
        signal,
        timeoutMs: TERMINAL_UI_SETTLE_RETRY_TIMEOUT_MS,
    });
    return settled;
}
