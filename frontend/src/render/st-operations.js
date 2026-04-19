import { createStructuredError } from '../retry-error.js';
import { getChatIdentity, getContext } from '../st-context.js';
import { isSameChat, reloadCurrentChatSafe } from '../st-chat.js';
import { readMessageText, waitForMessageElement, waitForStableText, waitForUiSettled } from './readiness.js';

export async function applyAcceptedOutput({ chatIdentity, status, signal }) {
    const context = getContext();
    const liveIdentity = getChatIdentity(context);
    if (!context || !isSameChat(chatIdentity, liveIdentity)) {
        return {
            ok: false,
            recoveryRequired: false,
            error: createStructuredError(
                'capture_chat_changed',
                'Retry Mobile could not apply an accepted output because the active chat changed.',
            ),
        };
    }

    const targetMessageIndex = Number(status?.targetMessageIndex);
    const targetMessageVersion = Number(status?.targetMessageVersion) || 0;
    const targetMessage = cloneValue(status?.targetMessage);
    const liveChat = Array.isArray(context?.chat) ? context.chat : null;
    if (!Number.isInteger(targetMessageIndex) || targetMessageIndex < 0 || !targetMessage || !liveChat) {
        return {
            ok: false,
            recoveryRequired: true,
            error: createStructuredError(
                'backend_write_failed',
                'Retry Mobile could not find a valid accepted output to apply.',
            ),
        };
    }

    const element = await waitForMessageElement(targetMessageIndex, { signal });
    if (!element) {
        return {
            ok: false,
            recoveryRequired: true,
            error: createStructuredError(
                'backend_write_failed',
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
                'backend_write_failed',
                'Retry Mobile could not safely patch the target assistant turn.',
            ),
        };
    }

    liveChat[targetMessageIndex] = {
        ...existing,
        ...targetMessage,
    };

    try {
        context.updateMessageBlock?.(targetMessageIndex, liveChat[targetMessageIndex]);
        context.swipe?.refresh?.(true);
        await waitForStableText(element, { signal });
        return {
            ok: true,
            jobId: String(status?.jobId || ''),
            targetMessageVersion,
        };
    } catch (error) {
        return {
            ok: false,
            recoveryRequired: true,
            error: createStructuredError(
                'backend_write_failed',
                error instanceof Error ? error.message : 'Retry Mobile could not patch the accepted output.',
            ),
        };
    }
}

export async function finishTerminalUi({ outcome, status, chatIdentity, signal }) {
    const applyResult = await applyFinalMessageIfNeeded({ chatIdentity, status, signal });
    const context = getContext();
    try {
        context?.activateSendButtons?.();
        context?.swipe?.refresh?.(true);
        const settled = await waitForUiSettled({ signal });
        if (!settled) {
            return {
                ok: false,
                recoveryRequired: true,
                error: createStructuredError(
                    'backend_write_failed',
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
                'backend_write_failed',
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

    const element = await waitForMessageElement(targetMessageIndex, { signal });
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
