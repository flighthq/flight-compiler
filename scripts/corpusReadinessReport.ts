import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { analyzeCorpusRefusals } from './corpusRefusalAnalysis.js';
import type { CorpusRefusalLedger } from './corpusRefusalAnalysis.js';
import { resolveDependency } from './dependencyLock.js';

// How much of the Flight SDK corpus the compiler can actually emit, and which refusal families are
// holding back the rest.
//
// This is the corpus sibling of `npm run readiness`, and it answers the question that instrument
// cannot. Readiness reads the committed golden tree, which is a set of probes for behavior the
// compiler already has, so it reports a share near 100% and is blind to the SDK. The SDK corpus can
// only be generated downstream, because the request needs a target repository's package graph,
// package targets, and binding profiles; this reads the ledger that run leaves behind.
//
// Reading artifacts rather than generating keeps this instrument fast and keeps the C++ toolchain
// out of the loop, exactly as `readiness` reads its golden pins. The cost is that the number is
// frozen at whatever revision produced the ledger, so the report states that provenance and the
// distance to this checkout rather than presenting a stale figure as current.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arguments_ = process.argv.slice(2);
const json = arguments_.includes('--json');
const corpusOption = arguments_.find((argument) => argument.startsWith('--corpus='));
const unknownArguments = arguments_.filter((argument) => argument !== '--json' && !argument.startsWith('--corpus='));
if (unknownArguments.length > 0) {
  process.stderr.write(`Unknown corpus readiness option(s): ${unknownArguments.join(', ')}\n`);
  process.exit(1);
}

const corpusDirectory =
  corpusOption === undefined
    ? path.join(resolveDependency(root, 'flight-cpp').directory, 'generated')
    : path.resolve(root, corpusOption.slice('--corpus='.length));
const manifestFile = path.join(corpusDirectory, 'manifest.json');
const refusalFile = path.join(corpusDirectory, 'refusals.json');

if (!existsSync(manifestFile) || !existsSync(refusalFile)) {
  process.stdout.write(
    `No SDK corpus ledger at ${path.relative(root, corpusDirectory)} (skipped); run \`npm run rehydrate\`, or generate one downstream and pass \`--corpus=<directory>\`.\n`,
  );
  process.exit(0);
}

interface CorpusManifestSummary {
  readonly emittedModules: number;
  readonly packages: number;
  readonly refusedModules: number;
  readonly sourceModules: number;
}

const manifest = JSON.parse(readFileSync(manifestFile, 'utf8')) as {
  bindingProfiles?: readonly Readonly<{ identity: string }>[] | undefined;
  compiler?: Readonly<{ revision: string }> | undefined;
  source?: Readonly<{ revision: string; version: string }> | undefined;
  summary: CorpusManifestSummary;
};
const ledger = JSON.parse(readFileSync(refusalFile, 'utf8')) as CorpusRefusalLedger;
const analysis = analyzeCorpusRefusals(ledger);
const summary = manifest.summary;
const profiles = (manifest.bindingProfiles ?? []).map((profile) => profile.identity);
const compilerRevision = ledger.compilerRevision;
const commitsBehind = getCommitsBehind(compilerRevision);

if (json) {
  process.stdout.write(
    `${JSON.stringify(
      {
        compilerRevision,
        corpusDirectory: path.relative(root, corpusDirectory),
        commitsBehind: commitsBehind ?? null,
        emittedModules: summary.emittedModules,
        sourceRevision: ledger.sourceRevision,
        sourceModules: summary.sourceModules,
        schema: 'flight-compiler-corpus-readiness/1',
        ...analysis,
      },
      undefined,
      2,
    )}\n`,
  );
  process.exit(0);
}

const lines: string[] = [
  `Corpus readiness over ${String(summary.sourceModules)} source modules across ${String(summary.packages)} packages.`,
  `Ledger: ${path.relative(root, corpusDirectory)}, source @flighthq/sdk ${manifest.source?.version ?? 'unknown'} at ${shorten(ledger.sourceRevision)}.`,
  `Binding profiles: ${profiles.length === 0 ? 'none (portable floor)' : profiles.join(', ')}.`,
  '',
  `  emitted     ${String(summary.emittedModules).padStart(5)}  (${share(summary.emittedModules, summary.sourceModules)})`,
  `  refused     ${String(summary.refusedModules).padStart(5)}`,
  `    direct    ${String(analysis.directRefusals).padStart(5)}`,
  `    propagated${String(analysis.propagatedRefusals).padStart(5)}`,
  '',
  `  ${String(analysis.distinctRules)} distinct rules in ${String(analysis.families.length)} families; ${String(analysis.singletonFamilies)} families block exactly one module.`,
  '',
];

lines.push(
  commitsBehind === undefined
    ? `Ledger was produced by compiler revision ${shorten(compilerRevision)}, which this checkout cannot place; the number is not attributable to the current tree.`
    : commitsBehind === 0
      ? `Ledger was produced by this checkout (${shorten(compilerRevision)}); it reflects the current tree.`
      : `Ledger was produced by compiler revision ${shorten(compilerRevision)}, ${String(commitsBehind)} commit(s) behind this checkout. Regenerate downstream before reading a delta as this tree's work.`,
);
lines.push('');

lines.push('Families, ranked by modules blocked (direct refusals plus transitive dependents):');
lines.push('  direct  blocked  family');
for (const family of analysis.families) {
  lines.push(
    `  ${String(family.directModules).padStart(6)}  ${String(family.blockedDependents).padStart(7)}  ${family.family}`,
  );
}

const detailed = analysis.families.filter((family) => family.payloads.length > 0).slice(0, 6);
if (detailed.length > 0) {
  lines.push('', 'Most-blocked families, by the concrete payload each refusal named:');
  for (const family of detailed) {
    lines.push(`  ${family.family}`);
    for (const payload of family.payloads.slice(0, 8)) {
      lines.push(`    ${String(payload.count).padStart(4)}  ${payload.payload}`);
    }
    if (family.payloads.length > 8) {
      lines.push(`        … and ${String(family.payloads.length - 8)} more`);
    }
  }
}

lines.push(
  '',
  'A blocked count is a lower bound: the compiler records one dependency-refused edge per blocked',
  'module, so a module held back by several refused dependencies is counted once, against whichever',
  'edge its propagation reached first. Ranking is therefore directional, not exact.',
);

process.stdout.write(`${lines.join('\n')}\n`);

function share(part: number, whole: number): string {
  return whole === 0 ? '0.0%' : `${((part / whole) * 100).toFixed(1)}%`;
}

function shorten(revision: string): string {
  return revision.slice(0, 7);
}

// How far this checkout has moved past the revision that produced the ledger. An unknown revision
// and a non-ancestor both return undefined, because neither supports a distance claim.
function getCommitsBehind(revision: string): number | undefined {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', revision, 'HEAD'], { cwd: root, stdio: 'ignore' });
    const count = execFileSync('git', ['rev-list', '--count', `${revision}..HEAD`], {
      cwd: root,
      encoding: 'utf8',
    });
    return Number.parseInt(count.trim(), 10);
  } catch {
    return undefined;
  }
}
