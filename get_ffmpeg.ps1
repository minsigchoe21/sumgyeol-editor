# 숨결 편집기: ffmpeg를 이 PC의 %LOCALAPPDATA%\sumgyeol\bin 에 받아요(구글 드라이브에 넣지 않음)
$d = Join-Path $env:LOCALAPPDATA 'sumgyeol'
$b = Join-Path $d 'bin'
New-Item -ItemType Directory -Force -Path $b | Out-Null
$u = 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip'
$z = Join-Path $d 'ff.zip'; $t = Join-Path $d 'fftmp'
Invoke-WebRequest $u -OutFile $z
Expand-Archive $z -DestinationPath $t -Force
Get-ChildItem $t -Recurse -Include ffmpeg.exe, ffprobe.exe | Copy-Item -Destination $b
Remove-Item $z; Remove-Item $t -Recurse
Write-Host "ffmpeg 준비 끝: $b"
