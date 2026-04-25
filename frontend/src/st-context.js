import { REQUIRED_EVENT_NAMES, REQUIRED_PAYLOAD_KEYS } from './constants.js';

export function getContext() {
    return window.SillyTavern?.getContext?.() ?? null;
}

export function getEventTypes(context = getContext()) {
    return context?.eventTypes ?? {};
}

export function getEventSource(context = getContext()) {
    return context?.eventSource ?? null;
}

export function subscribeEvent(eventName, handler, context = getContext()) {
    const source = getEventSource(context);
    if (!source || typeof source.on !== 'function') {
        return () => {};
    }

    source.on(eventName, handler);
    return () => {
        if (typeof source.off === 'function') {
            source.off(eventName, handler);
            return;
        }

        if (typeof source.removeListener === 'function') {
            source.removeListener(eventName, handler);
        }
    };
}

export function getChatIdentity(context = getContext()) {
    if (!context) {
        return null;
    }

    const chatId = safeInvoke(context.getCurrentChatId) ?? firstString(context.chatId, context.chat_id);
    const groupId = firstString(context.groupId, context.group_id, context.selectedGroup, context.selected_group);
    const characterRecord = getSelectedCharacterRecord(context);
    const avatarUrl = firstString(
        characterRecord?.avatar,
        characterRecord?.avatar_url,
    );
    const assistantName = firstString(
        context.name2,
        context.characterName,
        context.character_name,
        characterRecord?.name,
        context.chatMetadata?.character_name,
        'Assistant',
    );

    return {
        kind: groupId ? 'group' : 'character',
        chatId: chatId ? String(chatId) : '',
        fileName: chatId ? String(chatId) : '',
        groupId: groupId ? String(groupId) : null,
        avatarUrl,
        assistantName,
    };
}

export function getUserMessageIndexFromEvent(messageId) {
    if (typeof messageId === 'number' && Number.isFinite(messageId) && messageId >= 0) {
        return messageId;
    }

    return null;
}

export function getCurrentChatArray(context = getContext()) {
    return Array.isArray(context?.chat) ? context.chat : [];
}

export async function runDryRunProbe(context = getContext()) {
    if (!context?.generate) {
        return {
            ok: false,
            reason: 'generate() is unavailable',
        };
    }

    try {
        await context.generate('normal', {}, true);
        return { ok: true };
    } catch (error) {
        return {
            ok: false,
            reason: error instanceof Error ? error.message : String(error),
        };
    }
}

export function getCapabilityReport(context = getContext()) {
    const eventTypes = getEventTypes(context);
    const eventSource = getEventSource(context);
    const requiredEvents = REQUIRED_EVENT_NAMES.map((name) => ({
        name,
        present: Boolean(eventTypes?.[name]),
    }));

    return {
        hasContext: Boolean(context),
        hasEventSource: Boolean(eventSource && typeof eventSource.on === 'function'),
        hasGenerate: typeof context?.generate === 'function',
        hasStopGeneration: typeof context?.stopGeneration === 'function',
        hasSaveChat: typeof context?.saveChat === 'function',
        hasQuickReplyApi: Boolean(window.quickReplyApi && typeof window.quickReplyApi === 'object'),
        hasSlashCommands: Boolean(context?.SlashCommandParser && context?.SlashCommand?.fromProps),
        requiredEvents,
        requiredPayloadKeys: [...REQUIRED_PAYLOAD_KEYS],
    };
}

export function payloadHasRequiredKeys(payload) {
    if (!payload || typeof payload !== 'object') {
        return false;
    }

    const hasChatCompletionShape = 'chat_completion_source' in payload && Array.isArray(payload.messages);
    if (hasChatCompletionShape) {
        return true;
    }

    const hasTextCompletionShape = typeof payload.prompt === 'string'
        && payload.prompt.length > 0
        && typeof payload.api_type === 'string'
        && payload.api_type.length > 0
        && typeof payload.api_server === 'string'
        && payload.api_server.length > 0;
    return hasTextCompletionShape;
}

export function clonePayload(payload) {
    if (typeof structuredClone === 'function') {
        return structuredClone(payload);
    }

    return JSON.parse(JSON.stringify(payload));
}

export function showToast(kind, title, message) {
    const target = window.toastr;
    const fn = target?.[kind] ?? target?.info;
    fn?.(message, title);
}

export function focusPanelDrawer(drawerElement) {
    if (!drawerElement) {
        drawerElement = document.getElementById('retry-mobile-panel');
        if (!drawerElement) {
            return;
        }
    }

    let ancestor = drawerElement.parentElement;
    while (ancestor && ancestor !== document.body) {
        if (ancestor.classList.contains('closedDrawer')) {
            if (ancestor.previousElementSibling) {
                ancestor.previousElementSibling.click?.();
            }
        }
        ancestor = ancestor.parentElement;
    }

    const openDrawer = () => {
        const toggle = drawerElement.querySelector?.('.inline-drawer-toggle');
        const content = drawerElement.querySelector?.('.inline-drawer-content');
        const isCollapsed = drawerElement.classList.contains('inline-drawer-closed')
            || (content != null && window.getComputedStyle(content).display === 'none');

        if (!toggle) {
            return !isCollapsed;
        }

        if (isCollapsed) {
            // Some mobile WebViews occasionally swallow the first click; do both:
            // 1) click the toggle
            // 2) force the "open" class that ST's own drawers rely on
            toggle.click?.();
            drawerElement.classList.add('open');
        }

        return true;
    };

    // Attempt immediately (avoids timing flake on mobile).
    drawerElement.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
    const didAttempt = openDrawer();
    if (!didAttempt) {
        return;
    }

    // Retry once on the next frame in case layout/host mounts lag behind the command.
    window.requestAnimationFrame(() => {
        drawerElement.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
        openDrawer();
    });
}

export function registerSlashCommand(context, {
    name,
    aliases = [],
    callback,
    helpString,
}) {
    const parser = context?.SlashCommandParser;
    const SlashCommand = context?.SlashCommand;
    if (!parser?.addCommandObject || !SlashCommand?.fromProps || typeof callback !== 'function') {
        return () => {};
    }

    const command = SlashCommand.fromProps({
        name,
        aliases,
        callback: async (namedArgs = {}, value = '') => {
            await callback({
                namedArgs,
                unnamedArgs: typeof value === 'string' ? value : String(value ?? ''),
                value,
            });
            return '';
        },
        helpString,
        interruptsGeneration: false,
        purgeFromMessage: true,
        unnamedArgumentList: [],
        namedArgumentList: [],
        isHidden: false,
    });

    parser.addCommandObject(command);
    return () => {
        if (parser?.commands?.[name] === command) {
            delete parser.commands[name];
        }

        aliases.forEach((alias) => {
            if (parser?.commands?.[alias] === command) {
                delete parser.commands[alias];
            }
        });
    };
}

function safeInvoke(fn) {
    if (typeof fn !== 'function') {
        return null;
    }

    try {
        return fn();
    } catch {
        return null;
    }
}

function getSelectedCharacterRecord(context) {
    const characters = Array.isArray(context?.characters) ? context.characters : null;
    const rawCharacterId = context?.characterId;
    if (!characters || rawCharacterId == null) {
        return null;
    }

    const byKey = characters[rawCharacterId];
    if (byKey && typeof byKey === 'object') {
        return byKey;
    }

    const numericId = Number(rawCharacterId);
    if (Number.isInteger(numericId) && characters[numericId] && typeof characters[numericId] === 'object') {
        return characters[numericId];
    }

    return null;
}

function firstString(...values) {
    for (const value of values) {
        if (typeof value === 'string' && value.trim()) {
            return value.trim();
        }
    }

    return '';
}
