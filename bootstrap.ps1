param(
    [Parameter(Position = 0)]
    [string]$Branch = '',

    [Alias('b')]
    [string]$BranchOverride = '',

    [switch]$Headless,

    [string]$StRoot = '',

    [string]$Profile = '',

    [switch]$Help
)

$ErrorActionPreference = 'Stop'

$RepoUrl = 'https://github.com/wanderer210899-spec/retry-mobile.git'
# BOOTSTRAP_BRANCH: the default branch cloned when no CLI override or env var is supplied.
$BootstrapBranch = 'main'

if ($Help) {
    @'
Usage:
  irm <bootstrap-url> | iex
  & ([scriptblock]::Create((irm <bootstrap-url>))) <branch>
  & ([scriptblock]::Create((irm <bootstrap-url>))) -Branch <branch>
  & ([scriptblock]::Create((irm <bootstrap-url>))) -Branch <branch> -Headless
  & ([scriptblock]::Create((irm <bootstrap-url>))) -Branch <branch> -Headless -StRoot "C:\path\to\SillyTavern"
  & ([scriptblock]::Create((irm <bootstrap-url>))) -Branch <branch> -Headless -Profile "default-user"

Override precedence:
  1. CLI branch argument
  2. RETRY_MOBILE_BRANCH environment variable
  3. main

Options:
  -Headless        Non-interactive install/update. Installs backend plus global frontend.
  -StRoot <path>   Explicit SillyTavern root override.
  -Profile <name>  Profile-local frontend install target (for example: default-user).
'@ | Write-Host
    exit 0
}

$CliBranch = if ($BranchOverride) {
    [string]$BranchOverride
} elseif ($Branch) {
    [string]$Branch
} else {
    ''
}

$RepoBranch = if ($CliBranch) {
    $CliBranch
} elseif ($env:RETRY_MOBILE_BRANCH) {
    [string]$env:RETRY_MOBILE_BRANCH
} else {
    $BootstrapBranch
}
$TempRoot = Join-Path $env:TEMP ('retry-mobile-installer-' + [guid]::NewGuid().ToString('N'))
$RepoDir = Join-Path $TempRoot 'retry-mobile'
$LaunchDirectory = Resolve-LaunchDirectory -OverridePath $StRoot

function Resolve-LaunchDirectory {
    param(
        [string]$OverridePath
    )

    if ($OverridePath) {
        return (Resolve-Path -LiteralPath $OverridePath).Path
    }

    $cwd = (Get-Location).Path
    $cwdConfig = Join-Path $cwd 'config.yaml'
    if (Test-Path -LiteralPath $cwdConfig) {
        return $cwd
    }

    $cwdSt = Join-Path $cwd 'SillyTavern'
    $cwdStConfig = Join-Path $cwdSt 'config.yaml'
    if (Test-Path -LiteralPath $cwdStConfig) {
        return $cwdSt
    }

    return $cwd
}

try {
    New-Item -ItemType Directory -Force -Path $TempRoot | Out-Null

    if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
        throw 'Git is required to run the Retry Mobile bootstrap installer.'
    }

    if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
        throw 'Node.js is required to run the Retry Mobile bootstrap installer.'
    }

    git clone --depth 1 --branch $RepoBranch $RepoUrl $RepoDir | Out-Host
    Push-Location $LaunchDirectory
    try {
        $env:RETRY_MOBILE_BRANCH = $RepoBranch
        if ($Headless) {
            $env:RETRY_MOBILE_HEADLESS = '1'
        } else {
            Remove-Item Env:RETRY_MOBILE_HEADLESS -ErrorAction SilentlyContinue
        }
        if ($Profile) {
            $env:RETRY_MOBILE_PROFILE = $Profile
        } else {
            Remove-Item Env:RETRY_MOBILE_PROFILE -ErrorAction SilentlyContinue
        }
        & node (Join-Path $RepoDir 'install.cjs')
    }
    finally {
        Pop-Location
    }
}
finally {
    if (Test-Path $TempRoot) {
        Remove-Item -LiteralPath $TempRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}
