# ============================================================
#  IIS 反向代理一键配置脚本 (双域名版 v3)
#  必须以【管理员身份】运行 PowerShell 后执行
#
#  用法:
#    cd F:\TopN
#    Set-ExecutionPolicy Bypass -Scope Process -Force
#    .\setup-iis-proxy.ps1
#
#  功能:
#    1. 安装 URL Rewrite 2.1 + ARR 3.0 (已装则跳过)
#    2. 启用 ARR 代理
#    3. 为两个域名各建一个 IIS 站点 + 反向代理规则:
#         topn.cc.cd   :80  →  localhost:5678  (TopN 评分系统)
#         kaiwen.cc.cd :80  →  localhost:3000  (kaiwen 服务)
#    4. 自检绑定匹配
# ============================================================

# 要配置的域名 → 后端端口 映射表
$Map = @(
    @{ Domain='topn.cc.cd';   Port=5678; Site='TopN';    Dir='C:\inetpub\TopN' },
    @{ Domain='kaiwen.cc.cd'; Port=3000; Site='Kaiwen';  Dir='C:\inetpub\Kaiwen' }
)

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

function Step($m) { Write-Host "`n[*] $m" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "    ✔ $m" -ForegroundColor Green }
function Warn2($m){ Write-Host "    ! $m" -ForegroundColor Yellow }
function Err($m)  { Write-Host "    ✘ $m" -ForegroundColor Red }

# ---------- 0. 管理员检查 ----------
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { Err "请用【管理员身份】运行 PowerShell 再执行本脚本!"; exit 1 }
Ok "管理员权限确认"

# ---------- 1. 安装 URL Rewrite ----------
Step "安装 URL Rewrite 2.1 ..."
$rewriteMsi = Join-Path $ScriptDir 'rewrite_amd64.msi'
if (Test-Path $rewriteMsi) {
    $p = Start-Process msiexec.exe -ArgumentList "/i `"$rewriteMsi`" /quiet /norestart" -Wait -PassThru
    if ($p.ExitCode -eq 0)       { Ok "URL Rewrite 安装完成" }
    elseif ($p.ExitCode -eq 1638){ Warn2 "URL Rewrite 已安装过, 跳过" }
    else                         { Warn2 "URL Rewrite 返回码 $($p.ExitCode) (可能已安装)" }
} else { Warn2 "未找到 rewrite_amd64.msi, 跳过" }

# ---------- 2. 安装 ARR ----------
Step "安装 ARR 3.0 ..."
$arrMsi = Join-Path $ScriptDir 'requestRouter_amd64.msi'
if (Test-Path $arrMsi) {
    $p = Start-Process msiexec.exe -ArgumentList "/i `"$arrMsi`" /quiet /norestart" -Wait -PassThru
    if ($p.ExitCode -eq 0)       { Ok "ARR 安装完成" }
    elseif ($p.ExitCode -eq 1638){ Warn2 "ARR 已安装过, 跳过" }
    else                         { Warn2 "ARR 返回码 $($p.ExitCode) (可能已安装)" }
} else { Warn2 "未找到 requestRouter_amd64.msi, 跳过" }

# ---------- 3. 加载 IIS 模块 ----------
Step "加载 WebAdministration ..."
try {
    Import-Module WebAdministration -ErrorAction Stop
    Ok "WebAdministration 已加载"
} catch { Err "无法加载 WebAdministration, IIS 管理脚本功能可能未安装"; exit 1 }

# ---------- 4. 校验模块 ----------
Step "校验模块 ..."
$rewriteOk = Test-Path 'C:\Windows\System32\inetsrv\rewrite.dll'
$arrDll = Get-ChildItem 'C:\Windows\System32\inetsrv\requestRouter*.dll' -ErrorAction SilentlyContinue
Write-Host ("    URL Rewrite: {0}" -f $(if($rewriteOk){'存在'}else{'缺失'}))
Write-Host ("    ARR:         {0}" -f $(if($arrDll){'存在'}else{'缺失'}))

# ---------- 5. 启用 ARR 代理 ----------
Step "启用 ARR 代理 ..."
try {
    Set-WebConfigurationProperty -pspath 'MACHINE/WEBROOT/APPHOST' -filter "system.webServer/proxy" -name "enabled" -value "True" -ErrorAction Stop
    Set-WebConfigurationProperty -pspath 'MACHINE/WEBROOT/APPHOST' -filter "system.webServer/proxy" -name "preserveHostHeader" -value "True" -ErrorAction Stop
    Ok "ARR 代理已启用"
} catch { Err "启用 ARR 代理失败 (ARR 可能未正确安装): $($_.Exception.Message)" }

# ---------- 6. 处理 IIS 默认站点的空 Host 兜底 ----------
Step "检查 IIS 默认站点 (Default Web Site) ..."
$defaultSite = Get-Website -Name 'Default Web Site' -ErrorAction SilentlyContinue
if ($defaultSite) {
    $hasEmptyHost = $false
    foreach ($b in $defaultSite.Bindings.Collection) {
        $h = ($b.bindingInformation -split ':')[2]
        if ([string]::IsNullOrEmpty($h)) { $hasEmptyHost = $true; break }
    }
    if ($hasEmptyHost) {
        Warn2 "Default Web Site 绑定了空 Host (*:80), 会兜底所有未精确匹配的域名"
        Warn2 "为避免干扰, 将停止 Default Web Site (它的内容只是 IIS 欢迎页, 可随时恢复)"
        try {
            Stop-Website -Name 'Default Web Site' -ErrorAction Stop
            Ok "Default Web Site 已停止 (新站点精确绑定后将正常接管)"
            Ok "恢复方法: Start-Website -Name 'Default Web Site'"
        } catch { Err "停止 Default Web Site 失败: $($_.Exception.Message)" }
    } else { Ok "Default Web Site 无空 Host 绑定, 无需处理" }
}

# ---------- 7. 为每个域名建站点 + 反代规则 ----------
foreach ($entry in $Map) {
    $domain = $entry.Domain
    $port   = $entry.Port
    $site   = $entry.Site
    $dir    = $entry.Dir

    Step "配置站点 $site ( ${domain}:80 → localhost:$port ) ..."

    # 建物理目录
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }

    # 删除已存在同名站点 (幂等)
    if (Get-Website -Name $site -ErrorAction SilentlyContinue) {
        Remove-Website -Name $site -ErrorAction SilentlyContinue
        Warn2 "已移除旧 $site 站点"
    }
    # 独立应用池
    if (-not (Test-Path "IIS:\AppPools\$site")) { New-WebAppPool -Name $site | Out-Null }

    # 关键: 精确绑定域名
    try {
        New-Website -Name $site -PhysicalPath $dir -HostHeader $domain -Port 80 -ApplicationPool $site -Force -ErrorAction Stop | Out-Null
        Ok "站点 $site 已创建, 精确绑定 ${domain}:80"
    } catch { Err "创建 $site 失败: $($_.Exception.Message)"; continue }

    # 写反向代理规则
    $webConfig = @"
<?xml version="1.0" encoding="UTF-8"?>
<configuration>
  <system.webServer>
    <rewrite>
      <rules>
        <rule name="ReverseProxyToLocalhost" stopProcessing="true">
          <match url="(.*)" />
          <action type="Rewrite" url="http://localhost:$port/{R:1}" />
          <serverVariables>
            <set name="HTTP_X_FORWARDED_HOST" value="{HTTP_HOST}" />
            <set name="HTTP_X_FORWARDED_PROTO" value="http" />
          </serverVariables>
        </rule>
      </rules>
    </rewrite>
  </system.webServer>
</configuration>
"@
    $webConfigPath = Join-Path $dir 'web.config'
    $webConfig | Out-File $webConfigPath -Encoding utf8 -Force
    Ok "$site 反向代理规则已写入 → localhost:$port"

    # 启动站点
    Start-Website -Name $site -ErrorAction SilentlyContinue
    Ok "$site 已启动"
}

# ---------- 8. 自检 ----------
Step "自检: 各域名绑定匹配 ..."
foreach ($entry in $Map) {
    $domain = $entry.Domain; $site = $entry.Site
    $exact = @(); $wild = @()
    foreach ($s in (Get-Website)) {
        if ($s.State -ne 'Started') { continue }   # 只看已启动站点
        foreach ($b in $s.Bindings.Collection) {
            $h = ($b.bindingInformation -split ':')[2]
            if ($h -ieq $domain) { $exact += $s.Name }
            elseif ([string]::IsNullOrEmpty($h)) { $wild += $s.Name }
        }
    }
    if ($exact -contains $site) {
        Ok "${domain} → $site (精确匹配, 正确)"
    } else {
        Err "${domain} 未匹配到 $site! 当前精确匹配: " + ($exact -join ',') + " ; 兜底: " + ($wild -join ',')
    }
}

Write-Host "`n========================================" -ForegroundColor Green
Write-Host "  配置完成!" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Green
Write-Host "  链路:" -ForegroundColor White
Write-Host "    topn.cc.cd   →  IIS(TopN站点)    →  Node localhost:5678"
Write-Host "    kaiwen.cc.cd →  IIS(Kaiwen站点)  →  localhost:3000"
Write-Host ""
Write-Host "  下一步:" -ForegroundColor White
Write-Host "    1. 启动 TopN Node 服务: 双击 F:\TopN\start.bat (PORT=5678)"
Write-Host "    2. 启动 kaiwen 服务 (监听 3000)"
Write-Host "    3. 访问 http://topn.cc.cd  和  http://kaiwen.cc.cd"
Write-Host ""
Write-Host "  注: Default Web Site 已停止 (只剩 IIS 欢迎页, 可随时恢复)"
Write-Host "      恢复: Start-Website -Name 'Default Web Site'" -ForegroundColor DarkGray
