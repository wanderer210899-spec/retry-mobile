# Retry Mobile

Retry Mobile is a split SillyTavern plugin: the backend installs as a server plugin in `plugins/retry-mobile`, and the frontend installs into one or more profile extension folders under `data/<profile>/extensions/retry-mobile`.

## Requirements
- Node.js available in the terminal where you run the installer
- Git available so the bootstrap installer can fetch the current Retry Mobile repository

## Installation

### Windows
One-step default install/update (interactive menu):

```powershell
Set-Location "C:\path\to\your\SillyTavern"; irm https://raw.githubusercontent.com/wanderer210899-spec/retry-mobile/main/bootstrap.ps1 | iex
```

One-step non-interactive install/update (backend + global frontend):

```powershell
Set-Location "C:\path\to\your\SillyTavern"; & ([scriptblock]::Create((irm https://raw.githubusercontent.com/wanderer210899-spec/retry-mobile/main/bootstrap.ps1))) -Headless
```

If you launch from a folder that contains a `SillyTavern` subfolder, use:

```powershell
Set-Location "C:\path\to\your\SillyTavern-Launcher"; irm https://raw.githubusercontent.com/wanderer210899-spec/retry-mobile/main/bootstrap.ps1 | iex
```

To install a different branch, either pass it as a separate argument:

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/wanderer210899-spec/retry-mobile/main/bootstrap.ps1))) 'backend-refracter'
```

Headless with branch override:

```powershell
Set-Location "C:\path\to\your\SillyTavern"; & ([scriptblock]::Create((irm https://raw.githubusercontent.com/wanderer210899-spec/retry-mobile/main/bootstrap.ps1))) -Branch 'backend-refracter' -Headless
```

or set `RETRY_MOBILE_BRANCH` first:

```powershell
$env:RETRY_MOBILE_BRANCH = 'backend-refracter'
irm https://raw.githubusercontent.com/wanderer210899-spec/retry-mobile/main/bootstrap.ps1 | iex
```

Finished. The installer will:
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
One-step default install/update (interactive menu):

```bash
cd ~/SillyTavern && curl -fsSL https://raw.githubusercontent.com/wanderer210899-spec/retry-mobile/main/bootstrap.sh | bash
```

One-step non-interactive install/update (backend + global frontend):

```bash
cd ~/SillyTavern && curl -fsSL https://raw.githubusercontent.com/wanderer210899-spec/retry-mobile/main/bootstrap.sh | bash -s -- --headless
```

Keep the SillyTavern server running in its own Termux session and run the installer in a second session.

If you want profile-local install in headless mode:

```bash
cd ~/SillyTavern && curl -fsSL https://raw.githubusercontent.com/wanderer210899-spec/retry-mobile/main/bootstrap.sh | bash -s -- --headless --profile default-user
```

To install a different branch, either pass it as a separate argument:

```bash
curl -fsSL https://raw.githubusercontent.com/wanderer210899-spec/retry-mobile/main/bootstrap.sh | bash -s -- backend-refracter
```

or set `RETRY_MOBILE_BRANCH` on the `bash` side:

```bash
curl -fsSL https://raw.githubusercontent.com/wanderer210899-spec/retry-mobile/main/bootstrap.sh | RETRY_MOBILE_BRANCH=backend-refracter bash
```

If you run interactive mode, choose:

```text
2
1
```

That means:
- `2` = `Install / Update now`
- `1` = install the frontend into `default-user`

Finished. The installer will:
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
Navigate to your local SillyTavern installation and run the same one-step bootstrap command again.

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

### How does versioning work now?
`release.json` is the single source of truth for Retry Mobile versioning.

When you bump `release.json.version`, the installer writes that version into installed frontend/backend manifests during install/update so runtime version reporting stays aligned.

### Developer release checklist
1. Update `release.json` version once.
2. Push branch/tag as usual.
3. Re-run bootstrap install/update on target environment and restart SillyTavern.

### Where is the GitHub link?
The Retry Mobile frontend panel title links to the GitHub repository, and the install/update card inside the panel also links to GitHub.
