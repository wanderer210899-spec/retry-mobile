import {
    RENDER_MESSAGE_POLL_MS,
    RENDER_MESSAGE_WAIT_MS,
    RENDER_STABLE_TEXT_INTERVAL_MS,
    RENDER_STABLE_TEXT_TIMEOUT_MS,
    TERMINAL_UI_SETTLE_TIMEOUT_MS,
} from '../constants.js';

export async function waitForMessageElement(messageId, { signal, timeoutMs = RENDER_MESSAGE_WAIT_MS } = {}) {
    const startedAt = Date.now();
    while (!signal?.aborted && Date.now() - startedAt <= timeoutMs) {
        const element = document.querySelector(`.mes[mesid="${messageId}"]`);
        if (element) {
            return element;
        }
        await delay(RENDER_MESSAGE_POLL_MS, signal);
    }
    return null;
}

export async function waitForStableText(element, { signal, timeoutMs = RENDER_STABLE_TEXT_TIMEOUT_MS } = {}) {
    const startedAt = Date.now();
    let previous = '';
    while (!signal?.aborted && Date.now() - startedAt <= timeoutMs) {
        const next = readMessageText(element);
        if (next && next === previous) {
            return next;
        }
        previous = next;
        await delay(RENDER_STABLE_TEXT_INTERVAL_MS, signal);
    }
    return '';
}

export async function waitForUiSettled({ signal, timeoutMs = TERMINAL_UI_SETTLE_TIMEOUT_MS } = {}) {
    const startedAt = Date.now();
    while (!signal?.aborted && Date.now() - startedAt <= timeoutMs) {
        const lastMessage = document.querySelector('.mes.last_mes');
        if (!document.body?.dataset?.generating && lastMessage) {
            return true;
        }
        await delay(RENDER_MESSAGE_POLL_MS, signal);
    }
    return false;
}

export function readMessageText(element) {
    const target = element?.querySelector?.('.mes_text') || element;
    return String(target?.textContent || '').trim();
}

export async function delay(ms, signal) {
    if (signal?.aborted) {
        return;
    }

    await new Promise((resolve) => {
        const handle = window.setTimeout(resolve, ms);
        if (signal) {
            signal.addEventListener('abort', () => {
                window.clearTimeout(handle);
                resolve();
            }, { once: true });
        }
    });
}
