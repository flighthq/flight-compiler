import { readFileSync } from 'node:fs';
import path from 'node:path';

// The lock is the only place a sibling repository's identity is written down. Rehydration and every
// gate that reads a rehydrated checkout resolve paths through here, so a pin can never be half
// applied: one file names the repository, the branch it tracks, and the exact commit in use.

export interface PinnedDependency {
  readonly branch: string;
  readonly commit: string;
  readonly directory: string;
  readonly name: string;
  readonly repository: string;
}

export interface DependencyLock {
  readonly dependencies: readonly PinnedDependency[];
  readonly directory: string;
  readonly lockFile: string;
}

export function readDependencyLock(root: string): DependencyLock {
  const lockFile = path.join(root, 'dependencies.lock.json');
  const lock = JSON.parse(readFileSync(lockFile, 'utf8')) as {
    dependencies?: readonly { branch?: string; commit?: string; name?: string; repository?: string }[];
    directory?: string;
    schema?: string;
  };
  const failures: string[] = [];

  if (lock.schema !== SCHEMA) failures.push(`unsupported lock schema ${String(lock.schema)}, expected ${SCHEMA}`);
  if (typeof lock.directory !== 'string' || lock.directory.length === 0) {
    failures.push('lock does not name a rehydration directory');
  }
  if (!Array.isArray(lock.dependencies) || lock.dependencies.length === 0)
    failures.push('lock declares no dependencies');

  const dependencies: PinnedDependency[] = [];
  const seen = new Set<string>();
  let previous = '';
  for (const dependency of lock.dependencies ?? []) {
    const name = dependency.name ?? '';
    if (name.length === 0) failures.push('a dependency has no name');
    if (name < previous) failures.push('dependencies must be sorted by name');
    previous = name;
    if (seen.has(name)) failures.push(`duplicate dependency ${name}`);
    seen.add(name);
    if (!(dependency.repository ?? '').startsWith('https://')) {
      failures.push(`${name} must be pinned to an https repository`);
    }
    if (!COMMIT_PATTERN.test(dependency.commit ?? '')) {
      failures.push(`${name} is not pinned to a full 40-character commit`);
    }
    if ((dependency.branch ?? '').length === 0) failures.push(`${name} does not name a tracking branch`);
    dependencies.push({
      branch: dependency.branch ?? '',
      commit: dependency.commit ?? '',
      directory: path.join(root, lock.directory ?? '.dependencies', name),
      name,
      repository: dependency.repository ?? '',
    });
  }

  if (failures.length > 0) {
    process.stderr.write('dependencies.lock.json is invalid:\n');
    for (const failure of failures) process.stderr.write(`- ${failure}\n`);
    process.exit(1);
  }

  return { dependencies, directory: lock.directory ?? '', lockFile };
}

export function resolveDependency(root: string, name: string): PinnedDependency {
  const dependency = readDependencyLock(root).dependencies.find((entry) => entry.name === name);
  if (!dependency) throw new Error(`dependencies.lock.json does not pin ${name}`);
  return dependency;
}

const COMMIT_PATTERN = /^[0-9a-f]{40}$/u;
const SCHEMA = 'flight-dependency-lock/1';
