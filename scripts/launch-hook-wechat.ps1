param([switch]$PrepareOnly,[switch]$UpdateHook)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
& node (Join-Path $PSScriptRoot 'project-config.mjs')
if ($LASTEXITCODE -ne 0) { throw 'Project configuration invalid.' }
$config = Get-Content -LiteralPath (Join-Path $root 'config\wechatagent.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if ($config.runtime.sender -ne 'wechat-hook') { throw 'Set runtime.sender to wechat-hook first.' }
$exe = if ([IO.Path]::IsPathRooted($config.hook.wechatExecutable)) { [IO.Path]::GetFullPath($config.hook.wechatExecutable) } else { [IO.Path]::GetFullPath((Join-Path $root $config.hook.wechatExecutable)) }
if (-not (Test-Path -LiteralPath $exe)) { throw 'Matching WeChat client missing. Follow docs/WECHAT_HOOK.md to download and extract it.' }
if ((Get-Item -LiteralPath $exe).VersionInfo.FileVersion -ne $config.hook.expectedVersion) { throw 'Client version mismatch; Hook not installed.' }
$signature = Get-AuthenticodeSignature -LiteralPath $exe
if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'Tencent') { throw 'WeChat executable signature check failed.' }
. (Join-Path $PSScriptRoot 'hook-client-health.ps1')

function Start-MatchingWeChat {
if (-not $PrepareOnly) { Test-HookClientUpdate $exe }
if ($config.hook.expectedVersion -eq '4.1.15.13') {
    $loaderScript = Join-Path $PSScriptRoot 'load-hook-current.ps1'
    & $loaderScript -Executable $exe -BaseUrl $config.hook.baseUrl -PrepareOnly
    if ($PrepareOnly) { return }
    if($exe.StartsWith((Join-Path $root 'state\hook')+'\',[StringComparison]::OrdinalIgnoreCase)){
        & (Join-Path $PSScriptRoot 'pin-hook-client.ps1')
    }
    Open-HookClient $exe $config.hook.baseUrl
    & $loaderScript -Executable $exe -BaseUrl $config.hook.baseUrl
    return
}
$directory = Split-Path -Parent $exe
$existing = @(Get-CimInstance Win32_Process -Filter "Name='Weixin.exe'" | Where-Object { $_.CommandLine -notmatch '--type=|--crashpad-handler' })
$ours = @($existing | Where-Object ExecutablePath -eq $exe)
if ($ours.Count) {
    if ($PrepareOnly) { throw 'Close the matching WeChat before replacing its native component.' }
    $currentBuild = Get-Content -LiteralPath (Join-Path $root 'state\hook\native\build.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    $installedDll = Join-Path $directory 'version.dll'
    if (-not (Test-Path -LiteralPath $installedDll) -or (Get-FileHash -LiteralPath $installedDll -Algorithm SHA256).Hash.ToLowerInvariant() -ne $currentBuild.sha256) { throw 'HOOK_COMPONENT_UPDATE_PENDING: Exit the matching WeChat from its tray before reopening it to apply the updated sender.' }
    Write-Output 'Matching WeChat is open; checking its sender initialization...'
    Wait-HookClient $exe $config.hook.baseUrl $config.hook.expectedVersion (Join-Path $root 'state\hook\native-token.txt')
    Write-Output 'Matching WeChat sender is ready. Finish login, then start WeChatAgent.'; return
}
if (-not $PrepareOnly -and $existing.Count) { throw 'Another desktop WeChat is running. Exit it from the tray before opening the isolated Hook client; this script does not terminate it.' }
$native = Join-Path $root 'state\hook\native'
$build = Get-Content -LiteralPath (Join-Path $native 'build.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$dll = Join-Path $native 'version.dll'
if ($build.targetVersion -ne $config.hook.expectedVersion -or (Get-FileHash -LiteralPath $dll -Algorithm SHA256).Hash.ToLowerInvariant() -ne $build.sha256) { throw 'Native build hash/version mismatch.' }
$destination = Join-Path $directory 'version.dll'
if ((Test-Path -LiteralPath $destination) -and (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant() -ne $build.sha256) {
    $previousFile=Join-Path $native 'build.previous.json'
    if (-not $UpdateHook -or -not (Test-Path -LiteralPath $previousFile)) { throw 'A different version.dll already exists here; use UpdateHook only for a verified previous project build.' }
    $previous=Get-Content -LiteralPath $previousFile -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($previous.targetVersion -ne $config.hook.expectedVersion -or (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant() -ne $previous.sha256) { throw 'Installed DLL does not match the recorded previous project build.' }
    Copy-Item -LiteralPath $destination -Destination (Join-Path $native 'deployed.previous.dll') -Force
}
try {
    & (Join-Path $PSScriptRoot 'pin-hook-client.ps1') -Unlock
    Copy-Item -LiteralPath $dll -Destination $destination -Force
    Copy-Item -LiteralPath (Join-Path $root 'state\hook\native-token.txt') -Destination (Join-Path $directory 'wechatagent-hook.token') -Force
} finally { & (Join-Path $PSScriptRoot 'pin-hook-client.ps1') }
if ($PrepareOnly) { Write-Output 'Matching client prepared with verified Hook DLL and local token; not launched.'; return }
if ($existing.Count) { throw 'Another desktop WeChat is running. Exit it from the tray before opening the isolated Hook client; this script does not terminate it.' }
$port = ([Uri]$config.hook.baseUrl).Port
if (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) { throw 'Hook port is already in use; inspect the listener before launching.' }
$clientProcess = Start-Process -FilePath $exe -ArgumentList ('StartPort='+$port+' CallBackURL="http://127.0.0.1:'+ $config.ports.adapter + '/unused"') -WorkingDirectory $directory -WindowStyle Normal -PassThru
Write-Output 'Waiting for matching WeChat launcher handoff and sender initialization...'
Wait-HookClient $exe $config.hook.baseUrl $config.hook.expectedVersion (Join-Path $root 'state\hook\native-token.txt')
Write-Output ('Opened bundled matching WeChat '+$config.hook.expectedVersion+'; sender is ready. Log in, then start services in WeChatGirl.')
}

try { Start-MatchingWeChat }
catch {
    if ($_.Exception.Message -ne 'WECHAT_UPDATE_DIALOG_DETECTED' -or $config.hook.cancelUpdateAndRestart -ne $true) { throw }
    if ((Find-WeChatUpdateDialog $exe -Cancel) -ne 2) { throw 'WECHAT_UPDATE_CANCEL_UNAVAILABLE' }
    for ($attempt=0; $attempt -lt 8 -and (Find-WeChatUpdateDialog $exe) -gt 0; $attempt++) {
        Start-Sleep -Milliseconds 250
    }
    if ((Find-WeChatUpdateDialog $exe) -gt 0) { throw 'WECHAT_UPDATE_CANCEL_UNAVAILABLE' }
    Write-Output 'WECHAT_UPDATE_CANCELLED: Retrying the matching client once.'
    $deadline = [DateTime]::UtcNow.AddSeconds(8)
    $closeRequested = $false
    do {
        $instances = @(Get-CimInstance Win32_Process -Filter "Name='Weixin.exe' OR Name='WeChat.exe'" |
            Where-Object { $_.ExecutablePath -eq $exe -and $_.CommandLine -notmatch '--type=|--crashpad-handler' })
        if (-not $instances.Count) { break }
        if (-not $closeRequested) {
            foreach ($instance in $instances) {
                try {
                    $client = Get-Process -Id ([int]$instance.ProcessId) -ErrorAction Stop
                    if ($client.Path -eq $exe -and $client.MainWindowHandle -ne 0) {
                        if ($client.CloseMainWindow()) { $closeRequested = $true }
                    }
                } catch {}
            }
        }
        Start-Sleep -Milliseconds 400
    } while ([DateTime]::UtcNow -lt $deadline)
    $instances = @(Get-CimInstance Win32_Process -Filter "Name='Weixin.exe' OR Name='WeChat.exe'" |
        Where-Object { $_.ExecutablePath -eq $exe -and $_.CommandLine -notmatch '--type=|--crashpad-handler' })
    if ($instances.Count) { throw 'WECHAT_UPDATE_RESTART_REQUIRES_EXIT' }
    Start-MatchingWeChat
}
