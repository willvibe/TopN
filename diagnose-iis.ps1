# ============================================================
#  TopN IIS 完整诊断脚本 (只读, 不修改任何配置)
#  必须以【管理员身份】运行 PowerShell
#  用法: cd F:\TopN ; Set-ExecutionPolicy Bypass -Scope Process -Force ; .\diagnose-iis.ps1
# ============================================================

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { Write-Host "❌ 请用管理员身份运行!" -ForegroundColor Red; exit 1 }

$out = "F:\TopN\_iis-report.txt"
"===== TopN IIS 诊断报告 " + (Get-Date) + " =====" | Out-File $out -Encoding utf8

function Log($m) { $m | Tee-Object -FilePath $out -Append | Out-Host }

try { Import-Module WebAdministration -ErrorAction Stop } catch { Log "无法加载 WebAdministration"; exit 1 }

Log "`n========== 1. 全部 IIS 站点与绑定 =========="
$sites = Get-Website
Log ("站点总数: " + $sites.Count)
foreach ($s in $sites) {
    Log "`n● 站点: $($s.Name)   [状态: $($s.State)]"
    Log ("   物理路径: " + (Get-ItemProperty "IIS:\Sites\$($s.Name)" -Name physicalPath -ErrorAction SilentlyContinue))
    foreach ($b in $s.Bindings.Collection) {
        $parts = $b.bindingInformation -split ':'
        $port = $parts[1]; $hostHeader = $parts[2]
        $flag = if ([string]::IsNullOrEmpty($hostHeader)) { "  <<< 空 Host Header (捕获所有域名)" } else { "" }
        Log ("   绑定: ${port}  域名='$hostHeader'$flag")
    }
}

Log "`n========== 2. topn.cc.cd / kaiwen.cc.cd 各自会落到哪个站点 =========="
foreach ($h in @('topn.cc.cd','kaiwen.cc.cd')) {
    $exact = @(); $wild = @()
    foreach ($s in (Get-Website)) {
        foreach ($b in $s.Bindings.Collection) {
            $hh = ($b.bindingInformation -split ':')[2]
            if ($hh -ieq $h) { $exact += $s.Name }
            elseif ([string]::IsNullOrEmpty($hh)) { $wild += $s.Name }
        }
    }
    if ($exact.Count -gt 0) { Log ("  $h → 精确匹配: " + ($exact -join ', ')) }
    else { Log ("  $h → 无精确匹配! 兜底到: " + ($wild -join ', ')) }
}

Log "`n========== 3. TopN 站点 =========="
if (Get-Website -Name 'TopN' -ErrorAction SilentlyContinue) {
    $t = Get-Website -Name 'TopN'
    Log "  TopN 站点存在, 状态: $($t.State)"
    foreach ($b in $t.Bindings.Collection) { Log ("    绑定: " + $b.bindingInformation) }
    $wcp = 'C:\inetpub\TopN\web.config'
    if (Test-Path $wcp) { Log "  web.config 存在:"; Log (Get-Content $wcp -Raw) } else { Log "  web.config 不存在" }
} else { Log "  ✘ TopN 站点【不存在】" }

Log "`n========== 4. URL Rewrite / ARR 模块 =========="
Log ("  URL Rewrite: " + $(if(Test-Path 'C:\Windows\System32\inetsrv\rewrite.dll'){'已安装'}else{'未安装'}))
$arr = Get-ChildItem 'C:\Windows\System32\inetsrv\requestRouter*.dll' -ErrorAction SilentlyContinue
Log ("  ARR:         " + $(if($arr){'已安装'}else{'未安装'}))

Log "`n========== 5. 端口监听 =========="
$ports = netstat -ano | findstr LISTENING | findstr ":5678 :3000 :80 "
Log ($ports -join "`n")

Log "`n========== 6. appcmd 原始站点列表 =========="
$raw = & 'C:\Windows\System32\inetsrv\appcmd.exe' list site 2>&1
Log ($raw -join "`n")

Log "`n报告已保存到: $out"
Write-Host "`n请把 $out 的内容贴给我 (或直接贴屏幕输出)。" -ForegroundColor Cyan
