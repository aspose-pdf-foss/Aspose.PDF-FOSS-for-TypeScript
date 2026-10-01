# Writes test/fixtures/docx/word2010-basic.docx through Microsoft Word COM
# automation (m2fp.2). NOT run by npm test: it needs Word, and Word stamps
# docProps/core.xml with the save time, so a rerun is never byte-identical.
# The VENDORED file is the reference; see test/fixtures/docx/PROVENANCE.md.
#
# Styles are addressed by WdBuiltinStyle number, never by name: the installed
# Word is localized (Office14\1049) and style NAMES are translated.
param([string]$Out = (Join-Path $PSScriptRoot '..\test\fixtures\docx\word2010-basic.docx'))
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$png = Join-Path $env:TEMP 'gen-docx-word-pic.png'
$bmp = New-Object System.Drawing.Bitmap 16, 16
for ($x = 0; $x -lt 16; $x++) { for ($y = 0; $y -lt 16; $y++) {
  $bmp.SetPixel($x, $y, [System.Drawing.Color]::FromArgb(255, $x * 16, $y * 16, 128)) } }
$bmp.Save($png, [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()

$Out = [System.IO.Path]::GetFullPath($Out)
New-Item -ItemType Directory -Force (Split-Path $Out) | Out-Null
if (Test-Path $Out) { Remove-Item $Out }

$w = New-Object -ComObject Word.Application
try {
  $w.Visible = $false; $w.DisplayAlerts = 0
  "Word $($w.Version) build $($w.Build)"
  $d = $w.Documents.Add()
  $sel = $w.Selection
  $sel.Style = $d.Styles.Item(-2)          # wdStyleHeading1
  $sel.TypeText('Quarterly Report'); $sel.TypeParagraph()
  $sel.Style = $d.Styles.Item(-1)          # wdStyleNormal
  $sel.TypeText('An opening paragraph.'); $sel.TypeParagraph()
  $sel.Range.ListFormat.ApplyNumberDefault()
  $sel.TypeText('First item'); $sel.TypeParagraph()
  $sel.TypeText('Second item'); $sel.TypeParagraph()
  $sel.Range.ListFormat.RemoveNumbers()
  $sel.InlineShapes.AddPicture($png) | Out-Null; $sel.TypeParagraph()
  $sel.TypeText('See ')
  $d.Hyperlinks.Add($sel.Range, 'https://example.com', [Type]::Missing, [Type]::Missing, 'the docs') | Out-Null
  $sel.EndKey(6) | Out-Null                # wdStory
  $sel.TypeText('.')
  $d.SaveAs2([ref]$Out, [ref]16)           # wdFormatDocumentDefault (.docx)
  $d.Close([ref]0)
} finally {
  $w.Quit(); [Runtime.InteropServices.Marshal]::ReleaseComObject($w) | Out-Null
}
Remove-Item $png
"SHA-256 $((Get-FileHash $Out -Algorithm SHA256).Hash)"
