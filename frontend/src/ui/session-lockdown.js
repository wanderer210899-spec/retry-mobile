const BLOCKED_CLICK_SELECTORS = [
    '#send_but',
    '.last_mes .swipe_right',
    '.last_mes .swipe_left',
    '#option_regenerate',
    '#option_continue',
    '#mes_continue',
    '#mes_impersonate',
];

const ENTER_BLOCK_SELECTORS = [
    '#send_textarea',
];

const BLOCKED_SHORTCUT_KEYS = new Set([
    'ArrowLeft',
    'ArrowRight',
    'F5',
]);

const TOAST_THROTTLE_MS = 1800;

export function createSessionLockdown({
    getContext,
    showToast,
    translate,
    documentRef = document,
    observerFactory = (handler) => new MutationObserver(handler),
    now = () => Date.now(),
} = {}) {
    let active = false;
    let clickHandler = null;
    let keydownHandler = null;
    let observer = null;
    let lastToastAt = 0;
    let sendBusyOriginalIconClasses = null;

    return {
        enable() {
            if (active) {
                refreshBusyVisual();
                return true;
            }
            active = true;
            bindListeners();
            refreshBusyVisual();
            return true;
        },
        disable() {
            if (!active) {
                restoreSendButton();
                return true;
            }
            active = false;
            unbindListeners();
            restoreSendButton();
            return true;
        },
        isActive() {
            return active;
        },
    };

    function bindListeners() {
        clickHandler = (event) => {
            const element = toElement(event?.target);
            if (!element) {
                return;
            }
            if (!matchesBlockedClick(element)) {
                return;
            }
            blockEvent(event);
            emitBlockedToast();
        };

        keydownHandler = (event) => {
            const element = toElement(event?.target);
            if (!element) {
                return;
            }

            // Block enter submit from the chat textarea.
            if (event?.key === 'Enter' && !event?.shiftKey && matchesAnySelector(element, ENTER_BLOCK_SELECTORS)) {
                blockEvent(event);
                emitBlockedToast();
                return;
            }

            // Block common generation shortcuts while retry owns the run.
            const hasShortcutModifier = Boolean(event?.ctrlKey || event?.metaKey || event?.altKey);
            if (hasShortcutModifier && BLOCKED_SHORTCUT_KEYS.has(String(event?.key || ''))) {
                blockEvent(event);
                emitBlockedToast();
            }
        };

        documentRef.addEventListener?.('click', clickHandler, true);
        documentRef.addEventListener?.('keydown', keydownHandler, true);

        observer = observerFactory(() => {
            if (active) {
                refreshBusyVisual();
            }
        });
        try {
            observer.observe?.(documentRef.body || documentRef.documentElement, {
                childList: true,
                subtree: true,
            });
        } catch {
            observer = null;
        }
    }

    function unbindListeners() {
        if (clickHandler) {
            documentRef.removeEventListener?.('click', clickHandler, true);
        }
        if (keydownHandler) {
            documentRef.removeEventListener?.('keydown', keydownHandler, true);
        }
        clickHandler = null;
        keydownHandler = null;
        if (observer) {
            observer.disconnect?.();
        }
        observer = null;
    }

    function refreshBusyVisual() {
        const sendButton = documentRef.getElementById?.('send_but');
        if (!sendButton?.classList) {
            return false;
        }
        if (!sendBusyOriginalIconClasses) {
            sendBusyOriginalIconClasses = detectFaIconNameClasses(sendButton);
            if (sendBusyOriginalIconClasses.length === 0) {
                sendBusyOriginalIconClasses = ['fa-paper-plane'];
            }
        }

        detectFaIconNameClasses(sendButton).forEach((name) => sendButton.classList.remove(name));
        sendButton.classList.add('fa-solid');
        sendButton.classList.add('fa-spinner');
        sendButton.classList.add('fa-spin');
        return true;
    }

    function restoreSendButton() {
        const sendButton = documentRef.getElementById?.('send_but');
        if (!sendButton?.classList) {
            sendBusyOriginalIconClasses = null;
            return false;
        }

        sendButton.classList.remove('fa-spinner');
        sendButton.classList.remove('fa-spin');
        detectFaIconNameClasses(sendButton).forEach((name) => sendButton.classList.remove(name));
        (sendBusyOriginalIconClasses || []).forEach((name) => sendButton.classList.add(name));
        sendBusyOriginalIconClasses = null;
        return true;
    }

    function emitBlockedToast() {
        const current = now();
        if (current - lastToastAt < TOAST_THROTTLE_MS) {
            return;
        }
        lastToastAt = current;
        const title = String(translate?.('toasts.title') || 'Retry Mobile');
        const message = String(translate?.('toasts.interactionBlocked') || 'Interaction is blocked while retry is running.');
        showToast?.('warning', title, message);

        try {
            getContext?.()?.stopGeneration?.();
        } catch {}
    }
}

function matchesBlockedClick(element) {
    return matchesAnySelector(element, BLOCKED_CLICK_SELECTORS);
}

function matchesAnySelector(element, selectors) {
    return selectors.some((selector) => element.closest?.(selector));
}

function blockEvent(event) {
    try {
        event.preventDefault?.();
        event.stopImmediatePropagation?.();
        event.stopPropagation?.();
    } catch {}
}

function toElement(target) {
    if (!target || typeof target !== 'object') {
        return null;
    }
    return 'closest' in target ? target : null;
}

function detectFaIconNameClasses(element) {
    const classes = element?.classList ? Array.from(element.classList) : [];
    return classes.filter((name) => (
        name.startsWith('fa-')
        && name !== 'fa-solid'
        && name !== 'fa-regular'
        && name !== 'fa-brands'
        && name !== 'fa-spin'
        && name !== 'fa-spinner'
        && name !== 'fa-lg'
        && name !== 'fa-fw'
        && name !== 'fa-xs'
        && name !== 'fa-sm'
        && name !== 'fa-xl'
        && name !== 'fa-2xl'
        && name !== 'fa-pull-left'
        && name !== 'fa-pull-right'
    ));
}
