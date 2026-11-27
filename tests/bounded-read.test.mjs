import test from 'node:test';
import assert from 'node:assert/strict';
import { readBounded } from '../desktop/bounded-read.cjs';

test('bounded reads handle short reads and accept a file at the exact limit', async () => {
  const contents = Buffer.from('fixture');
  const handle = {
    async read(buffer, offset, length, position) {
      const bytesRead = contents.copy(buffer, offset, position, Math.min(position + length, position + 2));
      return { bytesRead };
    },
  };
  assert.deepEqual(await readBounded(handle, contents.length), contents);
});

test('a file that grows before reading is stopped after the first excess byte', async () => {
  const limit = 64 * 1024;
  let bytesRead = 0;
  const handle = {
    async read(buffer, offset, length, position) {
      assert.equal(position, bytesRead);
      assert.ok(position + length <= limit + 1);
      buffer.fill(32, offset, offset + length);
      bytesRead += length;
      return { bytesRead: length };
    },
  };
  await assert.rejects(readBounded(handle, limit), /10 MiB/);
  assert.equal(bytesRead, limit + 1);
});
