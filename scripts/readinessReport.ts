import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveDependency } from './dependencyLock.js';
import { collectReadinessRuleCounts, parseReadinessRefusalRule } from './readinessRuleGrouping.js';
import type { ReadinessFixtureOutcome } from './readinessRuleGrouping.js';

// What fraction of the corpus each target can actually emit, and which rules block the rest.
//
// The source is the committed golden tree rather than a live compile: `golden:check` proves those
// pins match what the compiler does today, and reading artifacts keeps this instrument out of the
// package dependency graph. It reports; nothing gates on it.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const goldenDirectory = path.join(root, 'golden');
// The C++ profile is the runtime repository's declaration, so it is read from the pinned checkout
// when one is present. This instrument reports; an absent checkout costs it two labels, not a run.
const cppProfileFile = path.join(
  resolveDependency(root, 'flight-cpp').directory,
  'conformance',
  'portable-typescript-v1.json',
);
const cppProfile = existsSync(cppProfileFile)
  ? (JSON.parse(readFileSync(cppProfileFile, 'utf8')) as { profile: string; supportStatus: string })
  : undefined;
const targets = ['cpp', 'haxe', 'rust'] as const;
const json = process.argv.slice(2).includes('--json');
const unknownArguments = process.argv.slice(2).filter((argument) => argument !== '--json');
if (unknownArguments.length > 0) {
  process.stderr.write(`Unknown readiness option(s): ${unknownArguments.join(', ')}\n`);
  process.exit(1);
}
const fixtures = readdirSync(goldenDirectory, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(path.join(goldenDirectory, entry.name, 'input.ts')))
  .map((entry) => entry.name)
  .sort();

if (fixtures.length === 0) {
  process.stderr.write('No golden fixtures found; readiness cannot be reported from an empty corpus.\n');
  process.exit(1);
}

const outcomes: ReadinessFixtureOutcome[] = [];
for (const fixture of fixtures) {
  for (const target of targets) {
    const errorFile = path.join(goldenDirectory, fixture, `${target}.error.txt`);
    if (existsSync(errorFile)) {
      outcomes.push({
        fixture,
        rule: parseReadinessRefusalRule(readFileSync(errorFile, 'utf8').trimEnd()),
        target,
        verdict: 'refused',
      });
      continue;
    }
    outcomes.push({ fixture, target, verdict: 'emitted' });
  }
}

const targetReports = targets.map((target) => {
  const forTarget = outcomes.filter((outcome) => outcome.target === target);
  const emitted = forTarget.filter((outcome) => outcome.verdict === 'emitted').length;
  return {
    emitted,
    emissionShare: Number(((emitted / forTarget.length) * 100).toFixed(1)),
    ...(target === 'cpp' && cppProfile ? { profile: cppProfile.profile, supportStatus: cppProfile.supportStatus } : {}),
    refused: forTarget.length - emitted,
    target,
    total: forTarget.length,
  };
});

const divergent = fixtures.filter((fixture) => {
  const verdicts = targets.map(
    (target) => outcomes.find((outcome) => outcome.fixture === fixture && outcome.target === target)?.verdict,
  );
  return new Set(verdicts).size > 1;
});
const blockingRules = collectReadinessRuleCounts(outcomes);
if (json) {
  process.stdout.write(
    `${JSON.stringify(
      {
        blockingRules,
        corpusFixtures: fixtures.length,
        divergentFixtures: divergent,
        schema: 'flight-compiler-readiness/1',
        targets: targetReports,
      },
      null,
      2,
    )}\n`,
  );
  process.exit(0);
}

const lines: string[] = [`Emission readiness over ${String(fixtures.length)} golden fixtures.`, ''];
for (const report of targetReports) {
  lines.push(
    `${report.target}: ${String(report.emitted)}/${String(report.total)} emit (${report.emissionShare.toFixed(1)}%)${'profile' in report ? `; ${report.profile} is ${report.supportStatus}` : ''}`,
  );
}

lines.push('', `Divergent fixtures, where targets disagree on emit vs. refuse: ${String(divergent.length)}`);
for (const fixture of divergent) lines.push(`  ${fixture}`);

lines.push('', 'Blocking rules, most fixtures first:');
for (const entry of blockingRules) {
  lines.push(`  ${String(entry.fixtures.length).padStart(2)} ${entry.target}  ${entry.rule}`);
  lines.push(`     ${entry.fixtures.join(', ')}`);
}

process.stdout.write(`${lines.join('\n')}\n`);
