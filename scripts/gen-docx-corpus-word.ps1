# m2fp.4: builds the five Word-written corpus documents through Microsoft Word
# COM. NOT run by npm test (needs Word; Word stamps docProps/core.xml, so a rerun
# is never byte-identical — the VENDORED files are the reference). The recipes
# mirror scripts/gen-docx-corpus-lo.py text for text; keep the two in step —
# except `notes` (v9j3.3.2): LibreOffice's footnote numbering is document-wide,
# so its file exercises format + start where this one restarts per section.
# -Only <topic> builds one document.
# Styles are addressed by WdBuiltinStyle number: this Word is localized (1049).
param([string]$OutDir = (Join-Path $PSScriptRoot '..\test\fixtures\docx'), [string]$Only = '')
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$OutDir = [IO.Path]::GetFullPath($OutDir)

$png = Join-Path $env:TEMP 'gen-docx-corpus-pic.png'
$bmp = New-Object System.Drawing.Bitmap 16, 16
for ($x = 0; $x -lt 16; $x++) { for ($y = 0; $y -lt 16; $y++) {
  $bmp.SetPixel($x, $y, [System.Drawing.Color]::FromArgb(255, $x * 16, $y * 16, 128)) } }
$bmp.Save($png, [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()

$w = New-Object -ComObject Word.Application
$w.Visible = $false; $w.DisplayAlerts = 0
"Word $($w.Version) build $($w.Build)"

function New-Doc { $script:d = $w.Documents.Add(); $script:sel = $w.Selection }
# `S -3` binds the STRING "-3" (a style name to Word), so a numeric id is cast.
function S([object]$id) { if ($id -is [string] -and $id -match '^-?\d+$') { $id = [int]$id }; $d.Styles.Item($id) }
# Collapse the selection to the end of the main story (before its final mark),
# which is safe after inserting a table, a footnote or a shape.
function Endpos { $e = $d.Content.End - 1; $d.Range($e, $e).Select() }   # Select(), not SetRange: a footnote leaves the selection in ITS story
function Save-Doc([string]$topic) {
  [string]$out = Join-Path $OutDir "word2010-$topic.docx"
  if (Test-Path $out) { Remove-Item $out }
  $d.SaveAs2([ref]$out, [ref]16); $d.Close([ref]0); "wrote $out"
}
# A paragraph in $style, typed PLAIN, then each run's formatting applied to its
# own range — so no formatting leaks through the insertion point.
# A run is a string or a hashtable: t, bold, italic, size, font, color ('red'), cstyle.
function P([object]$style, [object[]]$runs) {
  $sel.Range.ListFormat.RemoveNumbers()
  $sel.Style = $style
  $spans = @()
  foreach ($r in $runs) {
    if ($r -is [string]) { $r = @{ t = $r } }
    $s = $sel.Start; $sel.TypeText($r.t); $spans += ,@($s, $sel.Start, $r)
  }
  foreach ($sp in $spans) {
    $rg = $d.Range($sp[0], $sp[1]); $f = $sp[2]
    if ($f.cstyle) { $rg.Style = (S $f.cstyle) }
    if ($f.bold) { $rg.Font.Bold = 1 }
    if ($f.italic) { $rg.Font.Italic = 1 }
    if ($f.size) { $rg.Font.Size = $f.size }
    if ($f.font) { $rg.Font.Name = $f.font }
    if ($f.color -eq 'red') { $rg.Font.Color = 255 }   # wdColorRed
  }
  $sel.TypeParagraph()
}
# A list item: $tmpl applied at level $level, continuing the previous list or not.
# Applied to the PARAGRAPH's range once its text is typed. Word 2010 refuses
# ListLevelNumber > 1 through COM (0x800A1200) and ApplyListTemplateWithLevel
# ignores its level, so the level is reached by ListIndent().
function L([string]$t, [object]$tmpl, [int]$level, [bool]$cont) {
  $sel.Range.ListFormat.RemoveNumbers()
  $sel.Style = (S -1)
  $sel.TypeText($t)
  $pr = $sel.Paragraphs.Item(1).Range
  $pr.ListFormat.ApplyListTemplate($tmpl, $cont, 0)
  for ($i = 1; $i -lt $level; $i++) { $pr.ListFormat.ListIndent() }
  Endpos; $sel.TypeParagraph()
}
# An outline list template; $spec rows are @(NumberFormat, NumberStyle, Font or $null).
function New-Outline([object[]]$spec) {
  $lt = $d.ListTemplates.Add($true)
  for ($i = 0; $i -lt $spec.Count; $i++) {
    $lv = $lt.ListLevels.Item($i + 1)
    $lv.NumberFormat = $spec[$i][0]; $lv.NumberStyle = $spec[$i][1]; $lv.StartAt = 1
    if ($spec[$i][2]) { $lv.Font.Name = $spec[$i][2] }
    $lv.NumberPosition = 18 * $i; $lv.TextPosition = 18 * ($i + 1)
  }
  $lt
}

try {
  # ---- styles ----
  if (-not $Only -or $Only -eq 'styles') {
  New-Doc
  $ch = $d.Styles.Add('Custom Heading', 1); $ch.BaseStyle = (S -3).NameLocal
  $sc = $d.Styles.Add('Strong Custom', 2); $sc.Font.Bold = 1
  $bp = $d.Styles.Add('Bold Para', 1); $bp.BaseStyle = (S -1).NameLocal; $bp.Font.Bold = 1
  P (S -2) @('Styles and headings')
  P (S -3) @('Second level')
  P (S -4) @('Third level')
  P (S 'Custom Heading') @('Custom heading text')
  P (S -1) @('Plain body text.')
  P (S -1) @(@{ t = 'Direct '; bold = 1 }, @{ t = 'formats '; italic = 1 }, @{ t = 'sizes '; size = 16 },
    @{ t = 'fonts '; font = 'Courier New' }, @{ t = 'colours '; color = 'red' }, 'end.')
  P (S -1) @('A ', @{ t = 'strong '; cstyle = 'Strong Custom' }, 'word.')
  P (S 'Bold Para') @(@{ t = 'toggle '; cstyle = 'Strong Custom' }, 'rest.')
  Save-Doc 'styles'
  }

  # ---- lists ----
  if (-not $Only -or $Only -eq 'lists') {
  New-Doc
  # Word's own three default bullet glyphs; the bullet gallery's template is single-level.
  $bt = New-Outline @(@([string][char]0xF0B7, 23, 'Symbol'), @('o', 23, 'Courier New'), @([string][char]0xF0A7, 23, 'Wingdings'))
  $nt = New-Outline @(@('%1.', 0, $null), @('%2.', 4, $null), @('%3.', 2, $null))   # Arabic, lowercase letter, lowercase roman
  P (S -1) @('Bullets:')
  L 'Fruit' $bt 1 $false; L 'Apple' $bt 2 $true; L 'Green apple' $bt 3 $true; L 'Vegetables' $bt 1 $true
  P (S -1) @('Numbers:')
  L 'First' $nt 1 $false; L 'Sub a' $nt 2 $true; L 'Sub sub i' $nt 3 $true; L 'Second' $nt 1 $true
  P (S -1) @('An interruption.')
  L 'Third' $nt 1 $true
  P (S -1) @('A new list:')
  L 'Restart one' $nt 1 $false; L 'Restart two' $nt 1 $true
  P (S -1) @('End of lists.')
  Save-Doc 'lists'
  }

  # ---- tables ----
  if (-not $Only -or $Only -eq 'tables') {
  New-Doc
  P (S -1) @('Table:')
  $t = $d.Tables.Add($sel.Range, 4, 3); $t.Borders.Enable = $true
  $vals = @(@('Name', 'Qty', 'Note'), @('Wide cell', '', 'Shaded'), @('Tall', '', 'c3'), @('', 'b4', 'c4'))
  for ($r = 1; $r -le 4; $r++) { for ($c = 1; $c -le 3; $c++) { $t.Cell($r, $c).Range.Text = $vals[$r - 1][$c - 1] } }
  $t.Rows.Item(1).HeadingFormat = -1
  $t.Cell(2, 3).Shading.BackgroundPatternColor = 65535        # wdColorYellow
  $t.Cell(3, 1).Merge($t.Cell(4, 1))
  $t.Cell(2, 1).Merge($t.Cell(2, 2))
  # A COLLAPSED range: Tables.Add over a cell's whole range makes ONE row whatever
  # it is asked for, so the second row's text overwrote the first.
  $at = $t.Cell(3, 2).Range; $at.Collapse(1)
  $inner = $d.Tables.Add($at, 2, 1)
  $inner.Cell(1, 1).Range.Text = 'in1'; $inner.Cell(2, 1).Range.Text = 'in2'
  Endpos
  P (S -1) @('After the table.')
  Save-Doc 'tables'
  }

  # ---- media ----
  if (-not $Only -or $Only -eq 'media') {
  New-Doc
  $sel.Style = (S -1); $sel.TypeText('Picture: '); $sel.InlineShapes.AddPicture($png) | Out-Null; Endpos; $sel.TypeParagraph()
  $sel.TypeText('A link to ')
  $d.Hyperlinks.Add($sel.Range, 'https://example.com/docs', [Type]::Missing, [Type]::Missing, 'the example site') | Out-Null
  Endpos; $sel.TypeText('.'); $sel.TypeParagraph()
  $s = $sel.Start; $sel.TypeText('Target paragraph'); $d.Bookmarks.Add('target', $d.Range($s, $sel.Start)) | Out-Null; $sel.TypeParagraph()
  $sel.TypeText('Jump to ')
  $d.Hyperlinks.Add($sel.Range, '', 'target', [Type]::Missing, 'the target') | Out-Null
  Endpos; $sel.TypeText('.'); $sel.TypeParagraph()
  Save-Doc 'media'
  }

  # ---- skipped ----
  if (-not $Only -or $Only -eq 'skipped') {
  New-Doc
  $d.Sections.Item(1).Headers.Item(1).Range.Text = 'Running header'
  $d.Sections.Item(1).Footers.Item(1).Range.Text = 'Running footer'
  P (S -1) @('Contents:')
  $toc = $d.TablesOfContents.Add($sel.Range, $true, 1, 3); Endpos
  P (S -2) @('Chapter one')
  $sel.TypeText('Body with a footnote'); $d.Footnotes.Add($sel.Range).Range.Text = 'The footnote text.'; Endpos; $sel.TypeParagraph()
  $sel.TypeText('Body with an endnote'); $d.Endnotes.Add($sel.Range).Range.Text = 'The endnote text.'; Endpos; $sel.TypeParagraph()
  P (S -1) @('Anchor for a text box.')
  $anchor = $d.Paragraphs.Item($d.Paragraphs.Count - 1).Range
  $box = $d.Shapes.AddTextbox(1, 72, 72, 150, 30, $anchor); $box.TextFrame.TextRange.Text = 'Boxed words'; Endpos
  $s = $sel.Start; $sel.TypeText('Commented words'); $d.Comments.Add($d.Range($s, $sel.Start), 'A comment.') | Out-Null; Endpos; $sel.TypeParagraph()
  $base = $sel.Start; $sel.TypeText('Kept deleted words.')
  $d.TrackRevisions = $true
  $d.Range($base + 5, $base + 5).InsertAfter('inserted ')        # "Kept inserted deleted words."
  $d.Range($base + 14, $base + 22).Delete() | Out-Null            # deletes "deleted "
  $d.TrackRevisions = $false
  Endpos; $sel.TypeParagraph()
  $sel.InsertBreak(2)                                              # wdSectionBreakNextPage
  $d.Sections.Item(2).PageSetup.Orientation = 1                    # wdOrientLandscape
  P (S -2) @('Chapter two')
  P (S -1) @('Landscape page.')
  $toc.Update()
  Save-Doc 'skipped'
  }
  # ---- notes (v9j3.3.2) ----
  # The table's footnote is the LAST in section 1 on purpose: the renderer drops
  # a cell reference until v9j3.3.3, so a note after it would be numbered one
  # lower than Word numbers it.
  if (-not $Only -or $Only -eq 'notes') {
  New-Doc
  P (S -2) @('Notes')
  $sel.TypeText('Alpha'); $d.Footnotes.Add($sel.Range).Range.Text = 'First note.'; Endpos; $sel.TypeParagraph()
  $sel.TypeText('Beta'); $fn = $d.Footnotes.Add($sel.Range); $fn.Range.Text = 'Para one.'
  $fn.Range.InsertParagraphAfter(); $fn.Range.InsertAfter('Para two.'); Endpos; $sel.TypeParagraph()
  $sel.TypeText('Gamma'); $d.Footnotes.Add($sel.Range, '*').Range.Text = 'Starred note.'; Endpos; $sel.TypeParagraph()
  $sel.TypeText('Delta'); $d.Endnotes.Add($sel.Range).Range.Text = 'An endnote.'; Endpos; $sel.TypeParagraph()
  $t = $d.Tables.Add($sel.Range, 1, 2); $t.Borders.Enable = $true
  $t.Cell(1, 1).Range.Text = 'Cell'; $d.Footnotes.Add($t.Cell(1, 2).Range).Range.Text = 'Cell note.'
  Endpos; $sel.TypeParagraph()
  $sel.InsertBreak(2)                                              # wdSectionBreakNextPage
  $o = $d.Sections.Item(2).Range.FootnoteOptions
  $o.NumberStyle = 2; $o.NumberingRule = 1; $o.StartingNumber = 1  # lowercase roman, restart each section
  $sel.TypeText('Epsilon'); $d.Footnotes.Add($sel.Range).Range.Text = 'Second section note.'; Endpos; $sel.TypeParagraph()
  Save-Doc 'notes'
  }
} finally {
  $w.Quit(); [Runtime.InteropServices.Marshal]::ReleaseComObject($w) | Out-Null
  Remove-Item $png -ErrorAction SilentlyContinue
}
