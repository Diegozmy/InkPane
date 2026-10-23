# Build / flash / monitor helper for the InkPane firmware.
#
# Windows only, but deliberately small: it finds ESP-IDF through
# INKPANE_IDF_PROFILE, the -IdfProfile argument, or the local EIM installation,
# uses a short build directory (Windows MAX_PATH is a real problem here) and
# redirects the noisy build output to a log file.
#
# ESP-IDF selection (first match wins) is only performed when IDF_PATH /
# IDF_TOOLS_PATH / ESP_IDF_VERSION are not all present in the environment:
#   1. $env:INKPANE_IDF_PROFILE
#   2. -IdfProfile <path>
#   3. C:\Espressif\tools\Microsoft.v6.0.2.PowerShell_profile.ps1
#   4. newest installed C:\Espressif\tools\Microsoft.v6.*.PowerShell_profile.ps1
# The selected profile is dot-sourced (output discarded) so it also updates
# PATH, ESP_IDF_VERSION and IDF_PYTHON_ENV_PATH. Before building, the script
# runs and checks `idf.py --version` and fails with a clear error if the
# toolchain cannot be used.
#
#   powershell -ExecutionPolicy Bypass -File hardware/tools/build.ps1
#   powershell -ExecutionPolicy Bypass -File hardware/tools/build.ps1 -Flash -Port COM5
#   powershell -ExecutionPolicy Bypass -File hardware/tools/build.ps1 -Monitor -Port COM5
#   powershell -ExecutionPolicy Bypass -File hardware/tools/build.ps1 -Size
#   powershell -ExecutionPolicy Bypass -File hardware/tools/build.ps1 -Clean
#   powershell -ExecutionPolicy Bypass -File hardware/tools/build.ps1 -IdfProfile C:\Espressif\tools\Microsoft.v6.0.2.PowerShell_profile.ps1

param(
    [switch]$Flash,
    [switch]$Monitor,
    [switch]$Size,
    [switch]$Clean,
    [string]$BuildDir = (Join-Path $env:TEMP 'inkpane-build'),
    [string]$Port = '',
    [string]$IdfProfile = ''
)

$ErrorActionPreference = 'Stop'

# --- Locate and activate ESP-IDF -------------------------------------------

if (-not ($env:IDF_PATH -and $env:IDF_TOOLS_PATH -and $env:ESP_IDF_VERSION)) {
    $explicitProfiles = @()
    if ($env:INKPANE_IDF_PROFILE) { $explicitProfiles += $env:INKPANE_IDF_PROFILE }
    if ($IdfProfile) { $explicitProfiles += $IdfProfile }

    $defaultProfile = 'C:\Espressif\tools\Microsoft.v6.0.2.PowerShell_profile.ps1'
    $installedProfiles = @()
    $toolsRoot = 'C:\Espressif\tools'
    if (Test-Path -LiteralPath $toolsRoot) {
        $installedProfiles = Get-ChildItem -LiteralPath $toolsRoot -File -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -like 'Microsoft.v6.*.PowerShell_profile.ps1' } |
            Sort-Object -Property @{ Expression = {
                if ($_.Name -match 'Microsoft\.v(\d+(?:\.\d+)*)\.PowerShell_profile\.ps1') {
                    try { [version]$matches[1] } catch { [version]'0.0' }
                } else {
                    [version]'0.0'
                }
            } } -Descending |
            ForEach-Object { $_.FullName }
    }

    # De-duplicate while keeping the documented priority order.
    $candidates = @()
    $seen = @{}
    foreach ($candidate in (@($explicitProfiles) + @($defaultProfile) + @($installedProfiles))) {
        if ([string]::IsNullOrWhiteSpace($candidate)) { continue }
        $key = $candidate.Trim().ToLowerInvariant()
        if (-not $seen.ContainsKey($key)) {
            $seen[$key] = $true
            $candidates += $candidate.Trim()
        }
    }

    $attempted = @()
    $loadedProfile = $null
    foreach ($profilePath in $candidates) {
        $attempted += $profilePath
        if (-not (Test-Path -LiteralPath $profilePath -PathType Leaf)) {
            if ($explicitProfiles -contains $profilePath) {
                Write-Warning "ESP-IDF profile not found: $profilePath"
            }
            continue
        }
        try {
            . $profilePath *> $null
        }
        catch {
            Write-Warning "Failed to activate ESP-IDF profile '$profilePath': $($_.Exception.Message)"
            continue
        }
        if ($env:IDF_PATH -and $env:IDF_TOOLS_PATH) {
            $loadedProfile = $profilePath
            break
        }
        Write-Warning "ESP-IDF profile '$profilePath' did not set IDF_PATH/IDF_TOOLS_PATH."
    }

    if (-not $loadedProfile) {
        $list = if ($attempted.Count -gt 0) { $attempted -join "`n  " } else { '(no profile candidates found)' }
        throw "ESP-IDF is not configured and no usable profile could be activated. Tried:`n  $list`nSet INKPANE_IDF_PROFILE, pass -IdfProfile <path>, or install ESP-IDF v6.0.2 under C:\Espressif\tools."
    }
    Write-Host "ESP-IDF profile: $loadedProfile"
}

if (-not $env:IDF_PATH) {
    throw 'ESP-IDF is not configured. Run the EIM export script or set INKPANE_IDF_PROFILE.'
}

# --- Resolve the toolchain and verify it before touching the build tree ----

$project = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$project = Join-Path $project 'main'
$idf = Join-Path $env:IDF_PATH 'tools\idf.py'
if (-not (Test-Path -LiteralPath $idf -PathType Leaf)) {
    throw "idf.py not found at '$idf'. IDF_PATH='$env:IDF_PATH' does not look like an ESP-IDF checkout."
}

$python = 'python'
if ($env:IDF_PYTHON_ENV_PATH) {
    $candidate = Join-Path $env:IDF_PYTHON_ENV_PATH 'Scripts\python.exe'
    if (Test-Path -LiteralPath $candidate -PathType Leaf) { $python = $candidate }
}

$env:PYTHONUTF8 = '1'

$versionLines = @()
# Windows PowerShell 5.1 turns redirected native stderr into a terminating
# error while $ErrorActionPreference is 'Stop', so relax it for native tools.
$previousEap = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
try {
    $versionLines = @(& $python $idf --version 2>&1)
}
catch {
    throw "Unable to run 'idf.py --version' with '$python': $($_.Exception.Message)"
}
finally {
    $ErrorActionPreference = $previousEap
}
$versionText = ($versionLines | Out-String).Trim()
if ($LASTEXITCODE -ne 0) {
    throw "idf.py --version failed (exit code $LASTEXITCODE) with '$python $idf'.`nCheck the ESP-IDF profile and Python environment. Output:`n$versionText"
}
if ([string]::IsNullOrWhiteSpace($versionText)) {
    throw "idf.py --version produced no output with '$python $idf'. ESP-IDF is probably misconfigured; re-run the EIM profile or set INKPANE_IDF_PROFILE."
}
Write-Host "idf.py --version: $versionText"

# --- Build / flash / monitor ----------------------------------------------

Push-Location $project
try {
    if ($Clean) {
        Remove-Item $BuildDir -Recurse -Force -ErrorAction SilentlyContinue
    }
    New-Item -ItemType Directory -Force -Path $BuildDir | Out-Null

    if ($Monitor) {
        $arguments = @($idf, '-B', $BuildDir, 'monitor')
        if ($Port) { $arguments += @('-p', $Port) }
        & $python @arguments
        exit $LASTEXITCODE
    }

    if ($Flash) {
        $arguments = @($idf, '-B', $BuildDir, 'flash')
        if ($Port) { $arguments += @('-p', $Port) }
        & $python @arguments
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    }

    if ($Size) {
        & $python $idf -B $BuildDir size
        exit $LASTEXITCODE
    }

    $log = Join-Path $BuildDir 'build.log'
    # See the note above: idf.py writes progress to stderr and 5.1 would treat
    # that as a terminating error under 'Stop' once the stream is redirected.
    $previousEap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & $python $idf -B $BuildDir build *> $log
    }
    finally {
        $ErrorActionPreference = $previousEap
    }
    $code = $LASTEXITCODE
    if ($code -ne 0) {
        Write-Host 'Build failed. Tail of the log:'
        Get-Content $log -Tail 60
        exit $code
    }
    Write-Host "Build complete: $BuildDir"
    Get-ChildItem $BuildDir -Filter '*.bin' | Select-Object Name, Length
}
finally {
    Pop-Location
}
