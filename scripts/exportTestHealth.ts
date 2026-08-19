import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

import { collectDescribeNames, collectExportedApiDeclarations } from './packageHealthAst.js';

interface SourceTestRecord {
  exportedFunctions: readonly string[];
  source: string;
  test: string;
}

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packagesDirectory = path.join(repositoryRoot, 'packages');
const errors: string[] = [];
const records = collectSourceTestRecords();

for (const record of records) {
  if (!existsSync(record.test)) {
    errors.push(`${relative(record.source)}: missing matching ${path.basename(record.test)}`);
    continue;
  }
  const testSource = parseTypeScriptFile(record.test);
  const describeNames = collectDescribeNames(testSource);
  for (const functionName of record.exportedFunctions) {
    if (!describeNames.has(functionName)) {
      errors.push(`${relative(record.test)}: missing describe('${functionName}', ...)`);
    }
  }
}

if (errors.length > 0) {
  process.stderr.write(`Export test health failed with ${String(errors.length)} error(s):\n`);
  for (const error of errors) process.stderr.write(`- ${error}\n`);
  process.exit(1);
}

const exportedFunctions = records.reduce((total, record) => total + record.exportedFunctions.length, 0);
process.stdout.write(
  `Export test health passed for ${String(records.length)} source files and ${String(exportedFunctions)} exported functions.\n`,
);

function collectSourceTestRecords(): SourceTestRecord[] {
  const records: SourceTestRecord[] = [];
  for (const packageEntry of readdirSync(packagesDirectory, { withFileTypes: true })) {
    if (!packageEntry.isDirectory() || packageEntry.name === 'compiler-types') continue;
    const sourceDirectory = path.join(packagesDirectory, packageEntry.name, 'src');
    if (!existsSync(sourceDirectory)) continue;
    for (const entry of readdirSync(sourceDirectory, { withFileTypes: true })) {
      if (
        !entry.isFile() ||
        !entry.name.endsWith('.ts') ||
        entry.name.endsWith('.test.ts') ||
        entry.name.endsWith('.d.ts') ||
        entry.name === 'index.ts'
      ) {
        continue;
      }
      const source = path.join(sourceDirectory, entry.name);
      const sourceFile = parseTypeScriptFile(source);
      records.push({
        exportedFunctions: collectExportedApiDeclarations(sourceFile)
          .filter((declaration) => declaration.kind === 'function')
          .map((declaration) => declaration.name),
        source,
        test: source.replace(/\.ts$/u, '.test.ts'),
      });
    }
  }
  return records.sort((left, right) => left.source.localeCompare(right.source));
}

function parseTypeScriptFile(file: string): ts.SourceFile {
  return ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function relative(file: string): string {
  return path.relative(repositoryRoot, file).replaceAll('\\', '/');
}
