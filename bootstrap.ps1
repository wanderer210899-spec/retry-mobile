$RepoBranchArgument = if ($args.Count -gt 0) { [string]$args[0] } else { '' }
$ErrorActionPreference = 'Stop'

$RepoUrl = 'https://github.com/wanderer210899-spec/retry-mobile.git'
$RepoBranch = if ($RepoBranchArgument) {
    $RepoBranchArgument
} elseif ($env:RETRY_MOBILE_BRANCH) {
    [string]$env:RETRY_MOBILE_BRANCH
} else {
    'feature/screen_off_initial_generation'
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
