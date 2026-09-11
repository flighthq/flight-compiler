import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

import { applyMutant, collectMutants } from './mutationOperators.js';
import type { Mutant } from './mutationOperators.js';

// Mutation testing as a reporting instrument, not a gate. It answers one question the coverage
// percentage cannot: whether the assertions that execute a line would notice if that line decided
// the opposite.
//
// It is deliberately not part of `npm run verify`. One mutant costs a whole Vitest start, so the
// instrument is minutes where the gates are seconds, and its output is a worklist for a human rather
// than a pass/fail claim. Run it against one package while working on that package.
//
// A surviving mutant is a question, not a defect. Some survivors are equivalent mutants that no test
// could distinguish; others mark an assertion that cannot fail. Both are worth reading, which is why
// every survivor is printed with its line and its exact substitution.

interface MutationTarget {
  readonly source: string;
  readonly test: string;
}

interface FileResult {
  readonly killed: number;
  readonly source: string;
  readonly survivors: readonly Mutant[];
  readonly timeouts: readonly Mutant[];
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packagesDirectory = path.join(root, 'packages');
const selector = process.argv[2];
const targets = collectTargets(selector);

if (targets.length === 0) {
  process.stderr.write(
    selector === undefined
      ? 'Mutation run selected no source files.\n'
      : `Mutation run selected no source files for '${selector}'. Name a package directory under packages/.\n`,
  );
  process.exit(1);
}

const vitest = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'vitest.cmd' : 'vitest');
const results: FileResult[] = [];

for (const target of targets) {
  const contents = readFileSync(target.source, 'utf8');
  const sourceFile = ts.createSourceFile(target.source, contents, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const mutants = collectMutants(sourceFile);
  const survivors: Mutant[] = [];
  const timeouts: Mutant[] = [];
  let killed = 0;
  process.stdout.write(`\n▶ ${relative(target.source)} (${String(mutants.length)} mutants)\n`);
  const baseline = measureBaseline(target, contents);
  for (const mutant of mutants) {
    // applyMutant throws when the substitution would not change the text, so a survivor can never be
    // the artefact of an edit that never happened.
    const mutated = applyMutant(contents, mutant);
    const outcome = runMutant(target, mutated, baseline.timeoutMs);
    if (outcome === 'green') {
      survivors.push(mutant);
      process.stdout.write(`  survived ${String(mutant.line)}: ${mutant.description} [${mutant.operator}]\n`);
    } else {
      killed += 1;
      if (outcome === 'timeout') {
        timeouts.push(mutant);
        process.stdout.write(`  timed out ${String(mutant.line)}: ${mutant.description} [${mutant.operator}]\n`);
      }
    }
  }
  results.push({ killed, source: target.source, survivors, timeouts });
}

const mutantCount = results.reduce((total, result) => total + result.killed + result.survivors.length, 0);
const survivorCount = results.reduce((total, result) => total + result.survivors.length, 0);
const timeoutCount = results.reduce((total, result) => total + result.timeouts.length, 0);
process.stdout.write(
  `\n${String(mutantCount)} mutants across ${String(results.length)} files: ${String(mutantCount - survivorCount)} killed, ${String(survivorCount)} survived.\n`,
);
if (timeoutCount > 0) {
  process.stdout.write(
    `${String(timeoutCount)} of the killed mutants timed out rather than failing an assertion. A timeout usually means the mutant made a loop non-terminating, which is worth reading: the surrounding termination condition is decided by that operator alone.\n`,
  );
}
if (mutantCount === 0) {
  process.stderr.write('No mutants were generated, so this run measured nothing.\n');
  process.exit(1);
}

function collectTargets(selected: string | undefined): MutationTarget[] {
  const packageNames = readdirSync(packagesDirectory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => selected === undefined || name === selected || name === `compiler-${selected}`)
    .sort();
  const targets: MutationTarget[] = [];
  for (const packageName of packageNames) {
    const sourceDirectory = path.join(packagesDirectory, packageName, 'src');
    if (!existsSync(sourceDirectory)) continue;
    for (const entry of readdirSync(sourceDirectory, { withFileTypes: true }).sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
      if (entry.name.endsWith('.test.ts') || entry.name === 'index.ts') continue;
      const source = path.join(sourceDirectory, entry.name);
      const test = source.replace(/\.ts$/u, '.test.ts');
      if (existsSync(test)) targets.push({ source, test });
    }
  }
  return targets;
}

function relative(file: string): string {
  return path.relative(root, file).replaceAll('\\', '/');
}

// A mutant can make a loop non-terminating, and without a deadline the run then hangs forever on one
// mutant rather than reporting it. The deadline is derived from the file's own unmutated run so it
// travels across machines: generous enough that a slow-but-passing test is never called killed, since
// a false kill hides a gap where a false survivor only wastes a reading.
function measureBaseline(target: Readonly<MutationTarget>, contents: string): { timeoutMs: number } {
  const started = process.hrtime.bigint();
  const outcome = runMutant(target, contents, undefined);
  const elapsedMs = Number((process.hrtime.bigint() - started) / 1_000_000n);
  if (outcome !== 'green') {
    process.stderr.write(
      `${relative(target.test)} does not pass against its own unmutated source, so every mutant would be reported killed and the run would measure nothing.\n`,
    );
    process.exit(1);
  }
  return { timeoutMs: Math.max(30_000, elapsedMs * 10) };
}

function runMutant(
  target: Readonly<MutationTarget>,
  mutated: string,
  timeoutMs: number | undefined,
): 'green' | 'red' | 'timeout' {
  const result = spawnSync(vitest, ['run', '--config', 'vitest.config.mutation.ts', relative(target.test)], {
    cwd: root,
    env: {
      ...process.env,
      FLIGHT_MUTATION_SOURCE: Buffer.from(mutated, 'utf8').toString('base64'),
      FLIGHT_MUTATION_TARGET: target.source,
    },
    stdio: 'ignore',
    ...(timeoutMs === undefined ? {} : { killSignal: 'SIGKILL' as const, timeout: timeoutMs }),
  });
  if (result.status === 0) return 'green';
  return result.signal === 'SIGKILL' || result.error?.name === 'ETIMEDOUT' ? 'timeout' : 'red';
}
