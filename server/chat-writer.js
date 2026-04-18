const fs = require('node:fs');
const path = require('node:path');

const { createStructuredError } = require('./retry-error');
const { saveChatThroughSt } = require('./st-runtime');

async function writeAcceptedResult(job, accepted) {
    assertWritePathReady(job);

    let currentChat = await readCurrentChat(job);
    assertChatStillMatches(job, currentChat);

    let targetIndex = null;
    try {
        targetIndex = ensureAssistantSlotForWrite(job, currentChat);
    } catch (error) {
        if (!shouldUseConfirmedWriteSafetyRecheck(job, false, error)) {
            throw error;
        }

        currentChat = readChatJsonl(getSaveTarget(job).filePath);
        assertChatStillMatches(job, currentChat);
        try {
            targetIndex = ensureAssistantSlotForWrite(job, currentChat);
        } catch (secondError) {
            if (shouldUseConfirmedWriteSafetyRecheck(job, true, secondError)) {
                throw createStructuredError(
                    'native_persist_unresolved',
                    'Retry Mobile confirmed the native turn in the browser, but the saved chat still did not expose the assistant slot for writing.',
                );
            }

            throw secondError;
        }
    }

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

    try {
        await persistLiveChat(job, currentChat);
    } catch (error) {
        const messageText = String(error?.message || error || '');
        if (/integrity/i.test(messageText)) {
            throw createStructuredError(
                'write_conflict',
                'Retry Mobile stopped because SillyTavern rejected the save due to a chat integrity mismatch.',
                messageText,
            );
        }

        throw createStructuredError(
            'backend_write_failed',
            'Retry Mobile could not save the updated swipe set back to the live chat.',
            messageText,
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

function inspectNativeAssistantState(job) {
    const saveTarget = getSaveTarget(job);
    let chat = null;

    try {
        chat = readChatJsonl(saveTarget.filePath);
    } catch {
        return { kind: 'target_pending' };
    }

    const integrityState = getIntegrityState(job, chat);
    if (integrityState === 'mismatch') {
        return { kind: 'target_pending' };
    }

    const userState = resolveTargetUserState(job, chat);
    if (userState.kind === 'missing_appendable') {
        return {
            kind: canCreateMissingUserAnchor(job, chat)
                ? 'missing_user_anchor'
                : 'target_pending',
            persistedUserIndex: userState.persistedUserIndex,
        };
    }
    if (userState.kind !== 'present') {
        return { kind: 'target_pending' };
    }

    return inspectAdjacentAssistantState(job, chat);
}

function inspectRecoverySnapshot(job) {
    const persistedFloor = Number(job.acceptedCount) || 0;
    let chat = null;

    try {
        const saveTarget = getSaveTarget(job);
        chat = readChatJsonl(saveTarget.filePath);
    } catch {
        return buildRecoveryResult('backend_restarted', persistedFloor, 0, 'Retry Mobile could not read the live chat while recovering a persisted job.');
    }

    const integrityState = getIntegrityState(job, chat);
    if (integrityState === 'mismatch') {
        return buildRecoveryResult(
            persistedFloor > 0 ? 'recovery_ambiguous' : 'backend_restarted',
            persistedFloor,
            0,
            'The saved chat integrity changed before Retry Mobile could reconcile the recovered job.',
        );
    }

    const userState = resolveTargetUserState(job, chat);
    if (userState.kind !== 'present') {
        return buildRecoveryResult(
            persistedFloor > 0 ? 'recovery_ambiguous' : 'backend_restarted',
            persistedFloor,
            0,
            'Retry Mobile could not resolve the captured user turn while recovering the persisted job.',
        );
    }

    const assistantState = inspectAdjacentAssistantState(job, chat);
    if (assistantState.kind === 'missing_assistant') {
        return buildRecoveryResult(
            persistedFloor > 0 ? 'recovery_ambiguous' : 'backend_restarted',
            persistedFloor,
            0,
            'The captured assistant turn was still missing when Retry Mobile recovered the persisted job.',
        );
    }

    const liveCeiling = countTaggedAcceptedResults(job, assistantState.assistantMessage);
    if (liveCeiling < persistedFloor || (liveCeiling === 0 && persistedFloor > 0)) {
        return buildRecoveryResult(
            'recovery_ambiguous',
            persistedFloor,
            liveCeiling,
            'The saved chat contains fewer Retry Mobile-tagged swipes than the persisted snapshot expected.',
        );
    }

    const resolvedAcceptedCount = liveCeiling > persistedFloor ? liveCeiling : persistedFloor;
    if (resolvedAcceptedCount >= Number(job.targetAcceptedCount || 0)) {
        return buildRecoveryResult(
            'completed_on_recovery',
            persistedFloor,
            liveCeiling,
            `Recovered ${resolvedAcceptedCount} accepted swipes from the live chat after backend restart.`,
            resolvedAcceptedCount,
        );
    }

    if (resolvedAcceptedCount > 0) {
        return buildRecoveryResult(
            'partial_on_recovery',
            persistedFloor,
            liveCeiling,
            `Recovered ${resolvedAcceptedCount} accepted swipes from the live chat, but the run did not reach its target before backend restart.`,
            resolvedAcceptedCount,
        );
    }

    return buildRecoveryResult(
        'backend_restarted',
        persistedFloor,
        liveCeiling,
        'Retry Mobile restarted before it could confirm any accepted swipes from the recovered job.',
    );
}

async function readCurrentChat(job) {
    const saveTarget = getSaveTarget(job);
    const maxAttempts = 12;
    const delayMs = 300;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const liveChat = readChatJsonl(saveTarget.filePath);
        if (Array.isArray(liveChat) && liveChat.length > 0) {
            const integrityState = getIntegrityState(job, liveChat);
            if (integrityState === 'mismatch') {
                throw createStructuredError(
                    'chat_context_changed',
                    'Retry Mobile stopped because the saved chat integrity changed after capture.',
                );
            }

            const userState = resolveTargetUserState(job, liveChat);
            if (userState.kind === 'present') {
                return liveChat;
            }

            if (userState.kind === 'missing_appendable' && canCreateMissingUserAnchor(job, liveChat)) {
                insertUserMessage(job, liveChat, userState.persistedUserIndex);
                try {
                    await persistLiveChat(job, liveChat);
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
    const integrityState = getIntegrityState(job, chat);
    if (integrityState === 'mismatch') {
        throw createStructuredError(
            'chat_context_changed',
            'Retry Mobile stopped because the saved chat integrity changed after capture.',
        );
    }

    const userState = resolveTargetUserState(job, chat);
    if (userState.kind !== 'present') {
        throw createStructuredError(
            'backend_turn_missing',
            'Target user turn could not be resolved.',
        );
    }
}

function assertWritePathReady(job) {
    if (job?.nativeResolutionInProgress === true || job?.phase === 'native_confirming_persisted') {
        throw createStructuredError(
            'native_write_not_ready',
            'Retry Mobile blocked the write path because native persistence confirmation is still in progress.',
        );
    }

    if (job?.nativeState === 'pending') {
        throw createStructuredError(
            'native_write_not_ready',
            'Retry Mobile blocked the write path because the native turn has not resolved yet.',
        );
    }
}

function shouldUseConfirmedWriteSafetyRecheck(job, recheckUsed, error) {
    return job?.nativeState === 'confirmed'
        && job?.phase !== 'native_confirming_persisted'
        && job?.nativeResolutionInProgress !== true
        && recheckUsed !== true
        && String(error?.code || '') === 'backend_turn_missing';
}

function ensureAssistantSlotForWrite(job, chat) {
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

    if (userState.kind === 'missing_appendable' && canCreateMissingUserAnchor(job, chat)) {
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

function canCreateMissingUserAnchor(job, chat) {
    return shouldCreateMissingUserAnchor(job)
        && getIntegrityState(job, chat) === 'match'
        && Number.isFinite(Number(job.capturedChatLength))
        && (chat.length - getPersistedChatOffset(chat)) === Number(job.capturedChatLength);
}

function getIntegrityState(job, chat) {
    const expected = typeof job.capturedChatIntegrity === 'string' ? job.capturedChatIntegrity.trim() : '';
    if (!expected) {
        return 'missing';
    }

    const actual = String(chat?.[0]?.chat_metadata?.integrity || '').trim();
    if (!actual) {
        return 'missing';
    }

    return actual === expected ? 'match' : 'mismatch';
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

async function persistLiveChat(job, chatData) {
    const saveTarget = getSaveTarget(job);
    return await saveChatThroughSt({
        chatData,
        filePath: saveTarget.filePath,
        skipIntegrityCheck: false,
        handle: job.userContext.handle,
        cardName: saveTarget.cardName,
        backupDirectory: job.userContext.directories.backups,
    });
}

function buildRecoveryResult(reason, floor, ceiling, detail, acceptedCount = null) {
    return {
        reason,
        floor,
        ceiling,
        acceptedCount: acceptedCount == null ? floor : acceptedCount,
        detail,
    };
}

function countTaggedAcceptedResults(job, assistantMessage) {
    let count = 0;
    const swipeInfo = Array.isArray(assistantMessage?.swipe_info) ? assistantMessage.swipe_info : [];
    for (const row of swipeInfo) {
        if (String(row?.extra?.retryMobileJobId || '') === String(job.jobId)) {
            count += 1;
        }
    }

    if (count === 0 && String(assistantMessage?.extra?.retryMobileJobId || '') === String(job.jobId)) {
        count = 1;
    }

    return count;
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
    assertWritePathReady,
    inspectNativeAssistantState,
    inspectRecoverySnapshot,
    shouldUseConfirmedWriteSafetyRecheck,
    writeAcceptedResult,
};
