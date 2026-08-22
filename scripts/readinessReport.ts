import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { collectReadinessRuleCounts, parseReadinessRefusalRule } from './readinessRuleGrouping.js';
import type { ReadinessFixtureOutcome } from './readinessRuleGrouping.js';

// What fraction of the corpus each target can actually emit, and which rules block the rest.
//
// The source is the committed golden tree rather than a live compile: `golden:check` proves those
// pins match what the compiler does today, and reading artifacts keeps this instrument out of the
// package dependency graph. It reports; nothing gates on it.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const goldenDirectory = path.join(root, 'golden');
const targets = ['haxe', 'rust'] as const;
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

const lines: string[] = [`Readiness over ${String(fixtures.length)} golden fixtures.`, ''];
for (const target of targets) {
  const forTarget = outcomes.filter((outcome) => outcome.target === target);
  const emitted = forTarget.filter((outcome) => outcome.verdict === 'emitted').length;
  const share = ((emitted / forTarget.length) * 100).toFixed(1);
  lines.push(`${target}: ${String(emitted)}/${String(forTarget.length)} emit (${share}%)`);
}

const divergent = fixtures.filter((fixture) => {
  const verdicts = targets.map(
    (target) => outcomes.find((outcome) => outcome.fixture === fixture && outcome.target === target)?.verdict,
  );
  return verdicts[0] !== verdicts[1];
});
lines.push('', `Divergent fixtures, where one target emits and the other refuses: ${String(divergent.length)}`);
for (const fixture of divergent) lines.push(`  ${fixture}`);

lines.push('', 'Blocking rules, most fixtures first:');
for (const entry of collectReadinessRuleCounts(outcomes)) {
  lines.push(`  ${String(entry.fixtures.length).padStart(2)} ${entry.target}  ${entry.rule}`);
  lines.push(`     ${entry.fixtures.join(', ')}`);
}

process.stdout.write(`${lines.join('\n')}\n`);
