function Section($path) {
    $buffer=[Text.StringBuilder]::new(65536)
    $rc=[W17]::ReadDacl($path,$buffer,$buffer.Capacity)
    Write-Verbose "ReadDacl path=$path rc=$rc raw=$buffer"
    Check $rc 'read raw file DACL'
    return $buffer.ToString()
}
function New-DaclEditor($path,$sddl) {
    $acl=if ([IO.Directory]::Exists($path)) { [Security.AccessControl.DirectorySecurity]::new() }
         else { [Security.AccessControl.FileSecurity]::new() }
    $acl.SetSecurityDescriptorSddlForm($sddl,[Security.AccessControl.AccessControlSections]::Access)
    if ($acl.GetSecurityDescriptorSddlForm('Access') -cne $sddl) { throw "Cannot edit raw DACL losslessly $path" }
    return $acl
}
function Write-RawDacl($path,$before,$requested,$action,$measurement=$null) {
    $observed=[Text.StringBuilder]::new(65536)
    $rc=[W17]::WriteDacl($path,$before,$requested,$observed,$observed.Capacity)
    Write-Verbose "WriteDacl action=$action path=$path rc=$rc requested=$requested observed=$observed"
    if ($null -ne $measurement) {
        $measurement.observed=$observed.ToString()
        $measurement.rc=$rc
    }
    if ($action -eq 'protect stage DACL' -and $before -cmatch '^D:[^(]*AI' -and $requested.StartsWith('D:P(') -and $observed.ToString() -ceq $requested.Insert(3,'AI')) {
        if ($null -ne $measurement -and $rc -eq 13) { $measurement.stickyRequest=$observed.ToString() }
        Write-Verbose 'result=PROTECT_STAGE_AI_STICKY'
    }
    if ($rc -eq 0x20000001) { throw "$action raw DACL rollback failed or could not be verified (rc=$rc)" }
    Check $rc $action
}
function Protect-Stage($path,$ownerSid,[switch]$Marker,$measurement=$null) {
    # Remove inherited generic Users access before creating inputs or homes.
    $acl=if ($Marker) { [Security.AccessControl.FileSecurity]::new() } else { [Security.AccessControl.DirectorySecurity]::new() }
    $inherit=if ($Marker) { 'None' } else { 'ContainerInherit,ObjectInherit' }
    $acl.SetAccessRuleProtection($true,$false)
    foreach ($id in @($ownerSid,'S-1-5-18')) {
        $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($id),'FullControl',$inherit,'None','Allow'))
    }
    Write-RawDacl $path (Section $path) ($acl.GetSecurityDescriptorSddlForm('Access')) 'protect stage DACL' $measurement
}
function Ace($path,$sid,$rights,$inherit,$type,$scope) {
    $before=Section $path
    $acl=New-DaclEditor $path $before
    $entry=Intent 'acl' @{path=$path;before=$before;scope=$scope;sid=$sid;protected=$acl.AreAccessRulesProtected}
    $ace=[Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($sid),$rights,$inherit,'None',$type)
    $acl.AddAccessRule($ace)
    $entry.data.installed=$acl.GetSecurityDescriptorSddlForm('Access'); Save
    if ((Section $path) -cne $before) { throw "Conflicting initial DACL $path" }
    Write-RawDacl $path $before $entry.data.installed 'install raw file DACL'
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
        Write-RawDacl $e.data.path $current $e.data.before 'restore raw file DACL'
    }
    if ((Section $e.data.path) -cne $e.data.before) { throw "DACL restoration mismatch $($e.data.path)" }
}
function Read-Label($path) {
    $buffer=[Text.StringBuilder]::new(65536)
    Check ([W17]::ReadLabel($path,$buffer,$buffer.Capacity)) 'read mandatory label'
    return $buffer.ToString()
}
function Write-Label($path,$before,$requested) {
    $rc=[W17]::WriteLabel($path,$before,$requested)
    Write-Verbose "WriteLabel path=$path rc=$rc before=$before requested=$requested"
    if ($rc -eq 0x20000001) { throw "Mandatory label rollback or unchanged DACL could not be verified $path" }
    Check $rc 'write mandatory label'
}
function Install-LowLabel($path) {
    $before=Read-Label $path
    $entry=Intent 'label' @{path=$path;before=$before;installed='S:(ML;OICI;NW;;;LW)'}
    Write-Label $path $before $entry.data.installed
    if ((Read-Label $path) -cne $entry.data.installed) { throw "Inherited low integrity label missing $path" }
    return $entry
}
function RestoreLabel($e) {
    $current=Read-Label $e.data.path
    if (NeedsRestore $current $e.data.before $e.data.installed $e.data.path) {
        Write-Label $e.data.path $current $e.data.before
    }
    if ((Read-Label $e.data.path) -cne $e.data.before) { throw "Label restoration mismatch $($e.data.path)" }
}
