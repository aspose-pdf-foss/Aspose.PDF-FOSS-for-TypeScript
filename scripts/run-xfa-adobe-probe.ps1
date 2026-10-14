param([Parameter(Mandatory)][string]$Name)
# scripts/run-xfa-adobe-probe.ps1 -- NOT run by npm test (164g.11).
# Opens test\fixtures\xfa-adobe\<Name>.pdf in Adobe Acrobat Reader, waits for
# its docReady script to write Adobe's layout into the field at the top of
# page 1, and captures the Reader window (without focusing it) to
# test\fixtures\xfa-adobe\<Name>.png. Closes any running Reader first.
$dir = Join-Path $PSScriptRoot '..\test\fixtures\xfa-adobe'
$pdf = Join-Path $dir "$Name.pdf"
if (-not (Test-Path $pdf)) { "no $pdf"; exit 1 }
Get-Process Acrobat -ErrorAction SilentlyContinue | Stop-Process
Start-Sleep 2
Start-Process 'C:\Program Files\Adobe\Acrobat DC\Acrobat\Acrobat.exe' -ArgumentList "`"$((Resolve-Path $pdf).Path)`""
Start-Sleep 15

Add-Type -AssemblyName System.Drawing
Add-Type @"
using System; using System.Runtime.InteropServices;
public class XfaProbeCap { [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out R r); [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint f);
public struct R { public int L,T,Rt,B; } }
"@
$p = Get-Process Acrobat -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -like '*.pdf*' } | Select-Object -First 1
if (-not $p) { 'no Reader window'; exit 1 }
$p.MainWindowTitle
$r = New-Object XfaProbeCap+R
[XfaProbeCap]::GetWindowRect($p.MainWindowHandle, [ref]$r) | Out-Null
$bmp = New-Object Drawing.Bitmap ($r.Rt - $r.L), ($r.B - $r.T)
$g = [Drawing.Graphics]::FromImage($bmp)
$dc = $g.GetHdc()
[XfaProbeCap]::PrintWindow($p.MainWindowHandle, $dc, 2) | Out-Null
$g.ReleaseHdc($dc)
$bmp.Save((Join-Path $dir "$Name.png"))
