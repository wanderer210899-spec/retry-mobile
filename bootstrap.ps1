param(
    [Parameter(Position = 0)]
    [string]$Branch = '',

    [Alias('b')]
    [string]$BranchOverride = '',

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

Override precedence:
  1. CLI branch argument
  2. RETRY_MOBILE_BRANCH environment variable
  3. main
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
$LaunchDirectory = (Get-Location).Path

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
