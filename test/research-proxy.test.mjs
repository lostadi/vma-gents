import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('guest research proxy preserves opaque streams within bounded relay resources', async () => {
  await promisify(execFile)('python3', ['-B', fileURLToPath(new URL('./research-proxy.test.py', import.meta.url))], {
    timeout: 15000,
    maxBuffer: 65536,
  });
});
