[CmdletBinding()]
param([Parameter(Mandatory)][ValidateSet('primitives','package','cleanup')][string]$Phase)
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
# Leave a minute inside the step for reversal, in addition to the cleanup job step.
$phaseBudget = if ($Phase -eq 'primitives') { 9 } else { 7 }
$env:W17_DACL_CUTOFF = [DateTimeOffset]::UtcNow.AddMinutes($phaseBudget - 1).ToUnixTimeMilliseconds()
$out = $env:W17_OUT
$expected = Join-Path $env:RUNNER_TEMP "w17-windows-$env:GITHUB_RUN_ID-$env:GITHUB_RUN_ATTEMPT"
if (!$IsWindows -or !$out -or $out -ne $expected) { throw 'Expected run-specific Windows controller directory' }
if ((Get-Item -LiteralPath $out).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Unexpected controller directory redirection' }
$recovery=0
if ($Phase -eq 'cleanup') {
    & node "$PSScriptRoot/../evidence.mjs" recover
    $recovery=$LASTEXITCODE
}
& node "$PSScriptRoot\phase-log.mjs" $Phase begin
if ($LASTEXITCODE) { exit $LASTEXITCODE }
try {
    $env:W17_PRIVATE=$out
    $env:W17_ACL_VERIFY_ONLY='1'
    if (!$env:W17_PRIVATE_ACL) { throw 'Missing private DACL verifier' }
    & ([scriptblock]::Create($env:W17_PRIVATE_ACL))
    if ($Phase -eq 'primitives') {
        $principal=[Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
        $arch=[Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
        $admin=$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
        $bfe=(Get-Service BFE).Status.ToString()
        & node "$PSScriptRoot\phase-log.mjs" $Phase preflight $arch $admin $bfe
        if ($LASTEXITCODE) { $failure=$LASTEXITCODE; throw 'Could not record preflight' }
        if ($arch -ne 'X64' -or !$admin -or $bfe -ne 'Running') { throw "Preflight arch=$arch elevated=$admin BFE=$bfe" }
        $vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
        $vs = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
        if ($LASTEXITCODE) { $failure=$LASTEXITCODE; throw "vswhere exit $failure" }
        if (!$vs) { throw 'x64 MSVC missing' }
        Import-Module "$vs\Common7\Tools\Microsoft.VisualStudio.DevShell.dll"
        # VsDevCmd exports a line-oriented environment through cmd.exe.
        $multiline = @([Environment]::GetEnvironmentVariables().GetEnumerator() | Where-Object { $_.Value -match '[\r\n]' })
        try {
            foreach ($entry in $multiline) {
                Write-Host "dev-shell setting aside environment variable $($entry.Key)"
                [Environment]::SetEnvironmentVariable($entry.Key, [NullString]::Value)
            }
            Enter-VsDevShell -VsInstallPath $vs -SkipAutomaticLocation -DevCmdArguments '-arch=x64 -host_arch=x64' | Out-Null
        } finally {
            foreach ($entry in $multiline) {
                [Environment]::SetEnvironmentVariable($entry.Key, $entry.Value)
            }
        }
        Push-Location $out
        try {
            foreach ($source in @('controller','subject')) {
                $flags = @('/nologo','/EHsc','/std:c++17','/W4','/DUNICODE','/D_UNICODE','/D_WIN32_WINNT=0x0A00','/MT')
                $sources=@("$PSScriptRoot\$source.cpp")
                if ($source -eq 'controller') { $flags += '/LD'; $sources+="$PSScriptRoot\tree-acl.cpp" }
                & cl.exe @flags @sources /link /MACHINE:X64 advapi32.lib user32.lib userenv.lib ws2_32.lib fwpuclnt.lib ole32.lib uuid.lib
                $rc=$LASTEXITCODE
                & node "$PSScriptRoot\phase-log.mjs" $Phase command $rc cl.exe @flags @sources /link /MACHINE:X64 advapi32.lib user32.lib userenv.lib ws2_32.lib fwpuclnt.lib ole32.lib uuid.lib
                if ($rc) { $failure=$rc; throw "MSVC exit $rc" }
                if ($LASTEXITCODE) { throw 'Could not record compilation' }
            }
        } finally { Pop-Location }
    }
    $env:W17_PWSH = (Get-Process -Id $PID).Path
    & node "$PSScriptRoot\probe.mjs" $Phase
    if ($LASTEXITCODE) { $failure=$LASTEXITCODE; throw "Probe phase exit $failure" }
    exit $recovery
} catch {
    if (!$failure) { $failure=1 }
    [Console]::Error.WriteLine($_.Exception.Message)
    & node "$PSScriptRoot\phase-log.mjs" $Phase failure $failure
    exit $failure
}
