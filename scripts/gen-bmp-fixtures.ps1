# Write test/fixtures/bmp/*.bmp with GDI+ (System.Drawing), the imaging stack
# Windows itself uses -- and the closest thing BMP has to a reference producer,
# since the format is Microsoft's own. Invoked by scripts/gen-bmp-fixtures.mjs;
# see that file's header for why the fixtures exist at all.
#
# Windows-only by necessity. GDI+ is the only BMP writer available here, and no
# npm package writes the sub-8-bit, BI_BITFIELDS or partial-palette shapes this
# is for. That is recorded in test/fixtures/bmp/PROVENANCE.md rather than worked
# around: a fixture we encoded ourselves could not catch the bug class these
# exist for.

param([Parameter(Mandatory = $true)][string]$Out)

Add-Type -AssemblyName System.Drawing
if (-not (Test-Path $Out)) { New-Item -ItemType Directory $Out | Out-Null }

$W = 20; $H = 12

# The source. Ours by design -- only the BYTES need to be third-party, so
# choosing the picture is free and choosing it well makes assertions tight.
#
# Asymmetric against the three traps test/bmp.test.ts already names: not square
# (a transposition would show), no two rows alike (a row flip would show), no
# two channels alike (a BGR swap would show).
#
# And every value is MID-RANGE, 40..214, which the first draft of this script
# got wrong: a near-black or near-white pixel quantizes to the same index in
# every reduced format, so an assertion on it passes whatever the code does.
# Staying clear of both ends keeps the 1-, 4-, 8- and 16-bit files informative.
$bmp = New-Object System.Drawing.Bitmap($W, $H, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
for ($y = 0; $y -lt $H; $y++) {
  for ($x = 0; $x -lt $W; $x++) {
    $r = 40 + $x * 8
    $g = 60 + $y * 14
    $b = 80 + (($x * 7 + $y * 13) % 100)
    $bmp.SetPixel($x, $y, [System.Drawing.Color]::FromArgb(255, $r, $g, $b))
  }
}

# The raw source, for the cases that can assert against it exactly.
$raw = New-Object byte[] ($W * $H * 3)
for ($y = 0; $y -lt $H; $y++) {
  for ($x = 0; $x -lt $W; $x++) {
    $c = $bmp.GetPixel($x, $y)
    $i = ($y * $W + $x) * 3
    $raw[$i] = $c.R; $raw[$i + 1] = $c.G; $raw[$i + 2] = $c.B
  }
}
[System.IO.File]::WriteAllBytes((Join-Path $Out 'source-rgb.raw'), $raw)

# name -> PixelFormat. What each yields is asserted in test/bmp-real.test.ts and
# tabulated in PROVENANCE.md; GDI+ picks the header and compression itself.
$cases = [ordered]@{
  'gdi-1bpp-indexed'  = 'Format1bppIndexed'
  'gdi-4bpp-indexed'  = 'Format4bppIndexed'
  'gdi-8bpp-indexed'  = 'Format8bppIndexed'
  'gdi-16bpp-555'     = 'Format16bppRgb555'
  'gdi-16bpp-565'     = 'Format16bppRgb565'
  'gdi-24bpp'         = 'Format24bppRgb'
  'gdi-32bpp'         = 'Format32bppArgb'
}

$COMPRESSION = @{ 0 = 'BI_RGB'; 1 = 'BI_RLE8'; 2 = 'BI_RLE4'; 3 = 'BI_BITFIELDS'; 4 = 'BI_JPEG'; 5 = 'BI_PNG' }

foreach ($name in $cases.Keys) {
  $pf = [System.Drawing.Imaging.PixelFormat]::($cases[$name])
  $conv = $bmp.Clone([System.Drawing.Rectangle]::new(0, 0, $W, $H), $pf)
  $path = Join-Path $Out "$name.bmp"
  $conv.Save($path, [System.Drawing.Imaging.ImageFormat]::Bmp)
  $conv.Dispose()

  $b = [System.IO.File]::ReadAllBytes($path)
  $dib = [BitConverter]::ToUInt32($b, 14)
  $bpp = [BitConverter]::ToUInt16($b, 28)
  $comp = [BitConverter]::ToUInt32($b, 30)
  $clr = [BitConverter]::ToUInt32($b, 46)
  $masks = ''
  if ($comp -eq 3) {
    $masks = (' masks {0:x8}/{1:x8}/{2:x8}' -f `
      [BitConverter]::ToUInt32($b, 54), [BitConverter]::ToUInt32($b, 58), [BitConverter]::ToUInt32($b, 62))
  }
  '{0,-18} dib={1} bpp={2,2} {3,-13} palette={4,3} {5,5}B{6}' -f `
    $name, $dib, $bpp, $COMPRESSION[[int]$comp], $clr, $b.Length, $masks
}
$bmp.Dispose()
