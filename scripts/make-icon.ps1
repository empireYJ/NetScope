$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Drawing
$appRoot=Split-Path -Parent $PSScriptRoot
$bitmap=New-Object Drawing.Bitmap 64,64
$g=[Drawing.Graphics]::FromImage($bitmap)
$g.SmoothingMode=[Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.Clear([Drawing.Color]::FromArgb(9,15,11))
$pen=New-Object Drawing.Pen ([Drawing.Color]::FromArgb(177,248,106)),5
$points=[Drawing.Point[]]@([Drawing.Point]::new(14,45),[Drawing.Point]::new(14,19),[Drawing.Point]::new(32,45),[Drawing.Point]::new(32,19))
$g.DrawLines($pen,$points)
$g.DrawLines($pen,[Drawing.Point[]]@([Drawing.Point]::new(40,45),[Drawing.Point]::new(40,19),[Drawing.Point]::new(53,19)))
$g.DrawLines($pen,[Drawing.Point[]]@([Drawing.Point]::new(9,54),[Drawing.Point]::new(43,54),[Drawing.Point]::new(56,41)))
$icon=[Drawing.Icon]::FromHandle($bitmap.GetHicon())
$file=[IO.File]::Create((Join-Path $appRoot 'public\app.ico'))
$icon.Save($file)
$file.Dispose();$icon.Dispose();$pen.Dispose();$g.Dispose();$bitmap.Dispose()
