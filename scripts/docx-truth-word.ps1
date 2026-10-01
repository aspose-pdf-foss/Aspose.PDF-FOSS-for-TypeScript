# m2fp.4: Microsoft Word's reading of any .docx, as the DocxTruth JSON of
# test/helpers/docx-truth.ts, written beside it as <name>.word.json. Word opens
# each file read-only; tracked changes are COUNTED and then accepted (in memory
# only) so the paragraphs are the final text, as readDocx shows it. NOT run by
# npm test.
# Paths come positionally: `powershell -File` splits an array into separate arguments.
param([Parameter(Mandatory = $true, ValueFromRemainingArguments = $true)][string[]]$Docx)
$ErrorActionPreference = 'Stop'

# Field marks, anchors of notes and comments, page breaks and cell marks are not
# text; a manual line break (\v) is a newline.
function Clean([string]$s) {
  if ($null -eq $s) { return '' }
  $s = $s -replace "`v", "`n"
  return ($s -replace '[\x00-\x08\x0B\x0C\x0E-\x1F]', '')
}
$UNDEF = 9999999
# A range's text without its inline pictures: Word's Range.Text writes each one
# as a character ('/' for a DrawingML picture) that is not text.
function TextOf($rg) {
  $t = [string]$rg.Text
  $n = $rg.InlineShapes.Count
  if ($n -gt 0) {
    $idx = @(); for ($i = 1; $i -le $n; $i++) { $idx += ($rg.InlineShapes.Item($i).Range.Start - $rg.Start) }
    foreach ($k in ($idx | Sort-Object -Descending)) { if ($k -ge 0 -and $k -lt $t.Length) { $t = $t.Remove($k, 1) } }
  }
  return $t
}
function SegmentOf($rg) {
  [ordered]@{ text = ''; bold = ($rg.Font.Bold -eq -1); italic = ($rg.Font.Italic -eq -1)
    sizePt = [double]$rg.Font.Size; font = [string]$rg.Font.Name }
}
function Add-Seg([System.Collections.ArrayList]$segs, $seg, [string]$t) {
  if ($t -eq '') { return }
  $last = if ($segs.Count) { $segs[$segs.Count - 1] } else { $null }
  if ($last -and $last.bold -eq $seg.bold -and $last.italic -eq $seg.italic -and $last.sizePt -eq $seg.sizePt -and $last.font -eq $seg.font) {
    $last.text += $t
  } else { $seg.text = $t; [void]$segs.Add($seg) }
}

$w = New-Object -ComObject Word.Application
try {
  $w.Visible = $false; $w.DisplayAlerts = 0
  $reader = "Word $($w.Build)"
  foreach ($path in $Docx) {
    $path = [IO.Path]::GetFullPath($path)
    $d = $w.Documents.Open($path, $false, $true)

    $hdr = 0; $ftr = 0
    for ($si = 1; $si -le $d.Sections.Count; $si++) {
      $sec = $d.Sections.Item($si)
      foreach ($k in 1, 2, 3) {
        $h = $sec.Headers.Item($k); $f = $sec.Footers.Item($k)
        if ($h.Exists -and -not ($si -gt 1 -and $h.LinkToPrevious) -and (Clean ($h.Range.Text -replace "`r", '')).Trim() -ne '') { $hdr++ }
        if ($f.Exists -and -not ($si -gt 1 -and $f.LinkToPrevious) -and (Clean ($f.Range.Text -replace "`r", '')).Trim() -ne '') { $ftr++ }
      }
    }
    $tb = 0
    for ($i = 1; $i -le $d.Shapes.Count; $i++) { try { if ($d.Shapes.Item($i).TextFrame.HasText) { $tb++ } } catch { } }
    $fields = 0
    for ($i = 1; $i -le $d.Fields.Count; $i++) { if ($d.Fields.Item($i).Type -ne 88) { $fields++ } }   # not wdFieldHyperlink
    $counts = [ordered]@{ headers = $hdr; footers = $ftr; footnotes = $d.Footnotes.Count; endnotes = $d.Endnotes.Count
      textBoxes = $tb; fields = $fields; comments = $d.Comments.Count; revisions = $d.Revisions.Count }
    if ($d.Revisions.Count -gt 0) { $d.Revisions.AcceptAll() }

    $paras = @()
    for ($pi = 1; $pi -le $d.Paragraphs.Count; $pi++) {
      $p = $d.Paragraphs.Item($pi)
      # A table row's end mark enumerates as an empty paragraph; it is not one.
      # wdAtEndOfRowMarker answers only for a COLLAPSED range at the mark.
      if ($d.Range($p.Range.Start, $p.Range.Start).Information(31)) { continue }
      $segs = New-Object System.Collections.ArrayList
      $ws = $p.Range.Words
      for ($wi = 1; $wi -le $ws.Count; $wi++) {
        $wd = $ws.Item($wi)
        if ($null -eq $wd -or $null -eq $wd.Text) { continue }
        $t = Clean ((TextOf $wd) -replace "`r", '')
        if ($t -eq '') { continue }
        if ($wd.Font.Bold -eq $UNDEF -or $wd.Font.Italic -eq $UNDEF -or $wd.Font.Size -eq $UNDEF -or $wd.Font.Name -eq '') {
          $chs = $wd.Characters
          for ($ci = 1; $ci -le $chs.Count; $ci++) {
            $c = $chs.Item($ci); Add-Seg $segs (SegmentOf $c) (Clean ((TextOf $c) -replace "`r", ''))
          }
        } else { Add-Seg $segs (SegmentOf $wd) $t }
      }
      $lvl = [int]$p.OutlineLevel
      $label = $null
      if ($p.Range.ListFormat.ListType -ne 0) { $label = [string]$p.Range.ListFormat.ListString }
      $paras += [ordered]@{
        text = Clean ((TextOf $p.Range) -replace "`r", '')
        styleName = [string]$p.Style.NameLocal
        heading = $(if ($lvl -ge 1 -and $lvl -le 9) { $lvl } else { $null })
        listLabel = $label
        inTable = [bool]$p.Range.Information(12)                  # wdWithInTable
        segments = @($segs.ToArray())
      }
    }

    $tables = @()
    for ($ti = 1; $ti -le $d.Tables.Count; $ti++) {
      $tbl = $d.Tables.Item($ti)
      $byRow = @{}
      $cells = $tbl.Range.Cells
      for ($ci = 1; $ci -le $cells.Count; $ci++) {
        $c = $cells.Item($ci)
        if ($c.NestingLevel -ne 1) { continue }
        # A cell's text is its NON-EMPTY paragraphs: nested row marks leave empty lines.
        $txt = ((Clean ((TextOf $c.Range) -replace "`r", "`n")) -split "`n" | Where-Object { $_ -ne '' }) -join "`n"
        if (-not $byRow.ContainsKey($c.RowIndex)) { $byRow[$c.RowIndex] = New-Object System.Collections.ArrayList }
        [void]$byRow[$c.RowIndex].Add($txt)
      }
      $rows = @()
      foreach ($k in ($byRow.Keys | Sort-Object)) { $rows += , @($byRow[$k].ToArray()) }
      $tables += [ordered]@{ rows = $rows }
    }

    $links = @()
    for ($i = 1; $i -le $d.Hyperlinks.Count; $i++) {
      $h = $d.Hyperlinks.Item($i)
      $text = Clean $h.TextToDisplay
      if ([string]$h.Address -ne '') { $links += [ordered]@{ text = $text; url = [string]$h.Address } }
      else { $links += [ordered]@{ text = $text; anchor = [string]$h.SubAddress } }
    }
    $images = 0
    for ($i = 1; $i -le $d.InlineShapes.Count; $i++) { if ($d.InlineShapes.Item($i).Type -eq 3) { $images++ } }   # wdInlineShapePicture

    $d.Close([ref]0)
    $out = [ordered]@{ reader = $reader; paragraphs = $paras; tables = $tables; links = $links; images = $images; counts = $counts }
    $json = [IO.Path]::ChangeExtension($path, $null).TrimEnd('.') + '.word.json'
    [IO.File]::WriteAllText($json, (ConvertTo-Json -InputObject $out -Depth 10), (New-Object Text.UTF8Encoding($false)))
    "wrote $json"
  }
} finally { $w.Quit(); [Runtime.InteropServices.Marshal]::ReleaseComObject($w) | Out-Null }
