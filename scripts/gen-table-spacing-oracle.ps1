# m2fp.10's table spacing oracle: build table-spacing-oracle.docx, have Word
# 2010 lay it out through COM, and record where things land for a sweep of
# (space-after of the paragraph ABOVE a table, space-before of the one BELOW).
# NOT run by npm test: it needs Word. Same method as gen-spacing-oracle.ps1:
# the paragraph P3 below carries no spacing and is the WITNESS for where P2's
# line ended, since Word misreports the position of a paragraph WITH space
# before. Paragraph 2 of the document is the table cell's.
param(
  [string]$Docx = (Join-Path $PSScriptRoot '..\test\fixtures\docx\table-spacing-oracle.docx'),
  [string]$Json = (Join-Path $PSScriptRoot '..\test\fixtures\docx\table-spacing-oracle.json'))
$ErrorActionPreference = 'Stop'
$Docx = [IO.Path]::GetFullPath($Docx); $Json = [IO.Path]::GetFullPath($Json)
Push-Location (Join-Path $PSScriptRoot '..')
try { npx tsx scripts/gen-table-spacing-oracle.ts $Docx; if ($LASTEXITCODE) { throw 'builder failed' } } finally { Pop-Location }
$w = New-Object -ComObject Word.Application
try {
  $w.Visible = $true; $w.DisplayAlerts = 0
  # A copy, so the vendored file is never re-saved by Word.
  $tmp = Join-Path $env:TEMP 'table-spacing-oracle-work.docx'; Copy-Item $Docx $tmp -Force
  $d = $w.Documents.Open($tmp, $false, $false)
  $d.ActiveWindow.View.Type = 3                       # wdPrintView
  # By TEXT, never by index: Word counts a table row's end-of-row mark as a
  # paragraph of its own, so Item(3) is that mark and not P2 — measured, the
  # first run set space-before on it and P2's spacing never moved anything.
  $by = @{}; foreach ($q in $d.Paragraphs) { $t = $q.Range.Text -replace '[\r\a\x07]', ''; if ($t) { $by[$t] = $q } }
  $p1 = $by['One']; $cell = $by['Cell']; $p2 = $by['Two']; $p3 = $by['Three']
  if (-not ($p1 -and $cell -and $p2 -and $p3)) { throw "paragraphs not found: $($by.Keys -join ',')" }
  $rows = @()
  foreach ($c in @(@(0,0), @(12,0), @(0,18), @(12,18), @(18,12), @(24,6))) {
    $p1.Format.SpaceAfter = $c[0]; $p2.Format.SpaceBefore = $c[1]
    $d.Repaginate(); $w.ScreenRefresh()
    $rows += [ordered]@{ after = $c[0]; before = $c[1]; p1 = [double]$p1.Range.Information(6)
      cell = [double]$cell.Range.Information(6); p2reported = [double]$p2.Range.Information(6)
      p3 = [double]$p3.Range.Information(6) }
  }
  $d.Close([ref]0); Remove-Item $tmp -Force
  $out = [ordered]@{ word = "$($w.Version) build $($w.Build)"; lineHeight = 20; rows = $rows }
  [IO.File]::WriteAllText($Json, (ConvertTo-Json $out -Depth 4), (New-Object Text.UTF8Encoding($false)))
} finally { $w.Quit(); [Runtime.InteropServices.Marshal]::ReleaseComObject($w) | Out-Null }
"wrote $Json"
"SHA-256 $((Get-FileHash $Docx -Algorithm SHA256).Hash)"
