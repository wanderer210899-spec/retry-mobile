# Retry Mobile

Retry Mobile is a split SillyTavern plugin (backend + frontend) installed by a bootstrap script.

## Requirements
- SillyTavern

## Install / Update (same command)

### Windows
1. Open your SillyTavern folder in File Explorer.
2. Click the address bar, type `powershell`, press Enter.
3. Paste this and press Enter:

```powershell
irm https://raw.githubusercontent.com/wanderer210899-spec/retry-mobile/main/bootstrap.ps1 | iex
```

### Android / Termux
Run this from either:
- your SillyTavern folder (`~/SillyTavern`), or
- a folder that contains a `SillyTavern/` subfolder (the script will try to find it)

```bash
curl -fsSL https://raw.githubusercontent.com/wanderer210899-spec/retry-mobile/main/bootstrap.sh | bash
```

## Uninstall
Run the same command again and choose the uninstall option in the menu.
