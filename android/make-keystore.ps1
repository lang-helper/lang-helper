# 生成安卓 App 的签名密钥（只需要做一次）。不需要装 Java / Android Studio。
#
#   powershell -ExecutionPolicy Bypass -File android\make-keystore.ps1
#
# 生成到 android\keystore\（已在 .gitignore 里，不会被提交）：
#   lang-helper.p12      密钥文件 —— 另外备份一份！丢了就没法覆盖安装新版（只能卸载重装，App 里的设置和历史会丢）
#   password.txt         密码      → GitHub Secret「ANDROID_KEYSTORE_PASSWORD」
#   secret-base64.txt    密钥文件的 base64 → GitHub Secret「ANDROID_KEYSTORE_BASE64」
#
# 只在内存里生成，不放进 Windows 证书库。

$ErrorActionPreference = 'Stop'
$dir = Join-Path $PSScriptRoot 'keystore'
$p12 = Join-Path $dir 'lang-helper.p12'
if (Test-Path $p12) {
  Write-Host "已经有密钥了：$p12（不会覆盖。真要重新生成，先自己把它移走）"
  exit 1
}
New-Item -ItemType Directory -Force $dir | Out-Null

# 随机密码（字母数字，24 位）
$chars = [char[]]'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'
$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
$buf = New-Object byte[] 24
$rng.GetBytes($buf)
$password = -join ($buf | ForEach-Object { $chars[$_ % $chars.Length] })

$X509 = 'System.Security.Cryptography.X509Certificates'
$rsa = New-Object System.Security.Cryptography.RSACryptoServiceProvider(2048)
$dn = New-Object "$X509.X500DistinguishedName"('CN=lang-helper')
$req = New-Object "$X509.CertificateRequest"($dn, $rsa, [System.Security.Cryptography.HashAlgorithmName]::SHA256, [System.Security.Cryptography.RSASignaturePadding]::Pkcs1)
$cert = $req.CreateSelfSigned([DateTimeOffset]::UtcNow.AddDays(-1), [DateTimeOffset]::UtcNow.AddYears(30))
$cert.FriendlyName = 'lang-helper' # 在 Java 里就是密钥的别名（alias）
$bytes = $cert.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Pkcs12, $password)

# 检查：能用密码重新读出来，并且带私钥
$check = New-Object -TypeName "$X509.X509Certificate2" -ArgumentList $bytes, $password, ([System.Security.Cryptography.X509Certificates.X509KeyStorageFlags]::EphemeralKeySet)
if (-not $check.HasPrivateKey) { throw '生成的密钥文件里没有私钥' }

[System.IO.File]::WriteAllBytes($p12, $bytes)
[System.IO.File]::WriteAllText((Join-Path $dir 'password.txt'), $password)
[System.IO.File]::WriteAllText((Join-Path $dir 'secret-base64.txt'), [Convert]::ToBase64String($bytes))
$rsa.PersistKeyInCsp = $false
$rsa.Clear()

Write-Host "好了：$dir"
Write-Host "证书指纹（SHA-1）：$($check.Thumbprint)"
