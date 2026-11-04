param([switch]$Check,[switch]$DryRun,[string]$JobPath,[string]$AdobeExe)
$ErrorActionPreference='Stop'
$submitted=$false
$readerWindow=$null
$ownedHandle=[IntPtr]::Zero
$stage='Starting Adobe checks'
$baselineHandles=@()
$launched=$false
$result=@{submitted=$false;dryRun=[bool]$DryRun}
function Progress([string]$text) {
    $script:stage=$text
    if($JobPath){@{stage=$text;at=[DateTime]::UtcNow.ToString('o')} | ConvertTo-Json -Compress | Set-Content -LiteralPath ($JobPath+'.progress.json') -Encoding UTF8}
}
function TrackWindow($window) {
    if($JobPath) {
        @{handle=$window.handle;processId=$window.processId;startTicks=$window.startTicks;closeAllowed=($baselineHandles -notcontains $window.handle)} | ConvertTo-Json -Compress | Set-Content -LiteralPath ($JobPath+'.ownership.json') -Encoding UTF8
    }
}
try {
    Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes,System.Windows.Forms,System.Drawing
    Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Collections.Generic;
using System.Text;
public sealed class InvoiceAdobeNativeWindow {
 public long Handle; public int ProcessId; public string Title;
}
public static class InvoiceAdobeWindow {
 [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr handle);
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr handle,uint msg,IntPtr w,IntPtr l);
 private delegate bool EnumProc(IntPtr handle,IntPtr param);
 [DllImport("user32.dll")] private static extern bool EnumWindows(EnumProc callback,IntPtr param);
 [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr handle);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] private static extern int GetWindowText(IntPtr handle,StringBuilder text,int length);
 [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr handle,out uint processId);
 public static InvoiceAdobeNativeWindow[] VisibleWindows() {
  var result=new List<InvoiceAdobeNativeWindow>();
  EnumWindows(delegate(IntPtr handle,IntPtr param) {
   if(!IsWindowVisible(handle))return true;
   uint pid;GetWindowThreadProcessId(handle,out pid);
   var title=new StringBuilder(2048);GetWindowText(handle,title,title.Capacity);
   result.Add(new InvoiceAdobeNativeWindow {Handle=handle.ToInt64(),ProcessId=(int)pid,Title=title.ToString()});
   return true;
  },IntPtr.Zero);
  return result.ToArray();
 }
}
'@
    . (Join-Path $PSScriptRoot 'adobe-ui.ps1')
    Progress 'Checking Reader and the Windows default printer'
    $candidates=@($AdobeExe,$env:ADOBE_READER)
    foreach($registryPath in @('HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths','HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths','HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths')) {
        foreach($exe in @('Acrobat.exe','AcroRd32.exe')) {
            $entry=Get-ItemProperty -LiteralPath ($registryPath+'\'+$exe) -ErrorAction SilentlyContinue
            if($entry){$candidates+=($entry.'(default)')}
        }
    }
    foreach($base in @($env:ProgramFiles,${env:ProgramFiles(x86)})) {
        if($base){foreach($suffix in @('Adobe\Acrobat DC\Acrobat\Acrobat.exe','Adobe\Acrobat Reader DC\Reader\AcroRd32.exe','Adobe\Acrobat Reader\Reader\AcroRd32.exe')){$candidates+=(Join-Path $base $suffix)}}
    }
    $executable=$candidates | Where-Object {$_ -and [IO.Path]::IsPathRooted($_) -and $_ -match '\.exe$' -and (Test-Path -LiteralPath $_ -PathType Leaf)} | Select-Object -First 1
    if(!$executable){throw 'Adobe Reader was not found. Install the free desktop Reader or set ADOBE_READER in .env to its full executable path.'}
    $printer=New-Object System.Drawing.Printing.PrinterSettings
    if(!$printer.IsValid -or $printer.PrinterName -match 'PDF|XPS|OneNote|Fax'){throw 'Select your attached physical printer as the Windows default printer.'}
    $result.executable=$executable
    $result.printer=$printer.PrinterName
    $result.version=(Get-Item -LiteralPath $executable).VersionInfo.ProductVersion
    if($Check){$result.ready=$true;$result | ConvertTo-Json -Compress;exit 0}
    if(!$JobPath){throw 'Missing Adobe print job file'}
    $job=Get-Content -LiteralPath $JobPath -Raw | ConvertFrom-Json
    if(!$job.pdfPath -or ![IO.Path]::IsPathRooted($job.pdfPath) -or $job.sha256 -notmatch '^[a-f0-9]{64}$' -or $job.page -isnot [int] -or $job.page -lt 1){throw 'Invalid Adobe print job'}
    $proof=$job.verification
    if(!$proof -or $proof.schemaVersion -ne 1 -or $proof.status -ne 'VALID' -or $proof.sha256 -ne $job.sha256 -or @($proof.signatures).Count -lt 1){throw 'Missing application signature verification for this PDF'}
    foreach($signature in $proof.signatures) {
        if($signature.status -ne 'VALID' -or $signature.intact -ne $true -or $signature.cryptographicallyValid -ne $true -or $signature.trusted -ne $true){throw 'Incomplete application signature verification'}
    }
    if($proof.signatures[-1].coverage -ne 'ENTIRE_FILE'){throw 'Application verification does not cover the complete PDF'}
    if((Get-FileHash -LiteralPath $job.pdfPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $job.sha256){throw 'Verified original PDF changed before Adobe printing'}
    $result.applicationVerified=$true
    if((Get-Process -Id $PID).SessionId -eq 0 -or ![Environment]::UserInteractive){throw 'Adobe automation needs an unlocked interactive Windows desktop'}
    $existing=@(Get-AdobeWindows)
    $baselineHandles=@($existing | ForEach-Object {$_.handle})
    $session=$null
    if($job.sessionFile -and (Test-Path -LiteralPath $job.sessionFile)){$session=Get-Content -LiteralPath $job.sessionFile -Raw | ConvertFrom-Json}
    if($existing.Count) {
        if($existing.Count -ne 1 -or !$session -or $existing[0].processId -ne $session.processId -or $existing[0].startTicks -ne $session.startTicks -or $existing[0].handle -ne $session.handle -or !(Test-AdobeDocumentWindow $existing[0] $session.filename)) {
            throw 'Close existing Adobe Reader/Acrobat windows before this batch so automation can identify its own document.'
        }
    }
    function Elements($parent,$type) {
        return @(Get-AdobeControls $parent | Where-Object {$_.Current.ControlType -eq $type})
    }
    function Named($parent,$type,$pattern) {
        return @(Elements $parent $type | Where-Object {$_.Current.Name -match $pattern -and $_.Current.IsEnabled})
    }
    function One($items,$description) {
        $items=@($items)
        if($items.Count -ne 1){throw "Cannot uniquely identify Adobe $description. No print submitted."}
        return $items[0]
    }
    function Invoke($element) {
        $pattern=$element.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
        $pattern.Invoke()
    }
    function SetValue($element,$value) {
        $pattern=$element.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
        if($pattern.Current.IsReadOnly){throw 'Adobe print setting is read-only'}
        $pattern.SetValue($value)
        if($pattern.Current.Value -ne $value){throw 'Adobe did not retain the requested print setting'}
    }
    function AssociatedEdit($dialog,$label,$description) {
        $rect=$label.Current.BoundingRectangle
        $middle=$rect.Top+$rect.Height/2
        $matches=@(Elements $dialog ([System.Windows.Automation.ControlType]::Edit) | Where-Object {
            $r=$_.Current.BoundingRectangle
            $_.Current.IsEnabled -and $r.Left -ge $rect.Right-8 -and [Math]::Abs(($r.Top+$r.Height/2)-$middle) -lt 16
        })
        return One $matches $description
    }
    # Open the complete verified attachment. It is never split or resaved.
    Progress 'Opening the verified invoice in Reader'
    $arguments='/A "page='+$job.page+'" "'+$job.pdfPath+'"'
    # This mode explicitly automates the visible desktop dialog chosen by the user.
    Start-Process -FilePath $executable -ArgumentList $arguments -WindowStyle Normal | Out-Null
    $launched=$true
    Progress 'Waiting for the Reader document window (up to 30 seconds)'
    $deadline=[DateTime]::UtcNow.AddSeconds(30)
    while([DateTime]::UtcNow -lt $deadline) {
        $windows=@(Get-AdobeWindows)
        $matching=@($windows | Where-Object {$_.title.IndexOf([IO.Path]::GetFileName($job.pdfPath),[StringComparison]::OrdinalIgnoreCase) -ge 0})
        if($matching.Count -eq 1){$ownedHandle=[IntPtr]$matching[0].handle;TrackWindow $matching[0];$readerWindow=[System.Windows.Automation.AutomationElement]::FromHandle($ownedHandle);break}
        $new=@($windows | Where-Object {$baselineHandles -notcontains $_.handle})
        # On a fresh Reader launch, metadata may replace the filename in the title.
        # A single newly opened Reader window is still ours; existing batch windows
        # must positively identify the new filename before they can be reused.
        if(!$existing.Count -and $new.Count -eq 1) {
            $ownedHandle=[IntPtr]$new[0].handle
            TrackWindow $new[0]
            $candidate=[System.Windows.Automation.AutomationElement]::FromHandle($ownedHandle)
            $fileTabs=@(Get-AdobeControls $candidate | Where-Object {$_.Current.Name.IndexOf([IO.Path]::GetFileName($job.pdfPath),[StringComparison]::OrdinalIgnoreCase) -ge 0})
            if($fileTabs.Count){$readerWindow=$candidate;break}
        }
        if($existing.Count -eq 1 -and $session) {
            $current=@($windows | Where-Object {$_.handle -eq $session.handle -and $_.processId -eq $session.processId -and $_.startTicks -eq $session.startTicks})
            if($current.Count -eq 1 -and (Test-AdobeDocumentWindow $current[0] ([IO.Path]::GetFileName($job.pdfPath)))) {
                $ownedHandle=[IntPtr]$current[0].handle;TrackWindow $current[0]
                $readerWindow=[System.Windows.Automation.AutomationElement]::FromHandle($ownedHandle);break
            }
        }
        Start-Sleep -Milliseconds 300
    }
    if(!$readerWindow){throw 'Could not identify the opened invoice in Reader. Complete first-launch prompts, then retry.'}
    if($job.sessionFile) {
        $owner=Get-Process -Id $readerWindow.Current.ProcessId
        @{processId=$owner.Id;startTicks=$owner.StartTime.Ticks.ToString();handle=$ownedHandle.ToInt64();filename=[IO.Path]::GetFileName($job.pdfPath)} | ConvertTo-Json -Compress | Set-Content -LiteralPath $job.sessionFile -Encoding UTF8
    }
    # The application has already validated every signature, the chain,
    # revocation and exact source hash. Reader only renders/prints the original.
    # Its visual tick/status is not reliably exposed through accessibility APIs.
    # Do not wait for an English banner or claim Reader status was observed.
    $result.readerValidated=$null
    $result.validationSource='application'
    Progress 'Opening the Print dialog'
    $handle=$ownedHandle
    [InvoiceAdobeWindow]::SetForegroundWindow($handle) | Out-Null
    Start-Sleep -Milliseconds 300
    if([InvoiceAdobeWindow]::GetForegroundWindow() -ne $handle){throw 'Reader could not take focus. No print submitted.'}
    [System.Windows.Forms.SendKeys]::SendWait('^p')
    $dialog=$null
    $deadline=[DateTime]::UtcNow.AddSeconds(25)
    while([DateTime]::UtcNow -lt $deadline) {
        $windows=@([System.Windows.Automation.AutomationElement]::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children,[System.Windows.Automation.Condition]::TrueCondition))
        $windows+=@(Elements $readerWindow ([System.Windows.Automation.ControlType]::Window))
        $dialogs=@($windows | Where-Object {$_.Current.ProcessId -eq $readerWindow.Current.ProcessId -and $_.Current.Name -match '^Print$'} | Sort-Object -Property {$_.Current.NativeWindowHandle} -Unique)
        if($dialogs.Count -eq 1){$dialog=$dialogs[0];break}
        Start-Sleep -Milliseconds 250
    }
    if(!$dialog){throw 'Cannot identify the Adobe Print dialog. English Reader UI is currently required.'}
    Progress 'Selecting the default printer, one original page, one copy and Fit'
    function SelectedPrinter($combo) {
        $selection=$combo.GetCurrentPattern([System.Windows.Automation.SelectionPattern]::Pattern).GetCurrentSelection()
        if($selection.Count -ne 1){throw 'Cannot confirm the selected Adobe printer'}
        return $selection[0].Current.Name
    }
    $combos=@(Elements $dialog ([System.Windows.Automation.ControlType]::ComboBox) | Where-Object {
        $label=$_.Current.LabeledBy
        ($label -and $label.Current.Name -match '^Printer\s*:?$') -or $_.Current.Name -match '^Printer\s*:?$'
    })
    $combo=One $combos 'printer selector'
    if((SelectedPrinter $combo) -ne $printer.PrinterName) {
        $combo.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern).Expand()
        $printerItem=One (Named $dialog ([System.Windows.Automation.ControlType]::ListItem) ('^'+[regex]::Escape($printer.PrinterName)+'$')) 'default printer entry'
        $printerItem.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern).Select()
    }
    if((SelectedPrinter $combo) -ne $printer.PrinterName){throw 'Adobe printer differs from the Windows default'}
    $sizeButtons=@(Named $dialog ([System.Windows.Automation.ControlType]::Button) '^Size$')
    $sizeButtons+=@(Named $dialog ([System.Windows.Automation.ControlType]::RadioButton) '^Size$')
    if($sizeButtons.Count -gt 1){throw 'Ambiguous Adobe page sizing control'}
    if($sizeButtons.Count -eq 1) {
        if($sizeButtons[0].Current.ControlType -eq [System.Windows.Automation.ControlType]::RadioButton){$sizeButtons[0].GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern).Select()}
        else {Invoke $sizeButtons[0]}
    }
    $fit=One (Named $dialog ([System.Windows.Automation.ControlType]::RadioButton) '^Fit$') 'Fit page sizing option'
    $fit.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern).Select()
    $copiesLabel=One (Named $dialog ([System.Windows.Automation.ControlType]::Text) '^Copies\s*:?$') 'Copies label'
    $copies=AssociatedEdit $dialog $copiesLabel 'Copies input'
    SetValue $copies '1'
    $pages=One (Named $dialog ([System.Windows.Automation.ControlType]::RadioButton) '^Pages\s*:?$') 'Pages option'
    $pages.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern).Select()
    $range=AssociatedEdit $dialog $pages 'page range input'
    SetValue $range ([string]$job.page)
    $duplex=Named $dialog ([System.Windows.Automation.ControlType]::CheckBox) '^Print on both sides of paper'
    if($duplex.Count -gt 1){throw 'Ambiguous duplex setting'}
    if($duplex.Count -eq 1) {
        $toggle=$duplex[0].GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern)
        if($toggle.Current.ToggleState -eq [System.Windows.Automation.ToggleState]::On){$toggle.Toggle()}
        if($toggle.Current.ToggleState -ne [System.Windows.Automation.ToggleState]::Off){throw 'Could not disable duplex printing'}
    }
    $button=One (Named $dialog ([System.Windows.Automation.ControlType]::Button) '^Print$') 'Print button'
    # Re-read settings immediately before invoking the one specific Print button.
    if(!( $pages.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern).Current.IsSelected) -or
       $range.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).Current.Value -ne [string]$job.page -or
       $copies.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).Current.Value -ne '1' -or
       !$fit.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern).Current.IsSelected -or
       (SelectedPrinter $combo) -ne $printer.PrinterName){throw 'Adobe print settings changed before submission'}
    if((Get-FileHash -LiteralPath $job.pdfPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $job.sha256){throw 'Verified original changed while preparing Adobe printing'}
    $currentPrinter=New-Object System.Drawing.Printing.PrinterSettings
    if($currentPrinter.PrinterName -ne $printer.PrinterName){throw 'Windows default printer changed while preparing the job'}
    $result.page=$job.page;$result.copies=1;$result.scaling='fit'
    if($DryRun){$result.prepared=$true}
    else {
        Progress 'Submitting the verified Adobe print request'
        # Persist before invocation: any timeout/crash from here is uncertain and
        # must never cause an automatic retry or fallback to another engine.
        @{phase='invoking';pdfPath=$job.pdfPath} | ConvertTo-Json -Compress | Set-Content -LiteralPath ($JobPath+'.state.json') -Encoding UTF8
        $submitted=$true
        Invoke $button
        $deadline=[DateTime]::UtcNow.AddSeconds(20)
        $closed=$false
        while([DateTime]::UtcNow -lt $deadline) {
            try {if($dialog.Current.IsOffscreen){$closed=$true;break}}catch [System.Windows.Automation.ElementNotAvailableException] {$closed=$true;break}
            Start-Sleep -Milliseconds 250
        }
        if(!$closed){throw 'Adobe did not dismiss its Print dialog after submission; check Reader and the printer queue before retrying'}
        $result.submitted=$true
    }
} catch {
    $result.error=$_.Exception.Message
    $result.stage=$stage
    $result.uncertain=$submitted
    if($JobPath) {
        # Save the exact UI seen at failure before attempting cleanup. Do not dump
        # rendered document text or the entire desktop's accessibility tree.
        try {
            $windows=@(Get-AdobeWindows)
            $diagnosticRoot=$dialog
            if(!$diagnosticRoot){$diagnosticRoot=$readerWindow}
            if(!$diagnosticRoot -and $ownedHandle -ne [IntPtr]::Zero){$diagnosticRoot=[System.Windows.Automation.AutomationElement]::FromHandle($ownedHandle)}
            Write-AdobeDiagnostic ($JobPath+'.diagnostic.json') $windows $diagnosticRoot $stage $result.error
            $result.diagnosticPath=$JobPath+'.diagnostic.json'
        }catch {}
    }
} finally {
    # Only close our own document window before submission/during a dry run.
    # Leave submitted jobs in Reader so closing cannot interrupt spooling.
    if(!$submitted -and $launched) {
        Progress 'Closing Reader after a stopped or dry-run job'
        if($dialog){try {Invoke (One (Named $dialog ([System.Windows.Automation.ControlType]::Button) '^Cancel$') 'Cancel button')} catch {}}
        # Window-title detection can fail before a UIA root is available. Close
        # only newly created Reader windows, never pre-existing user windows.
        try {foreach($window in @(Get-AdobeWindows | Where-Object {$baselineHandles -notcontains $_.handle -and $_.handle -ne $ownedHandle.ToInt64()})) {
            [InvoiceAdobeWindow]::PostMessage([IntPtr]$window.handle,0x0010,[IntPtr]::Zero,[IntPtr]::Zero) | Out-Null
        }}catch {}
        Start-Sleep -Milliseconds 200
        if($ownedHandle -ne [IntPtr]::Zero -and $baselineHandles -notcontains $ownedHandle.ToInt64()){[InvoiceAdobeWindow]::PostMessage($ownedHandle,0x0010,[IntPtr]::Zero,[IntPtr]::Zero) | Out-Null}
    }
}
$result | ConvertTo-Json -Compress
if($result.error){exit 1}
