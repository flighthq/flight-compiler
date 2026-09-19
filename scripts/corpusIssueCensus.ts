import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  collectCorpusFoundations,
  collectCorpusIssueGroups,
  collectCorpusIssueLaneTotals,
  createCorpusIssueFingerprint,
  isCorpusRefusalCascade,
} from './corpusIssueAnalysis.js';
import type { CorpusCompilationRecord, CorpusPackageSummary } from './corpusIssueAnalysis.js';
import { describeCorpusIssueLane } from './corpusIssueLane.js';
import type { CorpusRefusalLedger } from './corpusRefusalAnalysis.js';
import { resolveDependency } from './dependencyLock.js';

// How many distinct issues the SDK corpus reports, who owns each one, and what a change did to that set.
//
// `npm run readiness:corpus` ranks refusal families by the modules they block. This counts the issues
// instead, because a module count is the wrong unit for planning: it moves only when a fix happens to
// unblock a whole module, so it reads as progress that is not there and hides progress that is. The
// fingerprints at the top change when the SET of issues changes, so a change that turns one refusal into
// a different one is visible even though every total holds.
//
// It reads the ledgers a downstream run already wrote and performs no generation and no compilation, so
// refreshing it is free. The cost is that the numbers are frozen at whatever revision produced the
// ledger, which is why the report states the provenance rather than presenting a stale figure as current.
//
// A foundational identity is a package name, or a source path suffix such as `src/entity.ts`. Entity,
// node, and host roots sit underneath most of the graph, so their issues are the most transitive and the
// easiest to lose inside a larger family's count.
//
// Prints by default; `--out=<file>` also writes it. Reads only, so it is safe to run at any time.
//
//   npm run readiness:issues [-- --json] [-- --foundation=<package|module>]...
//     [-- --corpus=<directory>] [-- --compile=<report.json>] [-- --out=<file>]

const defaultFoundations = ['@flighthq/entity', '@flighthq/host', '@flighthq/node'] as const;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arguments_ = process.argv.slice(2);
const json = arguments_.includes('--json');
const option = (name: string): string | undefined =>
  arguments_.find((argument) => argument.startsWith(`--${name}=`))?.slice(name.length + 3);
const foundations = arguments_
  .filter((argument) => argument.startsWith('--foundation='))
  .map((argument) => argument.slice('--foundation='.length));
const known = /^--(corpus|compile|foundation|out)=|^--json$/u;
const unknown = arguments_.filter((argument) => !known.test(argument));
if (unknown.length > 0) {
  process.stderr.write(`Unknown corpus issue census option(s): ${unknown.join(', ')}\n`);
  process.exit(1);
}

const corpusOption = option('corpus');
const corpusDirectory =
  corpusOption === undefined
    ? path.join(resolveDependency(root, 'flight-cpp').directory, 'generated')
    : path.resolve(root, corpusOption);
const compileOption = option('compile');
const compileFile =
  compileOption === undefined
    ? path.join(resolveDependency(root, 'flight-cpp').directory, 'out', 'sdk-sdl-header-compilation.json')
    : path.resolve(root, compileOption);
// Written only when asked. Printing is the default so running this cannot dirty a working tree, and the
// report is regenerable from the ledgers at any time.
const outputOption = option('out');
const outputFile = outputOption === undefined ? undefined : path.resolve(root, outputOption);

const manifestFile = path.join(corpusDirectory, 'manifest.json');
const refusalFile = path.join(corpusDirectory, 'refusals.json');
for (const file of [manifestFile, refusalFile]) {
  if (!existsSync(file)) {
    process.stderr.write(
      `Corpus issue census needs ${file}, which a downstream SDK run writes. ` +
        `Pass --corpus=<directory> to point at one.\n`,
    );
    process.exit(1);
  }
}

const ledger = JSON.parse(readFileSync(refusalFile, 'utf8')) as Readonly<CorpusRefusalLedger>;
const manifest = JSON.parse(readFileSync(manifestFile, 'utf8')) as Readonly<{
  packages: readonly Readonly<CorpusPackageSummary>[];
  source: Readonly<{ revision: string }>;
  summary: Readonly<{ emittedModules: number; refusedModules: number; sourceModules: number }>;
}>;
const compilation: Readonly<{
  failures: readonly Readonly<CorpusCompilationRecord>[];
  summary: Readonly<{ failedHeaders: number; passedHeaders: number; totalHeaders: number }>;
}> = existsSync(compileFile)
  ? (JSON.parse(readFileSync(compileFile, 'utf8')) as never)
  : { failures: [], summary: { failedHeaders: 0, passedHeaders: 0, totalHeaders: 0 } };

const refusalGroups = collectCorpusIssueGroups(
  ledger.refusals
    .filter((record) => !isCorpusRefusalCascade(record.reason))
    .map((record) => ({ identity: `${record.module}:${String(record.line ?? 0)}`, message: record.reason })),
);
const compileGroups = collectCorpusIssueGroups(
  compilation.failures.map((record) => ({ identity: record.header, message: record.diagnostic })),
);
const cascades =
  ledger.refusals.length - ledger.refusals.filter((record) => !isCorpusRefusalCascade(record.reason)).length;
const laneTotals = collectCorpusIssueLaneTotals([...refusalGroups, ...compileGroups]);
const foundationReports = collectCorpusFoundations(
  manifest.packages,
  ledger.refusals,
  foundations.length > 0 ? foundations : [...defaultFoundations],
);

const report = {
  schema: 'flight-corpus-issue-census/1',
  compileFingerprint: createCorpusIssueFingerprint(compileGroups),
  provenance: { compilerRevision: ledger.compilerRevision, sourceRevision: manifest.source.revision },
  refusalFingerprint: createCorpusIssueFingerprint(refusalGroups),
  summary: {
    cascadeRefusals: cascades,
    compileIssues: compileGroups.length,
    compiling: compilation.summary.passedHeaders,
    distinctIssues: refusalGroups.length + compileGroups.length,
    emitted: manifest.summary.emittedModules,
    refusalIssues: refusalGroups.length,
    refused: manifest.summary.refusedModules,
    source: manifest.summary.sourceModules,
    totalHeaders: compilation.summary.totalHeaders,
  },
  foundations: foundationReports,
  lanes: laneTotals,
  compile: compileGroups,
  refusals: refusalGroups,
};

if (json) {
  process.stdout.write(`${JSON.stringify(report, undefined, 2)}\n`);
} else {
  const lines = [
    '# Corpus issue census',
    '',
    `Source ${report.provenance.sourceRevision.slice(0, 7)}, compiler ${report.provenance.compilerRevision.slice(0, 7)}.`,
    `Refusal fingerprint ${report.refusalFingerprint}, compile fingerprint ${report.compileFingerprint}.`,
    'A fingerprint changes only when the SET of distinct issues changes, so it answers "did that do',
    'anything" in one comparison. The compiler reports only the FIRST refusal per module, so the issue',
    'count is a floor and not a total.',
    '',
    `DISTINCT ISSUES ${String(report.summary.distinctIssues)} = ${String(report.summary.refusalIssues)} direct refusals + ${String(report.summary.compileIssues)} compile failures`,
    `modules   ${String(report.summary.source)} total, ${String(report.summary.emitted)} emitted, ${String(report.summary.refused)} refused`,
    `cascades  ${String(report.summary.cascadeRefusals)} refused modules only inherit a dependency's refusal; they are not separate issues`,
    `headers   ${String(report.summary.compiling)}/${String(report.summary.totalHeaders)} compile`,
    '',
    '## Who owns what',
    '',
    '| lane | issues | occurrences | what it means |',
    '| --- | --- | --- | --- |',
    ...laneTotals.map(
      (total) =>
        `| ${total.lane} | ${String(total.issues)} | ${String(total.occurrences)} | ${describeCorpusIssueLane(total.lane)} |`,
    ),
    '',
    '## Foundations',
    '',
  ];
  for (const foundation of foundationReports) {
    lines.push(
      `${foundation.identity}: ${String(foundation.sourceModules)} modules, ${String(foundation.emittedModules)} emitted, ${String(foundation.refusedModules)} refused; ${String(foundation.issues.length)} direct issue(s)`,
    );
    for (const issue of foundation.issues.slice(0, 5)) {
      lines.push(`  ${String(issue.count).padStart(3)}  ${issue.key.slice(0, 100)}`);
    }
  }
  lines.push('', '## Compile issues (emitted code the target rejects)', '');
  for (const group of compileGroups) {
    lines.push(`- ${String(group.occurrences).padStart(4)}  ${group.key}`);
    lines.push(`        e.g. ${group.identities.slice(0, 3).join(', ')}`);
  }
  lines.push('', '## Direct refusal issues (emission declined; the module has no output)', '');
  for (const group of refusalGroups) {
    lines.push(`- ${String(group.occurrences).padStart(4)}  ${group.key}`);
    lines.push(`        e.g. ${group.identities.slice(0, 3).join(', ')}`);
  }
  const text = `${lines.join('\n')}\n`;
  if (outputFile !== undefined) {
    mkdirSync(path.dirname(outputFile), { recursive: true });
    writeFileSync(outputFile, text);
  }
  process.stdout.write(text);
}
