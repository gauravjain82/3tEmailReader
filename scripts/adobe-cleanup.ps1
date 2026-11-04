param([Parameter(Mandatory=$true)][string]$JobPath)
$ErrorActionPreference='Stop'
# Called only after the automation worker exited. A Print invocation marker
# always takes precedence: never close Reader while a job may be spooling.
if(Test-Path -LiteralPath ($JobPath+'.state.json')){exit 0}
if(!(Test-Path -LiteralPath ($JobPath+'.ownership.json'))){exit 0}
$owner=Get-Content -LiteralPath ($JobPath+'.ownership.json') -Raw | ConvertFrom-Json
if($owner.closeAllowed -ne $true){exit 0}
Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Collections.Generic;
public static class InvoiceAdobeCleanup {
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window,out uint pid);
 [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr window,uint msg,IntPtr w,IntPtr l);
 private delegate bool EnumProc(IntPtr window,IntPtr param);
 [DllImport("user32.dll")] private static extern bool EnumWindows(EnumProc callback,IntPtr param);
 [DllImport("user32.dll")] private static extern IntPtr GetWindow(IntPtr window,uint command);
 public static IntPtr[] OwnedDialogs(IntPtr parent) {
  var result=new List<IntPtr>();
  EnumWindows(delegate(IntPtr window,IntPtr param) {
   var owner=GetWindow(window,4);
   for(int depth=0;depth<8 && owner!=IntPtr.Zero;depth++) {
    if(owner==parent){result.Add(window);break;}
    owner=GetWindow(owner,4);
   }
   return true;
  },IntPtr.Zero);
  result.Reverse();return result.ToArray();
 }
}
'@
$native=[IntPtr][long]$owner.handle
[uint32]$actualPid=0
[InvoiceAdobeCleanup]::GetWindowThreadProcessId($native,[ref]$actualPid) | Out-Null
if($actualPid -ne $owner.processId){exit 0}
$process=Get-Process -Id $actualPid -ErrorAction SilentlyContinue
if(!$process -or $process.ProcessName -notmatch '^(Acrobat|AcroRd32)$' -or $process.StartTime.Ticks.ToString() -ne $owner.startTicks -or $process.SessionId -ne (Get-Process -Id $PID).SessionId){exit 0}
if(!(Test-Path -LiteralPath ($JobPath+'.state.json'))) {
 foreach($dialog in [InvoiceAdobeCleanup]::OwnedDialogs($native)) {
  if(Test-Path -LiteralPath ($JobPath+'.state.json')){exit 0}
  [InvoiceAdobeCleanup]::PostMessage($dialog,0x0010,[IntPtr]::Zero,[IntPtr]::Zero) | Out-Null
 }
 Start-Sleep -Milliseconds 200
 if(Test-Path -LiteralPath ($JobPath+'.state.json')){exit 0}
 [InvoiceAdobeCleanup]::PostMessage($native,0x0010,[IntPtr]::Zero,[IntPtr]::Zero) | Out-Null
}
