import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vitest = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'vitest.cmd' : 'vitest');
const result = spawnSync(vitest, ['run', 'packages/compiler-backend-cpp/src/cppCompilerBackend.test.ts'], {
  cwd: root,
  env: { ...process.env, FLIGHT_CPP_CONFORMANCE_UPDATE: '1' },
  stdio: 'inherit',
});

process.exit(result.status ?? 1);
