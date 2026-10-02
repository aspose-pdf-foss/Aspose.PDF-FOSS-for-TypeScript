# Writes test/fixtures/compare/word2010-rev1.pdf and word2010-rev2.pdf through
# Microsoft Word COM automation (aq4a.6): one document, saved as PDF, then
# edited by a KNOWN list of changes and saved again. The edit list is the
# oracle for test/compare-real.test.ts, and it comes from this script — not
# from the comparison code it checks.
#
# NOT run by npm test: it needs Word, and Word stamps the PDF with the save
# time, so a rerun is never byte-identical. The VENDORED files are the
# reference; see test/fixtures/compare/PROVENANCE.md.
#
# The text is set in Liberation Sans (OFL, vendored in fonts/), loaded for this
# session only through GDI's AddFontResource and unloaded afterwards, so the
# PDFs embed no font the repository could not ship. The script refuses to
# write a PDF that names any other font.
param([string]$OutDir = (Join-Path $PSScriptRoot '..\test\fixtures\compare'))
$ErrorActionPreference = 'Stop'

Add-Type @'
using System.Runtime.InteropServices;
public static class Gdi {
  [DllImport("gdi32.dll", CharSet = CharSet.Unicode)] public static extern int AddFontResource(string path);
  [DllImport("gdi32.dll", CharSet = CharSet.Unicode)] public static extern bool RemoveFontResource(string path);
}
'@

$OutDir = [System.IO.Path]::GetFullPath($OutDir)
New-Item -ItemType Directory -Force $OutDir | Out-Null
$fonts = @('LiberationSans-Regular.ttf', 'LiberationSans-Bold.ttf') | ForEach-Object {
  [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\fonts\$_"))
}
foreach ($f in $fonts) { if ([Gdi]::AddFontResource($f) -eq 0) { throw "AddFontResource failed: $f" } }

$topics = 'shipping', 'invoicing', 'returns', 'warranty', 'insurance', 'storage', 'inspection',
  'acceptance', 'confidentiality', 'subcontracting', 'notices', 'assignment', 'audits', 'records',
  'samples', 'labelling', 'customs', 'currency', 'discounts', 'rebates', 'forecasts', 'tooling',
  'spares', 'training', 'reporting', 'meetings', 'escalation', 'publicity', 'severance'

$w = New-Object -ComObject Word.Application
try {
  $w.Visible = $false; $w.DisplayAlerts = 0
  "Word $($w.Version) build $($w.Build)"
  $w.Options.CheckSpellingAsYouType = $false; $w.Options.CheckGrammarAsYouType = $false
  function Step([string]$m) { "$((Get-Date).ToString('HH:mm:ss')) $m" }
  $d = $w.Documents.Add()
  Step 'document added'
  # One assignment, never TypeText: typing runs AutoCorrect and AutoFormat as
  # you type, which can rewrite what was typed and is slow over COM.
  $paras = @(
    'Service Agreement',
    'This agreement is made between the supplier and the customer named below.',
    'The supplier shall deliver the goods within thirty days of the order. Late delivery incurs a penalty of two percent per week.',
    'The colour of the packaging is blue.'
  )
  for ($i = 0; $i -lt $topics.Count; $i++) {
    $t = $topics[$i]
    $paras += "Clause $($i + 1). The parties agree that this clause governs $t and that any question about $t is settled under the laws named in the schedule to this agreement."
  }
  $paras += "Clause $($topics.Count + 1). This agreement ends on the last day of December."
  $d.Content.Text = ($paras -join "`r")
  Step "text set, $($d.Paragraphs.Count) paragraphs"

  $d.Content.Font.Name = 'Liberation Sans'
  $d.Content.Font.Size = 11
  $d.Content.ParagraphFormat.SpaceAfter = 6
  $h = $d.Paragraphs.Item(1).Range
  $h.Font.Bold = 1; $h.Font.Size = 18

  $rev1 = [string](Join-Path $OutDir 'word2010-rev1.pdf')
  Step 'formatted; exporting rev1'
  $d.SaveAs2([ref]$rev1, [ref]17)             # wdFormatPDF
  Step 'rev1 exported'
  "pages in rev1: $($d.ComputeStatistics(2))"  # wdStatisticPages

  # --- the edits, in document order; test/compare-real.test.ts expects exactly these ---
  $d.Paragraphs.Item(1).Range.Font.Color = 255                                   # E1 heading red (appearance only)
  function Replace-Once([string]$find, [string]$with) {
    $r = $d.Content
    # Execute(FindText, MatchCase, MatchWholeWord, MatchWildcards, MatchSoundsLike,
    #         MatchAllWordForms, Forward, Wrap, Format, ReplaceWith, Replace=1 wdReplaceOne)
    $ok = $r.Find.Execute($find, $true, $false, $false, $false, $false, $true, 0, $false, $with, 1)
    if (-not $ok) { throw "not found: $find" }
  }
  Replace-Once 'thirty days' 'sixty days'                                         # E2
  Replace-Once ' Late delivery incurs a penalty of two percent per week.' ''      # E3
  $d.Paragraphs.Item(3).Range.InsertParagraphAfter()                              # E4
  # Long enough (about five lines) to push the end of page 1 onto page 2, so
  # document mode and pages mode genuinely disagree about the clauses it moves.
  $d.Paragraphs.Item(4).Range.InsertBefore('All prices exclude value added tax, which the customer pays at the rate in force on the date of the invoice. Payment is due within fourteen days of that date. Interest on late payment accrues daily at the base rate published by the central bank plus four percent, from the day after the due date until the day the payment is received in full, and the supplier may suspend deliveries while any invoice remains unpaid.')
  Replace-Once 'The colour of' 'The color of'                                     # E5
  Replace-Once 'last day of December.' 'last day of November.'                    # E6

  $rev2 = [string](Join-Path $OutDir 'word2010-rev2.pdf')
  Step 'edited; exporting rev2'
  $d.SaveAs2([ref]$rev2, [ref]17)
  Step 'rev2 exported'
  "pages in rev2: $($d.ComputeStatistics(2))"
  $d.Close([ref]0)
} finally {
  $w.Quit(); [Runtime.InteropServices.Marshal]::ReleaseComObject($w) | Out-Null
  foreach ($f in $fonts) { [Gdi]::RemoveFontResource($f) | Out-Null }
}

foreach ($p in $rev1, $rev2) {
  $text = [System.Text.Encoding]::GetEncoding(28591).GetString([System.IO.File]::ReadAllBytes($p))
  $names = [regex]::Matches($text, '/BaseFont\s*/([^\s/<>\[\]]+)') | ForEach-Object { $_.Groups[1].Value } | Sort-Object -Unique
  "$(Split-Path $p -Leaf): fonts $($names -join ', ')"
  foreach ($n in $names) { if (([regex]::Replace($n, '#([0-9A-Fa-f]{2})', { [char][Convert]::ToInt32($args[0].Groups[1].Value, 16) })) -notmatch '^[A-Z]{6}\+Liberation ?Sans(,Bold)?$') { Remove-Item $p; throw "$p embeds $n, which is not Liberation Sans" } }
  "SHA-256 $((Get-FileHash $p -Algorithm SHA256).Hash)"
}
