const fs = require('node:fs');
const path = require('node:path');
const { createStructuredError } = require('./retry-error');

async function writeAcceptedResult(job, accepted) {
    const currentChat = await readCurrentChat(job);
    assertChatStillMatches(job, currentChat);

    const targetIndex = ensureTargetAssistantMessage(job, currentChat);
    const targetMessage = currentChat[targetIndex];
    const timestamp = new Date().toISOString();
    const nextExtra = buildAcceptedExtra(job, targetMessage.extra, accepted);
    const shouldSeedResult = job.acceptedCount === 0 && !messageHasMeaningfulContent(targetMessage);

    targetMessage.extra = nextExtra;
    targetMessage.send_date = timestamp;
    targetMessage.gen_started = timestamp;
    targetMessage.gen_finished = timestamp;
    targetMessage.mes = accepted.text;

    if (shouldSeedResult) {
        targetMessage.swipes = [accepted.text];
        targetMessage.swipe_info = [createSwipeInfo(timestamp, nextExtra)];
        targetMessage.swipe_id = 0;
    } else {
        normalizeSwipeShape(targetMessage);
        targetMessage.swipes.push(accepted.text);
        targetMessage.swipe_info.push(createSwipeInfo(timestamp, nextExtra));
        targetMessage.swipe_id = targetMessage.swipes.length - 1;
    }

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

    job.targetMessageIndex = targetIndex - getPersistedChatOffset(currentChat);
    job.targetMessageVersion += 1;
    job.targetMessage = clone(targetMessage);

    return {
        targetMessageIndex: job.targetMessageIndex,
        targetMessageVersion: job.targetMessageVersion,
        targetMessage: job.targetMessage,
    };
}

async function confirmNativeAssistantTurn(job, assistantMessageIndex) {
    const liveAssistantIndex = Number(assistantMessageIndex);
    if (!Number.isFinite(liveAssistantIndex) || liveAssistantIndex < 0) {
        throw createStructuredError(
            'handoff_request_failed',
            'Retry Mobile did not receive a valid native assistant turn to confirm.',
        );
    }

    const currentChat = await readCurrentChat(job);
    assertChatStillMatches(job, currentChat);

    const state = inspectAdjacentAssistantState(job, currentChat);
    if (state.kind === 'missing_assistant') {
        throw createStructuredError(
            'backend_turn_missing',
            'The native assistant turn was missing when Retry Mobile tried to confirm it.',
        );
    }

    if (state.assistantMessageIndex !== liveAssistantIndex) {
        throw createStructuredError(
            'backend_turn_changed',
            'The confirmed native assistant turn no longer matches the captured user turn.',
            `Expected live assistant index ${liveAssistantIndex}, found ${state.assistantMessageIndex}.`,
        );
    }

    job.assistantMessageIndex = liveAssistantIndex;
    job.targetMessageIndex = liveAssistantIndex;
    job.targetMessage = clone(state.assistantMessage);

    return {
        assistantMessageIndex: liveAssistantIndex,
        targetMessageIndex: liveAssistantIndex,
        targetMessage: job.targetMessage,
    };
}

function inspectNativeAssistantState(job) {
    const saveTarget = getSaveTarget(job);
    let chat = null;

    try {
        chat = readChatJsonl(saveTarget.filePath);
    } catch {
        return { kind: 'target_pending' };
    }

    const userState = resolveTargetUserState(job, chat);
    if (userState.kind === 'missing_appendable') {
        return {
            kind: 'missing_user_anchor',
            persistedUserIndex: userState.persistedUserIndex,
        };
    }
    if (userState.kind !== 'present') {
        return { kind: 'target_pending' };
    }

    return inspectAdjacentAssistantState(job, chat);
}

async function readCurrentChat(job) {
    const saveTarget = getSaveTarget(job);
    const maxAttempts = 12;
    const delayMs = 300;
    const allowCreateUserAnchor = shouldCreateMissingUserAnchor(job);

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const liveChat = readChatJsonl(saveTarget.filePath);
        if (Array.isArray(liveChat) && liveChat.length > 0) {
            const userState = resolveTargetUserState(job, liveChat);
            if (userState.kind === 'present') {
                return liveChat;
            }

            if (allowCreateUserAnchor && userState.kind === 'missing_appendable') {
                insertUserMessage(job, liveChat, userState.persistedUserIndex);
                try {
                    saveChatJsonl(liveChat, saveTarget.filePath);
                } catch (error) {
                    throw createStructuredError(
                        'backend_write_failed',
                        'Retry Mobile could not save the recreated captured user turn back to the live chat.',
                        error instanceof Error ? error.message : String(error),
                    );
                }
                return liveChat;
            }
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
    const userState = resolveTargetUserState(job, chat);
    if (userState.kind !== 'present') {
        throw createStructuredError(
            'backend_turn_missing',
            'Target user turn could not be resolved.',
        );
    }
}

function liveChatContainsTargetTurn(job, chat) {
    return resolveTargetUserState(job, chat).kind === 'present';
}

function ensureTargetAssistantMessage(job, chat) {
    ensureTargetUserMessage(job, chat);
    const state = inspectAdjacentAssistantState(job, chat);

    if (state.kind === 'missing_assistant') {
        if (job.recoveryMode === 'create_missing_turn') {
            const created = insertAssistantMessage(job, chat, state.persistedAssistantIndex);
            job.assistantMessageIndex = created.assistantMessageIndex;
            job.targetMessageIndex = created.assistantMessageIndex;
            return created.persistedAssistantIndex;
        }

        throw createStructuredError(
            'backend_turn_missing',
            'The native assistant turn was missing when Retry Mobile tried to append a swipe.',
        );
    }

    const previousMessage = chat[state.persistedAssistantIndex - 1];
    if (previousMessage?.is_user !== true || previousMessage.mes !== job.targetFingerprint?.userMessageText) {
        throw createStructuredError(
            'backend_turn_changed',
            'The live assistant target no longer points at the captured user turn.',
        );
    }

    job.assistantMessageIndex = state.assistantMessageIndex;
    job.targetMessageIndex = state.assistantMessageIndex;
    return state.persistedAssistantIndex;
}

function inspectAdjacentAssistantState(job, chat) {
    const persistedUserIndex = getPersistedUserIndex(job, chat);
    const persistedAssistantIndex = Number.isFinite(persistedUserIndex) && persistedUserIndex >= 0
        ? persistedUserIndex + 1
        : -1;
    const assistantMessage = persistedAssistantIndex >= 0
        ? chat[persistedAssistantIndex]
        : null;
    const assistantMessageIndex = persistedAssistantIndex >= 0
        ? persistedAssistantIndex - getPersistedChatOffset(chat)
        : null;

    if (!assistantMessage || assistantMessage.is_user === true) {
        return {
            kind: 'missing_assistant',
            persistedUserIndex,
            persistedAssistantIndex,
            assistantMessageIndex,
            assistantMessage: null,
        };
    }

    return {
        kind: messageHasMeaningfulContent(assistantMessage) ? 'filled' : 'empty_placeholder',
        persistedUserIndex,
        persistedAssistantIndex,
        assistantMessageIndex,
        assistantMessage,
    };
}

function ensureTargetUserMessage(job, chat) {
    const userState = resolveTargetUserState(job, chat);
    if (userState.kind === 'present') {
        return userState.persistedUserIndex;
    }

    if (userState.kind === 'missing_appendable' && shouldCreateMissingUserAnchor(job)) {
        return insertUserMessage(job, chat, userState.persistedUserIndex).persistedUserIndex;
    }

    throw createStructuredError(
        'backend_turn_missing',
        'Target user turn could not be resolved.',
    );
}

function insertAssistantMessage(job, chat, persistedAssistantIndex) {
    const message = buildAssistantSeedMessage(job);
    chat.splice(persistedAssistantIndex, 0, message);

    return {
        persistedAssistantIndex,
        assistantMessageIndex: persistedAssistantIndex - getPersistedChatOffset(chat),
        assistantMessage: message,
    };
}

function insertUserMessage(job, chat, persistedUserIndex) {
    const message = buildUserSeedMessage(job);
    chat.splice(persistedUserIndex, 0, message);
    return {
        persistedUserIndex,
        userMessage: message,
    };
}

function buildUserSeedMessage(job) {
    const message = {
        name: firstString(job.captureMeta?.userName, 'You'),
        is_user: true,
        is_system: false,
        send_date: new Date().toISOString(),
        mes: String(job.targetFingerprint?.userMessageText || ''),
        extra: {
            isSmallSys: false,
        },
    };

    const userAvatar = firstString(job.captureMeta?.userAvatar);
    if (userAvatar) {
        message.force_avatar = userAvatar;
    }

    return message;
}

function buildAssistantSeedMessage(job) {
    const extra = {};
    const model = firstString(job.capturedRequest?.model);
    const api = firstString(job.capturedRequest?.chat_completion_source);

    if (api) {
        extra.api = api;
    }

    if (model) {
        extra.model = model;
    }

    const message = {
        name: firstString(job.captureMeta?.assistantName, job.chatIdentity?.assistantName, 'Assistant'),
        is_user: false,
        is_system: false,
        send_date: '',
        mes: '',
        title: '',
        extra,
        swipes: [],
        swipe_info: [],
        swipe_id: 0,
    };

    if (job.chatIdentity?.avatarUrl) {
        message.original_avatar = job.chatIdentity.avatarUrl;
    }

    return message;
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

function messageHasMeaningfulContent(message) {
    if (!message || typeof message !== 'object') {
        return false;
    }

    if (normalizeText(message.mes)) {
        return true;
    }

    if (Array.isArray(message.swipes)) {
        return message.swipes.some((swipe) => Boolean(normalizeText(swipe)));
    }

    return false;
}

function normalizeText(value) {
    return String(value ?? '')
        .replace(/\r\n/g, '\n')
        .trim();
}

function createSwipeInfo(timestamp, extra = {}) {
    return {
        send_date: timestamp,
        gen_started: timestamp,
        gen_finished: timestamp,
        extra: clone(extra || {}),
    };
}

function buildAcceptedExtra(job, currentExtra, accepted) {
    return {
        ...(currentExtra || {}),
        retryMobileJobId: job.jobId,
        retryMobileAcceptedCount: job.acceptedCount + 1,
        retryMobileCharacterCount: accepted.characterCount,
        retryMobileWordCount: accepted.characterCount,
        retryMobileTokenCount: accepted.tokenCount,
        model: firstString(job.capturedRequest?.model, currentExtra?.model),
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

function resolveTargetUserState(job, chat) {
    const fingerprint = job.targetFingerprint;
    const persistedUserIndex = getPersistedUserIndex(job, chat);
    if (!Number.isFinite(persistedUserIndex) || persistedUserIndex < 0) {
        return { kind: 'missing_unresolved', persistedUserIndex };
    }

    const current = chat[persistedUserIndex];
    if (!current) {
        if (persistedUserIndex === chat.length) {
            return { kind: 'missing_appendable', persistedUserIndex };
        }

        return { kind: 'missing_unresolved', persistedUserIndex };
    }

    if (current.is_user !== true) {
        throw createStructuredError(
            'backend_turn_changed',
            'The target user turn changed after capture, so Retry Mobile stopped instead of guessing.',
        );
    }

    if (typeof fingerprint?.userMessageText === 'string' && current.mes !== fingerprint.userMessageText) {
        throw createStructuredError(
            'backend_turn_changed',
            'The target user turn changed after capture, so Retry Mobile stopped instead of guessing.',
        );
    }

    return {
        kind: 'present',
        persistedUserIndex,
        userMessage: current,
    };
}

function shouldCreateMissingUserAnchor(job) {
    return job.nativeState === 'abandoned' && job.recoveryMode === 'create_missing_turn';
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
            'Retry Mobile could not read the chat file at the expected path.',
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
    confirmNativeAssistantTurn,
    inspectNativeAssistantState,
    writeAcceptedResult,
};
