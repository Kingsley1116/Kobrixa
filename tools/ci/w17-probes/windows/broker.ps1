# Private stdin/stdout RPC with the controller. Only the launch API receives
# a password pointer. Phase changes rotate the password of the SAME owned SID.
param([Parameter(Mandatory)][string]$Phase)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$WarningPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$out = $env:W17_OUT
$journal = Join-Path $out 'resources.json'
Add-Type -TypeDefinition ((Get-Content "$PSScriptRoot\bridge.cs" -Raw).Replace('W17_DLL', "$out\controller.dll"))
# Keep the cleanup journal under the same directory verified by bootstrap.
if ($Phase -eq 'cleanup' -and $env:W17_HOSTED -eq '1') {
    $controllerRoot=[W17]::PinStage($out)
    & node "$PSScriptRoot/../evidence.mjs" verify
    if ($LASTEXITCODE) { exit $LASTEXITCODE }
}
Add-Type -Path "$PSScriptRoot/receivers.cs"
$receivers=@{}
$owner = [Security.Principal.WindowsIdentity]::GetCurrent()
$secrets = @{}
function Check([uint32]$rc, $action) {
    if ($rc) { throw "$action returned $rc" }
}
function Save {
    $json = ConvertTo-Json -InputObject $script:j -Depth 16 -Compress
    [IO.File]::WriteAllText("$journal.next", $json)
    [IO.File]::Move("$journal.next",$journal,$true)
}
if (Test-Path $journal) {
    $j = Get-Content -LiteralPath $journal -Raw | ConvertFrom-Json -AsHashtable
} else {
    if ($Phase -ne 'primitives') { throw 'Missing private primitive resource journal' }
    $tag = [guid]::NewGuid().ToString('N')
    $j = @{ tag=$tag; stage=(Join-Path $env:ProgramFiles "W17-$tag"); accounts=@{}; entries=@(); active=@();
        container="W17.$tag"; layer=[guid]::NewGuid().ToString('B'); v4=[guid]::NewGuid().ToString('B'); v6=[guid]::NewGuid().ToString('B') }
    Save
}
function Intent($kind,$data) {
    $entry = @{id=[guid]::NewGuid().ToString();kind=$kind; data=$data; done=$false}
    $script:j.entries += $entry
    Save
    return $entry
}
function Done($entry) { $entry.done=$true; Save }
function Get-TokenSample($processId) {
    $buf=[Text.StringBuilder]::new(32768)
    Check ([W17]::Inspect($processId,$buf,$buf.Capacity)) 'OpenProcess/GetTokenInformation'
    return ($buf.ToString() | ConvertFrom-Json -AsHashtable)
}
function New-Password {
    $secret=[Security.SecureString]::new()
    $bytes=[Security.Cryptography.RandomNumberGenerator]::GetBytes(48)
    try {
        $alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!#'
        $classes=@('ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz','0123456789','!#')
        for ($i=0; $i -lt $classes.Count; $i++) {
            $group=$classes[$i]
            $secret.AppendChar($group[$bytes[$i] % $group.Length])
        }
        for ($i=$classes.Count; $i -lt $bytes.Length; $i++) { $secret.AppendChar($alphabet[$bytes[$i] -band 63]) }
    } finally { [Array]::Clear($bytes,0,$bytes.Length) }
    $secret.MakeReadOnly()
    return $secret
}
function Account($role) {
    if ($secrets.ContainsKey($role)) { return }
    $password=New-Password
    if (!$j.accounts.Contains($role)) {
        $name='w17'+$role.Substring(0,1)+$j.tag.Substring(0,14)
        if (Get-LocalUser -Name $name -EA SilentlyContinue) { throw 'Account name collision' }
        $record=Intent 'account' @{name=$name;role=$role;description="W17 $($j.tag)"}
        $user=New-LocalUser -Name $name -Password $password -Description $record.data.description
        $j.accounts[$role]=@{name=$name;sid=$user.SID.Value;home=(Join-Path $j.stage "$role-home")}
        Save
        $users=Get-LocalGroup -SID 'S-1-5-32-545'
        if (!(Get-LocalGroupMember $users | Where-Object { $_.SID -eq $user.SID })) {
            $null=Intent 'membership' @{sid=$user.SID.Value;group=$users.SID.Value}
            Add-LocalGroupMember $users -Member $user
        }
    } else {
        $a=$j.accounts[$role]
        $user=Get-LocalUser -SID $a.sid
        if ($user.Name -ne $a.name -or $user.Description -ne "W17 $($j.tag)") { throw 'Owned identity changed' }
        $null=Intent 'rotate' @{sid=$a.sid}
        Set-LocalUser -SID $a.sid -Password $password
    }
    $secrets[$role]=$password
}
function New-OwnedDir($path) {
    $null=Intent 'scratch directory' @{path=$path;undo='remove run-owned stage'}
    $null=New-Item -Type Directory -Path $path
    Save-StageChild $path $true $false
    Save
}
function Save-StageChild($path,[bool]$directory,[bool]$junction) {
    $stage=@($j.entries | Where-Object kind -eq 'stage')[0].data
    $path=[IO.Path]::GetFullPath($path)
    $parent=[IO.Path]::GetDirectoryName($path)
    if (!$stage.created -or ($parent -cne $j.stage -and !$stage.children.Contains($parent))) { throw 'Unconfirmed stage parent' }
    if ($stage.children.Contains($path)) { throw 'Stage child already recorded' }
    $pin=[W17]::PinStage($path)
    try { $stage.children[$path]=[W17]::ChildIdentity($pin,$directory,$junction) }
    finally { $pin.Dispose() }
}
function Confirm-Stage($entry,$pin) {
    $d=$entry.data
    if (!$d.created -or !$d.birth -or !$d.marker -or $d.path -cne $j.stage) { throw 'Stage creation not confirmed' }
    if (!$d.rootId -or [W17]::Identity($pin,$true) -cne $d.rootId) { throw 'Stage file ID changed' }
    $dir=Get-Item -Force -LiteralPath $d.path
    if (!$dir.PSIsContainer -or ($dir.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $dir.CreationTimeUtc.Ticks.ToString() -cne $d.birth) { throw 'Stage directory identity changed' }
    $marker=Get-Item -Force -LiteralPath (Join-Path $dir.FullName '.w17-owner')
    if ($marker.PSIsContainer -or ($marker.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $marker.Length -ne 32 -or [IO.File]::ReadAllText($marker.FullName) -cne $d.marker) { throw 'Stage ownership marker changed' }
}
function Section($path) {
    $buffer=[Text.StringBuilder]::new(65536)
    Check ([W17]::ReadDacl($path,$buffer,$buffer.Capacity)) 'read raw file DACL'
    return $buffer.ToString()
}
function New-DaclEditor($path,$sddl) {
    $acl=if ([IO.Directory]::Exists($path)) { [Security.AccessControl.DirectorySecurity]::new() }
         else { [Security.AccessControl.FileSecurity]::new() }
    $acl.SetSecurityDescriptorSddlForm($sddl,[Security.AccessControl.AccessControlSections]::Access)
    if ($acl.GetSecurityDescriptorSddlForm('Access') -cne $sddl) { throw "Cannot edit raw DACL losslessly $path" }
    return $acl
}
function Ace($path,$sid,$rights,$inherit,$type,$scope) {
    $before=Section $path
    $acl=New-DaclEditor $path $before
    $entry=Intent 'acl' @{path=$path;before=$before;scope=$scope;sid=$sid;protected=$acl.AreAccessRulesProtected}
    $ace=[Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($sid),$rights,$inherit,'None',$type)
    $acl.AddAccessRule($ace)
    $entry.data.installed=$acl.GetSecurityDescriptorSddlForm('Access'); Save
    if ((Section $path) -cne $before) { throw "Conflicting initial DACL $path" }
    Set-Acl -LiteralPath $path -AclObject $acl
    if ((Section $path) -cne $entry.data.installed) { throw "Unexpected installed DACL $path" }
    return @{id=$entry.id;before=$before;after=(Section $path);protected=$entry.data.protected;path=$path}
}
function NeedsRestore($current,$before,$installed,$resource) {
    if ($current -ceq $before) { return $false }
    if ($current -cne $installed) { throw "Conflicting descriptor or setting for ${resource}: current=$current installed=$installed original=$before" }
    return $true
}
function RestoreAcl($e) {
    $current=Section $e.data.path
    if (NeedsRestore $current $e.data.before $e.data.installed $e.data.path) {
        $acl=New-DaclEditor $e.data.path $e.data.before
        Set-Acl -LiteralPath $e.data.path -AclObject $acl
    }
    if ((Section $e.data.path) -cne $e.data.before) { throw "DACL restoration mismatch $($e.data.path)" }
}
function DesktopSD($i) {
    $buf=[Text.StringBuilder]::new(65536)
    Check ([W17]::DesktopRead($i,$buf,$buf.Capacity)) 'GetUserObjectSecurity'
    return $buf.ToString()
}
function DesktopGrant($logonSid) {
    if ($logonSid -notmatch '^S-1-5-5-\d+-\d+$') { throw 'No interactive logon SID' }
    foreach ($i in @(0,1)) {
        $before=DesktopSD $i

        $sd=[Security.AccessControl.CommonSecurityDescriptor]::new($false,$false,$before)
        $mask=if ($i) { 0xc3 } else { 0x323 }
        $sd.DiscretionaryAcl.AddAccess('Allow',[Security.Principal.SecurityIdentifier]::new($logonSid),$mask,'None','None')
        $installed=$sd.GetSddlForm('Access')
        $null=Intent 'desktop' @{index=$i;before=$before;installed=$installed}
        if ((DesktopSD $i) -cne $before) { throw 'Conflicting initial desktop descriptor' }
        Check ([W17]::DesktopWrite($i,$installed)) 'SetUserObjectSecurity'
        if ((DesktopSD $i) -cne $installed) { throw 'Unexpected installed desktop descriptor' }
    }
}
function QuoteArg([string]$arg) {
    # CommandLineToArgvW quoting, including runs of backslashes before a quote.
    return '"' + (($arg -replace '(\\*)"','$1$1\"') -replace '(\\+)$','$1$1') + '"'
}
function Start-Owned($p) {
    $role=$p.role
    Account $role
    $a=$j.accounts[$role]
    $homePath=$a.home
    $cwd=Join-Path $homePath 'empty'
    $envMap=[ordered]@{APPDATA="$homePath\Roaming"; COMPUTERNAME=$env:COMPUTERNAME; HOME=$homePath;
        LOCALAPPDATA="$homePath\Local"; PATH="$env:SystemRoot\System32"; SystemDrive=$env:SystemDrive; SystemRoot=$env:SystemRoot;
        TEMP="$homePath\Temp"; TMP="$homePath\Temp"; USERDOMAIN=$env:COMPUTERNAME; USERNAME=$a.name; USERPROFILE=$homePath; windir=$env:windir}
    $block=[string]::Join([char]0,@($envMap.GetEnumerator() | ForEach-Object { "$($_.Key)=$($_.Value)" }))+[char]0+[char]0
    $cmd=[Text.StringBuilder]::new(((@($p.exe)+@($p.args) | ForEach-Object { QuoteArg $_ }) -join ' '))
    if ($cmd.Length -ge 1024) { throw 'CreateProcessWithLogonW command exceeds 1024 characters' }
    $ptr=[Runtime.InteropServices.Marshal]::SecureStringToGlobalAllocUnicode($secrets[$role])
    $envPtr=[Runtime.InteropServices.Marshal]::StringToHGlobalUni($block)
    [uint32]$procId=0
    try {
        $null=Intent 'launch' @{role=$role;exe=$p.exe;ownedJob=$true;profileFor=$a.sid}
        Check ([W17]::Launch($a.name,$ptr,$p.exe,$cmd,$envPtr,$cwd,$p.stderr,[ref]$procId)) 'CreateProcessWithLogonW/AssignProcessToJobObject'
    } finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeGlobalAllocUnicode($ptr)
        [Runtime.InteropServices.Marshal]::FreeHGlobal($envPtr)
    }
    $token=Get-TokenSample $procId
    if ($token.sid -ne $a.sid -or $token.elevated -or $token.groups -contains 'S-1-5-32-544') { throw 'Unexpected launched token' }
    $j.active+=@{pid=$procId;birth=$token.birth;sid=$token.sid}; Save
    if ($p.desktop) { DesktopGrant $token.logon }
    Check ([W17]::Resume($procId)) 'ResumeThread'
    return $token
}
function Unwind($selection) {
    $results=@()
    for ($i=$j.entries.Count-1; $i -ge 0; $i--) {
        $e=$j.entries[$i]; $d=$e.data
        if ($e.done -or !( & $selection $e )) { continue }
        $stageHandle=$null
        try {
            if ($e.kind -eq 'stage' -or ($d.path -and ($d.path -eq $j.stage -or $d.path.StartsWith($j.stage+'\',[StringComparison]::OrdinalIgnoreCase)))) {
                $owned=@($j.entries | Where-Object kind -eq 'stage')
                if ($owned.Count -ne 1) { throw 'Missing unique stage creation record' }
                if (!$owned[0].data.created) { throw 'Stage creation not confirmed' }
                $stageHandle=[W17]::PinStage($j.stage)
                Confirm-Stage $owned[0] $stageHandle
            }
            switch ($e.kind) {
                'tree-acl' {
                    if ($d.ready) {
                        $timer=[Diagnostics.Stopwatch]::StartNew()
                        [uint32]$verified=0
                        $rc=[W17]::TreeChange($d.file,$d.count,$d.sid,1,[ref]$verified)
                        if ($rc -and [IO.File]::Exists($d.file+'.conflicts')) { throw ([IO.File]::ReadAllText($d.file+'.conflicts',[Text.Encoding]::Unicode)) }
                        Check $rc 'restore and compare all NTFS DACLs'
                        $d.restoreMs=$timer.ElapsedMilliseconds
                        if ($verified -ne $d.count) { throw 'Incomplete NTFS restore' }
                    }
                }
                'acl' { RestoreAcl $e }
                'desktop' {
                    $current=DesktopSD $d.index
                    if (NeedsRestore $current $d.before $d.installed "desktop $($d.index)") {
                        Check ([W17]::DesktopWrite($d.index,$d.before)) 'restore desktop'
                    }
                    if ((DesktopSD $d.index) -cne $d.before) { throw 'Desktop descriptor mismatch' }
                }
                'wfp' {
                    Check ([W17]::WfpClose()) 'FwpmEngineClose0'
                    Check ([W17]::WfpAbsent($j.layer,$j.v4,$j.v6)) 'verify WFP absence'
                }
                'audit' {
                    [uint32]$v=0; Check ([W17]::Audit(0,[ref]$v)) 'query current audit'
                    if (NeedsRestore $v $d.before $d.installed 'audit') {
                        $v=$d.before; Check ([W17]::Audit(1,[ref]$v)) 'restore audit'
                    }
                    Check ([W17]::Audit(0,[ref]$v)) 'query restored audit'
                    if ($v -ne $d.before) { throw 'Audit restoration mismatch' }
                }
                'firewall' {
                    $rules=@(Get-NetFirewallRule -PolicyStore PersistentStore | Where-Object Name -eq $d.name)
                    foreach ($rule in $rules) { $rule | Remove-NetFirewallRule }
                    if (Get-NetFirewallRule -PolicyStore ActiveStore | Where-Object Name -eq $d.name) { throw 'Firewall rule remains' }
                }
                'membership' {
                    $member=Get-LocalGroupMember -SID $d.group | Where-Object { $_.SID.Value -eq $d.sid }
                    if ($member) { Remove-LocalGroupMember -SID $d.group -Member $member }
                    if (Get-LocalGroupMember -SID $d.group | Where-Object { $_.SID.Value -eq $d.sid }) { throw 'Added Users membership remains' }
                }
                'stage' {
                    $seen=@{}
                    foreach ($baseline in $j.entries) {
                        if ($baseline.kind -ne 'acl' -or $baseline.data.scope -ne 'baseline') { continue }
                        $path=$baseline.data.path
                        if (!$seen.ContainsKey($path)) {
                            $seen[$path]=$baseline.data.before
                            if (!$d.removalStarted -or (Test-Path -LiteralPath $path)) {
                                $baseline.data.finalOriginal=Section $path
                                if ($baseline.data.finalOriginal -cne $seen[$path]) { throw "Final baseline DACL mismatch $path" }
                                Save
                            }
                            if ($baseline.data.finalOriginal -cne $seen[$path]) { throw "Missing final baseline DACL $path" }
                        }
                    }
                    $d.removalStarted=$true; Save
                    [W17]::RemoveStage($stageHandle,$j.stage,$d.rootId,$d.markerId,$d.children)
                    $stageHandle.Dispose()
                    $stageHandle=$null
                    if (Test-Path -LiteralPath $j.stage) { throw 'Stage remains' }
                    foreach ($link in $j.entries | Where-Object kind -eq 'junction') { Done $link }
                }
                'account' {
                    $u=Get-LocalUser | Where-Object Name -eq $d.name
                    if ($u -and $u.Description -ne $d.description) { throw 'Foreign account' }
                    $sid=$j.accounts[$d.role].sid
                    if ($u) {
                        if ($sid -and $sid -ne $u.SID.Value) { throw 'SID changed' }
                        $sid=$u.SID.Value
                    }
                    if ($sid) {
                        $profile=Get-CimInstance Win32_UserProfile -Filter "SID='$sid'"
                        if ($profile) {
                            $d.profile=$profile.LocalPath; Save
                            if ($profile.Loaded) { throw 'Owned profile remains loaded' }
                            $profile | Remove-CimInstance
                        }
                        if ((Get-CimInstance Win32_UserProfile -Filter "SID='$sid'") -or ($d.profile -and (Test-Path -LiteralPath $d.profile))) { throw 'Owned profile remains' }
                    }
                    if ($u) { Remove-LocalUser -SID $u.SID }
                    if (Get-LocalUser | Where-Object Name -eq $d.name) { throw 'Owned account remains' }
                }
                'container' { throw 'AppContainer removal in subject context still pending' }
            }
            Done $e
            $result=@{id=$e.id;kind=$e.kind;restored=$true;path=$d.path;descriptor=$d.before}
            if ($e.kind -eq 'tree-acl') { $result.objects=$d['count']; $result.restoreMs=$d.restoreMs }
            $results+=$result
        } catch { $results+=@{id=$e.id;kind=$e.kind;restored=$false;error=$_.Exception.Message} }
        finally { if ($stageHandle) { $stageHandle.Dispose() } }
    }
    return ,$results
}
function Dispatch($p) {
    switch ($p.op) {
        'host' {
            $arch=[Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
            $principal=[Security.Principal.WindowsPrincipal]::new($owner)
            $bfe=(Get-Service BFE).Status.ToString()
            return @{arch=$arch;admin=$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator);
                build=[Environment]::OSVersion.Version.ToString();bfe=$bfe;secondary=(Get-Service seclogon).Status.ToString();
                token=(Get-TokenSample $PID);controller=(Get-TokenSample $p.controllerPid);broker=(Get-TokenSample $PID);stage=$j.stage;name=$j.container;accounts=$j.accounts;desktop=$j.desktop}
        }
        'receiver' {
            try {
                if (!$p.reserve -and $receivers.ContainsKey($p.label)) { throw 'Duplicate receiver label' }
                $socket=[ProbeReceiver]::new($p.host,$p.protocol,$p.label,$p.reserve -eq $true)
                $port=$socket.Port
                if ($p.reserve) { $socket.Close() }
                else { $receivers[$p.label]=$socket }
                return @{port=$port;pid=$PID;wsa=0}
            } catch {
                $cause=$_.Exception.GetBaseException()
                if ($cause -isnot [Net.Sockets.SocketException]) { throw }
                return @{port=$null;pid=$PID;wsa=$cause.NativeErrorCode;operation=$cause.Data['operation']}
            }
        }
        'receiver-events' { return ,($receivers[$p.label].Drain()) }
        'volume' {
            $volume=Get-Volume -FilePath $p.file
            return @{filesystem=$volume.FileSystem;type=$volume.DriveType.ToString();id=$volume.UniqueId;letter=[string]$volume.DriveLetter}
        }
        'desktop-preflight' { return (DesktopSD 1) }
        'profile' {
            $r=Get-CimInstance Win32_UserProfile -Filter "SID='$($p.sid)'"
            if (!$r) { throw 'No local profile for the token SID' }
            return @{path=$r.LocalPath;sid=$r.SID;loaded=$r.Loaded}
        }
        'help' {
            return ,@(foreach ($cmd in @('New-LocalUser','New-NetFirewallRule','Get-NetFirewallRule')) {
                $help=Get-Help -Name $cmd
                @{command=$cmd;module=(Get-Command $cmd).ModuleName;synopsis=[string]$help.Synopsis}
            })
        }
        'rights' {
            $file=Join-Path $out 'interactive-rights.inf'
            $null=Intent 'private-output' @{path=$file}
            $null=& "$env:SystemRoot\System32\secedit.exe" /export /areas USER_RIGHTS /cfg $file /log "$out\secedit.log" /quiet
            Check $LASTEXITCODE 'secedit user-rights export'
            return ,@(Get-Content $file | Where-Object { $_ -match '^Se(Deny)?InteractiveLogonRight\s*=' })
        }
        'verify-wfp-absent' {
            Check ([W17]::WfpAbsent($j.layer,$j.v4,$j.v6)) 'verify WFP absence'
            return $true
        }
        'prepare' {
            Account 'subject'; Account 'other'
            if (Test-Path $j.stage) { throw 'Staging collision' }
            $entry=Intent 'stage' @{path=$j.stage;created=$false}
            $pin=[W17]::CreateStage($j.stage)
            try {
                $entry.data.rootId=[W17]::Identity($pin,$true)
                $entry.data.children=@{}
                $marker=[guid]::NewGuid().ToString('N')
                $markerFile=[IO.File]::Open((Join-Path $j.stage '.w17-owner'),'CreateNew','Write','None')
                try {
                    $markerFile.Write([Text.Encoding]::ASCII.GetBytes($marker),0,32)
                    $entry.data.markerId=[W17]::Identity($markerFile.SafeFileHandle,$false)
                } finally { $markerFile.Dispose() }
                $entry.data.marker=$marker
                $entry.data.birth=(Get-Item -LiteralPath $j.stage -Force).CreationTimeUtc.Ticks.ToString()
                $entry.data.created=$true
                Confirm-Stage $entry $pin
                Save
            } finally { $pin.Dispose() }
            # Remove inherited generic Users access before creating inputs or homes.
            $acl=Get-Acl $j.stage
            $acl.SetAccessRuleProtection($true,$false)
            foreach ($id in @($owner.User.Value,'S-1-5-18')) {
                $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($id),'FullControl','ContainerInherit,ObjectInherit','None','Allow'))
            }
            Set-Acl $j.stage $acl
            foreach ($a in $j.accounts.Values) {
                $null=Ace $j.stage $a.sid 'ReadAndExecute' 'None' 'Allow' 'stage'
                $null=Ace $env:RUNNER_TEMP $a.sid 'ReadAndExecute' 'ContainerInherit,ObjectInherit' 'Deny' 'runner'
            }
            foreach ($dir in @('bin','plans','negative','aliases')) {
                $path=Join-Path $j.stage $dir; New-OwnedDir $path
                foreach ($a in $j.accounts.Values) { $null=Ace $path $a.sid 'ReadAndExecute' 'ContainerInherit,ObjectInherit' 'Allow' 'stage' }
            }
            foreach ($a in $j.accounts.Values) {
                New-OwnedDir $a.home
                $null=Ace $a.home $a.sid 'Modify' 'ContainerInherit,ObjectInherit' 'Allow' 'stage'
                # The private subject scratch tree must also accept low-integrity
                # writes in the fallback. Set the inheritable label while empty.
                if ($a.sid -eq $j.accounts.subject.sid) {
                    $null=Intent 'owned integrity label' @{path=$a.home;undo='remove verified run-owned scratch'}
                    $null=& "$env:SystemRoot\System32\icacls.exe" $a.home /setintegritylevel '(OI)(CI)L'
                    Check $LASTEXITCODE 'set private scratch integrity label'
                }
                foreach ($dir in @('empty','Roaming','Local','Temp')) { New-OwnedDir (Join-Path $a.home $dir) }
            }
            return $j.accounts
        }
        'intent' { $null=Intent $p.kind $p.data; return $true }
        'stage-created' { foreach ($item in $p.items) { Save-StageChild $item.path ([bool]$item.directory) ([bool]$item.junction) }; Save; return $true }
        'desktop-route' { $j.desktop=$true; Save; return $true }
        'launch' { return Start-Owned $p }
        'wait' {
            [uint32]$code=0; $rc=[W17]::ExitCode($p.pid,$p.ms,[ref]$code)
            return @{wait=$rc;exit=$(if (!$rc) {$code} else {$null})}
        }
        'stop' { Check ([W17]::StopTree()) 'stop owned job'; return $true }
        'count' { [uint32]$n=0; Check ([W17]::JobCount([ref]$n)) 'job count'; return $n }
        'pin' { Check ([W17]::Pin($p.pid,[uint64]$p.birth)) 'pin exact owned process handle'; return $true }
        'kill' { $null=Intent 'terminate checked handle' @{pid=$p.pid;birth=$p.birth}; return [W17]::KillChecked($p.pid,[uint64]$p.birth) }
        'inspect' { return Get-TokenSample $p.pid }
        'births' {
            $remaining=@(foreach ($r in Get-CimInstance Win32_Process -Property ProcessId,CreationDate) {
                $saved=@($j.active | Where-Object pid -eq $r.ProcessId)
                if (!$saved.Count) { continue }
                if (!$r.CreationDate) { throw 'Missing final CIM process birth' }
                $birthTime=$r.CreationDate.ToUniversalTime().ToFileTimeUtc()
                foreach ($item in $saved) {
                    if ([Math]::Abs([decimal]$item.birth-$birthTime) -lt 10) {
                        $sample=Get-TokenSample $r.ProcessId
                        if ($sample.birth -eq $item.birth) { $sample }
                    }
                }
            })
            return ,$remaining
        }
        'tree' {
            $rows=@(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,ExecutablePath,CreationDate)
            $ids=[Collections.Generic.HashSet[uint32]]::new()
            foreach ($r in $rows) {
                if ($r.ExecutablePath -and $r.ExecutablePath.StartsWith($j.stage+'\',[StringComparison]::OrdinalIgnoreCase)) { $null=$ids.Add($r.ProcessId) }
            }
            do {
                $size=$ids.Count
                foreach ($r in $rows) { if ($ids.Contains($r.ParentProcessId)) { $null=$ids.Add($r.ProcessId) } }
            } while ($size -ne $ids.Count)
            $records=@(foreach ($r in $rows) {
                if ($ids.Contains($r.ProcessId)) {
                    $token=Get-TokenSample $r.ProcessId
                    if (!$r.CreationDate -or !$r.ExecutablePath) { throw 'Incomplete CIM process sample' }
                    $cimBirth=$r.CreationDate.ToUniversalTime().ToFileTimeUtc()
                    if ([math]::Abs([decimal]$token.birth-$cimBirth) -ge 10) { throw 'CIM and handle birth mismatch' }
                    [uint32]$member=0; Check ([W17]::Member($r.ProcessId,[ref]$member)) 'IsProcessInJob'
                    @{member=$member;pid=$r.ProcessId;ppid=$r.ParentProcessId;exe=$r.ExecutablePath;created=$r.CreationDate.ToUniversalTime().ToString('o');token=$token}
                }
            })
            foreach ($sample in $records) {
                if (!($j.active | Where-Object { $_.pid -eq $sample.pid -and $_.birth -eq $sample.token.birth })) {
                    $j.active+=@{pid=$sample.pid;birth=$sample.token.birth;sid=$sample.token.sid}
                }
            }
            if ($records.Count) { Save }
            return ,$records
        }
        'deny-tree' {
            $root=[IO.Path]::GetFullPath($p.path)
            if (!$root.StartsWith((Join-Path $j.stage 'sentinels')+'\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Outside staged sentinel tree' }
            $timer=[Diagnostics.Stopwatch]::StartNew()
            $file=Join-Path $out ([guid]::NewGuid().ToString()+'.dacl')
            $e=Intent 'tree-acl' @{path=$root;file=$file;sid=$j.accounts.subject.sid;ready=$false}
            [uint32]$count=0; [uint32]$checked=0
            Check ([W17]::TreeSave($root,$file,[ref]$count)) 'snapshot original DACLs and NTFS file IDs'
            if (!$count) { throw 'Empty NTFS snapshot' }
            if ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -ge [long]$env:W17_DACL_CUTOFF) { throw 'Insufficient time to apply and reverse DACLs' }
            $snapshotMs=$timer.ElapsedMilliseconds
            $e.data.ready=$true; $e.data.count=$count; Save
            Check ([W17]::TreeChange($file,$count,$e.data.sid,0,[ref]$checked)) 'apply SID deny through NTFS handles'
            if ($checked -ne $count) { throw 'Incomplete NTFS change' }
            return @{id=$e.id;root=$root;objects=$count;snapshotMs=$snapshotMs;elapsedMs=$timer.ElapsedMilliseconds;sha256=(Get-FileHash $file).Hash}
        }
        'acl' { return Ace $p.path $p.sid $p.rights $p.inherit $p.type $p.scope }
        'section' { return Section $p.path }
        'restore' { return Unwind { param($e) $e.kind -eq $p.kind -and (!$p.scope -or $e.data.scope -eq $p.scope) } }
        'firewall' {
            $name='W17-'+$j.tag
            if (Get-NetFirewallRule -PolicyStore ActiveStore | Where-Object Name -eq $name) { throw 'Firewall rule collision' }
            $null=Intent 'firewall' @{name=$name}
            $null=New-NetFirewallRule -Name $name -DisplayName $name -Direction Outbound -Action Block -Program $p.exe -Profile Any
            $rule=Get-NetFirewallRule -Name $name -PolicyStore ActiveStore
            return @{name=$rule.Name;enabled=$rule.Enabled.ToString();action=$rule.Action.ToString();direction=$rule.Direction.ToString();program=($rule | Get-NetFirewallApplicationFilter).Program}
        }
        'audit' {
            [uint32]$v=0; Check ([W17]::Audit(0,[ref]$v)) 'query audit'
            $entry=Intent 'audit' @{before=$v;installed=(($v -band 1) -bor 2)}
            $v=($v -band 1) -bor 2; Check ([W17]::Audit(1,[ref]$v)) 'enable failure audit'
            Check ([W17]::Audit(0,[ref]$v)) 'verify audit'
            if (!($v -band 2) -or $v -ne $entry.data.installed) { throw 'Unexpected installed audit setting' }
            return $v
        }
        'wfp' {
            Check ([W17]::WfpAbsent($j.layer,$j.v4,$j.v6)) 'verify unused WFP keys'
            $e=Intent 'wfp' @{layer=$j.layer;v4=$j.v4;v6=$j.v6}
            [uint64]$v4=0; [uint64]$v6=0
            Check ([W17]::WfpStart($j.accounts.subject.sid,$j.layer,$j.v4,$j.v6,[ref]$v4,[ref]$v6)) 'install dynamic WFP transaction'
            return @{id=$e.id;layer=$j.layer;v4=$v4.ToString();v6=$v6.ToString();condition='ALE_USER_ID';sid=$j.accounts.subject.sid}
        }
        'container-filter' {
            [uint32]$matchesFilter=0
            Check ([W17]::ContainerFilter([uint64]$p.id,[int]$p.ipv6,$p.sid,[ref]$matchesFilter)) 'FwpmFilterGetById0'
            return ($matchesFilter -eq 1)
        }
        'events' {
            $query="*[System[(EventID=5157) and TimeCreated[timediff(@SystemTime) <= 60000]] and EventData[Data[@Name='DestPort']='$([int]$p.port)']]"
            $events=@()
            try { $events=@(Get-WinEvent -LogName Security -FilterXPath $query -MaxEvents 512) }
            catch { if ($_.FullyQualifiedErrorId -notlike 'NoMatchingEventsFound*') { throw } }
            $list=@(foreach ($event in $events) {
                $record=@{at=$event.TimeCreated.ToUniversalTime().ToString('o');record=$event.RecordId}
                foreach ($d in ([xml]$event.ToXml()).Event.EventData.Data) {
                    if ($d.Name -in @('ProcessID','Direction','SourceAddress','SourcePort','DestAddress','DestPort','Protocol','FilterRTID','LayerRTID')) { $record[$d.Name]=$d.'#text' }
                }
                $record
            }); return ,$list
        }
        'exemptions' {
            $lines=& "$env:SystemRoot\System32\CheckNetIsolation.exe" LoopbackExempt -s
            Check $LASTEXITCODE 'CheckNetIsolation'
            return ,@($lines)
        }
        'container-owned' {
            foreach ($e in $j.entries) {
                if ($e.kind -eq 'container' -and !$e.done) { if ($e.data.sid -ne $p.sid) { throw 'Profile SID differs from intent' }; $e.data.created=$true; $e.data.folder=$p.folder; $e.data.folderId=$p.folderId; Save }
            }
            return $true
        }
        'container-gone' {
            foreach ($e in $j.entries) { if ($e.kind -eq 'container') { Done $e } }
            return $true
        }
        'state' { return @{entries=@($j.entries | Where-Object { !$_.done -and $_.kind -eq 'container' });accounts=$j.accounts;desktop=$j.desktop} }
        'final' {
            $remaining=@(Get-LocalUser | Where-Object { $_.Description -eq "W17 $($j.tag)" -or $_.SID.Value -in @($j.accounts.Values.sid) })
            if ($remaining.Count) { throw 'Final account snapshot found an owned identity' }
            foreach ($a in $j.accounts.Values) {
                if (Get-CimInstance Win32_UserProfile -Filter "SID='$($a.sid)'") { throw 'Final profile snapshot found an owned SID' }
            }
            $checked=@{}
            foreach ($e in $j.entries) {
                if (!$e.done) { throw "Unresolved resource $($e.kind)" }
                $d=$e.data
                if ($e.kind -eq 'account' -and $d.profile -and (Test-Path -LiteralPath $d.profile)) { throw 'Final profile directory remains' }
                if ($e.kind -eq 'acl' -and $d.scope -eq 'runner' -and !$checked.ContainsKey($d.path)) {
                    $checked[$d.path]=Section $d.path
                    if ($checked[$d.path] -cne $d.before) { throw "Final DACL mismatch $($d.path)" }
                }
                if ($e.kind -eq 'audit' -and !$checked.ContainsKey('audit')) {
                    [uint32]$value=0; Check ([W17]::Audit(0,[ref]$value)) 'query final audit setting'
                    if ($value -ne $d.before) { throw 'Final audit setting mismatch' }; $checked.audit=$value
                }
                if ($e.kind -eq 'desktop' -and !$checked.ContainsKey("desktop$($d.index)")) {
                    $sd=DesktopSD $d.index
                    if ($sd -cne $d.before) { throw 'Final desktop descriptor mismatch' }; $checked["desktop$($d.index)"]=$sd
                }
            }
            if (Get-NetFirewallRule -PolicyStore ActiveStore | Where-Object Name -eq ('W17-'+$j.tag)) { throw 'Final firewall snapshot found owned rule' }
            return @{descriptors=$checked;bfe=(Get-Service BFE).Status.ToString();secondary=(Get-Service seclogon).Status.ToString();accounts=$remaining.Count}
        }
        'recover-policy' {
            return Unwind { param($e) $e.kind -in @('wfp','firewall','audit','desktop','tree-acl') -or ($e.kind -eq 'acl' -and $e.data.scope -in @('baseline','container')) }
        }
        'cleanup' {
            # Desktop restores must also verify the runner is on the original desktop.
            $pendingProfile=@($j.entries | Where-Object { !$_.done -and $_.kind -eq 'container' }).Count -gt 0
            $results=Unwind { param($e)
                if ($pendingProfile -and $e.data.sid -eq $j.accounts.subject.sid -and ($e.kind -eq 'membership' -or ($e.kind -eq 'acl' -and $e.data.scope -in @('stage','runner')))) { return $false }
                return $e.kind -notin @('account','stage','junction')
            }
            $accounts=Unwind { param($e) $e.kind -eq 'account' -and (!$pendingProfile -or $e.data.role -ne 'subject') }
            $pendingStage=@($j.entries | Where-Object { !$_.done -and ($_.kind -in @('tree-acl','account','container') -or ($_.kind -eq 'acl' -and $_.data.scope -ne 'runner')) }).Count -gt 0
            $stageResult=Unwind {param($e) $e.kind -eq 'stage' -and !$pendingStage}
            return ,@($results+$accounts+$stageResult)
        }
        default { throw 'Unknown broker operation' }
    }
}
try {
    while ($null -ne ($line=[Console]::ReadLine())) {
        try {
            $p=$line | ConvertFrom-Json -AsHashtable
            $result=Dispatch $p
            $reply=@{ok=$true;value=$result}
        } catch { $reply=@{ok=$false;error=$_.Exception.Message} }
        [Console]::WriteLine((ConvertTo-Json $reply -Depth 20 -Compress))
    }
} finally {
    foreach ($receiver in $receivers.Values) { $receiver.Close() }
    foreach ($receiver in $receivers.Values) { $receiver.Join() }
    [Console]::WriteLine((ConvertTo-Json -Compress @{kind='listener';data=@{event='receiver shutdown complete';pid=$PID;workers=$receivers.Count}}))
    [Console]::Out.Flush()
    foreach ($secret in $secrets.Values) { $secret.Dispose() }
    if ($controllerRoot) { $controllerRoot.Dispose() }
}
