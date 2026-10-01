import { readFileSync } from 'node:fs';
import path from 'node:path';

import { analyzeCompilerCheckTriage, readCompilerCheckTriageReport } from './compilerCheckTriage.js';

// Read an existing package-check artifact. This command never invokes compilation or writes a report.
//
//   npm run triage:findings -- <check-report.json> [--limit=10] [--json]

const arguments_ = process.argv.slice(2);
const json = arguments_.includes('--json');
const limitOption = arguments_.find((argument) => argument.startsWith('--limit='));
const positional = arguments_.filter((argument) => !argument.startsWith('--'));
const unknown = arguments_.filter(
  (argument) => argument.startsWith('--') && argument !== '--json' && !argument.startsWith('--limit='),
);
if (unknown.length > 0) {
  process.stderr.write(`Unknown compiler check triage option(s): ${unknown.join(', ')}\n`);
  process.exit(1);
}
if (positional.length !== 1) {
  process.stderr.write('Usage: npm run triage:findings -- <check-report.json> [--limit=10] [--json]\n');
  process.exit(1);
}
const limit = limitOption === undefined ? 10 : Number.parseInt(limitOption.slice('--limit='.length), 10);
if (!Number.isSafeInteger(limit) || limit < 1) {
  process.stderr.write('--limit must be a positive integer\n');
  process.exit(1);
}

const reportFile = path.resolve(positional[0]!);
const analysis = analyzeCompilerCheckTriage(
  readCompilerCheckTriageReport(JSON.parse(readFileSync(reportFile, 'utf8')) as unknown),
);
if (json) {
  process.stdout.write(`${JSON.stringify(analysis, undefined, 2)}\n`);
} else {
  const lines = [
    `Compiler check triage for ${analysis.backend}: ${String(analysis.directFindings)} direct finding(s), ${String(analysis.cascades)} dependency cascade(s).`,
    `Report: ${path.relative(process.cwd(), reportFile)}; upstream ${analysis.provenance.upstream.name}@${analysis.provenance.upstream.revision}.`,
    '',
    'Direct findings ranked by dependency-cascade fan-out:',
  ];
  for (const finding of analysis.rankedFindings.slice(0, limit)) {
    lines.push(
      `  ${String(finding.cascadeFanOut).padStart(4)} fan-out, ${String(finding.exclusivelyBlockedModules.length).padStart(4)} exclusively blocked; ${finding.owner}; ${finding.module}`,
      `       ${finding.rule}`,
      `       ${finding.identity}`,
    );
  }

  lines.push('', 'Equivalent missing-external-binding candidates ranked by exact modules unlocked:');
  for (const candidate of analysis.missingBindingCandidates.slice(0, limit)) {
    lines.push(
      `  ${String(candidate.modulesUnlocked.length).padStart(4)} unlocked, ${String(candidate.cascadeFanOut).padStart(4)} fan-out, ${String(candidate.directFindingIdentities.length).padStart(3)} finding(s); ${candidate.owner}`,
      `       bindings: ${candidate.bindings.join(', ')}`,
      `       direct modules: ${candidate.directModules.join(', ')}`,
      `       exact modules unlocked: ${candidate.modulesUnlocked.join(', ')}`,
    );
  }

  lines.push(
    '',
    'Fan-out is directional: every cascade that cites a finding contributes to its rank. Exact unlocks are',
    'stricter and include a module only when this candidate covers every non-source direct finding or every',
    'direct-finding identity recorded on that cascade.',
  );
  process.stdout.write(`${lines.join('\n')}\n`);
}
