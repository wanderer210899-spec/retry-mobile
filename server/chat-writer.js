const fs = require('node:fs');
const path = require('node:path');
const { createStructuredError } = require('./retry-error');

async function writeAcceptedResult(job, accepted) {
    const currentChat = await readCurrentChat(job);
    assertChatStillMatches(job, currentChat);

    const targetIndex = ensureTargetAssistantMessage(job, currentChat);
    const targetMessage = currentChat[targetIndex];
    const timestamp = new Date().toISOString();

    targetMessage.swipes.push(accepted.text);
    targetMessage.swipe_info.push(createSwipeInfo(timestamp, targetMessage.extra));
    targetMessage.swipe_id = targetMessage.swipes.length - 1;
    targetMessage.mes = accepted.text;

    targetMessage.send_date = timestamp;
    targetMessage.gen_started = timestamp;
    targetMessage.gen_finished = timestamp;
    targetMessage.extra = {
        ...(targetMessage.extra || {}),
        retryMobileJobId: job.jobId,
        retryMobileAcceptedCount: job.acceptedCount + 1,
        retryMobileWordCount: accepted.wordCount,
        retryMobileTokenCount: accepted.tokenCount,
        model: firstString(job.capturedRequest?.model, targetMessage.extra?.model),
    };

    const saveTarget = getSaveTarget(job);
    try {
        saveChatJsonl(currentChat, saveTarget.filePath);
    } catch (error) {
        throw createStructuredError(
            'backend_write_failed',
            'Retry Mobile could not save the updated swipe set back to the live chat.',
            error instanceof Error ? error.message : String(error),
        );
    }

    job.targetMessageIndex = targetIndex;
    job.targetMessageVersion += 1;
    job.targetMessage = clone(targetMessage);

    return {
        targetMessageIndex: targetIndex,
        targetMessageVersion: job.targetMessageVersion,
        targetMessage: job.targetMessage,
    };
}

async function readCurrentChat(job) {
    const saveTarget = getSaveTarget(job);
    const maxAttempts = 12;
    const delayMs = 300;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const liveChat = readChatJsonl(saveTarget.filePath);
        if (Array.isArray(liveChat) && liveChat.length > 0 && liveChatContainsTargetTurn(job, liveChat)) {
            return liveChat;
        }

        if (attempt < maxAttempts) {
            await sleep(delayMs);
        }
    }

    throw createStructuredError(
        'backend_turn_missing',
        'Retry Mobile could not confirm the live chat on disk before appending a swipe.',
        `Polled "${saveTarget.filePath}" ${maxAttempts} times (${maxAttempts * delayMs}ms) without finding the target turn.`,
    );
}

function assertChatStillMatches(job, chat) {
    const fingerprint = job.targetFingerprint;
    const userIndex = getPersistedUserIndex(job, chat);
    if (!Number.isFinite(userIndex) || userIndex < 0) {
        throw createStructuredError(
            'backend_turn_missing',
            'Target user turn could not be resolved.',
        );
    }

    const current = chat[userIndex];
    if (!current || current.is_user !== true) {
        throw createStructuredError(
            'backend_turn_missing',
            'The target user turn no longer exists as a user message.',
        );
    }

    if (typeof fingerprint?.userMessageText === 'string' && current.mes !== fingerprint.userMessageText) {
        throw createStructuredError(
            'backend_turn_changed',
            'The target user turn changed after capture, so Retry Mobile stopped instead of guessing.',
        );
    }
}

function liveChatContainsTargetTurn(job, chat) {
    const fingerprint = job.targetFingerprint;
    const userIndex = getPersistedUserIndex(job, chat);
    if (!Number.isFinite(userIndex) || userIndex < 0) {
        return false;
    }

    const current = chat[userIndex];
    if (!current || current.is_user !== true) {
        return false;
    }

    if (typeof fingerprint?.userMessageText === 'string' && current.mes !== fingerprint.userMessageText) {
        return false;
    }

    return true;
}

function ensureTargetAssistantMessage(job, chat) {
    const targetIndex = getPersistedAssistantIndex(job, chat);
    const targetMessage = Number.isFinite(targetIndex) && targetIndex >= 0
        ? chat[targetIndex]
        : null;
    if (!targetMessage || targetMessage.is_user === true) {
        throw createStructuredError(
            'backend_turn_missing',
            'The native assistant turn was missing when Retry Mobile tried to append a swipe.',
        );
    }

    const previousMessage = chat[targetIndex - 1];
    if (previousMessage?.is_user !== true || previousMessage.mes !== job.targetFingerprint?.userMessageText) {
        throw createStructuredError(
            'backend_turn_changed',
            'The live assistant target no longer points at the captured user turn.',
        );
    }

    normalizeSwipeShape(targetMessage);
    job.targetMessageIndex = targetIndex - getPersistedChatOffset(chat);
    return targetIndex;
}

function normalizeSwipeShape(message) {
    if (!Array.isArray(message.swipes) || message.swipes.length === 0) {
        message.swipes = [String(message.mes ?? '')];
    }

    if (!Array.isArray(message.swipe_info) || message.swipe_info.length !== message.swipes.length) {
        message.swipe_info = message.swipes.map(() => createSwipeInfo(
            firstString(message.send_date, new Date().toISOString()),
            message.extra,
        ));
    }

    if (typeof message.swipe_id !== 'number' || message.swipe_id < 0 || message.swipe_id >= message.swipes.length) {
        message.swipe_id = Math.max(0, message.swipes.length - 1);
    }
}

function createSwipeInfo(timestamp, extra = {}) {
    return {
        send_date: timestamp,
        gen_started: timestamp,
        gen_finished: timestamp,
        extra: clone(extra || {}),
    };
}

function getSaveTarget(job) {
    const directories = job.userContext.directories;
    if (job.chatIdentity?.kind === 'group') {
        const id = String(job.chatIdentity.groupId || job.chatIdentity.chatId || '');
        if (!id) {
            throw createStructuredError(
                'backend_write_failed',
                'Retry Mobile could not resolve the group chat identity needed to locate the chat file.',
            );
        }
        return {
            filePath: path.join(directories.groupChats, sanitizeFileName(`${id}.jsonl`)),
            cardName: id,
        };
    }

    const cardName = String(job.chatIdentity.avatarUrl || '').replace('.png', '').trim();
    if (!cardName) {
        throw createStructuredError(
            'backend_write_failed',
            'Retry Mobile could not resolve the character avatar name needed to locate the chat file. Ensure the character has an avatar set.',
            `avatarUrl received: "${job.chatIdentity.avatarUrl}"`,
        );
    }
    const fileName = `${String(job.chatIdentity.fileName || job.chatIdentity.chatId || 'chat')}.jsonl`;
    return {
        filePath: path.join(directories.chats, cardName, sanitizeFileName(fileName)),
        cardName,
    };
}

function getPersistedUserIndex(job, chat) {
    const liveIndex = Number(job.targetFingerprint?.userMessageIndex);
    if (!Number.isFinite(liveIndex) || liveIndex < 0) {
        return -1;
    }

    return liveIndex + getPersistedChatOffset(chat);
}

function getPersistedAssistantIndex(job, chat) {
    const liveIndex = Number(job.assistantMessageIndex);
    if (!Number.isFinite(liveIndex) || liveIndex < 0) {
        return -1;
    }

    return liveIndex + getPersistedChatOffset(chat);
}

function getPersistedChatOffset(chat) {
    const firstRow = Array.isArray(chat) ? chat[0] : null;
    return firstRow && typeof firstRow === 'object' && firstRow.chat_metadata
        ? 1
        : 0;
}

function readChatJsonl(filePath) {
    let raw = '';
    try {
        raw = fs.readFileSync(filePath, 'utf8');
    } catch (error) {
        throw createStructuredError(
            'backend_turn_missing',
            `Retry Mobile could not read the chat file at the expected path.`,
            error instanceof Error ? error.message : String(error),
        );
    }

    const lines = raw.split('\n').filter((line) => line.trim());
    const parsed = [];
    for (const line of lines) {
        try {
            parsed.push(JSON.parse(line));
        } catch {
        }
    }
    return parsed;
}

function saveChatJsonl(chatData, filePath) {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    const jsonl = chatData.map((row) => JSON.stringify(row)).join('\n');
    fs.writeFileSync(filePath, jsonl, 'utf8');
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function clone(value) {
    return JSON.parse(JSON.stringify(value ?? null));
}

function firstString(...values) {
    for (const value of values) {
        if (typeof value === 'string' && value.trim()) {
            return value.trim();
        }
    }

    return '';
}

function sanitizeFileName(value) {
    return String(value ?? '')
        .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_')
        .replace(/\.+$/g, '')
        .trim();
}

module.exports = {
    writeAcceptedResult,
};
