const { spawn } = require('node:child_process');
const path = require('node:path');

const WINDOWS_RETRY_DELAYS_MS = Object.freeze([25, 50, 100, 200, 400]);

// Use Windows PowerShell's .NET APIs for private staging and ReplaceFileW.
// The command is fixed. The selected path and project bytes arrive on stdin.
const saveScript = String.raw`
$ErrorActionPreference = 'Stop'
$record = [Console]::In.ReadToEnd() | ConvertFrom-Json
$target = [string]$record.target
$parent = [IO.Path]::GetDirectoryName($target)
$stage = [IO.Path]::Combine($parent, '.orbit-save-' + [Guid]::NewGuid().ToString('N'))
$temporary = [IO.Path]::Combine($stage, 'project.tmp')
$backup = [IO.Path]::Combine($stage, 'previous.tmp')
$reparsePoint = [IO.FileAttributes]::ReparsePoint

function Assert-RealDirectory([string]$directory) {
    while ($directory) {
        $attributes = [IO.File]::GetAttributes($directory)
        if (($attributes -band $reparsePoint) -or -not ($attributes -band [IO.FileAttributes]::Directory)) {
            throw 'Invalid save directory'
        }
        $directory = [IO.Path]::GetDirectoryName($directory)
    }
}

$ownsStage = $false
$ownsTemporary = $false
$saved = $false
try {
    Assert-RealDirectory $parent
    $user = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $acl = [Security.AccessControl.DirectorySecurity]::new()
    $acl.SetAccessRuleProtection($true, $false)
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
        $user, 'FullControl', 'ContainerInherit, ObjectInherit', 'None', 'Allow'))
    if ([IO.Directory]::Exists($stage) -or [IO.File]::Exists($stage)) { throw 'Save staging name already exists' }
    [IO.Directory]::CreateDirectory($stage, $acl) | Out-Null
    $ownsStage = $true
    Assert-RealDirectory $stage
    $actualAcl = [IO.Directory]::GetAccessControl($stage)
    if (-not $actualAcl.AreAccessRulesProtected -or
        $actualAcl.GetSecurityDescriptorSddlForm('Access') -ne $acl.GetSecurityDescriptorSddlForm('Access')) {
        throw 'Unable to create private save directory'
    }

    $stream = [IO.FileStream]::new($temporary, 'CreateNew', 'Write', 'None')
    $ownsTemporary = $true
    try {
        $bytes = [Convert]::FromBase64String($record.contents)
        $stream.Write($bytes, 0, $bytes.Length)
        $stream.Flush($true)
    } finally { $stream.Dispose() }

    $delays = @(${WINDOWS_RETRY_DELAYS_MS.join(', ')})
    for ($attempt = 0; ; $attempt++) {
        Assert-RealDirectory $stage
        $attributes = $null
        try { $attributes = [IO.File]::GetAttributes($target) }
        catch [IO.FileNotFoundException] {}
        if ($null -ne $attributes -and ($attributes -band ($reparsePoint -bor [IO.FileAttributes]::Directory))) {
            throw 'Invalid save destination'
        }
        try {
            if ($null -eq $attributes) { [IO.File]::Move($temporary, $target) }
            else { [IO.File]::Replace($temporary, $target, $backup, $false) }
            $saved = $true
            break
        } catch {
            # ReplaceFileW can move the original to the backup before reporting
            # a failure. Restore it without overwriting a concurrent save.
            if ([IO.File]::Exists($backup)) {
                [IO.File]::Move($backup, $target)
                throw
            }
            $code = $_.Exception.GetBaseException().HResult -band 65535
            if ($attempt -ge $delays.Length -or $code -notin @(5, 32, 33)) { throw }
            Start-Sleep -Milliseconds $delays[$attempt]
        }
    }
} finally {
    if ($ownsStage) {
        Assert-RealDirectory $stage
        if ($ownsTemporary) { [IO.File]::Delete($temporary) }
        if ($saved) { [IO.File]::Delete($backup) }
        # Retain the original in the protected directory if recovery itself fails.
        if (-not [IO.File]::Exists($backup)) { [IO.Directory]::Delete($stage) }
    }
}
`;

function windowsPowerShell() {
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot || !/^[a-z]:[\\/]/i.test(systemRoot)) throw new Error('Windows SystemRoot is unavailable');
  return path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

function windowsPowerShellEnv(extra = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toUpperCase() !== 'PSMODULEPATH'));
  return { ...env, ...extra, PSModulePath: path.join(path.dirname(windowsPowerShell()), 'Modules') };
}

async function windowsWriteProject(target, contents) {
  const command = Buffer.from(saveScript, 'utf16le').toString('base64');
  const executable = windowsPowerShell();
  const payload = JSON.stringify({ target, contents: Buffer.from(contents, 'utf8').toString('base64') })
    .replace(/[^\x00-\x7f]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
  await new Promise((resolve, reject) => {
    const child = spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', command], {
      cwd: path.dirname(executable), env: windowsPowerShellEnv(), windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'],
    });
    const fail = () => reject(new Error('실험 파일을 저장할 수 없습니다. 저장 위치와 파일의 권한을 확인해 주세요.'));
    let inputFailed = false;
    child.on('error', fail);
    child.stdin.on('error', () => { inputFailed = true; });
    child.on('close', code => {
      if (code === 0 && !inputFailed) resolve();
      else fail();
    });
    child.stdin.end(payload);
  });
}

module.exports = { windowsPowerShell, windowsPowerShellEnv, windowsWriteProject, WINDOWS_RETRY_DELAYS_MS };
