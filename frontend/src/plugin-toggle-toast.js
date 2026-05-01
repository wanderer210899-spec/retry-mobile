import { isRunningLikeState } from './core/run-state.js';

export function shouldToastPluginOn(previousState, nextState) {
    const prev = String(previousState || '').trim();
    const next = String(nextState || '').trim();
    if (!next) {
        return false;
    }
    // We only show "plugin on" when we have newly armed the plugin.
    return next === 'armed' && prev !== 'armed';
}

export function shouldToastPluginOff(previousState, nextState) {
    const prev = String(previousState || '').trim();
    const next = String(nextState || '').trim();
    if (!prev) {
        return false;
    }
    // Only show "plugin off" when leaving an active/armed state back to idle.
    return isRunningLikeState(prev) && next === 'idle';
}

