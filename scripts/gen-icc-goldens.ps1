# Drive Windows Color System (mscms.dll) to transform sRGB to a destination
# profile's CMYK, for `scripts/gen-icc-fixture.mjs`.
#
# Reads "r,g,b" triples on stdin, one per line. Writes "r,g,b,c,m,y,k" with
# every value a RAW INTEGER: c/m/y/k are 0..65535 straight out of the API.
# Raw on purpose -- this machine's locale formats decimals with a comma, so
# emitting floats here would put "0,5000" into the goldens.
param([Parameter(Mandatory = $true)][string]$Profile)

$ErrorActionPreference = 'Stop'
$src = 'C:\Windows\System32\spool\drivers\color\sRGB Color Space Profile.icm'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class WcsGen {
    [StructLayout(LayoutKind.Sequential)]
    public struct PROFILE { public uint dwType; public IntPtr pProfileData; public uint cbDataSize; }
    [DllImport("mscms.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern IntPtr OpenColorProfileW(ref PROFILE p, uint a, uint s, uint c);
    [DllImport("mscms.dll", SetLastError = true)]
    public static extern IntPtr CreateMultiProfileTransform(IntPtr[] pr, uint n, uint[] it, uint ni, uint f, uint cmm);
    [DllImport("mscms.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool TranslateColors(IntPtr t, ushort[] i, uint n, int ci, ushort[] o, int co);
    [DllImport("mscms.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool IsColorProfileValid(IntPtr h, [MarshalAs(UnmanagedType.Bool)] ref bool valid);
    [DllImport("mscms.dll")] public static extern bool CloseColorProfile(IntPtr h);
    [DllImport("mscms.dll")] public static extern bool DeleteColorTransform(IntPtr h);

    public static IntPtr Open(string path) {
        IntPtr name = Marshal.StringToHGlobalUni(path);
        PROFILE p = new PROFILE();
        p.dwType = 1; p.pProfileData = name; p.cbDataSize = (uint)((path.Length + 1) * 2);
        IntPtr h = OpenColorProfileW(ref p, 1, 1, 3);
        Marshal.FreeHGlobal(name);
        if (h == IntPtr.Zero) throw new Exception("OpenColorProfile failed " + Marshal.GetLastWin32Error() + " : " + path);
        return h;
    }
    public static ushort[] ToCmyk(IntPtr t, int r, int g, int b) {
        ushort[] i = new ushort[4]; ushort[] o = new ushort[4];
        i[0] = (ushort)(r * 257); i[1] = (ushort)(g * 257); i[2] = (ushort)(b * 257);
        if (!TranslateColors(t, i, 1, 2, o, 7))
            throw new Exception("TranslateColors failed " + Marshal.GetLastWin32Error());
        return o;
    }
}
'@

$hDst = [WcsGen]::Open($Profile)
$valid = $false
[void][WcsGen]::IsColorProfileValid($hDst, [ref]$valid)
if (-not $valid) { throw "WCS rejects the profile as invalid: $Profile" }

$hSrc = [WcsGen]::Open($src)
$hT = [WcsGen]::CreateMultiProfileTransform([IntPtr[]]@($hSrc, $hDst), 2, [uint32[]]@(0, 0), 2, 3, 0)
if ($hT -eq [IntPtr]::Zero) {
  throw "CreateMultiProfileTransform failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())"
}

foreach ($line in [Console]::In.ReadToEnd() -split "`n") {
  $t = $line.Trim()
  if ($t -eq '') { continue }
  $p = $t -split ','
  $r = [int]$p[0]; $g = [int]$p[1]; $b = [int]$p[2]
  $o = [WcsGen]::ToCmyk($hT, $r, $g, $b)
  [Console]::Out.WriteLine("$r,$g,$b,$($o[0]),$($o[1]),$($o[2]),$($o[3])")
}

[void][WcsGen]::DeleteColorTransform($hT)
[void][WcsGen]::CloseColorProfile($hSrc)
[void][WcsGen]::CloseColorProfile($hDst)
