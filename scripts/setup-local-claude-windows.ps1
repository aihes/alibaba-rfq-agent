$ErrorActionPreference = 'Stop'

function Find-ClaudeExe {
  $candidates = @(
    (Join-Path $env:USERPROFILE '.local\bin\claude.exe'),
    (Join-Path $env:USERPROFILE '.claude\local\claude.exe')
  )
  foreach ($candidate in $candidates) {
    if (Test-Path -LiteralPath $candidate -PathType Leaf) { return (Resolve-Path -LiteralPath $candidate).Path }
  }
  $command = Get-Command claude.exe -ErrorAction SilentlyContinue
  if ($command -and $command.Source -and (Test-Path -LiteralPath $command.Source -PathType Leaf)) { return $command.Source }
  return $null
}

try {
  $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
  $helper = Join-Path $scriptDir 'configure-local-claude.cjs'
  $appNode = [IO.Path]::GetFullPath((Join-Path $scriptDir '..\..\..\RFQ助手.exe'))
  if (Test-Path -LiteralPath $appNode -PathType Leaf) { $nodeExe = $appNode; $useElectron = $true }
  else {
    $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
    if (-not $nodeCommand) { throw '找不到 RFQ 助手内置运行环境。请从已安装的 RFQ 助手设置页打开此脚本。' }
    $nodeExe = $nodeCommand.Source; $useElectron = $false
  }

  Write-Host 'RFQ 助手 · 本机 Claude 安装与 GLM 配置'
  Write-Host '此操作会安装 Anthropic 官方 Claude Code，并更新用户目录中 .claude\settings.json 的 GLM 认证与接口。'
  Write-Host '其他设置会保留，原文件会备份。Key 会以明文写入用户目录内的设置文件；不会出现在命令行参数中。'
  $consent = Read-Host '继续吗？[y/N]'
  if ($consent -notin @('y', 'Y')) { return }

  $claudeExe = Find-ClaudeExe
  if (-not $claudeExe) {
    Write-Host '正在从 claude.ai 下载并运行 Anthropic 官方安装脚本…'
    $installer = Join-Path $env:TEMP ("rfq-claude-install-{0}.ps1" -f [guid]::NewGuid().ToString('N'))
    try {
      Invoke-WebRequest -Uri 'https://claude.ai/install.ps1' -OutFile $installer -UseBasicParsing
      $global:LASTEXITCODE = 0
      & $installer
      if ($LASTEXITCODE -ne 0 -and $null -ne $LASTEXITCODE) { throw 'Claude 官方安装脚本执行失败。' }
    } finally {
      Remove-Item -LiteralPath $installer -Force -ErrorAction SilentlyContinue
    }
    $claudeExe = Find-ClaudeExe
  }
  if (-not $claudeExe) { throw 'Claude 安装未完成或未找到原生 claude.exe。' }
  & $claudeExe --version
  if ($LASTEXITCODE -ne 0) { throw 'Claude 可执行文件无法启动。' }

  Write-Host '请选择 API Key 所属平台：'
  Write-Host '  1) 智谱国内 open.bigmodel.cn'
  Write-Host '  2) Z.AI 国际 api.z.ai'
  $choice = Read-Host '输入 1 或 2'
  if ($choice -eq '1') { $region = 'china' }
  elseif ($choice -eq '2') { $region = 'zai' }
  else { throw '未选择有效平台；未修改 Claude 设置。' }

  $secureKey = Read-Host '粘贴该平台的 API Key（输入时不显示）' -AsSecureString
  $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)
  try { $apiKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
  $start = New-Object Diagnostics.ProcessStartInfo
  $start.FileName = $nodeExe
  $start.Arguments = ('"{0}" --region {1} --executable "{2}"' -f $helper, $region, $claudeExe)
  $start.UseShellExecute = $false
  $start.RedirectStandardInput = $true
  $start.RedirectStandardOutput = $true
  $start.RedirectStandardError = $true
  $start.CreateNoWindow = $true
  if ($useElectron) { $start.EnvironmentVariables['ELECTRON_RUN_AS_NODE'] = '1' }
  $process = [Diagnostics.Process]::Start($start)
  $process.StandardInput.Write($apiKey)
  $process.StandardInput.Close()
  $apiKey = $null
  $output = $process.StandardOutput.ReadToEnd()
  $errorOutput = $process.StandardError.ReadToEnd()
  $process.WaitForExit()
  if ($process.ExitCode -ne 0) { throw $errorOutput.Trim() }
  Write-Host $output.Trim()
  Write-Host '完成。请回到 RFQ 助手，点击「重新读取本机环境变量」，再点击「测试模型连接」。'
} catch {
  Write-Host ("安装或配置失败：{0}" -f $_.Exception.Message)
  exit 1
}
