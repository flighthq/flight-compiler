import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Rewrites the committed golden output. A wrapper rather than an inline environment assignment so
// the command works the same on Windows, where `NAME=value command` is not a shell construct.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vitest = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'vitest.cmd' : 'vitest');
const result = spawnSync(vitest, ['run', 'golden'], {
  cwd: root,
  env: { ...process.env, FLIGHT_GOLDEN_UPDATE: '1' },
  stdio: 'inherit',
});

process.exit(result.status ?? 1);
