# engine-check.ps1 - 🔬 does every engine of the editor work on this PC, and how fast? Run on a server / helper PC
# (from JASPREET: ssh limelight-a "powershell -File 'D:\Video Editor Agent\tools\server\engine-check.ps1'").
# Checks: programs; the NVIDIA encoder / decoder (4K test clips, frames per second, vs the CPU); Python's AI libraries and
# the card; Whisper - speed and accuracy on a sentence Windows reads aloud (word error rate); the disks (D: and the NAS);
# the running editor (version, health, jobs). Writes nothing but temp files (deleted at the end). -Quick: no Whisper.
param([switch]$Quick, [string]$App = 'D:\Video Editor Agent')
$ErrorActionPreference = 'Continue'
$tmp = Join-Path $env:TEMP "limelight-check-$PID"; New-Item -ItemType Directory -Force $tmp | Out-Null
$res = [ordered]@{}
function Ok($k, $v) { $res[$k] = $v; Write-Host ("  [OK] {0,-26} {1}" -f $k, $v) -ForegroundColor Green }
function Bad($k, $v) { $res[$k] = "FAIL: $v"; Write-Host ("  [!!] {0,-26} {1}" -f $k, $v) -ForegroundColor Yellow }
function Time([scriptblock]$b) { $s = [Diagnostics.Stopwatch]::StartNew(); & $b; $s.Stop(); return $s.Elapsed.TotalSeconds }
Write-Host "`n=== Limelight engine check on $env:COMPUTERNAME - $(Get-Date -Format 'yyyy-MM-dd HH:mm') ===`n" -ForegroundColor Cyan

Write-Host 'Programs' -ForegroundColor Cyan
foreach ($p in @(@('node', '--version'), @('ffmpeg', '-version'), @('ffprobe', '-version'), @('python', '--version'), @('nvidia-smi', '--query-gpu=name,driver_version,memory.total --format=csv,noheader'))) {
  $o = $null; try { $o = (& $p[0] ($p[1] -split ' ') 2>$null | Out-String).Trim() -split "`r?`n" | Select-Object -First 1 } catch {}
  if ($o) { Ok $p[0] ("$o" -replace 'Copyright.*', '').Trim() } else { Bad $p[0] 'not found' }
}

Write-Host "`nVideo (10 s of 4K test picture)" -ForegroundColor Cyan
$src = Join-Path $tmp 'src.mp4'
& ffmpeg -v error -y -f lavfi -i testsrc2=size=3840x2160:rate=25 -f lavfi -i sine=frequency=440 -t 10 -c:v libx264 -preset ultrafast -pix_fmt yuv420p -c:a aac $src 2>&1 | Out-Null
foreach ($e in @(@('h264_nvenc', 'NVENC H.264'), @('hevc_nvenc', 'NVENC HEVC'), @('libx264', 'CPU x264 (medium)'))) {
  $out = Join-Path $tmp "$($e[0]).mp4"
  $preset = if ($e[0] -eq 'libx264') { 'medium' } else { 'p5' }
  $s = Time { & ffmpeg -v error -y -i $src -c:v $e[0] -preset $preset -b:v 40M -an $out 2>&1 | Out-Null }
  if ($LASTEXITCODE -eq 0 -and (Test-Path $out)) { Ok $e[1] ("{0:N1} s  ({1:N0} fps, {2:N1}x real time)" -f $s, (250 / $s), (10 / $s)) } else { Bad $e[1] 'did not encode' }
}
$s = Time { & ffmpeg -v error -hwaccel cuda -i (Join-Path $tmp 'hevc_nvenc.mp4') -f null - 2>&1 | Out-Null }
if ($LASTEXITCODE -eq 0) { Ok 'NVDEC decode HEVC 4K' ("{0:N1} s  ({1:N0} fps)" -f $s, (250 / $s)) } else { Bad 'NVDEC decode HEVC 4K' 'failed' }
# a preview copy as the editor makes it on the card (scale_cuda), 4K -> 960 px
$s = Time { & ffmpeg -v error -y -hwaccel cuda -hwaccel_output_format cuda -i (Join-Path $tmp 'hevc_nvenc.mp4') -vf scale_cuda=960:-2 -c:v h264_nvenc -preset p4 -an (Join-Path $tmp 'proxy.mp4') 2>&1 | Out-Null }
if ($LASTEXITCODE -eq 0) { Ok 'Preview copy on the card' ("{0:N1} s for 10 s of 4K" -f $s) } else { Bad 'Preview copy on the card' 'failed' }

Write-Host "`nPython AI" -ForegroundColor Cyan
$py = @'
import importlib.util as u, json
r = {m: bool(u.find_spec(m)) for m in ('faster_whisper', 'ctranslate2', 'torch', 'torchvision', 'cv2', 'transformers', 'easyocr', 'demucs')}
try:
    import torch; r['cuda'] = torch.cuda.is_available(); r['gpu'] = torch.cuda.get_device_name(0) if r['cuda'] else ''
    if r['cuda']:
        import time; a = torch.randn(4096, 4096, device='cuda'); torch.cuda.synchronize(); t = time.time()
        for _ in range(50): a @ a
        torch.cuda.synchronize(); r['tflops'] = round(50 * 2 * 4096 ** 3 / (time.time() - t) / 1e12, 1)
except Exception as e: r['torch_error'] = str(e)[:120]
try:
    import ctranslate2; r['ct2_cuda'] = ctranslate2.get_cuda_device_count() > 0
except Exception: r['ct2_cuda'] = False
print(json.dumps(r))
'@
Set-Content -Path (Join-Path $tmp 'ai.py') -Value $py -Encoding ascii
$j = & python (Join-Path $tmp 'ai.py') 2>$null | Select-Object -Last 1 | ConvertFrom-Json
if ($j) {
  foreach ($m in 'faster_whisper', 'torch', 'cv2', 'transformers', 'easyocr', 'demucs') { if ($j.$m) { Ok "lib $m" 'installed' } else { Bad "lib $m" 'missing' } }
  if ($j.cuda) { Ok 'PyTorch on the card' "$($j.gpu) - $($j.tflops) TFLOPS (fp32 matmul)" } else { Bad 'PyTorch on the card' "no CUDA $($j.torch_error)" }
  if ($j.ct2_cuda) { Ok 'Whisper on the card' 'CTranslate2 sees CUDA' } else { Bad 'Whisper on the card' 'CTranslate2 has no CUDA - Whisper runs on the CPU (slow)' }
} else { Bad 'Python AI' 'python did not run' }

if (-not $Quick -and $j.faster_whisper) {
  Write-Host "`nWhisper speed + accuracy" -ForegroundColor Cyan
  $text = 'The quick brown fox jumps over the lazy dog. Limelight edits every reel on the new server with the graphics card. Please send the final video to the client by six in the evening.'
  Add-Type -AssemblyName System.Speech
  $wav = Join-Path $tmp 'say.wav'
  $sp = New-Object System.Speech.Synthesis.SpeechSynthesizer; $sp.Rate = 0; $sp.SetOutputToWaveFile($wav); $sp.Speak($text); $sp.Dispose()
  $srt = Join-Path $tmp 'say.srt'
  # (the editor's own copy - or, on a helper PC, the copy its helper keeps in step with the editor)
  $tp = @((Join-Path $App 'engine\transcribe.py'), "$env:LOCALAPPDATA\LimelightWorker\code\engine\transcribe.py") | Where-Object { Test-Path $_ } | Select-Object -First 1
  $s = Time { & python $tp $wav --lang en --out $srt 2>&1 | Out-Null }
  if (Test-Path $srt) {
    $got = ((Get-Content $srt) | Where-Object { $_ -and $_ -notmatch '^\d+$' -and $_ -notmatch '-->' }) -join ' '
    # (numbers as words: "6" and "six" are the same word)
    $nums = @{ '1' = 'one'; '2' = 'two'; '3' = 'three'; '4' = 'four'; '5' = 'five'; '6' = 'six'; '7' = 'seven'; '8' = 'eight'; '9' = 'nine'; '10' = 'ten' }
    $norm = { param($x) (($x.ToLower() -replace "[^a-z0-9' ]", ' ') -split '\s+') | Where-Object { $_ } | ForEach-Object { if ($nums[$_]) { $nums[$_] } else { $_ } } }
    $a = @(& $norm $text); $b = @(& $norm $got)
    # word error rate: edit distance between the words said and the words heard (one row at a time)
    $prev = 0..$b.Count
    for ($i = 1; $i -le $a.Count; $i++) {
      $row = @($i) + (1..[Math]::Max(1, $b.Count) | ForEach-Object { 0 })
      for ($k = 1; $k -le $b.Count; $k++) {
        $c = if ($a[$i - 1] -eq $b[$k - 1]) { 0 } else { 1 }
        $up = $prev[$k] + 1; $left = $row[$k - 1] + 1; $diag = $prev[$k - 1] + $c
        $row[$k] = [Math]::Min([Math]::Min($up, $left), $diag)
      }
      $prev = $row
    }
    $wer = [Math]::Round(100 * $prev[$b.Count] / $a.Count, 1)
    Ok 'Whisper (large-v3-turbo)' ("{0:N1} s incl. loading the model - accuracy {1}% (word error {2}%)" -f $s, (100 - $wer), $wer)
    $res['whisper_heard'] = $got
    Write-Host "       heard: $got" -ForegroundColor DarkGray
  } else { Bad 'Whisper (large-v3-turbo)' 'no subtitles came out' }
}

Write-Host "`nDisks" -ForegroundColor Cyan
foreach ($dir in @((Join-Path $App 'cache'), $(if (Test-Path 'Z:\') { 'Z:\Limelight Bench' } else { '\\192.168.0.99\Team Editing\Limelight Bench' }))) {
  # (over SSH there is no Z: - the NAS by its address then)
  try { New-Item -ItemType Directory -Force $dir -ErrorAction Stop | Out-Null } catch { Bad "disk $dir" 'not there'; continue }
  $f = Join-Path $dir "speed-$env:COMPUTERNAME-$PID.bin"; $buf = New-Object byte[] (64MB); (New-Object Random).NextBytes($buf)
  $w = Time { $fs = [IO.File]::Create($f, 1MB, [IO.FileOptions]::WriteThrough); for ($i = 0; $i -lt 16; $i++) { $fs.Write($buf, 0, $buf.Length) }; $fs.Close() }
  $r = Time { $fs = [IO.File]::OpenRead($f); while ($fs.Read($buf, 0, $buf.Length) -gt 0) {}; $fs.Close() }
  Remove-Item $f -Force
  Ok "disk $(if ($dir -like '\\*') { 'NAS' } else { Split-Path $dir -Qualifier })" ("write {0:N0} MB/s, read {1:N0} MB/s (1 GB)" -f (1024 / $w), (1024 / $r))
}

Write-Host "`nThe running editor" -ForegroundColor Cyan
try { $v = Invoke-RestMethod http://localhost:3000/api/version -TimeoutSec 5; Ok 'editor' "build $($v.build)" } catch { Bad 'editor' "not answering on port 3000" }
try { $h = Invoke-RestMethod http://localhost:3000/api/health -TimeoutSec 20; Ok 'editor health' ("ffmpeg {0}, NVENC {1}, Whisper {2}, CLIP search {3}" -f [bool]$h.ffmpeg, [bool]$h.nvenc, [bool]$h.whisper, [bool]$h.clip) } catch { Bad 'editor health' $_.Exception.Message }
try { $jb = @(Invoke-RestMethod http://localhost:3000/api/jobs -TimeoutSec 5 | Where-Object { $_ }); Ok 'jobs running' $jb.Count } catch {}
try { $f = Invoke-RestMethod http://localhost:3000/api/farm -TimeoutSec 5; Ok 'helper PCs' (($f.workers | ForEach-Object { "$($_.name) ($($_.busy)/$($_.slots), done $($_.done), failed $($_.failed))" }) -join '; ') } catch {}

Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
$bad = @($res.Values | Where-Object { "$_" -like 'FAIL*' }).Count
Write-Host ("`n{0}" -f $(if ($bad) { "$bad thing(s) need a look - see [!!] above" } else { 'Everything works.' })) -ForegroundColor $(if ($bad) { 'Yellow' } else { 'Green' })
$res | ConvertTo-Json -Compress | Set-Content -Path (Join-Path $env:TEMP 'limelight-engine-check.json') -Encoding UTF8
