<#
.SYNOPSIS
    Installs the DreamFXLang extension into VSCode from a .vsix.

.DESCRIPTION
    With no argument it picks the newest .vsix beside this script, so it works both on a release
    download and straight after `npm run package` without having to type the version.
#>
param(
    [string]$VsixPath = ""
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($VsixPath)) {
    $candidate = Get-ChildItem -LiteralPath $PSScriptRoot -Filter "*.vsix" -File |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 1
    if (-not $candidate) {
        throw "No .vsix beside this script. Run 'npm run package' first, or pass -VsixPath."
    }
    $VsixPath = $candidate.FullName
}

if (-not (Test-Path -LiteralPath $VsixPath)) {
    throw "VSIX package not found: $VsixPath"
}

# Most specific first: a per-user install shadows a machine-wide one, and a `code` on PATH is as
# likely to be a shim for something else as it is the editor itself.
$codeCandidates = @(
    (Join-Path $env:LOCALAPPDATA "Programs\Microsoft VS Code\bin\code.cmd"),
    (Join-Path $env:ProgramFiles "Microsoft VS Code\bin\code.cmd"),
    (Join-Path ${env:ProgramFiles(x86)} "Microsoft VS Code\bin\code.cmd"),
    "code"
) | Where-Object { $_ -and $_.Trim().Length -gt 0 }

$codeCommand = $null
foreach ($candidate in $codeCandidates) {
    if ($candidate -eq "code") {
        $resolved = Get-Command code -ErrorAction SilentlyContinue
        if ($resolved) {
            $codeCommand = $resolved.Source
            break
        }
        continue
    }

    if (Test-Path -LiteralPath $candidate) {
        $codeCommand = $candidate
        break
    }
}

if (-not $codeCommand) {
    throw "Could not find the VSCode 'code' command. Open VSCode and install from VSIX manually."
}

# Code.exe cannot install an extension; the bin\code.cmd shim is the one with the CLI.
if ([System.IO.Path]::GetFileName($codeCommand) -ieq "Code.exe") {
    $binCandidate = Join-Path (Split-Path -Parent $codeCommand) "bin\code.cmd"
    if (Test-Path -LiteralPath $binCandidate) {
        $codeCommand = $binCandidate
    }
}

Write-Host "Installing $(Split-Path -Leaf $VsixPath)" -ForegroundColor Cyan
& $codeCommand --install-extension $VsixPath --force
if ($LASTEXITCODE -ne 0) {
    throw "VSCode extension install failed with exit code $LASTEXITCODE."
}
