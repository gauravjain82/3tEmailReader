param([switch]$Check,[switch]$DryRun,[string]$JobPath,[string]$AdobeExe)
$ErrorActionPreference='Stop'
$submitted=$false
$readerWindow=$null
$result=@{submitted=$false;dryRun=[bool]$DryRun}
try {
    Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes,System.Windows.Forms,System.Drawing
    Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class InvoiceAdobeWindow {
 [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr handle);
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr handle,uint msg,IntPtr w,IntPtr l);
}
'@
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
    if((Get-FileHash -LiteralPath $job.pdfPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $job.sha256){throw 'Verified original PDF changed before Adobe printing'}
    if((Get-Process -Id $PID).SessionId -eq 0 -or ![Environment]::UserInteractive){throw 'Adobe automation needs an unlocked interactive Windows desktop'}
    $existing=@(Get-Process Acrobat,AcroRd32 -ErrorAction SilentlyContinue | Where-Object {$_.MainWindowHandle -ne 0})
    $session=$null
    if($job.sessionFile -and (Test-Path -LiteralPath $job.sessionFile)){$session=Get-Content -LiteralPath $job.sessionFile -Raw | ConvertFrom-Json}
    if($existing.Count) {
        if($existing.Count -ne 1 -or !$session -or $existing[0].Id -ne $session.processId -or $existing[0].StartTime.Ticks.ToString() -ne $session.startTicks -or $existing[0].MainWindowHandle.ToInt64() -ne $session.handle -or !$existing[0].MainWindowTitle.Contains($session.filename)) {
            throw 'Close existing Adobe Reader/Acrobat windows before this batch so automation can identify its own document.'
        }
    }
    function Elements($parent,$type) {
        $condition=New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty,$type)
        return @($parent.FindAll([System.Windows.Automation.TreeScope]::Descendants,$condition))
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
    $arguments='/A "page='+$job.page+'" "'+$job.pdfPath+'"'
    # This mode explicitly automates the visible desktop dialog chosen by the user.
    Start-Process -FilePath $executable -ArgumentList $arguments -WindowStyle Normal | Out-Null
    $deadline=[DateTime]::UtcNow.AddSeconds(45)
    while([DateTime]::UtcNow -lt $deadline) {
        $processes=@(Get-Process Acrobat,AcroRd32 -ErrorAction SilentlyContinue | Where-Object {$_.MainWindowHandle -ne 0 -and $_.MainWindowTitle.Contains([IO.Path]::GetFileName($job.pdfPath))})
        if($processes.Count -eq 1){$readerWindow=[System.Windows.Automation.AutomationElement]::FromHandle($processes[0].MainWindowHandle);break}
        Start-Sleep -Milliseconds 300
    }
    if(!$readerWindow){throw 'Could not identify the opened invoice in Reader. Complete first-launch prompts, then retry.'}
    if($job.sessionFile) {
        $owner=Get-Process -Id $readerWindow.Current.ProcessId
        @{processId=$owner.Id;startTicks=$owner.StartTime.Ticks.ToString();handle=$readerWindow.Current.NativeWindowHandle;filename=[IO.Path]::GetFileName($job.pdfPath)} | ConvertTo-Json -Compress | Set-Content -LiteralPath $job.sessionFile -Encoding UTF8
    }
    # A positive Reader validation status is required as well as the application's
    # independent cryptographic verification. Never replace the appearance ourselves.
    $deadline=[DateTime]::UtcNow.AddSeconds(75)
    $validated=$false
    $positiveReads=0
    while([DateTime]::UtcNow -lt $deadline) {
        $all=@($readerWindow.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.Condition]::TrueCondition))
        $positive=@($all | Where-Object {$_.Current.Name -match '^Signed and all signatures are valid[.!]?$|^All signatures are valid[.!]?$'})
        if($positive.Count){$positiveReads++}else{$positiveReads=0}
        if($positiveReads -ge 3){$validated=$true;break}
        $validate=Named $readerWindow ([System.Windows.Automation.ControlType]::Button) '^Validate All( Signatures)?$'
        if($validate.Count -eq 1){Invoke $validate[0]}
        Start-Sleep -Milliseconds 500
    }
    if(!$validated){throw 'Reader did not expose an all-signatures-valid status. Enable verification when opening documents in Reader Preferences > Signatures > Verification, and resolve Reader trust/accessibility prompts. No print submitted.'}
    $result.readerValidated=$true
    $handle=[IntPtr]$readerWindow.Current.NativeWindowHandle
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
    $result.uncertain=$submitted
} finally {
    # Only close our own document window before submission/during a dry run.
    # Leave submitted jobs in Reader so closing cannot interrupt spooling.
    if($readerWindow -and !$submitted) {
        if($dialog){try {Invoke (One (Named $dialog ([System.Windows.Automation.ControlType]::Button) '^Cancel$') 'Cancel button')} catch {}}
        [InvoiceAdobeWindow]::PostMessage([IntPtr]$readerWindow.Current.NativeWindowHandle,0x0010,[IntPtr]::Zero,[IntPtr]::Zero) | Out-Null
    }
}
$result | ConvertTo-Json -Compress
if($result.error){exit 1}
