# batch-bench.ps1 - ⏱ a batch of the editor's kind of work on THIS PC: N preview copies on the card (Par at once, as the
# editor runs them) and E exports on the CPU (2 at once), from a 20 s 4K HEVC 10-bit clip. Prints the wall time of each
# batch. Run the same batch on one PC (the old way) and split over several PCs at the same time (the farm) to compare.
param([int]$N = 12, [int]$Par = 3, [int]$E = 6, [int]$EPar = 2, [string]$FF = 'ffmpeg')
$tmp = Join-Path $env:TEMP "limelight-batch-$PID"; New-Item -ItemType Directory -Force $tmp | Out-Null
$src = Join-Path $tmp 'src.mp4'
& $FF -hide_banner -loglevel error -y -f lavfi -i testsrc2=s=3840x2160:r=30:d=20 -f lavfi -i sine=d=20 -pix_fmt p010le -c:v hevc_nvenc -b:v 80M -c:a aac $src
function Batch($count, $par, [scriptblock]$argsOf) {
  $sw = [Diagnostics.Stopwatch]::StartNew(); $run = @()
  for ($i = 0; $i -lt $count; $i++) {
    while (@($run | Where-Object { -not $_.HasExited }).Count -ge $par) { Start-Sleep -Milliseconds 100 }
    $run += Start-Process -FilePath $FF -ArgumentList (& $argsOf $i) -NoNewWindow -PassThru
  }
  $run | ForEach-Object { $_.WaitForExit() }
  return $sw.Elapsed.TotalSeconds
}
$p = Batch $N $Par { param($i) @('-hide_banner', '-loglevel', 'error', '-y', '-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda', '-i', $src, '-vf', 'scale_cuda=-2:720:format=yuv420p', '-c:v', 'h264_nvenc', '-preset', 'p4', '-an', (Join-Path $tmp "p$i.mp4")) }
$x = Batch $E $EPar { param($i) @('-hide_banner', '-loglevel', 'error', '-y', '-i', $src, '-vf', 'scale=-2:1080,format=yuv420p', '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-c:a', 'aac', (Join-Path $tmp "e$i.mp4")) }
"{0}: {1} preview copies in {2:N1} s | {3} exports in {4:N1} s" -f $env:COMPUTERNAME, $N, $p, $E, $x
Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
