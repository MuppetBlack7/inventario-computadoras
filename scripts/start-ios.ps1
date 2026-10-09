$ErrorActionPreference = 'Stop'
$projectPath = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectPath

if (-not (Test-Path -LiteralPath (Join-Path $projectPath 'dist\index.html'))) {
  Write-Host 'Creando la versión de producción...'
  & npm.cmd run build
  if ($LASTEXITCODE -ne 0) { throw 'No fue posible compilar la aplicación.' }
}

$cloudflared = Get-Command cloudflared.exe -ErrorAction SilentlyContinue
if (-not $cloudflared) {
  $standardPath = Join-Path ${env:ProgramFiles(x86)} 'cloudflared\cloudflared.exe'
  if (Test-Path -LiteralPath $standardPath) {
    $cloudflaredPath = $standardPath
  } else {
    Write-Host 'Falta cloudflared. Instálalo una vez con:' -ForegroundColor Yellow
    Write-Host 'winget install -e --id Cloudflare.cloudflared'
    throw 'No se puede crear la dirección HTTPS sin cloudflared.'
  }
} else {
  $cloudflaredPath = $cloudflared.Source
}

$preview = Start-Process -FilePath 'npm.cmd' -ArgumentList @('run', 'preview') -WorkingDirectory $projectPath -PassThru -WindowStyle Hidden
try {
  $ready = $false
  for ($attempt = 0; $attempt -lt 30; $attempt++) {
    try {
      $response = Invoke-WebRequest -Uri 'http://127.0.0.1:4173' -UseBasicParsing -TimeoutSec 2
      if ($response.StatusCode -eq 200) { $ready = $true; break }
    } catch { Start-Sleep -Milliseconds 500 }
  }
  if (-not $ready) { throw 'La vista previa no respondió en el puerto 4173.' }
  Write-Host ''
  Write-Host 'La aplicación local está lista. Cloudflare mostrará una URL https://...trycloudflare.com' -ForegroundColor Green
  Write-Host 'Ábrela en Safari del iPhone/iPad. Mantén esta ventana abierta; Ctrl+C detiene el acceso.'
  Write-Host ''
  & $cloudflaredPath tunnel --url 'http://127.0.0.1:4173'
} finally {
  if ($preview -and -not $preview.HasExited) { Stop-Process -Id $preview.Id -Force }
}
