# Retry Mobile (IN PROGRESS...)

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

2. Run this command:

```bash
curl -fsSL https://raw.githubusercontent.com/wanderer210899-spec/retry-mobile/main/bootstrap.sh | bash
```

3. Finished. The installer will:
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
Install / Update now
```

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
