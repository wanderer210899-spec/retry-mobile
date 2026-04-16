import { QUICK_REPLY_SET_NAME, SLASH_COMMAND_PREFIX } from './constants.js';

const BUTTON_SPECS = Object.freeze([
    {
        label: 'Start Retry',
        automationId: 'retry-mobile-arm',
        message: `/${SLASH_COMMAND_PREFIX}-start`,
        icon: 'fa-tower-broadcast',
        title: 'Arm Retry Mobile for the next qualifying generation request',
    },
    {
        label: 'Stop Retry',
        automationId: 'retry-mobile-stop',
        message: `/${SLASH_COMMAND_PREFIX}-stop`,
        icon: 'fa-hand',
        title: 'Stop the armed or running Retry Mobile job',
    },
    {
        label: 'Open Panel',
        automationId: 'retry-mobile-panel',
        message: `/${SLASH_COMMAND_PREFIX}-panel`,
        icon: 'fa-sliders',
        title: 'Focus the Retry Mobile settings panel',
    },
    {
        label: 'Run Diagnostics',
        automationId: 'retry-mobile-diagnostics',
        message: `/${SLASH_COMMAND_PREFIX}-diagnostics`,
        icon: 'fa-stethoscope',
        title: 'Run Retry Mobile diagnostics',
    },
]);

export function getQuickReplyStatus() {
    const api = getQuickReplyApi();
    if (!api) {
        return {
            ok: false,
            reason: 'Quick Reply API unavailable',
        };
    }

    const set = api.getSetByName?.(QUICK_REPLY_SET_NAME) ?? null;
    const globalSets = api.listGlobalSets?.() ?? [];
    const chatSets = api.listChatSets?.() ?? [];
    const attachedGlobal = globalSets.includes(QUICK_REPLY_SET_NAME);
    const attachedChat = chatSets.includes(QUICK_REPLY_SET_NAME);
    const automationIds = Array.isArray(set?.qrList)
        ? set.qrList.map((item) => item?.automationId).filter(Boolean)
        : [];

    return {
        ok: true,
        setExists: Boolean(set),
        attached: attachedGlobal || attachedChat,
        attachedGlobal,
        attachedChat,
        buttonCount: BUTTON_SPECS.filter((spec) => automationIds.includes(spec.automationId)).length,
    };
}

export function setQuickReplyAttached(enabled) {
    const api = getQuickReplyApi();
    if (!api) {
        return {
            ok: false,
            reason: 'Quick Reply API unavailable',
        };
    }

    if (!enabled) {
        detachSet(api, QUICK_REPLY_SET_NAME);
        return {
            ok: true,
            ...getQuickReplyStatus(),
        };
    }

    const set = api.getSetByName?.(QUICK_REPLY_SET_NAME)
        ?? api.createSet?.(QUICK_REPLY_SET_NAME, {
            disableSend: false,
            placeBeforeInput: false,
            injectInput: false,
        });

    if (!set) {
        return { ok: false, reason: 'Could not create QR set' };
    }

    BUTTON_SPECS.forEach((spec) => {
        ensureButton(api, QUICK_REPLY_SET_NAME, spec);
    });

    attachGlobalSet(api, QUICK_REPLY_SET_NAME);
    return {
        ok: true,
        ...getQuickReplyStatus(),
    };
}

function getQuickReplyApi() {
    return window.quickReplyApi && typeof window.quickReplyApi === 'object'
        ? window.quickReplyApi
        : null;
}

function ensureButton(api, setName, spec) {
    const set = api.getSetByName?.(setName);
    if (!set?.qrList) {
        return null;
    }

    const existing = set.qrList.find((item) => item?.automationId === spec.automationId);
    if (existing?.message === spec.message && existing?.label === spec.label) {
        return existing;
    }

    if (existing) {
        deleteButton(api, setName, existing);
    }

    return api.createQuickReply?.(setName, spec.label, {
        message: spec.message,
        title: spec.title,
        icon: spec.icon,
        showLabel: true,
        automationId: spec.automationId,
    }) ?? null;
}

function deleteButton(api, setName, button) {
    if (typeof api.deleteQuickReply === 'function') {
        api.deleteQuickReply(setName, button.label);
        return;
    }

    button.delete?.();
}

function attachGlobalSet(api, setName) {
    const names = api.listGlobalSets?.() ?? [];
    if (!names.includes(setName)) {
        api.addGlobalSet?.(setName);
    }
}

function detachSet(api, setName) {
    const globalSets = api.listGlobalSets?.() ?? [];
    if (globalSets.includes(setName)) {
        api.removeGlobalSet?.(setName);
    }

    const chatSets = api.listChatSets?.() ?? [];
    if (chatSets.includes(setName)) {
        api.removeChatSet?.(setName);
    }
}
