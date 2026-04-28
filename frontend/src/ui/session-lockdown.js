// Mirrors SillyTavern `OVERSWIPE_BEHAVIOR` string values from `scripts/constants.js`.
const OVERSWIPE = {
    NONE: 'none',
    LOOP: 'loop',
    PRISTINE_GREETING: 'pristine_greeting',
    EDIT_GENERATE: 'edit_generate',
    REGENERATE: 'regenerate',
};

/** @internal Used only for toast gating — not a DOM selector. */
const BLOCKED_LAST_SWIPE_RIGHT_GEN = 'blocked:last-swipe-right-gen';

const BLOCKED_CLICK_SELECTORS = [
    '#send_but',
    '#option_regenerate',
    '#option_continue',
    '#mes_continue',
    '#mes_impersonate',
];

const ENTER_BLOCK_SELECTORS = [
    '#send_textarea',
];

const TOAST_THROTTLE_MS = 1800;
const REGEN_SWIPE_MIN_DISTANCE_PX = 56;
const REGEN_SWIPE_MAX_VERTICAL_DRIFT_PX = 80;

export function createSessionLockdown({
    getContext,
    showToast,
    translate,
    documentRef = document,
    now = () => Date.now(),
} = {}) {
    let active = false;
    let clickHandler = null;
    let keydownHandler = null;
    let touchStartHandler = null;
    let touchEndHandler = null;
    let pointerDownHandler = null;
    let pointerUpHandler = null;
    let lastToastAt = 0;
    const gesture = {
        active: false,
        startX: 0,
        startY: 0,
        startedOnLastMessage: false,
        pointerId: null,
    };

    return {
        enable() {
            if (active) {
                return true;
            }
            active = true;
            bindListeners();
            return true;
        },
        disable() {
            if (!active) {
                return true;
            }
            active = false;
            unbindListeners();
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
            if (element.closest?.('.last_mes .swipe_right') && wouldLastMessageRightSwipeCauseGeneration(getContext?.())) {
                blockEvent(event);
                emitBlockedToast({
                    source: 'blocked_click',
                    blockedSelector: BLOCKED_LAST_SWIPE_RIGHT_GEN,
                });
                return;
            }
            const blockedSelector = resolveBlockedClickSelector(element);
            if (!blockedSelector) {
                return;
            }
            blockEvent(event);
            if (shouldToastForBlockedSelector(blockedSelector)) {
                emitBlockedToast({
                    source: 'blocked_click',
                    blockedSelector,
                });
            }
        };

        keydownHandler = (event) => {
            const element = toElement(event?.target);
            if (!element) {
                return;
            }

            if (event?.key === 'Enter' && !event?.shiftKey && matchesAnySelector(element, ENTER_BLOCK_SELECTORS)) {
                blockEvent(event);
                emitBlockedToast({
                    source: 'blocked_send',
                    kind: 'enter_submit',
                });
                return;
            }

            // Stock SillyTavern (RossAscends): unmodified ArrowRight with empty
            // send bar triggers `$('.swipe_right:last').click()` — block only
            // when that would overswipe into generation on the last message.
            if (event?.key === 'ArrowRight'
                && !keyboardEventHasModifier(event)
                && sendTextareaIsEmptyForSwipeHotkey(documentRef)
                && wouldLastMessageRightSwipeCauseGeneration(getContext?.())) {
                blockEvent(event);
                emitBlockedToast({
                    source: 'blocked_keyboard_swipe',
                    blockedSelector: BLOCKED_LAST_SWIPE_RIGHT_GEN,
                });
            }
        };

        touchStartHandler = (event) => {
            const point = getEventPoint(event);
            const element = toElement(event?.target);
            if (!point || !element) {
                return;
            }
            gesture.active = true;
            gesture.startX = point.x;
            gesture.startY = point.y;
            gesture.startedOnLastMessage = Boolean(element.closest?.('.last_mes'));
            gesture.pointerId = null;
        };

        touchEndHandler = (event) => {
            if (!gesture.active) {
                return;
            }
            const point = getEventPoint(event);
            const element = toElement(event?.target);
            const startX = gesture.startX;
            const startY = gesture.startY;
            const startedOnLastMessage = gesture.startedOnLastMessage;
            gesture.active = false;
            gesture.pointerId = null;
            if (!point || !element) {
                return;
            }
            const deltaX = point.x - startX;
            const deltaY = point.y - startY;
            const absX = Math.abs(deltaX);
            const absY = Math.abs(deltaY);
            const isHorizontalSwipe = absX >= REGEN_SWIPE_MIN_DISTANCE_PX && absY <= REGEN_SWIPE_MAX_VERTICAL_DRIFT_PX;
            if (!isHorizontalSwipe || !startedOnLastMessage) {
                return;
            }
            if (deltaX >= 0) {
                return;
            }
            if (!wouldLastMessageRightSwipeCauseGeneration(getContext?.())) {
                return;
            }
            blockEvent(event);
            emitBlockedToast({
                source: 'blocked_swipe',
                swipeDirection: 'right_to_left',
            });
        };

        pointerDownHandler = (event) => {
            if (!event || typeof event !== 'object') {
                return;
            }
            const element = toElement(event?.target);
            const point = getEventPoint(event);
            if (!element || !point) {
                return;
            }
            gesture.active = true;
            gesture.startX = point.x;
            gesture.startY = point.y;
            gesture.startedOnLastMessage = Boolean(element.closest?.('.last_mes'));
            gesture.pointerId = typeof event.pointerId === 'number' ? event.pointerId : null;
        };

        pointerUpHandler = (event) => {
            if (!gesture.active) {
                return;
            }
            if (gesture.pointerId != null && typeof event?.pointerId === 'number' && event.pointerId !== gesture.pointerId) {
                return;
            }
            const element = toElement(event?.target);
            const point = getEventPoint(event);
            const startX = gesture.startX;
            const startY = gesture.startY;
            const startedOnLastMessage = gesture.startedOnLastMessage;
            gesture.active = false;
            gesture.pointerId = null;
            if (!element || !point) {
                return;
            }
            const deltaX = point.x - startX;
            const deltaY = point.y - startY;
            const absX = Math.abs(deltaX);
            const absY = Math.abs(deltaY);
            const isHorizontalSwipe = absX >= REGEN_SWIPE_MIN_DISTANCE_PX && absY <= REGEN_SWIPE_MAX_VERTICAL_DRIFT_PX;
            if (!isHorizontalSwipe || !startedOnLastMessage) {
                return;
            }
            if (deltaX >= 0) {
                return;
            }
            if (!wouldLastMessageRightSwipeCauseGeneration(getContext?.())) {
                return;
            }
            blockEvent(event);
            emitBlockedToast({
                source: 'blocked_swipe',
                swipeDirection: 'right_to_left',
            });
        };

        documentRef.addEventListener?.('click', clickHandler, true);
        documentRef.addEventListener?.('keydown', keydownHandler, true);
        documentRef.addEventListener?.('touchstart', touchStartHandler, { capture: true, passive: false });
        documentRef.addEventListener?.('touchend', touchEndHandler, { capture: true, passive: false });
        documentRef.addEventListener?.('pointerdown', pointerDownHandler, { capture: true, passive: false });
        documentRef.addEventListener?.('pointerup', pointerUpHandler, { capture: true, passive: false });
    }

    function unbindListeners() {
        if (clickHandler) {
            documentRef.removeEventListener?.('click', clickHandler, true);
        }
        if (keydownHandler) {
            documentRef.removeEventListener?.('keydown', keydownHandler, true);
        }
        if (touchStartHandler) {
            documentRef.removeEventListener?.('touchstart', touchStartHandler, true);
        }
        if (touchEndHandler) {
            documentRef.removeEventListener?.('touchend', touchEndHandler, true);
        }
        if (pointerDownHandler) {
            documentRef.removeEventListener?.('pointerdown', pointerDownHandler, true);
        }
        if (pointerUpHandler) {
            documentRef.removeEventListener?.('pointerup', pointerUpHandler, true);
        }
        clickHandler = null;
        keydownHandler = null;
        touchStartHandler = null;
        touchEndHandler = null;
        pointerDownHandler = null;
        pointerUpHandler = null;
    }

    function emitBlockedToast(detail) {
        const current = now();
        if (current - lastToastAt < TOAST_THROTTLE_MS) {
            return;
        }
        lastToastAt = current;
        const title = String(translate?.('toasts.title') || 'Retry Mobile');
        const message = String(translate?.('toasts.interactionBlocked') || 'Interaction is blocked while retry is running.');
        showToast?.('warning', title, message);
        void detail;
    }
}

/**
 * True when the next SillyTavern SWIPE_DIRECTION.RIGHT on the last chat
 * message would enter overswipe with REGENERATE or EDIT_GENERATE (actual
 * generation), not when it only reveals another stored candidate.
 */
export function wouldLastMessageRightSwipeCauseGeneration(context) {
    if (!context || typeof context !== 'object') {
        return false;
    }
    const chat = context.chat;
    if (!Array.isArray(chat) || chat.length === 0) {
        return false;
    }
    const mesId = chat.length - 1;
    const message = chat[mesId];
    if (!isAssistantSwipeableMessage(message)) {
        return false;
    }
    const swipeId = Number(message.swipe_id ?? 0);
    const swipesLen = Math.max(1, Array.isArray(message.swipes) ? message.swipes.length : 1);
    const nextSwipeId = swipeId + 1;
    if (nextSwipeId < swipesLen) {
        return false;
    }
    const chatMetadata = context.chatMetadata ?? context.chat_metadata;
    const overswipe = resolveOverswipeBehavior(mesId, message, chatMetadata);
    return overswipe === OVERSWIPE.REGENERATE || overswipe === OVERSWIPE.EDIT_GENERATE;
}

function resolveOverswipeBehavior(messageId, message, chatMetadata) {
    if (typeof message?.extra?.overswipe_behavior === 'string') {
        return message.extra.overswipe_behavior;
    }
    if (message?.extra?.swipeable === false) {
        return OVERSWIPE.NONE;
    }
    if (message?.extra?.isSmallSys) {
        return OVERSWIPE.NONE;
    }
    const isPristine = !chatMetadata?.tainted;
    if (messageId === 0 && isPristine) {
        return OVERSWIPE.PRISTINE_GREETING;
    }
    if (!message?.is_user && !message?.is_system) {
        return OVERSWIPE.REGENERATE;
    }
    return OVERSWIPE.LOOP;
}

function isAssistantSwipeableMessage(message) {
    if (!message || typeof message !== 'object') {
        return false;
    }
    if (message.extra?.isSmallSys) {
        return false;
    }
    if (message.extra?.swipeable === false) {
        return false;
    }
    if (message.is_user) {
        return false;
    }
    return true;
}

function sendTextareaIsEmptyForSwipeHotkey(documentRef) {
    const ta = documentRef.getElementById?.('send_textarea');
    if (!ta || typeof ta.value !== 'string') {
        return true;
    }
    return ta.value === '';
}

function keyboardEventHasModifier(event) {
    return Boolean(event?.ctrlKey || event?.metaKey || event?.altKey || event?.shiftKey);
}

function resolveBlockedClickSelector(element) {
    for (const selector of BLOCKED_CLICK_SELECTORS) {
        try {
            if (element.closest?.(selector)) {
                return selector;
            }
        } catch {}
    }
    return '';
}

function shouldToastForBlockedSelector(selector) {
    if (!selector) {
        return false;
    }
    return selector === '#send_but'
        || selector === BLOCKED_LAST_SWIPE_RIGHT_GEN
        || selector === '#option_regenerate'
        || selector === '#option_continue'
        || selector === '#mes_continue'
        || selector === '#mes_impersonate';
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

function getEventPoint(event) {
    const touch = event?.changedTouches?.[0] || event?.touches?.[0] || null;
    if (touch && typeof touch.clientX === 'number' && typeof touch.clientY === 'number') {
        return { x: touch.clientX, y: touch.clientY };
    }
    if (typeof event?.clientX === 'number' && typeof event?.clientY === 'number') {
        return { x: event.clientX, y: event.clientY };
    }
    return null;
}
