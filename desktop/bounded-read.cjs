async function readBounded(handle, maxBytes) {
  const buffer = Buffer.allocUnsafe(maxBytes + 1);
  let total = 0;
  while (total <= maxBytes) {
    const { bytesRead } = await handle.read(buffer, total, Math.min(64 * 1024, buffer.length - total), total);
    if (bytesRead === 0) return buffer.subarray(0, total);
    total += bytesRead;
  }
  throw new Error('실험 파일은 10 MiB 이하여야 합니다.');
}

module.exports = { readBounded };
