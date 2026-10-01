param(
  [Parameter(Mandatory = $true)][string]$ApplicationPath,
  [Parameter(Mandatory = $true)][string]$ExpectedSubject,
  [Parameter(Mandatory = $true)][string]$ExpectedVersion,
  [switch]$Installer,
  [string]$ReleaseVersion
)
$ErrorActionPreference = 'Stop'
$signature = Get-AuthenticodeSignature -LiteralPath $ApplicationPath
if ($signature.Status -ne 'Valid') { throw "Invalid Authenticode signature: $($signature.Status)" }
if ($signature.SignerCertificate.Subject -cne $ExpectedSubject) { throw 'Unexpected signing certificate subject' }
if ($null -eq $signature.TimeStamperCertificate) { throw 'Trusted timestamp is missing' }
$metadata = (Get-Item -LiteralPath $ApplicationPath).VersionInfo
if ($metadata.ProductName -cne 'Kobrixa' -or (-not $Installer -and $metadata.OriginalFilename -cne 'kobrixa.exe')) {
  throw 'Unexpected executable product metadata'
}
$expectedProductVersion = if ($Installer) { $ReleaseVersion } else { $ExpectedVersion }
if ($metadata.ProductVersion -cne $expectedProductVersion -or $metadata.FileVersion -cne $ExpectedVersion) {
  throw 'Executable version differs from the release version'
}
# The Windows runner includes the SDK. /pa verifies the Authenticode chain and
# timestamp; /all rejects an invalid additional signature as well.
$sdk = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits/10/bin'
$signTool = Get-ChildItem -Path "$sdk/*/x64/signtool.exe" |
  Sort-Object { [version]$_.Directory.Parent.Name } -Descending | Select-Object -First 1
if ($null -eq $signTool) { throw 'Windows SDK SignTool is missing' }
& $signTool.FullName verify /pa /all /tw $ApplicationPath
if ($LASTEXITCODE -ne 0) { throw 'SignTool trust verification failed' }
