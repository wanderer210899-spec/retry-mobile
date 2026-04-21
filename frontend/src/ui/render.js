import { formatStructuredError } from '../retry-error.js';
import { formatVisibleStateLabel, isRunningLikeState } from '../core/run-state.js';
import { syncValidationControls } from './panel-bindings.js';

export function createRenderer({ runtime }) {
    return function render() {
        if (!runtime.ui.panel) {
            return;
        }

        const snapshot = getControlSnapshot(runtime);
        const state = snapshot.phase;
        const activeStatus = snapshot.activeStatus;
        const errorText = shouldShowError(snapshot)
            ? formatStructuredError(snapshot.error)
            : '';

        runtime.ui.statusText.textContent = formatVisibleStateLabel(state, activeStatus, snapshot.transport);
        runtime.ui.statusText.dataset.state = state;

        runtime.ui.stats.innerHTML = [
            renderStat('Accepted', activeStatus?.acceptedCount ?? 0),
            renderStat('Attempts', activeStatus?.attemptCount ?? 0),
            renderStat('Target', runtime.settings.targetAcceptedCount),
            renderStat('Timeout', `${runtime.settings.attemptTimeoutSeconds}s`),
        ].join('');

        runtime.ui.errorBox.hidden = !errorText;
        runtime.ui.errorBox.textContent = errorText;

        if (runtime.ui.quickReplyStatusLine) {
            runtime.ui.quickReplyStatusLine.textContent = renderQuickReplyStatusLine(runtime.quickReplyStatus);
        }
        if (runtime.ui.releaseInfoContainer) {
            runtime.ui.releaseInfoContainer.innerHTML = renderReleaseInfo(runtime.releaseInfo);
        }
        if (runtime.ui.retryLogContainer) {
            runtime.ui.retryLogContainer.textContent = runtime.log.text || 'No retry log is available yet.';
        }
        if (runtime.ui.retryLogShell) {
            runtime.ui.retryLogShell.hidden = !runtime.log.show;
        }
        if (runtime.ui.diagnosticsOutput) {
            runtime.ui.diagnosticsOutput.innerHTML = renderDiagnostics(runtime.diagnostics);
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
        syncValidationControls(runtime.ui.panel, runtime.settings);

        if (runtime.ui.actionToggleButton) {
            const stopMode = isRunningLikeState(state);
            runtime.ui.actionToggleButton.textContent = stopMode ? 'Stop' : 'Start';
            runtime.ui.actionToggleButton.classList.toggle('rm-button--danger', stopMode);
            runtime.ui.actionToggleButton.classList.toggle('rm-button--primary', !stopMode);
        }
        if (runtime.ui.quickReplyToggleButton) {
            const attached = Boolean(runtime.quickReplyStatus?.attached);
            runtime.ui.quickReplyToggleButton.textContent = attached ? 'Uninject' : 'Inject';
            runtime.ui.quickReplyToggleButton.classList.toggle('rm-qr-toggle--active', attached);
        }

        if (runtime.ui.toggleLogButton) {
            runtime.ui.toggleLogButton.textContent = runtime.log.show ? 'Hide' : 'Show';
        }
    };
}

function getControlSnapshot(runtime) {
    const context = runtime.retryFsm?.getContext?.() || null;
    const phase = context?.state || 'idle';
    const activeStatus = runtime.activeJobStatus
        || context?.lastTerminalResult?.status
        || null;

    return {
        phase,
        activeStatus,
        error: runtime.controlError || context?.error || null,
        transport: 'healthy',
    };
}

function shouldShowError(snapshot) {
    if (!snapshot?.error) {
        return false;
    }

    return snapshot.phase !== 'running';
}

function renderStat(title, value) {
    return `
        <div class="rm-stat-card">
            <strong>${escapeHtml(title)}</strong>
            <span>${escapeHtml(String(value))}</span>
        </div>
    `;
}

function renderDiagnostics(diagnostics) {
    if (!diagnostics) {
        return `
            <div class="rm-diagnostics__title">Diagnostics</div>
            <div class="rm-diagnostics__line">No diagnostics have run yet.</div>
        `;
    }

    const capabilities = diagnostics.capabilities;
    const eventItems = capabilities.requiredEvents.map((event) => `
        <li class="rm-diagnostics__item" data-icon="${event.present ? '*' : 'x'}">
            <span>${escapeHtml(event.name)}: ${event.present ? 'present' : 'missing'}</span>
        </li>
    `).join('');

    return `
        <div class="rm-diagnostics__title">Diagnostics</div>
        <div class="rm-diagnostics__line">Start is ${diagnostics.startEnabled ? 'enabled' : 'blocked'} by the current capability checks.</div>
        <ul class="rm-diagnostics__list">
            <li class="rm-diagnostics__item" data-icon="${capabilities.hasContext ? '*' : 'x'}">
                <span><code>SillyTavern.getContext()</code>: ${capabilities.hasContext ? 'available' : 'missing'}</span>
            </li>
            <li class="rm-diagnostics__item" data-icon="${capabilities.hasGenerate ? '*' : 'x'}">
                <span><code>generate()</code>: ${capabilities.hasGenerate ? 'available' : 'missing'}</span>
            </li>
            <li class="rm-diagnostics__item" data-icon="${capabilities.hasStopGeneration ? '*' : 'x'}">
                <span><code>stopGeneration()</code>: ${capabilities.hasStopGeneration ? 'available' : 'missing'}</span>
            </li>
            <li class="rm-diagnostics__item" data-icon="${capabilities.hasQuickReplyApi ? '*' : 'x'}">
                <span>Quick Reply API: ${capabilities.hasQuickReplyApi ? 'available' : 'missing'}</span>
            </li>
            <li class="rm-diagnostics__item" data-icon="${diagnostics.dryRun.ok ? '*' : 'x'}">
                <span>Dry-run generation probe: ${diagnostics.dryRun.ok ? 'passed' : escapeHtml(diagnostics.dryRun.reason || 'failed')}</span>
            </li>
        </ul>
        <div class="rm-diagnostics__line">Required native events:</div>
        <ul class="rm-diagnostics__list">${eventItems}</ul>
    `;
}

function renderReleaseInfo(releaseInfo) {
    if (!releaseInfo) {
        return '<div class="rm-release-card__line">Checking Retry Mobile install status...</div>';
    }

    const localVersion = releaseInfo.installed?.version || 'unknown';
    const latestVersion = releaseInfo.latest?.version || 'unknown';
    const branch = releaseInfo.installed?.branch || releaseInfo.branch || 'unknown';
    const commit = typeof releaseInfo.installed?.commit === 'string' && releaseInfo.installed.commit
        ? releaseInfo.installed.commit.slice(0, 12)
        : '';
    const updateMessage = releaseInfo.update?.message || 'Update information unavailable.';
    const hasUpdate = Boolean(releaseInfo.update?.hasUpdate);
    const updateStateClass = hasUpdate ? 'rm-release-card__status--warning' : 'rm-release-card__status--ok';
    const updateLabel = hasUpdate ? 'Update available' : 'Up to date';

    return `
        <div class="rm-release-card__header">
            <span class="rm-release-card__status ${updateStateClass}">${escapeHtml(updateLabel)}</span>
        </div>
        <div class="rm-release-card__line">${escapeHtml(updateMessage)}</div>
        <div class="rm-release-card__grid">
            <div><strong>Version</strong><span>${escapeHtml(localVersion)} -> ${escapeHtml(latestVersion)}</span></div>
            <div><strong>Branch</strong><span>${escapeHtml(branch)}${commit ? ` @ ${escapeHtml(commit)}` : ''}</span></div>
        </div>
    `;
}

function renderQuickReplyStatusLine(status) {
    if (!status?.ok) {
        return 'Quick Reply API unavailable in this session.';
    }

    if (status.attached) {
        return `Injected (${status.buttonCount}/4 Retry Mobile buttons detected in the set).`;
    }

    if (status.setExists) {
        return `Detached (${status.buttonCount}/4 Retry Mobile buttons saved in the set).`;
    }

    return 'No Retry Mobile Quick Reply set exists yet.';
}

function escapeHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}
