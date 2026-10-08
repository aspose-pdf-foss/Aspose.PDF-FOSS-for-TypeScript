# m2fp.4: (re)builds the DOCX corpus and both readers' truth for every corpus
# file, then prints SHA-256s for PROVENANCE. NOT run by npm test.
#   -LoProgram  LibreOffice's program directory (soffice.exe, python.exe)
#   -SkipBuild  re-read only; keep the vendored .docx files
#   -Only       build one topic (e.g. notes); every file is still re-read
param([Parameter(Mandatory = $true)][string]$LoProgram, [switch]$SkipBuild, [string]$Only = '')
$ErrorActionPreference = 'Stop'
$root = Join-Path $PSScriptRoot '..'
$fx = [IO.Path]::GetFullPath((Join-Path $root 'test\fixtures\docx'))
$py = Join-Path $LoProgram 'python.exe'
Push-Location $PSScriptRoot
try {
  if (-not $SkipBuild) {
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'gen-docx-corpus-word.ps1') -OutDir $fx -Only $Only
    if ($LASTEXITCODE) { throw 'Word builder failed' }
    & $py (Join-Path $PSScriptRoot 'gen-docx-corpus-lo.py') $fx $Only
    if ($LASTEXITCODE) { throw 'LibreOffice builder failed' }
  }
  $files = @(Get-ChildItem $fx -Filter *.docx | Where-Object { $_.Name -notlike '*-oracle.docx' } | Sort-Object Name)
  & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'docx-truth-word.ps1') $files.FullName
  if ($LASTEXITCODE) { throw 'Word reader failed' }
  & $py (Join-Path $PSScriptRoot 'docx-truth-lo.py') $files.FullName
  if ($LASTEXITCODE) { throw 'LibreOffice reader failed' }
} finally { Pop-Location }
foreach ($f in $files) { "{0}  {1}" -f (Get-FileHash $f.FullName -Algorithm SHA256).Hash, $f.Name }
