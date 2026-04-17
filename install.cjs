const fs = require('node:fs');
const path = require('node:path');
const process = require('node:process');
const readline = require('node:readline/promises');

const { DEFAULT_BRANCH, PLUGIN_ID, PLUGIN_NAME, REPOSITORY_URL } = require('./server/plugin-meta');

const LEGACY_PLUGIN_ID = 'auto-reroll';
const SOURCE_ROOT = __dirname;
const FRONTEND_SOURCE = path.join(SOURCE_ROOT, 'frontend');
const BACKEND_SOURCE = path.join(SOURCE_ROOT, 'server');
const RAW_REPOSITORY_BASE = REPOSITORY_URL.replace('https://github.com/', 'https://raw.githubusercontent.com/');
const RELEASE_MANIFEST_FILE = 'release.json';
const INSTALLER_BRANCH = resolveInstallerBranch();

main().catch((error) => {
    console.error(`\n${PLUGIN_NAME} installer failed.`);
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
});

async function main() {
    const platform = detectPlatform();
    const layout = resolveLocalLayout(process.cwd(), platform);
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });

    try {
        let keepRunning = true;
        while (keepRunning) {
            refreshProfiles(layout);
            await refreshInstallerReleaseStatus(layout);
            renderMenu(layout, platform);
            const choice = await promptMainMenuChoice(rl);
            switch (choice) {
                case '1':
                    await configureServerPluginSettings(rl, layout, platform);
                    break;
                case '2':
                    await installOrUpdateNow(rl, layout, platform);
                    break;
                case '3':
                    await uninstallFlow(rl, layout);
                    break;
                case '0':
                    keepRunning = false;
                    break;
                default:
                    console.log('Choose a valid option: 0, 1, 2, or 3.');
                    break;
            }
        }
    } finally {
        rl.close();
    }
}

function detectPlatform() {
    if (process.platform === 'win32') {
        return 'windows';
    }

    if (String(process.env.PREFIX || '').includes('com.termux') || fs.existsSync('/data/data/com.termux')) {
        return 'termux';
    }

    return process.platform;
}

function resolveLocalLayout(startDir, platform) {
    const workingDir = path.resolve(startDir);
    const candidates = [
        workingDir,
        path.join(workingDir, 'SillyTavern'),
    ];
    const stRoot = candidates.find((candidate) => fs.existsSync(path.join(candidate, 'config.yaml')));

    if (!stRoot) {
        throw new Error(buildInvalidLocationMessage(workingDir, platform));
    }

    const configPath = path.join(stRoot, 'config.yaml');
    const configText = fs.readFileSync(configPath, 'utf8');
    const config = parseConfigSummary(configText);
    const dataRoot = resolveDataRoot(stRoot, config.dataRoot);
    const layout = {
        workingDir,
        stRoot,
        configPath,
        config,
        dataRoot,
        pluginsDir: path.join(stRoot, 'plugins'),
        backendTarget: path.join(stRoot, 'plugins', PLUGIN_ID),
        legacyBackendTarget: path.join(stRoot, 'plugins', LEGACY_PLUGIN_ID),
        globalExtensionsDir: path.join(stRoot, 'public', 'scripts', 'extensions', 'third-party'),
        globalFrontendTarget: path.join(stRoot, 'public', 'scripts', 'extensions', 'third-party', PLUGIN_ID),
        globalFrontendInstalled: false,
        releaseUpdate: null,
        profiles: [],
    };

    refreshProfiles(layout);
    return layout;
}

function buildInvalidLocationMessage(workingDir, platform) {
    const navigationCommand = platform === 'windows'
        ? 'Set-Location "C:\\path\\to\\your\\SillyTavern"'
        : 'cd ~/SillyTavern';
    const launcherCommand = platform === 'windows'
        ? 'Set-Location "C:\\path\\to\\your\\SillyTavern-Launcher"'
        : 'cd ~/SillyTavern';

    return [
        'This installer must be launched from your local SillyTavern installation.',
        `Current directory: ${workingDir}`,
        'Expected one of these locations:',
        '- the SillyTavern root that contains config.yaml',
        '- or a launcher folder that contains a SillyTavern subfolder',
        'Navigate there first, then rerun the bootstrap command.',
        `Example: ${navigationCommand}`,
        `Launcher example: ${launcherCommand}`,
        'No SillyTavern files were modified.',
    ].join('\n');
}

function parseConfigSummary(configText) {
    return {
        dataRoot: extractYamlScalar(configText, 'dataRoot') || './data',
        enableServerPlugins: extractYamlScalar(configText, 'enableServerPlugins') === 'true',
        enableServerPluginsAutoUpdate: extractYamlScalar(configText, 'enableServerPluginsAutoUpdate') === 'true',
    };
}

function extractYamlScalar(text, key) {
    const pattern = new RegExp(`^${escapeRegExp(key)}:\\s*(.+)$`, 'm');
    const match = text.match(pattern);
    if (!match) {
        return '';
    }

    return String(match[1] || '').trim().replace(/^['"]|['"]$/g, '');
}

function resolveDataRoot(stRoot, dataRootValue) {
    const value = String(dataRootValue || './data');
    if (path.isAbsolute(value)) {
        return value;
    }

    return path.resolve(stRoot, value);
}

function refreshProfiles(layout) {
    const entries = fs.existsSync(layout.dataRoot)
        ? fs.readdirSync(layout.dataRoot, { withFileTypes: true })
        : [];

    layout.globalFrontendInstalled = fs.existsSync(layout.globalFrontendTarget);
    const profiles = entries
        .filter((entry) => entry.isDirectory())
        .filter((entry) => !entry.name.startsWith('_'))
        .filter((entry) => looksLikeProfileRoot(path.join(layout.dataRoot, entry.name)))
        .map((entry) => createProfileRecord(path.join(layout.dataRoot, entry.name), entry.name))
        .sort((left, right) => left.handle.localeCompare(right.handle));

    if (profiles.length > 0) {
        layout.profiles = profiles;
        return;
    }

    if (looksLikeProfileRoot(layout.dataRoot)) {
        layout.profiles = [createProfileRecord(layout.dataRoot)];
        return;
    }

    layout.profiles = [];
}

function looksLikeProfileRoot(root) {
    if (!fs.existsSync(root)) {
        return false;
    }

    const stats = fs.statSync(root);
    if (!stats.isDirectory()) {
        return false;
    }

    const extensionsDir = path.join(root, 'extensions');
    return fs.existsSync(extensionsDir) && fs.statSync(extensionsDir).isDirectory();
}

function createProfileRecord(root, handle = path.basename(root)) {
    const extensionsDir = path.join(root, 'extensions');
    const frontendTarget = path.join(extensionsDir, PLUGIN_ID);
    return {
        handle,
        root,
        extensionsDir,
        frontendTarget,
        hasFrontend: fs.existsSync(frontendTarget),
    };
}

function renderMenu(layout, platform) {
    console.log('\n ==============================================================');
    console.log(` | > ${PLUGIN_NAME} Installer`);
    console.log(' ==============================================================');
    console.log(' ______________________________________________________________');
    console.log(' | **What would you like to do?**');
    console.log(' |   1. Server plugin / auto-update');
    console.log(' |   2. Install / Update now');
    console.log(' |   3. Uninstall');
    console.log(' ______________________________________________________________');
    console.log(' | Menu Options:');
    console.log(' |   0. Exit');
    console.log(' ______________________________________________________________');
            console.log(' | Local Install:');
            console.log(` |   Working dir: ${truncateMiddle(layout.workingDir, 42)}`);
            console.log(` |   ST root:     ${truncateMiddle(layout.stRoot, 42)}`);
            console.log(` |   Repository:  ${truncateMiddle(REPOSITORY_URL, 42)}`);
            console.log(` |   Branch:      ${truncateMiddle(INSTALLER_BRANCH, 42)}`);
            console.log(` |   Source Ver:  ${truncateMiddle(formatInstallerReleaseStatus(layout.releaseUpdate), 42)}`);
            console.log(' ______________________________________________________________');
    console.log(' | Retry Mobile Status:');
    console.log(` |   Server plugins: ${layout.config.enableServerPlugins ? 'Enabled' : 'Disabled'}`);
    console.log(` |   Auto-update:    ${layout.config.enableServerPluginsAutoUpdate ? 'Enabled' : 'Disabled'}`);
    console.log(` |   Backend:        ${fs.existsSync(layout.backendTarget) ? 'Installed' : 'Not installed'}`);
    console.log(` |   Everyone:       ${layout.globalFrontendInstalled ? 'Installed in third-party' : 'Not installed in third-party'}`);
    if (layout.profiles.length === 0) {
        console.log(' |   Profiles:       None detected in data root');
    } else {
        for (const profile of layout.profiles) {
            console.log(` |   ${truncateMiddle(`Profile ${profile.handle}`, 28)}: ${profile.hasFrontend ? 'Installed' : 'Not installed'}`);
        }
    }
    if (fs.existsSync(layout.legacyBackendTarget)) {
        console.log(` |   Legacy backend detected: ${LEGACY_PLUGIN_ID}`);
    }
    console.log(' ______________________________________________________________');
    if (platform === 'windows') {
        console.log(' | Windows note: Restart SillyTavern from your launcher after config or install changes.');
    } else if (platform === 'termux') {
        console.log(' | Termux note: Stop the running SillyTavern process before replacing plugin files.');
    }
    console.log(' ==============================================================');
}

async function promptMainMenuChoice(rl) {
    return (await rl.question(' Choose Your Destiny (0-3): ')).trim();
}

async function configureServerPluginSettings(rl, layout, platform) {
    console.log('\nServer plugin settings');
    console.log('1. Enable server plugin');
    console.log('2. Enable plugin auto-update');
    console.log('3. Enable both');
    console.log('0. Cancel');
    console.log('Plugin auto-update lets SillyTavern automatically update server-side plugins inside plugins/.');

    const choice = (await rl.question('Selection: ')).trim();
    if (choice === '1') {
        updateServerPluginSettings(layout, { enableServerPlugins: true });
        logProcessComplete('Config change complete.', [
            'Server plugins are now enabled in config.yaml.',
            'Plugin auto-update was left unchanged.',
        ], platform);
        return;
    }

    if (choice === '2') {
        updateServerPluginSettings(layout, { enableServerPluginsAutoUpdate: true });
        const lines = ['Server plugin auto-update is now enabled in config.yaml.'];
        if (!layout.config.enableServerPlugins) {
            lines.push('Server plugins are still disabled. Auto-update will only apply after server plugins are enabled.');
        }
        logProcessComplete('Config change complete.', lines, platform);
        return;
    }

    if (choice === '3') {
        updateServerPluginSettings(layout, {
            enableServerPlugins: true,
            enableServerPluginsAutoUpdate: true,
        });
        logProcessComplete('Config change complete.', [
            'Server plugins and plugin auto-update are now enabled in config.yaml.',
        ], platform);
        return;
    }

    console.log('No config changes were made.');
}

function updateServerPluginSettings(layout, changes) {
    ensureWritable(layout.configPath);
    let configText = fs.readFileSync(layout.configPath, 'utf8');

    if (typeof changes.enableServerPlugins === 'boolean') {
        configText = upsertYamlBoolean(configText, 'enableServerPlugins', changes.enableServerPlugins);
    }

    if (typeof changes.enableServerPluginsAutoUpdate === 'boolean') {
        configText = upsertYamlBoolean(configText, 'enableServerPluginsAutoUpdate', changes.enableServerPluginsAutoUpdate);
    }

    fs.writeFileSync(layout.configPath, configText, 'utf8');
    layout.config = parseConfigSummary(configText);
}

function logRestartMessage(platform) {
    console.log(platform === 'windows'
        ? 'Restart SillyTavern from your Windows launcher for the change to take effect.'
        : 'Restart SillyTavern in Termux for the change to take effect.');
}

function logProcessComplete(title, lines, platform) {
    console.log(`\n${title}`);
    for (const line of lines) {
        console.log(line);
    }
    if (platform) {
        logRestartMessage(platform);
    }
}

async function installOrUpdateNow(rl, layout, platform) {
    if (!layout.config.enableServerPlugins) {
        console.log('Server plugins are disabled. Install / Update now will not change config.yaml.');
        console.log('Use option 1 first to enable the server plugin prerequisite, then run Install / Update now again.');
        return;
    }

    ensureWritable(layout.pluginsDir, true);
    installBackend(layout);

    const target = await promptFrontendDestination(rl, layout);
    if (!target) {
        refreshProfiles(layout);
        logProcessComplete('Install / Update process complete.', [
            'Backend installed or updated.',
            'Frontend selection was cancelled.',
        ], platform);
        return;
    }

    const completionLines = ['Backend installed or updated.'];
    if (target.kind === 'global') {
        const installedProfiles = layout.profiles.filter((profile) => profile.hasFrontend);
        if (installedProfiles.length > 0) {
            const migrate = await confirm(rl, 'Profile-local frontend installs were found. Remove them and switch to one global install for everyone?', true);
            if (!migrate) {
                console.log('Global frontend install cancelled to avoid duplicate frontend copies.');
                return;
            }

            removeProfileFrontends(installedProfiles);
        }

        installGlobalFrontend(layout);
        refreshProfiles(layout);
        completionLines.push(`Installed ${PLUGIN_NAME} frontend for everyone in public/scripts/extensions/third-party/${PLUGIN_ID}.`);
    } else {
        if (layout.globalFrontendInstalled) {
            console.log('A global third-party frontend install already exists. Remove it first from Uninstall before creating profile-local installs.');
            return;
        }

        installFrontendForProfiles(target.profiles);
        refreshProfiles(layout);
        completionLines.push(`Installed ${PLUGIN_NAME} frontend for ${target.profiles.map((profile) => profile.handle).join(', ')}.`);
    }

    if (fs.existsSync(layout.legacyBackendTarget)) {
        completionLines.push(`Legacy backend ${LEGACY_PLUGIN_ID} is still present. Remove it manually when you are done migrating.`);
    }

    logProcessComplete('Install / Update process complete.', completionLines, platform);
}

async function promptFrontendDestination(rl, layout) {
    const profiles = layout.profiles;

    if (profiles.length === 0) {
        const installGlobal = await confirm(rl, 'No profiles were detected. Install the frontend for everyone in third-party?', true);
        return installGlobal ? { kind: 'global' } : null;
    }

    if (profiles.length === 1) {
        const [profile] = profiles;
        console.log(`\nFrontend destination`);
        console.log(`1. Install only for profile: ${profile.handle}`);
        console.log('2. Install for everyone in third-party');
        console.log('0. Cancel');
        const choice = (await rl.question('Selection: ')).trim();
        if (choice === '1') {
            return { kind: 'profiles', profiles: [profile] };
        }
        if (choice === '2') {
            return { kind: 'global' };
        }
        return null;
    }

    console.log('\nFrontend destination');
    console.log('1. Install for one profile');
    console.log('2. Install for multiple profiles');
    console.log('3. Install for everyone in third-party');
    console.log('0. Cancel');
    const choice = (await rl.question('Selection: ')).trim();
    if (choice === '1') {
        const selected = await promptForProfiles(rl, profiles, false);
        return selected.length > 0 ? { kind: 'profiles', profiles: [selected[0]] } : null;
    }
    if (choice === '2') {
        const selected = await promptForProfiles(rl, profiles, true);
        return selected.length > 0 ? { kind: 'profiles', profiles: selected } : null;
    }
    if (choice === '3') {
        return { kind: 'global' };
    }
    return null;
}

async function uninstallFlow(rl, layout) {
    refreshProfiles(layout);
    console.log('\nUninstall');
    console.log('1. Remove frontend from selected profiles');
    console.log('2. Remove frontend from third-party (everyone)');
    console.log('3. Remove everything');
    console.log('0. Cancel');

    const choice = (await rl.question('Selection: ')).trim();
    if (choice === '1') {
        const installedProfiles = layout.profiles.filter((profile) => profile.hasFrontend);
        if (installedProfiles.length === 0) {
            console.log('No profile-local frontend installs were found.');
            return;
        }

        const selected = await promptForProfiles(rl, installedProfiles, true);
        if (selected.length === 0) {
            console.log('No profiles selected.');
            return;
        }

        removeProfileFrontends(selected);
        refreshProfiles(layout);
        console.log(`Removed ${PLUGIN_NAME} frontend from ${selected.map((profile) => profile.handle).join(', ')}.`);
        return;
    }

    if (choice === '2') {
        if (!layout.globalFrontendInstalled) {
            console.log('No global third-party frontend install was found.');
            return;
        }

        removeDirectory(layout.globalFrontendTarget);
        refreshProfiles(layout);
        console.log(`Removed ${PLUGIN_NAME} from public/scripts/extensions/third-party.`);
        return;
    }

    if (choice === '3') {
        const approved = await confirm(rl, 'Remove the backend plus all profile and global frontend installs?', false);
        if (!approved) {
            console.log('Uninstall cancelled.');
            return;
        }

        removeDirectory(layout.backendTarget);
        removeDirectory(layout.globalFrontendTarget);
        removeProfileFrontends(layout.profiles.filter((profile) => profile.hasFrontend));
        refreshProfiles(layout);
        console.log(`Removed ${PLUGIN_NAME} backend and all frontend installs.`);
    }
}

function installBackend(layout) {
    replaceDirectory(BACKEND_SOURCE, layout.backendTarget);
    fs.copyFileSync(path.join(SOURCE_ROOT, RELEASE_MANIFEST_FILE), path.join(layout.backendTarget, RELEASE_MANIFEST_FILE));
}

function installGlobalFrontend(layout) {
    ensureWritable(layout.globalExtensionsDir, true);
    replaceDirectory(FRONTEND_SOURCE, layout.globalFrontendTarget);
}

function installFrontendForProfiles(profiles) {
    for (const profile of profiles) {
        ensureWritable(profile.extensionsDir, true);
        replaceDirectory(FRONTEND_SOURCE, profile.frontendTarget);
    }
}

function removeProfileFrontends(profiles) {
    for (const profile of profiles) {
        removeDirectory(profile.frontendTarget);
    }
}

async function promptForProfiles(rl, profiles, allowMultiple) {
    if (profiles.length === 0) {
        return [];
    }

    profiles.forEach((profile, index) => {
        const status = profile.hasFrontend ? 'installed' : 'missing';
        console.log(`${index + 1}. ${profile.handle} (${status})`);
    });

    while (true) {
        const raw = (await rl.question(allowMultiple ? 'Select profile numbers separated by commas: ' : 'Select one profile number: ')).trim();
        if (!raw) {
            return [];
        }

        const indexes = raw.split(',').map((part) => Number.parseInt(part.trim(), 10) - 1);
        if (indexes.length === 0 || indexes.some((index) => !Number.isInteger(index) || index < 0 || index >= profiles.length)) {
            console.log('Enter valid profile numbers from the list.');
            continue;
        }
        if (!allowMultiple && indexes.length !== 1) {
            console.log('Choose exactly one profile number.');
            continue;
        }

        return [...new Set(indexes)].map((index) => profiles[index]);
    }
}

function replaceDirectory(source, destination) {
    if (!fs.existsSync(source)) {
        throw new Error(`Source directory is missing: ${source}`);
    }

    ensureWritable(path.dirname(destination), true);
    removeDirectory(destination);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.cpSync(source, destination, { recursive: true, force: true });
}

function removeDirectory(target) {
    fs.rmSync(target, { recursive: true, force: true });
}

function ensureWritable(targetPath, allowCreate = false) {
    const existingPath = findExistingPath(targetPath);
    if (!existingPath) {
        if (allowCreate) {
            fs.mkdirSync(targetPath, { recursive: true });
            return;
        }
        throw new Error(`Path does not exist: ${targetPath}`);
    }

    try {
        fs.accessSync(existingPath, fs.constants.W_OK);
    } catch {
        throw new Error(`Write access is required for ${existingPath}. Close SillyTavern and rerun this installer with sufficient permissions.`);
    }
}

function findExistingPath(targetPath) {
    let current = targetPath;
    while (current && !fs.existsSync(current)) {
        const parent = path.dirname(current);
        if (parent === current) {
            return null;
        }
        current = parent;
    }
    return current;
}

async function refreshInstallerReleaseStatus(layout) {
    layout.releaseUpdate = await readInstallerReleaseUpdateInfo(SOURCE_ROOT);
}

async function readInstallerReleaseUpdateInfo(repoPath) {
    const result = {
        canCheck: false,
        hasUpdate: false,
        localVersion: '',
        remoteVersion: '',
        message: 'Update check unavailable',
    };

    try {
        const localRelease = readJsonFile(path.join(repoPath, RELEASE_MANIFEST_FILE)) || {};
        const remoteRelease = await fetchJson(`${RAW_REPOSITORY_BASE}/${INSTALLER_BRANCH}/${RELEASE_MANIFEST_FILE}`);
        result.localVersion = typeof localRelease.version === 'string' ? localRelease.version : '';
        result.remoteVersion = typeof remoteRelease?.version === 'string' ? remoteRelease.version : '';
        result.canCheck = Boolean(result.localVersion && result.remoteVersion);
        result.hasUpdate = result.canCheck && compareVersions(result.localVersion, result.remoteVersion) < 0;
        result.message = result.canCheck
            ? (result.hasUpdate
                ? `Update available (${result.localVersion} → ${result.remoteVersion})`
                : `Up to date (${result.localVersion})`)
            : 'Release manifest missing a version value.';
        return result;
    } catch (error) {
        result.message = error instanceof Error ? error.message : String(error);
        return result;
    }
}

function resolveInstallerBranch() {
    const value = String(process.env.RETRY_MOBILE_BRANCH || DEFAULT_BRANCH || '').trim();
    return value || 'main';
}

async function fetchJson(url) {
    const options = {};
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
        options.signal = AbortSignal.timeout(8000);
    }

    const response = await fetch(url, options);
    if (!response.ok) {
        throw new Error(`Update check failed at ${url} (${response.status}).`);
    }

    return response.json();
}

function readJsonFile(filePath) {
    if (!filePath || !fs.existsSync(filePath)) {
        return null;
    }

    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function compareVersions(left, right) {
    const leftParts = normalizeVersion(left);
    const rightParts = normalizeVersion(right);
    const length = Math.max(leftParts.length, rightParts.length);

    for (let index = 0; index < length; index += 1) {
        const leftPart = leftParts[index] ?? 0;
        const rightPart = rightParts[index] ?? 0;
        if (leftPart > rightPart) {
            return 1;
        }
        if (leftPart < rightPart) {
            return -1;
        }
    }

    return 0;
}

function normalizeVersion(value) {
    return String(value || '')
        .trim()
        .replace(/^v/i, '')
        .split('.')
        .map((part) => Number.parseInt(part, 10))
        .filter((part) => Number.isFinite(part));
}

function formatInstallerReleaseStatus(releaseUpdate) {
    return releaseUpdate?.message || 'Update check unavailable';
}

function truncateMiddle(value, maxLength) {
    const text = String(value || '');
    if (text.length <= maxLength) {
        return text;
    }

    const edge = Math.max(8, Math.floor((maxLength - 3) / 2));
    return `${text.slice(0, edge)}...${text.slice(-edge)}`;
}

async function confirm(rl, prompt, defaultValue) {
    const suffix = defaultValue ? ' [Y/n] ' : ' [y/N] ';
    const answer = (await rl.question(`${prompt}${suffix}`)).trim().toLowerCase();
    if (!answer) {
        return defaultValue;
    }
    return answer === 'y' || answer === 'yes';
}

function upsertYamlBoolean(text, key, value) {
    const normalized = value ? 'true' : 'false';
    const pattern = new RegExp(`^(\\s*${escapeRegExp(key)}:\\s*)(.+)$`, 'm');
    if (pattern.test(text)) {
        return text.replace(pattern, `$1${normalized}`);
    }

    const suffix = text.endsWith('\n') ? '' : '\n';
    return `${text}${suffix}${key}: ${normalized}\n`;
}

function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
