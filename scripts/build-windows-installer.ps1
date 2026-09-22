[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$ExpectedCompilerVersion = '7.1.0'
$ExpectedCompilerMachine = 0x8664
$ProductName = 'CourseStow'
$ProductPublisher = 'aryanramz'
$ProductRepository = 'https://github.com/aryanramz/coursestow'

function Read-JsonFile([string]$Path, [string]$Label) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "$Label is missing: $Path"
    }
    try {
        return Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
    }
    catch {
        throw "$Label is not valid JSON: $Path"
    }
}

function Resolve-IsccPath {
    if (-not [string]::IsNullOrWhiteSpace($env:ISCC_PATH)) {
        $explicit = [Environment]::ExpandEnvironmentVariables($env:ISCC_PATH.Trim().Trim('"'))
        if (-not (Test-Path -LiteralPath $explicit -PathType Leaf)) {
            throw "ISCC_PATH does not point to an existing compiler: $explicit"
        }
        return (Resolve-Path -LiteralPath $explicit).Path
    }

    $candidates = New-Object System.Collections.Generic.List[string]
    if (-not [string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
        $candidates.Add((Join-Path $env:LOCALAPPDATA 'Programs\Inno Setup 7\ISCC.exe'))
    }
    foreach ($programFilesRoot in @(
        [Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFiles),
        ${env:ProgramFiles},
        ${env:ProgramFiles(x86)}
    )) {
        if (-not [string]::IsNullOrWhiteSpace($programFilesRoot)) {
            $candidates.Add((Join-Path $programFilesRoot 'Inno Setup 7\ISCC.exe'))
        }
    }
    foreach ($candidate in $candidates | Select-Object -Unique) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) {
            return (Resolve-Path -LiteralPath $candidate).Path
        }
    }
    throw "Inno Setup $ExpectedCompilerVersion x64 was not found. Install that exact compiler or set ISCC_PATH to its ISCC.exe."
}

function Get-PeMachine([string]$Path) {
    $stream = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
    try {
        $reader = New-Object System.IO.BinaryReader($stream)
        try {
            if ($reader.ReadUInt16() -ne 0x5A4D) { throw "Compiler is not a Windows PE executable: $Path" }
            $stream.Seek(0x3C, [System.IO.SeekOrigin]::Begin) | Out-Null
            $peOffset = $reader.ReadInt32()
            $stream.Seek($peOffset, [System.IO.SeekOrigin]::Begin) | Out-Null
            if ($reader.ReadUInt32() -ne 0x00004550) { throw "Compiler has an invalid PE header: $Path" }
            return $reader.ReadUInt16()
        }
        finally { $reader.Dispose() }
    }
    finally { $stream.Dispose() }
}

function Assert-Compiler([string]$Path) {
    $versionLines = @(& $Path --version 2>&1)
    if ($LASTEXITCODE -ne 0) {
        throw "Unable to query the Inno Setup compiler version at: $Path"
    }
    $versionText = ($versionLines | ForEach-Object { [string]$_ }) -join "`n"
    $reportedVersions = @([regex]::Matches($versionText, '(?<!\d)\d+\.\d+\.\d+(?!\d)') | ForEach-Object { $_.Value } | Select-Object -Unique)
    $actualVersion = if ($reportedVersions.Count -eq 1) { $reportedVersions[0] } else { 'unknown' }
    if ($actualVersion -cne $ExpectedCompilerVersion) {
        throw "Inno Setup compiler version mismatch: expected $ExpectedCompilerVersion x64, found $actualVersion."
    }
    $machine = Get-PeMachine $Path
    if ($machine -ne $ExpectedCompilerMachine) {
        throw ('Inno Setup compiler architecture mismatch: expected x64 PE machine 0x8664, found 0x{0:X4}.' -f $machine)
    }
}

function Assert-VersionMatch([string]$Label, [string]$Actual, [string]$Expected) {
    if ($Actual -ne $Expected) {
        throw "$Label version mismatch: expected $Expected, found $Actual."
    }
}

function Get-NormalizedFourPartVersion([string]$Value, [string]$Field, [string]$Label) {
    try { $parsed = [Version]$Value }
    catch { throw "Packaged Windows binary $Field metadata is invalid for ${Label}." }
    if ($parsed.Build -lt 0) { throw "Packaged Windows binary $Field metadata is incomplete for ${Label}." }
    $revision = if ($parsed.Revision -lt 0) { 0 } else { $parsed.Revision }
    return '{0}.{1}.{2}.{3}' -f $parsed.Major, $parsed.Minor, $parsed.Build, $revision
}

function Assert-PackagedBinaryVersion([string]$Path, [string]$Label, [string]$Expected) {
    $expectedFourPart = "$Expected.0"
    try { $assemblyVersion = [System.Reflection.AssemblyName]::GetAssemblyName($Path).Version.ToString() }
    catch { throw "Packaged Windows binary assembly metadata could not be read for ${Label}." }
    $versionInfo = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($Path)
    $actualVersions = @(
        @{ Field = 'assembly version'; Value = Get-NormalizedFourPartVersion $assemblyVersion 'assembly version' $Label },
        @{ Field = 'file version'; Value = Get-NormalizedFourPartVersion ([string]$versionInfo.FileVersion) 'file version' $Label },
        @{ Field = 'product version'; Value = Get-NormalizedFourPartVersion ([string]$versionInfo.ProductVersion) 'product version' $Label }
    )
    foreach ($actual in $actualVersions) {
        if ($actual.Value -cne $expectedFourPart) {
            throw "Packaged Windows binary version mismatch for ${Label}: expected $Expected ($expectedFourPart), $($actual.Field) is $($actual.Value)."
        }
    }
}

function Get-Sha256([string]$Path) {
    $stream = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)
    try {
        $algorithm = [System.Security.Cryptography.SHA256]::Create()
        try {
            $digest = $algorithm.ComputeHash($stream)
            return -join ($digest | ForEach-Object { $_.ToString('x2') })
        }
        finally { $algorithm.Dispose() }
    }
    finally { $stream.Dispose() }
}

$repositoryRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$packageFile = Join-Path $repositoryRoot 'package.json'
$licenseFile = Join-Path $repositoryRoot 'LICENSE'
$bundleRoot = Join-Path $repositoryRoot 'dist\CourseStow'
$manifestFile = Join-Path $bundleRoot 'bundle-manifest.json'
$packagedPackageFile = Join-Path $bundleRoot 'app\package.json'
$installerSource = Join-Path $repositoryRoot 'installer\windows\CourseStow.iss'
$outputDirectory = Join-Path $repositoryRoot 'dist\installer'

$package = Read-JsonFile $packageFile 'Authoritative package metadata'
$appVersion = [string]$package.version
if ($appVersion -notmatch '^\d+\.\d+\.\d+(?:\.\d+)?$') {
    throw "Authoritative package version is not a supported numeric installer version: $appVersion"
}
if ([string]$package.name -ne 'coursestow') { throw 'Authoritative package name must be coursestow.' }
if (-not (Test-Path -LiteralPath $licenseFile -PathType Leaf)) { throw "Project MIT LICENSE is missing: $licenseFile" }
if (-not (Test-Path -LiteralPath $installerSource -PathType Leaf)) { throw "Inno Setup source is missing: $installerSource" }
if (-not (Test-Path -LiteralPath $bundleRoot -PathType Container)) {
    throw "Portable bundle is missing: $bundleRoot. Run npm run build:windows-bundle first."
}

$requiredBundleFiles = @(
    'CourseStow.exe',
    'CourseStow.exe.config',
    'CourseStow Credential Helper.exe',
    'CourseStow Credential Helper.exe.config',
    'CourseStow.cmd',
    'LICENSE',
    'bundle-manifest.json',
    'runtime\node.exe',
    'app\LICENSE',
    'app\package.json',
    'app\src\launcher.mjs',
    'app\node_modules\playwright\package.json'
)
foreach ($relative in $requiredBundleFiles) {
    $candidate = Join-Path $bundleRoot $relative
    if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
        throw "Portable bundle is incomplete; required file is missing: $relative"
    }
}

foreach ($relative in @(
    'config.json', 'BrowserProfile', 'state', 'logs', '.env', '.coursestow.lock',
    'app\config.json', 'app\BrowserProfile', 'app\state', 'app\logs'
)) {
    if (Test-Path -LiteralPath (Join-Path $bundleRoot $relative)) {
        throw "Portable bundle contains private runtime material and cannot be installed: $relative"
    }
}
if (Test-Path -LiteralPath (Join-Path $bundleRoot 'app\node_modules\playwright-core\.local-browsers')) {
    throw 'Portable bundle unexpectedly contains Playwright-downloaded browser binaries.'
}

foreach ($entry in Get-ChildItem -LiteralPath $bundleRoot -Recurse -Force) {
    $relative = $entry.FullName.Substring($bundleRoot.Length).TrimStart('\', '/')
    $segments = $relative -split '[\\/]'
    if ($segments | Where-Object { $_ -in @('BrowserProfile', '.brightspace-profile', 'BrightspaceMirror') }) {
        throw "Portable bundle contains private profile or mirror material and cannot be installed: $relative"
    }
    if (-not $entry.PSIsContainer -and (
        $entry.Name -ieq 'config.json' -or
        $entry.Name -ieq '_sync_state.json' -or
        $entry.Name -ieq '.coursestow.lock' -or
        $entry.Name -ieq '.brightspace-sync.lock' -or
        $entry.Name -ieq '.env' -or
        $entry.Name -ilike '.env.*'
    )) {
        throw "Portable bundle contains private configuration, state, or secret material and cannot be installed: $relative"
    }
}

$manifest = Read-JsonFile $manifestFile 'Portable bundle manifest'
$packagedPackage = Read-JsonFile $packagedPackageFile 'Packaged application metadata'
Assert-VersionMatch 'Portable bundle manifest' ([string]$manifest.application.version) $appVersion
Assert-VersionMatch 'Packaged application' ([string]$packagedPackage.version) $appVersion
if ([string]$manifest.application.name -ne $ProductName -or
    [string]$manifest.application.publisher -ne $ProductPublisher -or
    [string]$manifest.application.repository -ne $ProductRepository -or
    [string]$manifest.application.packageName -ne 'coursestow') {
    throw 'Portable bundle product metadata does not match the CourseStow installer identity.'
}
if ([string]$manifest.desktopEntrypoint -ne 'CourseStow.exe' -or
    [string]$manifest.credentialHelper -ne 'CourseStow Credential Helper.exe' -or
    [string]$manifest.runtime.platform -ne 'win32' -or
    [string]$manifest.runtime.architecture -ne 'x64') {
    throw 'Portable bundle entrypoint or runtime architecture metadata is not installable by the x64 CourseStow setup.'
}

Assert-PackagedBinaryVersion (Join-Path $bundleRoot 'CourseStow.exe') 'CourseStow.exe' $appVersion
Assert-PackagedBinaryVersion (Join-Path $bundleRoot 'CourseStow Credential Helper.exe') 'CourseStow Credential Helper.exe' $appVersion

$licenseHash = Get-Sha256 $licenseFile
foreach ($bundledLicense in @((Join-Path $bundleRoot 'LICENSE'), (Join-Path $bundleRoot 'app\LICENSE'))) {
    if ((Get-Sha256 $bundledLicense) -cne $licenseHash) {
        throw "Bundled LICENSE does not match the repository MIT LICENSE: $bundledLicense"
    }
}

$compilerPath = Resolve-IsccPath
Assert-Compiler $compilerPath

New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
$installerBaseName = "$ProductName-$appVersion-Setup"
$installerFile = Join-Path $outputDirectory "$installerBaseName.exe"
$checksumFile = "$installerFile.sha256"
Remove-Item -LiteralPath $installerFile -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $checksumFile -Force -ErrorAction SilentlyContinue

$compilerArguments = @(
    "/DAppVersion=$appVersion",
    "/DSourceBundle=$bundleRoot",
    "/DInstallerOutputDir=$outputDirectory",
    "/DProjectLicenseFile=$licenseFile",
    $installerSource
)
& $compilerPath @compilerArguments
if ($LASTEXITCODE -ne 0) { throw "Inno Setup compilation failed with exit code $LASTEXITCODE." }
if (-not (Test-Path -LiteralPath $installerFile -PathType Leaf)) {
    throw "Inno Setup reported success but the expected installer was not generated: $installerFile"
}

$installerVersionInfo = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($installerFile)
$expectedVersion = [Version]$appVersion
$actualVersion = [Version]$installerVersionInfo.ProductVersion
if ($actualVersion.Major -ne $expectedVersion.Major -or
    $actualVersion.Minor -ne $expectedVersion.Minor -or
    $actualVersion.Build -ne $expectedVersion.Build -or
    ($expectedVersion.Revision -ge 0 -and $actualVersion.Revision -ne $expectedVersion.Revision)) {
    throw "Generated installer product version mismatch: expected $appVersion, found $($installerVersionInfo.ProductVersion)."
}

$sha256 = Get-Sha256 $installerFile
if ($sha256 -notmatch '^[0-9a-f]{64}$') { throw 'SHA-256 generation returned an invalid digest.' }
$checksumLine = "$sha256  $([System.IO.Path]::GetFileName($installerFile))"
Set-Content -LiteralPath $checksumFile -Value $checksumLine -Encoding Ascii -NoNewline
$savedChecksum = Get-Content -LiteralPath $checksumFile -Raw
if ($savedChecksum -cne $checksumLine) { throw 'Generated SHA-256 sidecar does not match the required conventional format.' }
if ((Get-Sha256 $installerFile) -cne $sha256) {
    throw 'Independent SHA-256 verification failed after writing the sidecar.'
}

Write-Host "Inno Setup compiler: $ExpectedCompilerVersion x64"
Write-Host "CourseStow version: $appVersion"
Write-Host "Installer: $installerFile"
Write-Host "SHA-256: $sha256"
