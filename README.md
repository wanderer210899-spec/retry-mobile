# Retry Mobile

Retry Mobile is a split SillyTavern plugin: the backend installs as a server plugin in `plugins/retry-mobile`, and the frontend installs into one or more profile extension folders under `data/<profile>/extensions/retry-mobile`.

## Requirements
- Node.js available in the terminal where you run the installer
- Git available so the bootstrap installer can fetch the current Retry Mobile repository

## Installation

### Windows
1. Navigate to your local SillyTavern installation or launcher folder.

```powershell
Set-Location "C:\path\to\your\SillyTavern"
```

or, if you launch from a folder that contains a `SillyTavern` subfolder:

```powershell
Set-Location "C:\path\to\your\SillyTavern-Launcher"
```

2. Run this command:

```powershell
irm https://raw.githubusercontent.com/wanderer210899-spec/retry-mobile/main/bootstrap.ps1 | iex
```

To install a different branch, either pass it as a separate argument:

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/wanderer210899-spec/retry-mobile/main/bootstrap.ps1))) 'backend-refracter'
```

or set `RETRY_MOBILE_BRANCH` first:

```powershell
$env:RETRY_MOBILE_BRANCH = 'backend-refracter'
irm https://raw.githubusercontent.com/wanderer210899-spec/retry-mobile/main/bootstrap.ps1 | iex
```

3. Finished. The installer will:
- detect your local SillyTavern install automatically
- offer `Enable server plugins`, `Install / Update now`, or `Uninstall`
- install the backend to `SillyTavern\plugins\retry-mobile`
- if multiple profiles exist, ask whether to install the frontend for one profile, multiple profiles, or everyone

If you choose a single profile, the frontend installs into a path like:

```text
SillyTavern\data\default-user\extensions\retry-mobile
```

If you choose everyone, the frontend installs into:

```text
SillyTavern\public\scripts\extensions\third-party\retry-mobile
```

### Android / Termux
1. Navigate to your local SillyTavern installation.

```bash
cd ~/SillyTavern
```

2. Keep the SillyTavern server running in its own Termux session.
Open a different Termux session for the installer or updater. Do not run the bootstrap flow in the same session that is currently running `bash start.sh`, or you can end up thinking the update finished while the live frontend/backend files are still stale.

3. Run this command from that separate Termux session:

```bash
curl -fsSL https://raw.githubusercontent.com/wanderer210899-spec/retry-mobile/main/bootstrap.sh | bash
```

To install a different branch, either pass it as a separate argument:

```bash
curl -fsSL https://raw.githubusercontent.com/wanderer210899-spec/retry-mobile/main/bootstrap.sh | bash -s -- backend-refracter
```

or set `RETRY_MOBILE_BRANCH` on the `bash` side:

```bash
curl -fsSL https://raw.githubusercontent.com/wanderer210899-spec/retry-mobile/main/bootstrap.sh | RETRY_MOBILE_BRANCH=backend-refracter bash
```

4. Choose:

```text
2
1
```

That means:
- `2` = `Install / Update now`
- `1` = install the frontend into `default-user`

5. Finished. The installer will:
- detect your local SillyTavern install automatically
- offer `Enable server plugins`, `Install / Update now`, or `Uninstall`
- install the backend to `~/SillyTavern/plugins/retry-mobile`
- ask whether to install the frontend for one profile, multiple profiles, or everyone

If you choose a single profile, the frontend installs into a path like:

```text
~/SillyTavern/data/default-user/extensions/retry-mobile
```

If you choose everyone, the frontend installs into:

```text
~/SillyTavern/public/scripts/extensions/third-party/retry-mobile
```

## Update
Navigate to your local SillyTavern installation and run the same bootstrap command again.

### Windows

```powershell
Set-Location "C:\path\to\your\SillyTavern"
irm https://raw.githubusercontent.com/wanderer210899-spec/retry-mobile/main/bootstrap.ps1 | iex
```

### Android / Termux

```bash
cd ~/SillyTavern
curl -fsSL https://raw.githubusercontent.com/wanderer210899-spec/retry-mobile/main/bootstrap.sh | bash
```

Then choose:

```text
2
1
```

Run that bootstrap flow from a different Termux session than the one currently hosting `bash start.sh`.

The Retry Mobile frontend panel shows:
- current installed backend/frontend versions
- latest GitHub versions it can detect
- whether an update is available
- GitHub link and manual update instructions

## Uninstall
Run the bootstrap command from your local SillyTavern installation and choose:

```text
Uninstall
```

The uninstall menu supports:
- removing the frontend from selected profiles
- removing the frontend from `third-party` for everyone
- removing everything, including the backend

## FAQ
### What if I run the installer from the wrong directory?
It aborts immediately and prints the correct navigation command for your platform. No SillyTavern files are modified.

### I installed it but cannot see the plugin
Check the following:
- `enableServerPlugins: true` in `config.yaml`
- SillyTavern was restarted after installation
- the frontend was installed for the profile you are currently using, or for everyone via `third-party`

### Why is there no native Extensions update button?
Retry Mobile uses an installer-managed split deployment instead of relying on SillyTavern's git-managed third-party extension update buttons.

### Where is the GitHub link?
The Retry Mobile frontend panel title links to the GitHub repository, and the install/update card inside the panel also links to GitHub.
