import { readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const directories = [path.join(root, 'dist')];
if (!process.argv.includes('--dist-only')) directories.push(path.join(root, 'coverage'));
for (const directory of directories) {
  rmSync(directory, { force: true, recursive: true });
}

for (const entry of readdirSync(path.join(root, 'packages'), { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const packageDirectory = path.join(root, 'packages', entry.name);
  rmSync(path.join(packageDirectory, 'dist'), { force: true, recursive: true });
  for (const child of readdirSync(packageDirectory, { withFileTypes: true })) {
    if (child.isFile() && child.name.endsWith('.tsbuildinfo')) {
      rmSync(path.join(packageDirectory, child.name), { force: true });
    }
  }
}
