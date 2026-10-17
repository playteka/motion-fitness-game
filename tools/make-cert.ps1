# 生成「本机自签 HTTPS 证书」（零依赖：只用 Windows 自带的 PowerShell）。
#
# 为什么需要它：手机浏览器只在 **https / localhost** 下允许 getUserMedia（secure context 规则），
# 所以用 `HTTPS=1 node preview-server.js` 把手机连上摄像头之前，先得有证书。
#
# 用法（在项目根目录，用 **Windows PowerShell 5.1** 或 PowerShell 7 都行）：
#
#   powershell -ExecutionPolicy Bypass -File tools\make-cert.ps1
#
# 可选参数：
#   -Password <字符串>   导出的 PFX 口令（默认 motion-fitness，服务器用 CERT_PASS 覆盖）
#   -Days <数字>         有效期天数（默认 397；Apple 要求 ≤ 825 天，取小一点更保险）
#   -OutDir <路径>       输出目录（默认 tools\certs）
#
# 产出（都在 tools\certs\ 下，已 gitignore，**不要提交**）：
#   dev.pfx        给 preview-server.js 用（HTTPS=1 时自动读取）
#   dev-cert.pem   给手机装：iOS 用「照片/文件」或 AirDrop 传过去，Safari 打开即可装描述文件
#   dev-cert.cer   同上（DER 格式，Windows / Android 也认）
#
# 装证书那一步不能省：自签证书不装进手机、不设为「信任」，浏览器照样拒绝开摄像头。

[CmdletBinding()]
param(
  [string]$Password = 'motion-fitness',
  [int]$Days = 397,
  [string]$OutDir = ''
)

$ErrorActionPreference = 'Stop'

# 脚本所在目录（tools\）；被「读成字符串再执行」时 $PSScriptRoot 是空的，退回当前目录
$here = $PSScriptRoot
if (-not $here) { $here = (Get-Location).Path }
if (-not $OutDir) { $OutDir = Join-Path $here 'certs' }
if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Force -Path $OutDir | Out-Null }
$OutDir = (Resolve-Path $OutDir).Path

# ---- 收集要写进证书的地址（SAN）：localhost + 127.0.0.1 + 本机名 + 每个局域网 IPv4 ----
$ips = @()
try {
  $ips = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop |
    Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } |
    Select-Object -ExpandProperty IPAddress
} catch {
  $ips = [System.Net.Dns]::GetHostAddresses([System.Net.Dns]::GetHostName()) |
    Where-Object { $_.AddressFamily -eq 'InterNetwork' } |
    ForEach-Object { $_.IPAddressToString }
}
$ips = @($ips | Sort-Object -Unique)
$names = @('localhost', '127.0.0.1', $env:COMPUTERNAME) + $ips
$san = ($names | ForEach-Object {
  if ($_ -match '^\d+\.\d+\.\d+\.\d+$') { "IPAddress=$_" } else { "DNS=$_" }
}) -join '&'

Write-Host ''
Write-Host '正在生成自签证书：' -ForegroundColor Cyan
Write-Host ("  写入地址（SAN）： " + ($names -join ', '))
Write-Host ("  有效期： " + $Days + " 天")

# ---- 生成证书（放进当前用户的个人证书库，导出后立刻删掉，不留痕）----
$cert = $null
$inStore = $false
try {
  $cert = New-SelfSignedCertificate -Subject 'CN=Motion Fitness Dev' `
    -CertStoreLocation 'Cert:\CurrentUser\My' `
    -KeyAlgorithm RSA -KeyLength 2048 -HashAlgorithm SHA256 `
    -KeyExportPolicy Exportable -KeyUsage DigitalSignature, KeyEncipherment `
    -TextExtension @("2.5.29.17={text}$san", '2.5.29.37={text}1.3.6.1.5.5.7.3.1') `
    -NotAfter (Get-Date).AddDays($Days)
  $inStore = $true
} catch {
  Write-Host ('New-SelfSignedCertificate 不可用（' + $_.Exception.Message + '），改用 .NET CertificateRequest…') -ForegroundColor Yellow
  # 兜底：纯 .NET 生成（Windows PowerShell 5.1 的 .NET Framework 4.7.2+ 就有这个类）
  $rsa = [System.Security.Cryptography.RSA]::Create(2048)
  $req = [System.Security.Cryptography.X509Certificates.CertificateRequest]::new(
    'CN=Motion Fitness Dev', $rsa,
    [System.Security.Cryptography.HashAlgorithmName]::SHA256,
    [System.Security.Cryptography.RSASignaturePadding]::Pkcs1)
  $sanBuilder = [System.Security.Cryptography.X509Certificates.SubjectAlternativeNameBuilder]::new()
  foreach ($n in $names) {
    if ($n -match '^\d+\.\d+\.\d+\.\d+$') { $sanBuilder.AddIpAddress([System.Net.IPAddress]::Parse($n)) }
    else { $sanBuilder.AddDnsName($n) }
  }
  # 注意：这几行的返回值都往 Out-Null 里丢，否则 PowerShell 会把扩展对象直接打到屏幕上（刷一堆表格）
  $sanBuilder.Build($req.CertificateExtensions) | Out-Null
  $oids = [System.Security.Cryptography.OidCollection]::new()
  $oids.Add([System.Security.Cryptography.Oid]::new('1.3.6.1.5.5.7.3.1')) | Out-Null
  $req.CertificateExtensions.Add(
    [System.Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension]::new($oids, $false)) | Out-Null
  $cert = $req.CreateSelfSigned((Get-Date).AddDays(-1), (Get-Date).AddDays($Days))
}

# ---- 导出：PFX（服务器用）+ PEM / CER（手机装）----
$pfxPath = Join-Path $OutDir 'dev.pfx'
$pemPath = Join-Path $OutDir 'dev-cert.pem'
$cerPath = Join-Path $OutDir 'dev-cert.cer'

# ⚠️ PFX 必须用 .NET 的 `Export(Pkcs12, 口令)` 导出，**不能用 `Export-PfxCertificate`**：
#    后者走 CertEnroll，要求私钥已经落到证书库的密钥容器里 —— 走 .NET 兜底路径生成的证书没有容器，
#    它会把「只有公钥的 PFX」写出来（体积看着正常），Node 一读就报
#    `Unable to load private key from PFX data`。这里改成 .NET 直出，两条路径都稳。
[System.IO.File]::WriteAllBytes($pfxPath, $cert.Export(
  [System.Security.Cryptography.X509Certificates.X509ContentType]::Pkcs12, $Password))

$der = $cert.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Cert)
[System.IO.File]::WriteAllBytes($cerPath, $der)
$b64 = [Convert]::ToBase64String($der)
$pem = "-----BEGIN CERTIFICATE-----`r`n"
for ($i = 0; $i -lt $b64.Length; $i += 64) { $pem += $b64.Substring($i, [Math]::Min(64, $b64.Length - $i)) + "`r`n" }
$pem += "-----END CERTIFICATE-----`r`n"
[System.IO.File]::WriteAllText($pemPath, $pem, (New-Object System.Text.UTF8Encoding($false)))

# 验一遍：PFX 里**真的带私钥**才算成功（「Node 读不了 pfx」最常见的原因就是少了它）。
# 用 EphemeralKeySet 读：不往用户密钥容器里落东西，受限环境（比如沙箱 / 只读配置）也能读。
$check = $null
try {
  $check = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2(
    $pfxPath, $Password,
    ([System.Security.Cryptography.X509Certificates.X509KeyStorageFlags]::EphemeralKeySet))
} catch {
  Write-Host ('（校验 PFX 时读不出来，跳过这一步：' + $_.Exception.Message + '）') -ForegroundColor Yellow
}
if ($check -and -not $check.HasPrivateKey) {
  Write-Host '✗ 导出的 PFX 里没有私钥（Node 会报 Unable to load private key from PFX data）。' -ForegroundColor Red
  Write-Host '  请把这段输出发给开发者；也可以改用 PEM：$env:CERT_FILE / $env:KEY_FILE。' -ForegroundColor Red
  exit 1
}

if ($inStore) { Remove-Item ("Cert:\CurrentUser\My\" + $cert.Thumbprint) -Force -ErrorAction SilentlyContinue }

Write-Host ''
Write-Host '生成完成：' -ForegroundColor Green
Get-ChildItem $OutDir | ForEach-Object { Write-Host ('  ' + $_.FullName + '  (' + $_.Length + ' 字节)') }
Write-Host ''
Write-Host '下一步：' -ForegroundColor Cyan
Write-Host '  1) 启动 https 预览（手机与电脑要连同一个 Wi-Fi）：'
Write-Host '       $env:HOST="0.0.0.0"; $env:HTTPS="1"; node preview-server.js'
Write-Host '     终端会同时打印 https://<局域网IP>:4174 —— 手机浏览器照抄这个地址。'
Write-Host '  2) 手机先装证书（不装的话浏览器照样不给摄像头）：'
Write-Host ('       把 ' + $pemPath + ' 传到手机（AirDrop / 微信文件传输 / 邮件附件）')
Write-Host '       iPhone：设置 → 通用 → VPN与设备管理 → 安装描述文件；'
Write-Host '               再进 设置 → 通用 → 关于本机 → 证书信任设置 → 打开该证书的完全信任。'
Write-Host '       Android：设置 → 安全 → 加密与凭据 → 安装证书 → CA 证书。'
Write-Host ''
