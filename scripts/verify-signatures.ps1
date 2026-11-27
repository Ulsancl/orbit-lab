param(
    [Parameter(Mandatory)][ValidatePattern('\A[0-9a-fA-F]{40}\z')][string]$ExpectedThumbprint,
    [Parameter(Mandatory)][string]$Installer,
    [Parameter(Mandatory)][string]$Application
)

$ErrorActionPreference = 'Stop'
foreach ($file in @($Installer, $Application)) {
    $signature = Get-AuthenticodeSignature -LiteralPath $file
    if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Thumbprint -ne $ExpectedThumbprint) {
        throw "Authenticode verification failed for $([IO.Path]::GetFileName($file)): $($signature.Status) or unexpected publisher."
    }
}
