# Run in a fresh x64 pwsh process on the disposable Windows preflight host.
param([Parameter(Mandatory)][string]$ControllerDll)
$ErrorActionPreference = 'Stop'
$log=Join-Path (Split-Path -Parent (Resolve-Path -LiteralPath $ControllerDll)) 'preflight.log'
$clock=[Diagnostics.Stopwatch]::StartNew()
function Result($op,$rc,$detail) {
    Add-Content -LiteralPath $log "$op rc=$rc elapsedMs=$($clock.ElapsedMilliseconds) $detail"
}
function Invoke-Measurement($name,[scriptblock]$call) {
    Add-Content -LiteralPath $log "$name started"
    $clock.Restart()
    try { return (& $call) }
    catch {
        Add-Content -LiteralPath $log "$name exception=$($_.Exception.GetBaseException().GetType().Name) elapsedMs=$($clock.ElapsedMilliseconds)"
        throw
    }
}
# Reopen against creation IDs after the ACL round trip so its native opens
# keep their original sharing semantics. Pin parents before opening children.
$objects=[Collections.Generic.List[object]]::new()
function Remember($path,[bool]$directory) {
    $pin=[W17]::PinStage($path)
    try {
        $id=[W17]::Identity($pin,$directory)
        $objects.Add(@{path=$path;directory=$directory;id=$id;pin=$null})
    } finally { $pin.Dispose() }
}
function Remove-Fixture {
    foreach ($item in $objects) {
        try {
            $item.pin=[W17]::PinStage($item.path)
            if ([W17]::Identity($item.pin,$item.directory) -cne $item.id) { throw 'Fixture replaced' }
        } catch {
            Add-Content -LiteralPath $log "cleanup pending path=$($item.path) reason=$($_.Exception.GetBaseException().Message)"
            foreach ($known in $objects) {
                if ($known.pin) { $known.pin.Dispose() }
            }
            throw
        }
    }
    $pending=$false
    for ($i=$objects.Count-1; $i -ge 0; $i--) {
        $item=$objects[$i]
        $pin=$item.pin
        try {
            if ($item.directory) {
                $listed=0
                foreach ($remaining in [IO.Directory]::EnumerateFileSystemEntries($item.path)) {
                    if (++$listed -gt 7) {
                        Add-Content -LiteralPath $log "cleanup additional children retained path=$($item.path)"
                        break
                    }
                    Add-Content -LiteralPath $log "cleanup retained child=$remaining"
                }
            }
            [W17]::DeletePinned($pin) # Directory disposition fails if anything remains.
        } catch {
            Add-Content -LiteralPath $log "cleanup pending path=$($item.path) reason=$($_.Exception.GetBaseException().Message)"
            $pending=$true
        } finally { if ($pin) { $pin.Dispose() } }
    }
    if ($pending) { throw "Preflight cleanup incomplete. Retain $stage for reconciliation." }
}
$dll = (Resolve-Path -LiteralPath $ControllerDll).Path
Add-Type -TypeDefinition ((Get-Content "$PSScriptRoot/bridge.cs" -Raw).Replace('W17_DLL',$dll))
$desktop = [Text.StringBuilder]::new(65536)
$rc=Invoke-Measurement 'descriptor' { [W17]::DesktopRead(1,$desktop,$desktop.Capacity) }
Result 'descriptor' $rc "desktop=$desktop"
if ($rc -or !$desktop.Length) { if ($rc) {exit $rc}; throw 'Empty desktop descriptor' }
$repo = (Resolve-Path "$PSScriptRoot/../../../..").Path
$dependency = & node -e 'console.log(require.resolve("zod/package.json",{paths:[process.argv[1]]}))' "$repo/apps/desktop"
if ($LASTEXITCODE) { exit $LASTEXITCODE }
$stage = [IO.Directory]::CreateTempSubdirectory('w17-preflight-').FullName
Add-Content -LiteralPath $log "scratch=$stage"
function New-FixtureDir($path) {
    if (![W17]::CreateDirectoryW($path,[IntPtr]::Zero)) { throw 'Fixture directory collision or creation error' }
    Remember $path $true
}
$failure=0
try {
    Remember $stage $true
    $root = Join-Path $stage 'sentinels'
    $manifest = Join-Path $stage 'snapshot.dacl'
    New-FixtureDir $root
    foreach ($label in @('checkout','worktree','dependency')) {
        $dir=Join-Path $root $label
        New-FixtureDir $dir
        $source = if ($label -eq 'dependency') { $dependency } else { "$repo/package.json" }
        $file=Join-Path $dir 'package.json'
        [IO.File]::Copy($source,$file,$false)
        Remember $file $false
    }
    # An unassigned SID exercises the same DACL change without creating an account.
    $random = [guid]::NewGuid().ToByteArray()
    $sid = 'S-1-5-21-{0}-{1}-{2}-1001' -f [BitConverter]::ToUInt32($random,0),[BitConverter]::ToUInt32($random,4),[BitConverter]::ToUInt32($random,8)
    try {
        $null=[Security.Principal.SecurityIdentifier]::new($sid).Translate([Security.Principal.NTAccount])
        throw 'Generated preflight SID already maps to an account'
    } catch [Security.Principal.IdentityNotMappedException] { }
    [uint32]$count=0
    [uint32]$verified=0
    [IO.File]::Open($manifest,'CreateNew','Write','None').Dispose()
    Remember $manifest $false
    $countRef=[ref]$count
    $verifiedRef=[ref]$verified
    $rc=Invoke-Measurement 'snapshot' { [W17]::TreeSaveTrace($root,$manifest,$countRef,$log) }
    Result 'snapshot' $rc "objects=$count"
    if ($rc) { $failure=$rc; throw 'Snapshot failed' }
    if ($count -ne 7) { throw "Snapshot objects=$count" }
    try {
        $apply=Invoke-Measurement 'apply' { [W17]::TreeChangeTrace($manifest,$count,$sid,0,$verifiedRef,$log) }
        Result 'apply' $apply "verified=$verified"
        if ($apply) { $failure=$apply; throw 'Apply failed' }
        if ($verified -ne $count) { throw "Apply verified=$verified" }
    } finally {
        $restore=Invoke-Measurement 'restore' { [W17]::TreeChangeTrace($manifest,$count,$sid,1,$verifiedRef,$log) }
        Result 'restore' $restore "verified=$verified"
        if ($restore) { $failure=$restore; throw 'Restore failed' }
        if ($verified -ne $count) { throw "Restore verified=$verified" }
    }
} catch {
    if (!$failure) { $failure=1 }
    Add-Content -LiteralPath $log "fixture failure=$($_.Exception.GetBaseException().Message)"
} finally {
    try {
        Remove-Fixture
        if ([IO.Directory]::Exists($stage)) { throw "Stage still present" }
        Add-Content -LiteralPath $log "cleanup removed scratch=$stage"
    } catch {
        Add-Content -LiteralPath $log "cleanup incomplete scratch=$stage reason=$($_.Exception.GetBaseException().Message)"
        if (!$failure) { $failure=1 }
    }
}
exit $failure
