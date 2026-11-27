import path from 'node:path';
import { defineConfig, normalizePath } from 'vite';

const generated = '{output,release,dist,.security-stage-*,.security-write-*}';

export default defineConfig(({ command }) => ({
  base: './',
  define: { __ORBIT_TEST_BUILD__: command === 'serve' },
  server: {
    host: '127.0.0.1',
    port: 5250,
    strictPort: true,
    watch: { ignored: ['**/' + generated, '**/' + generated + '/**'] },
  },
  plugins: [{
    name: 'orbit-generated-files',
    config(config) {
      // Match the workspace's own output paths without hiding dependency dist directories.
      const root = normalizePath(path.resolve(config.root ?? '.')).replace(/[*?[\]{}()!]/g, '\\$&');
      const artifacts = root + '/' + generated;
      return { server: { fs: { deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', artifacts, artifacts + '/**'] } } };
    },
  }],
}));
