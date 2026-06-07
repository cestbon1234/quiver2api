param(
  [int]$Port = 3000,
  [switch]$Restart
)

$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = Split-Path -Parent $scriptDir
$logDir = Join-Path $projectRoot 'logs'
$logPath = Join-Path $logDir 'server.log'
$errorLogPath = Join-Path $logDir 'server.err.log'

function Test-LocalPort {
  param([int]$PortToCheck)

  $client = $null
  try {
    $client = [System.Net.Sockets.TcpClient]::new()
    $connect = $client.BeginConnect('127.0.0.1', $PortToCheck, $null, $null)
    if (-not $connect.AsyncWaitHandle.WaitOne(350, $false)) {
      return $false
    }
    $client.EndConnect($connect)
    return $true
  } catch {
    return $false
  } finally {
    if ($client) {
      $client.Close()
    }
  }
}

function Get-LocalPortPids {
  param([int]$PortToCheck)

  try {
    return @(Get-NetTCPConnection -LocalPort $PortToCheck -State Listen -ErrorAction Stop |
      Select-Object -ExpandProperty OwningProcess -Unique |
      Where-Object { $_ -and $_ -gt 0 })
  } catch {
    $matches = netstat -ano | Select-String "LISTENING\s+(\d+)$" | Where-Object {
      $_.Line -match "[:.]$PortToCheck\s+"
    }
    return @($matches | ForEach-Object {
      if ($_.Line -match "LISTENING\s+(\d+)$") { [int]$Matches[1] }
    } | Select-Object -Unique)
  }
}

function Quote-CmdArg {
  param([string]$Value)

  return '"' + ($Value -replace '"', '\"') + '"'
}

if (Test-LocalPort -PortToCheck $Port) {
  if (-not $Restart) {
    Write-Host "Quiver2API is already running at http://127.0.0.1:$Port"
    exit 0
  }

  $pids = Get-LocalPortPids -PortToCheck $Port
  if (-not $pids.Count) {
    Write-Error "Port $Port is in use, but no listening process id could be found"
    exit 1
  }

  foreach ($processId in $pids) {
    Write-Host "Stopping process $processId on port $Port"
    Stop-Process -Id $processId -Force
  }

  $deadline = (Get-Date).AddSeconds(8)
  while ((Get-Date) -lt $deadline) {
    if (-not (Test-LocalPort -PortToCheck $Port)) { break }
    Start-Sleep -Milliseconds 250
  }

  if (Test-LocalPort -PortToCheck $Port) {
    Write-Error "Port $Port is still in use after stopping process(es): $($pids -join ', ')"
    exit 1
  }
}

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) {
  Write-Error 'node was not found in PATH'
  exit 1
}

New-Item -ItemType Directory -Force -Path $logDir | Out-Null

$command = 'cmd.exe /d /c "cd /d {0} && set "PORT={1}" && {2} src\index.js >> {3} 2>> {4}"' -f `
  (Quote-CmdArg $projectRoot),
  $Port,
  (Quote-CmdArg $node),
  (Quote-CmdArg $logPath),
  (Quote-CmdArg $errorLogPath)
$shell = New-Object -ComObject WScript.Shell
$null = $shell.Run($command, 0, $false)

$deadline = (Get-Date).AddSeconds(8)
while ((Get-Date) -lt $deadline) {
  if (Test-LocalPort -PortToCheck $Port) { break }
  Start-Sleep -Milliseconds 250
}

if (Test-LocalPort -PortToCheck $Port) {
  Write-Host "Quiver2API started at http://127.0.0.1:$Port"
  Write-Host "Log: $logPath"
  Write-Host "Error log: $errorLogPath"
  exit 0
}

Write-Error "Quiver2API did not start on port $Port. Check log: $logPath"
exit 1
