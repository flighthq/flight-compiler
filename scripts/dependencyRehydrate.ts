import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readDependencyLock } from './dependencyLock.js';
import type { PinnedDependency } from './dependencyLock.js';

// Materializes the sibling repositories this one is pinned against into a gitignored directory.
//
// The runtime left this repository once its contract stopped changing every week, and the two now
// pin each other instead of sharing a tree. The checkouts are disposable build inputs, never sources
// of truth: nothing here is committed, and the pinned commit in `dependencies.lock.json` is the only
// thing that decides which revision a gate reads.
//
// `--check` is the non-writing mode, so CI can fail on a stale checkout instead of silently
// rehydrating one mid-run. `--update` re-pins each dependency to its tracking branch head.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const options = process.argv.slice(2);
const check = options.includes('--check');
const update = options.includes('--update');
const unknown = options.filter((option) => option !== '--check' && option !== '--update');
if (unknown.length > 0) {
  process.stderr.write(`Unknown rehydrate option(s): ${unknown.join(', ')}\n`);
  process.exit(1);
}
if (check && update) {
  process.stderr.write('--check reports and --update writes; they cannot be combined.\n');
  process.exit(1);
}

const { dependencies, lockFile } = readDependencyLock(root);
const failures: string[] = [];
const reports: string[] = [];

if (update) {
  const lock = JSON.parse(readFileSync(lockFile, 'utf8')) as {
    dependencies: { branch: string; commit: string; name: string; repository: string }[];
  };
  for (const dependency of lock.dependencies) {
    const remoteHead = resolveRemoteHead(dependency.repository, dependency.branch);
    if (!remoteHead) {
      failures.push(`${dependency.name} has no ${dependency.branch} on ${dependency.repository}`);
      continue;
    }
    reports.push(
      remoteHead === dependency.commit
        ? `${dependency.name} already at ${remoteHead.slice(0, 7)}`
        : `${dependency.name} ${dependency.commit.slice(0, 7)} -> ${remoteHead.slice(0, 7)}`,
    );
    dependency.commit = remoteHead;
  }
  if (failures.length === 0) writeFileSync(lockFile, `${JSON.stringify(lock, undefined, 2)}\n`);
} else {
  for (const dependency of dependencies) {
    const current = existsSync(path.join(dependency.directory, '.git')) ? head(dependency.directory) : undefined;
    if (current === dependency.commit) {
      reports.push(`${dependency.name} at ${dependency.commit.slice(0, 7)}`);
      continue;
    }
    if (check) {
      failures.push(
        current
          ? `${dependency.name} is at ${current.slice(0, 7)}, pinned to ${dependency.commit.slice(0, 7)}`
          : `${dependency.name} is not rehydrated`,
      );
      continue;
    }
    fetchDependency(dependency);
    reports.push(`${dependency.name} rehydrated at ${dependency.commit.slice(0, 7)}`);
  }
}

if (failures.length > 0) {
  process.stderr.write(`Dependency rehydration failed with ${String(failures.length)} error(s):\n`);
  for (const failure of failures) process.stderr.write(`- ${failure}\n`);
  if (check) process.stderr.write('Run `npm run rehydrate` to materialize the pinned checkouts.\n');
  process.exit(1);
}

process.stdout.write(`${reports.join(', ')}.\n`);

function attempt(command: string, argumentList: readonly string[], cwd: string): boolean {
  return spawnSync(command, [...argumentList], { cwd, encoding: 'utf8' }).status === 0;
}

function fetchDependency(dependency: PinnedDependency): void {
  mkdirSync(dependency.directory, { recursive: true });
  if (!existsSync(path.join(dependency.directory, '.git'))) {
    run('git', ['init', '--quiet'], dependency.directory);
    run('git', ['remote', 'add', 'origin', dependency.repository], dependency.directory);
  }
  // A pinned commit is reachable from its branch, so GitHub serves it directly and a depth of one
  // keeps a rehydration from paying for history no gate reads. A server that refuses a commit fetch
  // falls back to the branch, which still lands the exact revision after checkout.
  const fetched = attempt('git', ['fetch', '--depth', '1', 'origin', dependency.commit], dependency.directory);
  if (!fetched) run('git', ['fetch', 'origin', dependency.branch], dependency.directory);
  run('git', ['checkout', '--quiet', '--detach', dependency.commit], dependency.directory);
}

function head(directory: string): string | undefined {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: directory, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

function resolveRemoteHead(repository: string, branch: string): string | undefined {
  const result = spawnSync('git', ['ls-remote', repository, `refs/heads/${branch}`], { encoding: 'utf8' });
  if (result.status !== 0) return undefined;
  return /^(?<commit>[0-9a-f]{40})\s/u.exec(result.stdout.trim())?.groups?.commit;
}

function run(command: string, argumentList: readonly string[], cwd: string): void {
  const result = spawnSync(command, [...argumentList], { cwd, encoding: 'utf8', stdio: 'inherit' });
  if (result.status !== 0) {
    process.stderr.write(`\n${command} ${argumentList.join(' ')} failed in ${cwd}\n`);
    process.exit(1);
  }
}
