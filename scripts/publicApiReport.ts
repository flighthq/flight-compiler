import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

import { classifyPublicApiSymbol, formatPublicApiReport } from './publicApiSurface.js';
import type { PublicApiExport } from './publicApiSurface.js';

// `npm run api` writes the report; `npm run api:check` verifies the committed one still matches.
// Bare name writes, `:check` reports — the same read/write pairing `format` and `format:check` use.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const reportFile = path.join(root, 'api', 'tool-compiler.api.md');
const facade = path.join(root, 'packages', 'tool-compiler', 'src', 'index.ts');
const checkMode = process.argv.includes('--check');
const report = formatPublicApiReport(collectFacadeExports());

if (!checkMode) {
  writeFileSync(reportFile, report);
  process.stdout.write(`Wrote ${path.relative(root, reportFile).replaceAll('\\', '/')}.\n`);
  process.exit(0);
}

const committed = readReport();
if (committed === report) {
  process.stdout.write(`Public API report matches the facade (${String(report.split('\n').length)} lines).\n`);
  process.exit(0);
}

process.stderr.write('The public API report no longer matches the facade.\n');
for (const line of describeDifference(committed, report)) process.stderr.write(`- ${line}\n`);
process.stderr.write('Run `npm run api` and review the diff as a change to the published surface.\n');
process.exit(1);

function collectFacadeExports(): PublicApiExport[] {
  const configPath = path.join(root, 'tsconfig.json');
  const parsed = ts.getParsedCommandLineOfConfigFile(
    configPath,
    {},
    { ...ts.sys, onUnRecoverableConfigFileDiagnostic: fail },
  );
  if (!parsed) fail({ messageText: `Unable to parse ${configPath}` } as ts.Diagnostic);
  const program = ts.createProgram({ options: parsed.options, rootNames: [facade] });
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(facade);
  if (!source) {
    process.stderr.write(`The facade ${path.relative(root, facade)} is not in the program, so nothing was read.\n`);
    process.exit(1);
  }
  const moduleSymbol = checker.getSymbolAtLocation(source);
  if (!moduleSymbol) {
    process.stderr.write('The facade resolved to no module symbol, so nothing was read.\n');
    process.exit(1);
  }
  const exports = checker.getExportsOfModule(moduleSymbol).map((symbol) => ({
    kind: classifyPublicApiSymbol(symbol, checker),
    name: symbol.getName(),
  }));
  if (exports.length === 0) {
    process.stderr.write('The facade exported nothing, so this run measured nothing.\n');
    process.exit(1);
  }
  return exports;
}

// Names rather than a character diff: the reader needs to know which exports entered or left the
// published surface, not which table row moved.
function describeDifference(committed: string, current: string): string[] {
  const names = (report: string): Set<string> =>
    new Set([...report.matchAll(/^\| `(?<name>[^`]+)`/gmu)].map((match) => match.groups?.name ?? ''));
  const before = names(committed);
  const after = names(current);
  const added = [...after].filter((name) => !before.has(name)).sort();
  const removed = [...before].filter((name) => !after.has(name)).sort();
  const lines = [...added.map((name) => `added: ${name}`), ...removed.map((name) => `removed: ${name}`)];
  return lines.length > 0 ? lines : ['the export set is unchanged; the report body differs'];
}

function fail(diagnostic: ts.Diagnostic): never {
  process.stderr.write(`${ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}\n`);
  process.exit(1);
}

function readReport(): string {
  try {
    return readFileSync(reportFile, 'utf8');
  } catch {
    process.stderr.write(`No committed report at ${path.relative(root, reportFile)}. Run \`npm run api\`.\n`);
    process.exit(1);
  }
}
