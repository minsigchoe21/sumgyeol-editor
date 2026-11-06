# 숨결 편집기 자동 업데이트: GitHub(minsigchoe21/sumgyeol-editor) main의 VERSION이 다르면 최신판을 받아 덮어써요.
# projects\ 와 키 파일은 건드리지 않아요. 인터넷이 안 되면 그냥 넘어가요.
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$repo = 'minsigchoe21/sumgyeol-editor'
try {
  $local = if (Test-Path "$here\VERSION") { (Get-Content "$here\VERSION" -Raw).Trim() } else { '' }
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  $sha = (Invoke-RestMethod "https://api.github.com/repos/$repo/commits/main" -Headers @{'User-Agent'='sumgyeol-editor'} -TimeoutSec 8).sha
  $remote = (Invoke-WebRequest "https://raw.githubusercontent.com/$repo/$sha/VERSION" -UseBasicParsing -TimeoutSec 8).Content.Trim()
  if ($remote -eq $local) { Write-Host "[업데이트] 최신판이에요 ($local)"; exit 0 }
  Write-Host "[업데이트] 새 버전 $remote 받는 중... (지금 $local)"
  $tmp = Join-Path $env:TEMP ('sumgyeol_upd_' + [guid]::NewGuid())
  New-Item -ItemType Directory -Path $tmp | Out-Null
  Invoke-WebRequest "https://codeload.github.com/$repo/zip/$sha" -OutFile "$tmp\u.zip" -UseBasicParsing -TimeoutSec 60
  Expand-Archive "$tmp\u.zip" -DestinationPath $tmp -Force
  $src = Get-ChildItem $tmp -Directory | Select-Object -First 1
  Get-ChildItem $src.FullName -Recurse -File | ForEach-Object {
    $rel = $_.FullName.Substring($src.FullName.Length + 1)
    if ($rel -like 'projects*' -or $rel -like 'inbox*') { return }
    $dst = Join-Path $here $rel
    if ($rel -eq 'START.bat') { $dst = Join-Path $here 'START.new.bat' }   # 실행 중인 START.bat은 덮어쓰지 않음
    New-Item -ItemType Directory -Force -Path (Split-Path $dst) | Out-Null
    Copy-Item $_.FullName $dst -Force
  }
  Remove-Item $tmp -Recurse -Force
  if (Test-Path "$here\START.new.bat") {
    if ((Get-FileHash "$here\START.new.bat").Hash -eq (Get-FileHash "$here\START.bat").Hash) { Remove-Item "$here\START.new.bat" }
    else { Write-Host "[업데이트] START.bat이 바뀌었어요. 편집기를 끈 뒤 START.new.bat 이름을 START.bat으로 바꿔 주세요." }
  }
  Write-Host "[업데이트] 끝 → $remote"
} catch {
  Write-Host "[업데이트] 건너뜀(인터넷 또는 GitHub 문제): $($_.Exception.Message)"
}
