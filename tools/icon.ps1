param([string]$OutDir, [string]$UiDir)
Add-Type -AssemblyName System.Drawing

function P([float]$x, [float]$y) { New-Object System.Drawing.PointF $x, $y }
function C([int]$a, [int]$r, [int]$g, [int]$b) { [System.Drawing.Color]::FromArgb($a, $r, $g, $b) }

function Draw([int]$S) {
  $bmp = New-Object System.Drawing.Bitmap $S, $S
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'; $g.InterpolationMode = 'HighQualityBicubic'
  $k = $S / 512.0

  # rounded dark tile
  $r = 112 * $k; $tile = New-Object System.Drawing.Drawing2D.GraphicsPath
  $tile.AddArc(0, 0, $r, $r, 180, 90); $tile.AddArc($S - $r, 0, $r, $r, 270, 90)
  $tile.AddArc($S - $r, $S - $r, $r, $r, 0, 90); $tile.AddArc(0, $S - $r, $r, $r, 90, 90); $tile.CloseFigure()
  $bg = New-Object System.Drawing.Drawing2D.LinearGradientBrush((P 0 0), (P $S $S), (C 255 46 26 92), (C 255 10 22 40))
  $g.FillPath($bg, $tile)
  $g.SetClip($tile)

  # incoming white beam (left -> prism face)
  $beam = New-Object System.Drawing.Drawing2D.GraphicsPath
  $beam.AddPolygon(@((P (0) (300*$k)), (P (205*$k) (262*$k)), (P (205*$k) (276*$k)), (P (0) (322*$k))))
  $bb = New-Object System.Drawing.Drawing2D.LinearGradientBrush((P 0 0), (P (205*$k) 0), (C 0 255 255 255), (C 235 255 255 255))
  $g.FillPath($bb, $beam)

  # rainbow fan (prism face -> right edge)
  $cols = @((C 235 45 230 200), (C 235 70 170 255), (C 235 140 110 255), (C 235 230 100 220))
  $ox = 300*$k; $oy = 268*$k; $top = 200*$k; $step = 52*$k
  for ($i = 0; $i -lt $cols.Count; $i++) {
    $y0 = $top + $i * $step; $y1 = $y0 + $step + 1
    $band = New-Object System.Drawing.Drawing2D.GraphicsPath
    $band.AddPolygon(@((P $ox ($oy - 4*$k + $i*1.6*$k)), (P $S $y0), (P $S $y1), (P $ox ($oy - 2*$k + ($i+1)*1.6*$k))))
    $fb = New-Object System.Drawing.Drawing2D.LinearGradientBrush((P $ox 0), (P $S 0), (C 40 255 255 255), $cols[$i])
    $g.FillPath($fb, $band)
  }

  # glass triangle
  $tri = @((P (256*$k) (96*$k)), (P (416*$k) (392*$k)), (P (96*$k) (392*$k)))
  $glass = New-Object System.Drawing.Drawing2D.LinearGradientBrush((P (40*$k) (40*$k)), (P (472*$k) (448*$k)), (C 200 190 235 255), (C 90 120 90 230))
  $soft = New-Object System.Drawing.Pen($glass, [float](34*$k)); $soft.LineJoin = 'Round'
  $g.DrawPolygon($soft, $tri); $g.FillPolygon($glass, $tri)
  # inner highlight facet
  $facet = @((P (256*$k) (96*$k)), (P (300*$k) (392*$k)), (P (96*$k) (392*$k)))
  $fb2 = New-Object System.Drawing.Drawing2D.LinearGradientBrush((P (96*$k) (96*$k)), (P (300*$k) (392*$k)), (C 70 255 255 255), (C 0 255 255 255))
  $g.FillPolygon($fb2, $facet)
  $pen = New-Object System.Drawing.Pen((C 120 230 240 255), [float](4*$k)); $pen.LineJoin = 'Round'
  $g.DrawPolygon($pen, $tri)

  $g.Dispose(); return $bmp
}

New-Item -ItemType Directory -Force $OutDir | Out-Null
$big = Draw 512; $big.Save("$OutDir\icon.png", [System.Drawing.Imaging.ImageFormat]::Png)
$big.Save("$UiDir\logo.png", [System.Drawing.Imaging.ImageFormat]::Png)

# multi-size .ico with PNG-compressed entries
$sizes = 256, 64, 48, 32, 16
$pngs = foreach ($s in $sizes) { $m = New-Object IO.MemoryStream; (Draw $s).Save($m, [System.Drawing.Imaging.ImageFormat]::Png); ,$m.ToArray() }
$ms = New-Object IO.MemoryStream; $w = New-Object IO.BinaryWriter $ms
$w.Write([uint16]0); $w.Write([uint16]1); $w.Write([uint16]$sizes.Count)
$offset = 6 + 16 * $sizes.Count
for ($i = 0; $i -lt $sizes.Count; $i++) {
  $s = $sizes[$i]; $b = if ($s -ge 256) { 0 } else { $s }
  $w.Write([byte]$b); $w.Write([byte]$b); $w.Write([byte]0); $w.Write([byte]0)
  $w.Write([uint16]1); $w.Write([uint16]32); $w.Write([uint32]$pngs[$i].Length); $w.Write([uint32]$offset)
  $offset += $pngs[$i].Length
}
foreach ($p in $pngs) { $w.Write($p) }
[IO.File]::WriteAllBytes("$OutDir\icon.ico", $ms.ToArray())
"ok"
