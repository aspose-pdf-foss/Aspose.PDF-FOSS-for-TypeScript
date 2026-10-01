# m2fp.3's oracle: build wml-oracle.docx from test/helpers/build-wml-oracle.ts,
# open it in Microsoft Word through COM, and record Word's COMPUTED formatting
# per paragraph and word as test/fixtures/docx/wml-oracle.json. The JSON is the
# ground truth test/wml-oracle.test.ts compares readDocx against. NOT run by
# npm test: it needs Word.
param(
  [string]$Docx = (Join-Path $PSScriptRoot '..\test\fixtures\docx\wml-oracle.docx'),
  [string]$Json = (Join-Path $PSScriptRoot '..\test\fixtures\docx\wml-oracle.json'))
$ErrorActionPreference = 'Stop'
$Docx = [IO.Path]::GetFullPath($Docx); $Json = [IO.Path]::GetFullPath($Json)
Push-Location (Join-Path $PSScriptRoot '..')
try { npx tsx scripts/gen-wml-oracle.ts $Docx; if ($LASTEXITCODE) { throw 'builder failed' } } finally { Pop-Location }

$w = New-Object -ComObject Word.Application
try {
  $w.Visible = $false; $w.DisplayAlerts = 0
  $d = $w.Documents.Open($Docx, $false, $true)       # ConfirmConversions, ReadOnly
  $paras = @()
  # Indexed .Item(k), not foreach: PowerShell 5.1's enumeration of these COM
  # collections yields a null element on this document.
  for ($pi = 1; $pi -le $d.Paragraphs.Count; $pi++) {
    $p = $d.Paragraphs.Item($pi)
    $words = @()
    $ws = $p.Range.Words
    for ($wi = 1; $wi -le $ws.Count; $wi++) {
      $wd = $ws.Item($wi)
      if ($null -eq $wd -or $null -eq $wd.Text) { continue }
      $t = $wd.Text.Trim(); if ($t -eq '') { continue }
      $words += [ordered]@{
        text = $t; bold = ($wd.Font.Bold -eq -1); italic = ($wd.Font.Italic -eq -1)
        size = [double]$wd.Font.Size; name = [string]$wd.Font.Name; nameAscii = [string]$wd.Font.NameAscii
        color = [int]$wd.Font.Color; underline = ([int]$wd.Font.Underline -ne 0)
        strike = ($wd.Font.StrikeThrough -eq -1); highlight = [int]$wd.HighlightColorIndex
        shading = [int]$wd.Font.Shading.BackgroundPatternColor }
    }
    $paras += [ordered]@{ text = $p.Range.Text.TrimEnd("`r", [char]7); listString = $p.Range.ListFormat.ListString
      outlineLevel = [int]$p.OutlineLevel; words = $words }
  }
  $d.Close([ref]0)
  $out = [ordered]@{ word = "$($w.Version) build $($w.Build)"; paragraphs = $paras }
  [IO.File]::WriteAllText($Json, (ConvertTo-Json $out -Depth 6), (New-Object Text.UTF8Encoding($false)))
} finally { $w.Quit(); [Runtime.InteropServices.Marshal]::ReleaseComObject($w) | Out-Null }
"wrote $Json"
"SHA-256 $((Get-FileHash $Docx -Algorithm SHA256).Hash)"
