# Renders tests/fixtures/demo-dm.png: a synthetic DM thread (client left, creator right).
# Windows only (System.Drawing). Run from app/: pwsh scripts/make-demo-dm.ps1
# Text must match DEMO_DM in tests/fixtures/texts.ts.
Add-Type -AssemblyName System.Drawing

$messages = @(
  @{ who = 'client';  text = 'Hi Imani! The Morning Pour shot has been doing great on our Instagram.' },
  @{ who = 'creator'; text = 'So glad to hear it! What are you planning next?' },
  @{ who = 'client';  text = "We're refreshing the spring menu next month. We'd also like to use it on our printed menus and in-store posters. Same US stores, nothing else changes. Can you send something over this week?" }
)

$canvasW = 720; $pad = 24; $maxBubble = 470
$font = New-Object System.Drawing.Font('Segoe UI', 15, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
$small = New-Object System.Drawing.Font('Segoe UI', 13, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$measureBmp = New-Object System.Drawing.Bitmap 1, 1
$m = [System.Drawing.Graphics]::FromImage($measureBmp)

$layout = @(); $y = 84
foreach ($msg in $messages) {
  $size = $m.MeasureString($msg.text, $font, $maxBubble - 28)
  $bw = [int][Math]::Ceiling($size.Width) + 28; $bh = [int][Math]::Ceiling($size.Height) + 22
  $x = if ($msg.who -eq 'client') { $pad } else { $canvasW - $pad - $bw }
  $layout += @{ msg = $msg; x = $x; y = $y; w = $bw; h = $bh }
  $y += $bh + 18
}
$canvasH = $y + 16

$bmp = New-Object System.Drawing.Bitmap $canvasW, $canvasH
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = 'AntiAlias'; $g.TextRenderingHint = 'ClearTypeGridFit'
$g.Clear([System.Drawing.Color]::White)

# Header: the client's name, like a DM app.
$g.FillRectangle((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(246, 246, 248))), 0, 0, $canvasW, 64)
$g.DrawString('northwind.coffee', $small, [System.Drawing.Brushes]::Black, $pad, 22)

foreach ($b in $layout) {
  $client = $b.msg.who -eq 'client'
  $fill = if ($client) { [System.Drawing.Color]::FromArgb(236, 236, 240) } else { [System.Drawing.Color]::FromArgb(56, 112, 240) }
  $ink = if ($client) { [System.Drawing.Brushes]::Black } else { [System.Drawing.Brushes]::White }
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $r = 18; $x = $b.x; $yy = $b.y; $w = $b.w; $h = $b.h
  $path.AddArc($x, $yy, $r, $r, 180, 90); $path.AddArc($x + $w - $r, $yy, $r, $r, 270, 90)
  $path.AddArc($x + $w - $r, $yy + $h - $r, $r, $r, 0, 90); $path.AddArc($x, $yy + $h - $r, $r, $r, 90, 90)
  $path.CloseFigure()
  $g.FillPath((New-Object System.Drawing.SolidBrush $fill), $path)
  $rect = New-Object System.Drawing.RectangleF ($x + 14), ($yy + 11), ($w - 28), ($h - 22)
  $g.DrawString($b.msg.text, $font, $ink, $rect)
}

$out = Join-Path $PSScriptRoot '..\tests\fixtures\demo-dm.png'
$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose(); $m.Dispose(); $measureBmp.Dispose()
Write-Output "wrote $out ($canvasW x $canvasH)"
