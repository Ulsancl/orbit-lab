import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { atomicWriteProject, WINDOWS_RETRY_DELAYS_MS } from '../desktop/atomic-save.cjs';
import { windowsPowerShell, windowsPowerShellEnv } from '../desktop/windows-save.cjs';

const previous = '{"original":"보존할 실험"}', replacement = '{"replacement":"완료된 실험"}';
const scratchRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'output', 'atomic-save-tests');
const failure = code => Object.assign(new Error(`synthetic ${code}`), { code });
async function fixture(t) {
  await fs.mkdir(scratchRoot, { recursive: true });
  const directory = await fs.mkdtemp(path.join(scratchRoot, 'fixture-'));
  t.after(async () => {
    const resolved = path.resolve(directory);
    assert.equal(path.dirname(resolved), scratchRoot);
    assert.ok(path.basename(resolved).startsWith('fixture-'));
    await fs.rm(resolved, { recursive: true, force: true });
  });
  const target = path.join(directory, 'experiment.json');
  await fs.writeFile(target, previous);
  const validateTarget = async filename => {
    assert.equal(filename, target);
    const stat = await fs.lstat(filename);
    if (!stat.isFile() || stat.isSymbolicLink()) throw failure('UNSAFE_TARGET');
  };
  return { directory, target, validateTarget };
}
async function unchangedAndClean({ directory, target }) {
  assert.equal(await fs.readFile(target, 'utf8'), previous);
  assert.deepEqual(await fs.readdir(directory), ['experiment.json']);
}

test('Windows transient replacement failures retry the flushed file and revalidate every attempt', async t => {
  const value = await fixture(t), waits = [], order = [];
  let attempts = 0, validations = 0;
  const operations = { ...fs, rename: async (source, target) => {
    attempts++; order.push('rename');
    assert.equal(await fs.readFile(source, 'utf8'), replacement);
    assert.equal(await fs.readFile(target, 'utf8'), previous);
    if (attempts <= 3) throw failure(['EPERM', 'EACCES', 'EBUSY'][attempts - 1]);
    await fs.rename(source, target);
  }, unlink: async filename => { assert.notEqual(filename, value.target); await fs.unlink(filename); } };
  await atomicWriteProject(value.target, replacement, { operations, platform: 'win32',
    validateTarget: async filename => { validations++; order.push('validate'); await value.validateTarget(filename); },
    wait: async milliseconds => { waits.push(milliseconds); } });
  assert.deepEqual(waits, [25, 50, 100]); assert.equal(attempts, 4); assert.equal(validations, 5);
  assert.deepEqual(order, ['validate', 'validate', 'rename', 'validate', 'rename', 'validate', 'rename', 'validate', 'rename']);
  assert.equal(await fs.readFile(value.target, 'utf8'), replacement);
  assert.deepEqual(await fs.readdir(value.directory), ['experiment.json']);
});

test('exhausted Windows retries preserve original bytes and remove only their temporary file', async t => {
  const value = await fixture(t), waits = [];
  let attempts = 0;
  const operations = { ...fs, rename: async () => { attempts++; throw failure('EPERM'); },
    unlink: async filename => { assert.notEqual(filename, value.target); await fs.unlink(filename); } };
  await assert.rejects(atomicWriteProject(value.target, replacement, { operations, platform: 'win32',
    validateTarget: value.validateTarget, wait: async milliseconds => { waits.push(milliseconds); } }), { code: 'EPERM' });
  assert.equal(attempts, 6); assert.deepEqual(waits, [...WINDOWS_RETRY_DELAYS_MS]);
  assert.equal(waits.reduce((sum, duration) => sum + duration, 0), 775);
  await unchangedAndClean(value);
});

test('a target that becomes unsafe during a retry is rejected before another replacement', async t => {
  const value = await fixture(t);
  let attempts = 0, validations = 0, waited = false;
  await assert.rejects(atomicWriteProject(value.target, replacement, { platform: 'win32',
    operations: { ...fs, rename: async () => { attempts++; throw failure('EBUSY'); } },
    validateTarget: async filename => { validations++; if (waited) throw failure('UNSAFE_TARGET'); await value.validateTarget(filename); },
    wait: async () => { waited = true; } }), { code: 'UNSAFE_TARGET' });
  assert.equal(attempts, 1); assert.equal(validations, 3);
  await unchangedAndClean(value);
});

test('unrelated errors and non-Windows permission errors propagate without retries', async t => {
  for (const [platform, code] of [['win32', 'EIO'], ['linux', 'EPERM']]) {
    const value = await fixture(t);
    let attempts = 0, waits = 0;
    await assert.rejects(atomicWriteProject(value.target, replacement, { platform,
      operations: { ...fs, rename: async () => { attempts++; throw failure(code); } },
      validateTarget: value.validateTarget, wait: async () => { waits++; } }), { code });
    assert.equal(attempts, 1); assert.equal(waits, 0);
    await unchangedAndClean(value);
  }
});

test('a failed flush closes and removes the incomplete sibling without touching the old destination', async t => {
  const value = await fixture(t);
  let closed = false, renamed = false;
  const operations = { ...fs, open: async (...args) => {
    const handle = await fs.open(...args);
    return { writeFile: (...values) => handle.writeFile(...values), sync: async () => { throw failure('EIO'); },
      close: async () => { closed = true; await handle.close(); } };
  }, rename: async () => { renamed = true; } };
  await assert.rejects(atomicWriteProject(value.target, replacement, { operations, validateTarget: value.validateTarget }), { code: 'EIO' });
  assert.equal(closed, true); assert.equal(renamed, false);
  await unchangedAndClean(value);
});

test('a preexisting sibling stays untouched when exclusive creation fails', async t => {
  const value = await fixture(t);
  let existingSibling;
  const operations = {
    ...fs,
    async open(filename, flags, mode) {
      existingSibling = filename;
      assert.equal(mode, 0o600);
      await fs.writeFile(filename, 'existing sibling');
      return fs.open(filename, flags, mode);
    },
  };
  await assert.rejects(atomicWriteProject(value.target, replacement, { operations, validateTarget: value.validateTarget }), { code: 'EEXIST' });
  assert.equal(await fs.readFile(existingSibling, 'utf8'), 'existing sibling');
  assert.equal(await fs.readFile(value.target, 'utf8'), previous);
});

test('native saves create private files and preserve a distinct Windows destination DACL', async t => {
  const { directory, target } = await fixture(t);
  const newTarget = path.join(directory, '새 실험 [검사].json');
  const validateTarget = async filename => {
    try { assert.ok((await fs.lstat(filename)).isFile()); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  };

  const runPowerShell = script => {
    const command = Buffer.from("$ErrorActionPreference = 'Stop'\n" + script, 'utf16le').toString('base64');
    const result = spawnSync(windowsPowerShell(), ['-NoProfile', '-NonInteractive', '-EncodedCommand', command], {
      encoding: 'utf8', env: windowsPowerShellEnv({ ORBIT_ACL_EXISTING: target, ORBIT_ACL_NEW: newTarget }),
    });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const readDacl = "[IO.File]::GetAccessControl($env:ORBIT_ACL_EXISTING).GetSecurityDescriptorSddlForm('Access')";
  let originalDacl;
  if (process.platform === 'win32') {
    originalDacl = runPowerShell(`
      $acl = [IO.File]::GetAccessControl($env:ORBIT_ACL_EXISTING)
      $acl.SetAccessRuleProtection($true, $false)
      $user = [Security.Principal.WindowsIdentity]::GetCurrent().User
      $anonymous = [Security.Principal.SecurityIdentifier]::new('S-1-5-7')
      $acl.SetAccessRule([Security.AccessControl.FileSystemAccessRule]::new($user, 'FullControl', 'Allow'))
      $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($anonymous, 'ReadData', 'Deny'))
      [IO.File]::SetAccessControl($env:ORBIT_ACL_EXISTING, $acl)
      ${readDacl}
    `);
    assert.match(originalDacl, /^D:P.*\(D;/);
  }

  await atomicWriteProject(newTarget, replacement, { validateTarget });
  await atomicWriteProject(target, replacement, { validateTarget });
  assert.equal(await fs.readFile(newTarget, 'utf8'), replacement);
  assert.equal(await fs.readFile(target, 'utf8'), replacement);
  assert.deepEqual((await fs.readdir(directory)).sort(), ['experiment.json', '새 실험 [검사].json']);
  if (process.platform === 'win32') {
    assert.equal(runPowerShell(readDacl), originalDacl);
    const isPrivate = runPowerShell(`
      $acl = [IO.File]::GetAccessControl($env:ORBIT_ACL_NEW)
      $rules = $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])
      $user = [Security.Principal.WindowsIdentity]::GetCurrent().User
      $rules.Count -eq 1 -and $rules[0].IdentityReference -eq $user
    `);
    assert.equal(isPrivate, 'True');

    await fs.chmod(target, 0o444);
    try {
      await assert.rejects(atomicWriteProject(target, previous, { validateTarget }), /실험 파일을 저장할 수 없습니다/);
      assert.equal(await fs.readFile(target, 'utf8'), replacement);
      assert.equal(runPowerShell(readDacl), originalDacl);
      assert.deepEqual((await fs.readdir(directory)).sort(), ['experiment.json', '새 실험 [검사].json']);
    } finally {
      await fs.chmod(target, 0o600);
    }
  } else {
    for (const filename of [newTarget, target]) assert.equal((await fs.stat(filename)).mode & 0o077, 0);
  }
});
