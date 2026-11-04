# Shared, read-only UI inspection. Never enumerate another application's controls.
function Get-AdobeWindows {
    $windows=@()
    foreach($native in [InvoiceAdobeWindow]::VisibleWindows()) {
        $owner=Get-Process -Id $native.ProcessId -ErrorAction SilentlyContinue
        if($owner -and $owner.ProcessName -match '^(Acrobat|AcroRd32)$' -and $owner.SessionId -eq (Get-Process -Id $PID).SessionId) {
            $windows+=@{handle=$native.Handle;processId=$owner.Id;startTicks=$owner.StartTime.Ticks.ToString();title=$native.Title}
        }
    }
    return $windows
}
function Get-AdobeControls($root) {
    # Descendant FindAll(TrueCondition) traverses the rendered PDF's accessibility
    # tree and can hang for minutes. Walk the application chrome, skipping document
    # content, with limits on count and depth instead.
    $walker=[System.Windows.Automation.TreeWalker]::ControlViewWalker
    $queue=New-Object System.Collections.Queue
    $queue.Enqueue(@{element=$root;depth=0})
    $items=New-Object System.Collections.Generic.List[object]
    $script:AdobeControlSnapshot=New-Object System.Collections.Generic.List[object]
    $clock=[Diagnostics.Stopwatch]::StartNew()
    while($queue.Count -gt 0 -and $items.Count -lt 800 -and $clock.Elapsed.TotalSeconds -lt 5) {
        $item=$queue.Dequeue();$element=$item.element
        try {
            $current=$element.Current
            $items.Add($element)
            $script:AdobeControlSnapshot.Add(@{name=$current.Name;type=$current.ControlType.ProgrammaticName;automationId=$current.AutomationId;className=$current.ClassName;enabled=$current.IsEnabled;offscreen=$current.IsOffscreen})
            if($item.depth -ge 14 -or $current.ControlType -eq [System.Windows.Automation.ControlType]::Document -or $current.ClassName -eq 'AVPageView'){continue}
            $child=$walker.GetFirstChild($element)
            while($child -and $queue.Count -lt 800 -and $clock.Elapsed.TotalSeconds -lt 5) {
                $queue.Enqueue(@{element=$child;depth=$item.depth+1})
                $child=$walker.GetNextSibling($child)
            }
        }catch [System.Windows.Automation.ElementNotAvailableException] {}
    }
    return $items.ToArray()
}
function Test-AdobeDocumentWindow($window,[string]$filename) {
    if($window.title.IndexOf($filename,[StringComparison]::OrdinalIgnoreCase) -ge 0){return $true}
    $root=[System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$window.handle)
    foreach($element in @(Get-AdobeControls $root)) {
        if($element.Current.Name.IndexOf($filename,[StringComparison]::OrdinalIgnoreCase) -ge 0){return $true}
    }
    return $false
}
function Write-AdobeDiagnostic([string]$file,$windows,$root,[string]$stage,[string]$errorText) {
    # Use the last bounded scan. A fresh UIA query during error handling can hang
    # against the very provider that just failed and prevent Reader cleanup.
    $controls=@()
    if($script:AdobeControlSnapshot){$controls=$script:AdobeControlSnapshot.ToArray()}
    @{stage=$stage;error=$errorText;windows=@($windows);controls=$controls;recordedAt=[DateTime]::UtcNow.ToString('o')} | ConvertTo-Json -Depth 7 | Set-Content -LiteralPath $file -Encoding UTF8
}
