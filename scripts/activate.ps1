Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
}
"@
$title = $args[0]
$p = Get-Process | Where-Object { $_.MainWindowTitle -like "*$title*" } | Select-Object -First 1
if (-not $p) { "pencere bulunamadi: $title"; exit 1 }
[Win]::ShowWindow($p.MainWindowHandle, 9) | Out-Null   # restore
[Win]::BringWindowToTop($p.MainWindowHandle) | Out-Null
[Win]::SetForegroundWindow($p.MainWindowHandle) | Out-Null
Start-Sleep -Milliseconds 700
"aktif: $($p.MainWindowTitle)"