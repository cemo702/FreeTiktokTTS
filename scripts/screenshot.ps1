Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$root = "C:\Users\NVME\Desktop\Neo Scavenger\tiktok-yorum-ses"
$shot = Join-Path $root ".cache\screen.png"
$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
$gfx = [System.Drawing.Graphics]::FromImage($bmp)
$gfx.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
$bmp.Save($shot, [System.Drawing.Imaging.ImageFormat]::Png)
$gfx.Dispose(); $bmp.Dispose()
"captured: $shot ($($bounds.Width)x$($bounds.Height))"