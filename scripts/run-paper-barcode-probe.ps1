param([Parameter(Mandatory)][string]$Name)
# scripts/run-paper-barcode-probe.ps1 -- NOT run by npm test (2srz.4).
# Opens test/fixtures/paper-barcode/<Name>.pdf in Adobe Acrobat Reader, whose
# /OpenAction sets the field values and recalculates, so Reader draws the
# barcode from Adobe's own computed content; captures the Reader window
# (without focusing it) to test/fixtures/paper-barcode/<Name>.png.
$dir = Join-Path $PSScriptRoot '..\test\fixtures\paper-barcode'
$pdf = Join-Path $dir "$Name.pdf"
if (-not (Test-Path $pdf)) { "no $pdf"; exit 1 }
Get-Process Acrobat -ErrorAction SilentlyContinue | Stop-Process
Start-Sleep 2
Start-Process 'C:\Program Files\Adobe\Acrobat DC\Acrobat\Acrobat.exe' -ArgumentList "`"$((Resolve-Path $pdf).Path)`""
Start-Sleep 15

Add-Type -AssemblyName System.Drawing
Add-Type @"
using System; using System.Runtime.InteropServices;
public class PaperProbeCap { [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out R r); [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint f);
public struct R { public int L,T,Rt,B; } }
"@
$p = Get-Process Acrobat -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -like '*.pdf*' } | Select-Object -First 1
if (-not $p) { 'no Reader window'; exit 1 }
$p.MainWindowTitle
$r = New-Object PaperProbeCap+R
[PaperProbeCap]::GetWindowRect($p.MainWindowHandle, [ref]$r) | Out-Null
$bmp = New-Object Drawing.Bitmap ($r.Rt - $r.L), ($r.B - $r.T)
$g = [Drawing.Graphics]::FromImage($bmp)
$dc = $g.GetHdc()
[PaperProbeCap]::PrintWindow($p.MainWindowHandle, $dc, 2) | Out-Null
$g.ReleaseHdc($dc)
$bmp.Save((Join-Path $dir "$Name.png"))
