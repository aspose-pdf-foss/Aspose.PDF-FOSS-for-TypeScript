# v9j3.1's tab oracle: build tab-oracle.docx, have Word lay it out through COM,
# and record where each case's MARKER character lands — its left edge,
# Range.Information(5) (wdHorizontalPositionRelativeToPage), in points. NOT run
# by npm test: it needs Word. The markers are the upper-case letters A..H, each
# occurring once in the document (test/helpers/build-tab-oracle.ts).
param(
  [string]$Docx = (Join-Path $PSScriptRoot '..\test\fixtures\docx\tab-oracle.docx'),
  [string]$Json = (Join-Path $PSScriptRoot '..\test\fixtures\docx\tab-oracle.json'))
$ErrorActionPreference = 'Stop'
$Docx = [IO.Path]::GetFullPath($Docx); $Json = [IO.Path]::GetFullPath($Json)
Push-Location (Join-Path $PSScriptRoot '..')
try { npx tsx scripts/gen-tab-oracle.ts $Docx; if ($LASTEXITCODE) { throw 'builder failed' } } finally { Pop-Location }
$w = New-Object -ComObject Word.Application
try {
  $w.Visible = $true; $w.DisplayAlerts = 0
  # A copy, so the vendored file is never re-saved by Word.
  $tmp = Join-Path $env:TEMP 'tab-oracle-work.docx'; Copy-Item $Docx $tmp -Force
  $d = $w.Documents.Open($tmp, $false, $false)
  $d.ActiveWindow.View.Type = 3                       # wdPrintView
  $d.Repaginate(); $w.ScreenRefresh()
  $text = $d.Content.Text
  $rows = @()
  foreach ($m in [char[]]'ABCDEFGH') {
    $i = $text.IndexOf($m)
    if ($i -lt 0) { throw "marker $m not found" }
    $r = $d.Range($d.Content.Start + $i, $d.Content.Start + $i + 1)
    if ($r.Text -ne [string]$m) { throw "marker $m resolved to '$($r.Text)'" }
    $rows += [ordered]@{ char = [string]$m; x = [double]$r.Information(5); font = $r.Font.Name }
  }
  $d.Close([ref]0); Remove-Item $tmp -Force
  $out = [ordered]@{ word = "$($w.Version) build $($w.Build)"; rows = $rows }
  [IO.File]::WriteAllText($Json, (ConvertTo-Json $out -Depth 4), (New-Object Text.UTF8Encoding($false)))
} finally { $w.Quit(); [Runtime.InteropServices.Marshal]::ReleaseComObject($w) | Out-Null }
"wrote $Json"
"SHA-256 $((Get-FileHash $Docx -Algorithm SHA256).Hash)"
"SHA-256 $((Get-FileHash $Json -Algorithm SHA256).Hash)"
