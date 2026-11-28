param([Parameter(Mandatory)][string]$Build)
$ErrorActionPreference='Stop'
$log=Join-Path $Build preflight.log
$dll=(Resolve-Path "$build/controller.dll").Path
Add-Type -TypeDefinition ((Get-Content "$PSScriptRoot/bridge.cs" -Raw).Replace('W17_DLL',$dll))
. "$PSScriptRoot/raw-acl.ps1"

# These disposable journal entries exercise the same editor and restore functions.
$entries=[Collections.Generic.List[object]]::new()
function Intent($kind,$data) {
    $entry=@{id=$entries.Count;kind=$kind;data=$data}
    $entries.Add($entry)
    return $entry
}
function Save {}
function Check($rc,$action) { if ($rc) { throw "$action returned $rc" } }
function Verify-Private($mode,[switch]$ExpectRejection) {
    $env:W17_ACL_VERIFY_ONLY=$mode
    $command='try { & ([scriptblock]::Create($env:W17_PRIVATE_ACL)) } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }'
    $output=node -e 'const r=require("node:child_process").spawnSync("pwsh",["-NoProfile","-NonInteractive","-Command",process.argv[1]],{stdio:"inherit"}); if(r.error) throw r.error; process.exit(r.status ?? 1)' $command 2>&1
    $rc=$LASTEXITCODE
    foreach ($line in $output) { Add-Content $log $line.ToString() }
    Write-Verbose "verify-private mode=$mode rc=$rc"
    if ($ExpectRejection) {
        if (!$rc -or !(($output -join [Environment]::NewLine) -match '(?m)^(?:Private directory DACL mismatch|Unexpected private directory ACE)\s*$')) {
            throw "Expected private verifier rejection rc=$rc"
        }
        Write-Verbose "result=PRIVATE_VERIFIER_REJECTS_NONPRIVATE rc=$rc"
    } else { Check $rc 'private verifier' }
}
function Test-RawAcl {
    $VerbosePreference='Continue'
    $objects=[Collections.Generic.List[string]]::new()
    $stage=Join-Path $env:ProgramFiles ("W17-preflight-"+[guid]::NewGuid().ToString('N'))
    $dir=Join-Path $stage home
    $file=Join-Path $dir input
    $marker=Join-Path $stage '.w17-owner'
    $protected=$false
    $random=[guid]::NewGuid().ToByteArray()
    $sid='S-1-5-21-{0}-{1}-{2}-1001' -f [BitConverter]::ToUInt32($random,0),[BitConverter]::ToUInt32($random,4),[BitConverter]::ToUInt32($random,8)
    try {
        $c='raw=unavailable'
        try {
            if ([string]::IsNullOrWhiteSpace($env:W17_PRIVATE_ACL)) { throw 'Missing private DACL verifier' }
            $env:W17_PRIVATE=[IO.Directory]::CreateTempSubdirectory('w17-private-').FullName
            $objects.Add($env:W17_PRIVATE)
            $original=Section $env:W17_PRIVATE
            $c="original=$original"
            Verify-Private '0'
            $private=Section $env:W17_PRIVATE
            $c+=" private=$private"
            if ($private -ceq $original) { throw 'Private verifier produced no DACL change' }
            Write-RawDacl $env:W17_PRIVATE $private $original 'restore private original'
            if ((Section $env:W17_PRIVATE) -cne $original) { throw 'Private original mismatch' }
            Write-RawDacl $env:W17_PRIVATE $original $private 'reinstall private DACL'
            if ((Section $env:W17_PRIVATE) -cne $private) { throw 'Private reinstall mismatch' }
            Verify-Private '1'
            # Add an explicit third trustee to the verified private descriptor.
            $nonprivate=$private+"(A;;FR;;;$sid)"
            Write-RawDacl $env:W17_PRIVATE $private $nonprivate 'install negative control'
            $negative=Section $env:W17_PRIVATE
            $c+=" negative=$negative"
            if ($negative -cne $nonprivate) { throw 'Private negative control mismatch' }
            Verify-Private '1' -ExpectRejection
            Write-Verbose "result=PRIVATE_VERIFIER PASS $c"
        } catch { $script:failed=$true; Write-Verbose "result=PRIVATE_VERIFIER FAIL $c error=$($_.Exception.Message)" }

        $original=$null
        $measurement=@{}
        $after=$null
        try {
            $ownerSid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
            $pin=[W17]::CreateStage($stage)
            try { $objects.Add($stage) } finally { $pin.Dispose() }
            [IO.File]::Open($marker,'CreateNew','Write','None').Dispose()
            $objects.Add($marker)
            $original=Section $stage
            Protect-Stage $stage $ownerSid -measurement $measurement
            $after=Section $stage
            if ($after -cne $measurement.observed -or $after -cnotmatch '^D:P\(') { throw "Unexpected protected stage raw=$after" }
            $protected=$true
            Protect-Stage $marker $ownerSid -Marker
            if ($original -cnotmatch '^D:[^(]*AI') { throw 'PROTECT_STAGE_INITIAL_AI_ABSENT' }
            Write-Verbose "result=PROTECT_STAGE PASS raw=$after rc=$($measurement.rc)"
        } catch {
            $script:failed=$true
            Write-Verbose "result=PROTECT_STAGE FAIL before=$original observed=$($measurement.observed) rc=$($measurement.rc) error=$($_.Exception.Message)"
            if ($original) {
                try { Write-Verbose "stage after primary measurement raw=$(Section $stage)" }
                catch { Write-Verbose "stage readback error=$($_.Exception.Message)" }
            }
            if ($measurement.stickyRequest) {
                try {
                    Write-RawDacl $stage $original $measurement.stickyRequest 'preflight sticky AI fallback'
                    $after=Section $stage
                    if ($after -cne $measurement.stickyRequest) { throw "Fallback stage mismatch raw=$after" }
                    $protected=$true
                    Write-Verbose "result=STICKY_STAGE_FALLBACK PASS raw=$after"
                } catch { Write-Verbose "result=STICKY_STAGE_FALLBACK FAIL error=$($_.Exception.Message)" }
            }
        }
        $beforeAI=if ($original) { $original -cmatch '^D:[^(]*AI' } else { 'unknown' }
        $afterAI=if ($measurement.observed) { $measurement.observed -cmatch '^D:[^(]*AI' } else { 'unknown' }
        Write-Verbose "result=PROTECT_STAGE_AI beforeAI=$beforeAI afterAI=$afterAI before=$original firstObserved=$($measurement.observed)"

        $b='raw=unavailable'
        try {
            if (!$protected) { throw 'Protected stage unavailable' }
            $parent=Ace $stage $sid ReadAndExecute None Allow stage
            if (![W17]::CreateDirectoryW($dir,[IntPtr]::Zero)) { throw 'Child creation failed' }
            $objects.Add($dir)
            $homeGrant=Ace $dir $sid Modify 'ContainerInherit,ObjectInherit' Allow stage
            [IO.File]::Open($file,'CreateNew','Write','None').Dispose()
            $objects.Add($file)
            $fileBefore=Section $file
            $container='S-1-15-2-100-200-300-400-500-600-700'
            $grant=Ace $dir $container Modify 'ContainerInherit,ObjectInherit' Allow container
            $fileAfter=Section $file
            $b="directory=$($grant.after) fileBefore=$fileBefore fileAfter=$fileAfter"
            if ($grant.before -ceq $grant.after -or $fileAfter -cne $fileBefore) { throw 'Directory grant or non-propagation mismatch' }
            $fileGrant=Ace $file $container ReadAndExecute None Allow container
            if ($parent.before -ceq $parent.after -or $homeGrant.before -ceq $homeGrant.after -or $fileGrant.before -ceq $fileGrant.after) { throw 'Grant had no effect' }
            for ($i=$entries.Count-1;$i -ge 0;$i--) { RestoreAcl $entries[$i] }
            Write-Verbose "result=CHILD_GRANTS PASS $b"
        } catch { $script:failed=$true; Write-Verbose "result=CHILD_GRANTS FAIL $b error=$($_.Exception.Message)" }

        $d='rc=unavailable'
        try {
            if (!$protected) { throw 'Protected stage unavailable' }
            # Keep the labeled directory empty and independent of the child grant test.
            $scratch=Join-Path $stage integrity
            if (![W17]::CreateDirectoryW($scratch,[IntPtr]::Zero)) { throw 'Integrity directory creation failed' }
            $objects.Add($scratch)
            $homeGrant=Ace $scratch $sid Modify 'ContainerInherit,ObjectInherit' Allow stage
            $grantEntry=$entries[$entries.Count-1]
            $before=Section $scratch
            if ($before -cne $homeGrant.after) { throw 'Integrity fixture DACL changed before label' }
            $labelEntry=Install-LowLabel $scratch
            if ($labelEntry.data.before -ceq $labelEntry.data.installed) { throw 'Integrity fixture already has requested label' }
            $raw=Section $scratch
            $d="before=$before after=$raw originalLabel=$($labelEntry.data.before) installedLabel=$(Read-Label $scratch)"
            if ($raw -cne $before) { throw 'Integrity label changed the raw DACL' }
            RestoreLabel $labelEntry
            $d+=" restoredLabel=$(Read-Label $scratch)"
            if ((Section $scratch) -cne $before) { throw 'Integrity label restore changed the raw DACL' }
            RestoreAcl $grantEntry
            Write-Verbose "result=INTEGRITY_LABEL PASS $d"
        } catch { $script:failed=$true; Write-Verbose "result=INTEGRITY_LABEL FAIL $d error=$($_.Exception.Message)" }

        # Repeat the original experiment only on disposable state, after measurement.
        try {
            $control=Join-Path $stage icacls-control
            if (!$protected -or ![W17]::CreateDirectoryW($control,[IntPtr]::Zero)) { throw 'Control directory unavailable' }
            $objects.Add($control)
            $null=Ace $control $sid Modify 'ContainerInherit,ObjectInherit' Allow stage
            $controlBefore=Section $control
            $listing=& "$env:SystemRoot\System32\icacls.exe" $control /setintegritylevel '(OI)(CI)L' 2>&1
            $rc=$LASTEXITCODE
            foreach ($line in $listing) { Write-Verbose $line.ToString() }
            $controlAfter=Section $control
            $label=Read-Label $control
            $observed=if ($rc) { 'unknown' } else { $controlBefore -cne $controlAfter }
            Write-Verbose "result=ICACLS_LABEL_REWRITES_DACL observed=$observed rc=$rc before=$controlBefore after=$controlAfter label=$label"
        } catch { Write-Verbose "result=ICACLS_LABEL_REWRITES_DACL observed=unknown error=$($_.Exception.Message)" }
    } finally {
        $pending=$false
        for ($i=$objects.Count-1;$i -ge 0;$i--) {
            $path=$objects[$i]
            try {
                if ($path -ceq $file -or $path -ceq $marker) { [IO.File]::Delete($path) }
                else { [IO.Directory]::Delete($path,$false) }
                Add-Content $log "cleanup removed path=$path"
            } catch {
                $pending=$true
                Add-Content $log "cleanup pending path=$path error=$($_.Exception.Message)"
            }
        }
        if ($pending) { $script:failed=$true; Write-Verbose 'Raw preflight cleanup incomplete' }
    }
}
$failed=$false
try { Test-RawAcl 4>&1 | ForEach-Object { Add-Content $log $_.ToString() } }
catch { $failed=$true; Add-Content $log "raw preflight failure=$($_.Exception.Message)" }
if ($failed) { exit 1 }
Add-Content $log 'result=RAW_PREFLIGHT_VERIFIED'
