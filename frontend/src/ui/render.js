import { formatVisibleStateLabel, isRunningLikeState } from '../core/run-state.js';
import { syncValidationControls } from './panel-bindings.js';
import { deriveUiState } from './derive-ui.js';
import { showToast } from '../st-context.js';
import { t } from '../i18n.js';

export function createRenderer({ runtime }) {
    return function render() {
        if (!runtime.ui.panel) {
            return;
        }

        const context = runtime.retryFsm?.getContext?.() || null;
        const snapshot = deriveUiState(context, runtime);
        const state = snapshot.phase;
        const activeStatus = snapshot.activeStatus;
        const errorText = snapshot.errorVisible ? snapshot.errorText : '';

        for (const toast of snapshot.toastsToFire || []) {
            showToast(toast.kind, toast.title, toast.message);
        }
        if (snapshot.nextToastScope && runtime.retryFsm?.setToastScope) {
            runtime.retryFsm.setToastScope(snapshot.nextToastScope);
        }

        runtime.ui.statusText.textContent = snapshot.statusLabel || formatVisibleStateLabel(state, activeStatus, snapshot.transport);
        runtime.ui.statusText.dataset.state = state;

        runtime.ui.stats.innerHTML = [
            renderStat(t('render.statAccepted'), activeStatus?.acceptedCount ?? 0),
            renderStat(t('render.statAttempts'), activeStatus?.attemptCount ?? 0),
            renderStat(t('render.statTarget'), runtime.settings.targetAcceptedCount),
            renderStat(t('render.statTimeout'), `${runtime.settings.attemptTimeoutSeconds}s`),
        ].join('');

        runtime.ui.errorBox.hidden = !snapshot.errorVisible;
        runtime.ui.errorBox.textContent = errorText;

        if (runtime.ui.quickReplyStatusLine) {
            runtime.ui.quickReplyStatusLine.textContent = renderQuickReplyStatusLine(runtime.quickReplyStatus);
        }
        if (runtime.ui.releaseInfoContainer) {
            runtime.ui.releaseInfoContainer.innerHTML = renderReleaseInfo(runtime.releaseInfo);
        }
        if (runtime.ui.retryLogContainer) {
            runtime.ui.retryLogContainer.textContent = runtime.log.text || t('render.retryLogEmpty');
        }
        if (runtime.ui.retryLogShell) {
            runtime.ui.retryLogShell.hidden = !runtime.log.show;
        }
        if (runtime.ui.mainPane && runtime.ui.systemPane) {
            const showSystem = runtime.ui.activeTab === 'system';
            runtime.ui.mainPane.hidden = showSystem;
            runtime.ui.systemPane.hidden = !showSystem;
        }

        runtime.ui.tabButtons.forEach((button) => {
            const tab = button.dataset.tab === 'system' ? 'system' : 'main';
            button.classList.toggle('rm-tab--active', runtime.ui.activeTab === tab);
        });
        syncValidationControls(runtime, runtime.settings);

        if (runtime.ui.actionToggleButton) {
            const stopMode = isRunningLikeState(state);
            runtime.ui.actionToggleButton.textContent = stopMode ? t('panel.stop') : t('panel.start');
            runtime.ui.actionToggleButton.classList.toggle('rm-button--danger', stopMode);
            runtime.ui.actionToggleButton.classList.toggle('rm-button--primary', !stopMode);
        }
        if (runtime.ui.quickReplyToggleButton) {
            const attached = Boolean(runtime.quickReplyStatus?.attached);
            runtime.ui.quickReplyToggleButton.textContent = attached ? t('panel.uninject') : t('panel.inject');
            runtime.ui.quickReplyToggleButton.classList.toggle('rm-qr-toggle--active', attached);
        }

        if (runtime.ui.toggleLogButton) {
            runtime.ui.toggleLogButton.textContent = runtime.log.show ? t('panel.hide') : t('panel.show');
        }
    };
}

function renderStat(title, value) {
    return `
        <div class="rm-stat-card">
            <strong>${escapeHtml(title)}</strong>
            <span>${escapeHtml(String(value))}</span>
        </div>
    `;
}

function renderReleaseInfo(releaseInfo) {
    if (!releaseInfo) {
        return `<div class="rm-release-card__line">${escapeHtml(t('render.releaseChecking'))}</div>`;
    }

    const localVersion = releaseInfo.installed?.version || 'unknown';
    const latestVersion = releaseInfo.latest?.version || 'unknown';
    const branch = releaseInfo.installed?.branch || releaseInfo.branch || 'unknown';
    const commit = typeof releaseInfo.installed?.commit === 'string' && releaseInfo.installed.commit
        ? releaseInfo.installed.commit.slice(0, 12)
        : '';
    const updateMessage = releaseInfo.update?.message || t('render.releaseUpdateInfoUnavailable');
    const hasUpdate = Boolean(releaseInfo.update?.hasUpdate);
    const updateStateClass = hasUpdate ? 'rm-release-card__status--warning' : 'rm-release-card__status--ok';
    const updateLabel = hasUpdate ? t('render.releaseUpdateAvailable') : t('render.releaseUpToDate');

    return `
        <div class="rm-release-card__header">
            <span class="rm-release-card__status ${updateStateClass}">${escapeHtml(updateLabel)}</span>
        </div>
        <div class="rm-release-card__line">${escapeHtml(updateMessage)}</div>
        <div class="rm-release-card__grid">
            <div><strong>${escapeHtml(t('render.releaseVersion'))}</strong><span>${escapeHtml(localVersion)} -> ${escapeHtml(latestVersion)}</span></div>
            <div><strong>${escapeHtml(t('render.releaseBranch'))}</strong><span>${escapeHtml(branch)}${commit ? ` @ ${escapeHtml(commit)}` : ''}</span></div>
        </div>
    `;
}

function renderQuickReplyStatusLine(status) {
    if (!status?.ok) {
        return t('render.quickReplyUnavailable');
    }

    if (status.attached) {
        return t('render.quickReplyInjected', { count: status.buttonCount });
    }

    if (status.setExists) {
        return t('render.quickReplyDetached', { count: status.buttonCount });
    }

    return t('render.quickReplyMissingSet');
}

function escapeHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}
