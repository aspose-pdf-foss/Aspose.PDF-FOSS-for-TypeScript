# m2fp.5's spacing oracle: build spacing-oracle.docx, have Word 2010 lay it out
# through COM, and record how far apart two paragraphs land for a sweep of
# (space-after of P1, space-before of P2). NOT run by npm test: it needs Word.
#
# The measurement is a WITNESS: P3 carries no spacing on either side of the
# P2/P3 boundary, so its reported position (Range.Information(6),
# wdVerticalPositionRelativeToPage) is where P2's line really ended. The
# position Word reports for a paragraph that HAS space before is NOT trustworthy
# — measured: it reads prevEnd + after + before even where the layout (and so
# every paragraph after it) used max(after, before). Word runs visible in Print
# Layout; a hidden instance reports the same numbers, but the view is stated
# so the measurement never depends on it. Word 2010's PDF export hangs on this
# machine, which is why a PDF could not serve as the witness.
param(
  [string]$Docx = (Join-Path $PSScriptRoot '..\test\fixtures\docx\spacing-oracle.docx'),
  [string]$Json = (Join-Path $PSScriptRoot '..\test\fixtures\docx\spacing-oracle.json'))
$ErrorActionPreference = 'Stop'
$Docx = [IO.Path]::GetFullPath($Docx); $Json = [IO.Path]::GetFullPath($Json)
Push-Location (Join-Path $PSScriptRoot '..')
try { npx tsx scripts/gen-spacing-oracle.ts $Docx; if ($LASTEXITCODE) { throw 'builder failed' } } finally { Pop-Location }
$w = New-Object -ComObject Word.Application
try {
  $w.Visible = $true; $w.DisplayAlerts = 0
  # A copy, so the vendored file is never re-saved by Word.
  $tmp = Join-Path $env:TEMP 'spacing-oracle-work.docx'; Copy-Item $Docx $tmp -Force
  $d = $w.Documents.Open($tmp, $false, $false)
  $d.ActiveWindow.View.Type = 3                       # wdPrintView
  $p1 = $d.Paragraphs.Item(1); $p2 = $d.Paragraphs.Item(2); $p3 = $d.Paragraphs.Item(3)
  $p2.Format.SpaceAfter = 0; $p3.Format.SpaceBefore = 0
  $rows = @()
  foreach ($c in @(@(0,0), @(12,0), @(0,18), @(12,18), @(18,12), @(24,18), @(6,30))) {
    $p1.Format.SpaceAfter = $c[0]; $p2.Format.SpaceBefore = $c[1]
    $d.Repaginate(); $w.ScreenRefresh()
    $rows += [ordered]@{ after = $c[0]; before = $c[1]; p1 = [double]$p1.Range.Information(6)
      p2reported = [double]$p2.Range.Information(6); p3 = [double]$p3.Range.Information(6) }
  }
  $d.Close([ref]0); Remove-Item $tmp -Force
  $out = [ordered]@{ word = "$($w.Version) build $($w.Build)"; lineHeight = 20; rows = $rows }
  [IO.File]::WriteAllText($Json, (ConvertTo-Json $out -Depth 4), (New-Object Text.UTF8Encoding($false)))
} finally { $w.Quit(); [Runtime.InteropServices.Marshal]::ReleaseComObject($w) | Out-Null }
"wrote $Json"
"SHA-256 $((Get-FileHash $Docx -Algorithm SHA256).Hash)"
