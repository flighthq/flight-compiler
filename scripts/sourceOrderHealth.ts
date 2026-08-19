import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

import { rewriteImportBlock } from './importBlockWriter.js';
import { collectSourceOrderIssues } from './sourceOrdering.js';

// Reports the ordering rules AGENTS.md states and no formatter enforces. Every scanned file is
// counted in the summary so a clean run is readable as measured rather than as a walk that reached
// nothing.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packagesDirectory = path.join(root, 'packages');
const scriptsDirectory = path.join(root, 'scripts');
const errors: string[] = [];
const fixMode = process.argv.includes('--fix');
const rewritten: string[] = [];
const refused: string[] = [];

const packageSources = readdirSync(packagesDirectory, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => path.join(packagesDirectory, entry.name, 'src'))
  .filter((directory) => existsSync(directory))
  .flatMap((directory) => typeScriptFiles(directory));
const scriptSources = typeScriptFiles(scriptsDirectory);

// Exported functions are alphabetized in package source, where the file is a public surface a reader
// scans. Repository automation is exempt for the same reason it is exempt from the other package
// conventions: a script reads top to bottom as one task.
for (const file of packageSources) checkFile(file, true);
for (const file of scriptSources) checkFile(file, false);

for (const file of rewritten) process.stdout.write(`Ordered imports in ${file}.\n`);
// A refusal is printed rather than swallowed: the file still needs ordering, by hand.
for (const reason of refused) process.stderr.write(`Left alone because of ${reason}\n`);

if (errors.length > 0) {
  process.stderr.write(`Source order health failed with ${String(errors.length)} error(s):\n`);
  for (const error of errors) process.stderr.write(`- ${error}\n`);
  process.exit(1);
}

process.stdout.write(
  `Source order health passed for ${String(packageSources.length)} package sources and ${String(scriptSources.length)} scripts.\n`,
);

function checkFile(file: string, alphabetizeExports: boolean): void {
  let contents = readFileSync(file, 'utf8');
  let sourceFile = ts.createSourceFile(file, contents, ts.ScriptTarget.Latest, true, scriptKind(file));
  if (fixMode) {
    const rewrite = rewriteImportBlock(sourceFile, contents);
    if (rewrite.kind === 'ordered') {
      writeFileSync(file, rewrite.text);
      rewritten.push(relative(file));
      contents = rewrite.text;
      sourceFile = ts.createSourceFile(file, contents, ts.ScriptTarget.Latest, true, scriptKind(file));
    } else if (rewrite.kind === 'refused') {
      refused.push(`${relative(file)}: ${rewrite.reason}`);
    }
  }
  for (const issue of collectSourceOrderIssues(sourceFile, alphabetizeExports)) {
    errors.push(`${relative(file)}:${String(issue.line)} [${issue.rule}] ${issue.detail}`);
  }
}

function relative(file: string): string {
  return path.relative(root, file).replaceAll('\\', '/');
}

function scriptKind(file: string): ts.ScriptKind {
  return file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
}

function typeScriptFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...typeScriptFiles(target));
    else if (entry.isFile() && /\.tsx?$/u.test(entry.name)) files.push(target);
  }
  return files.sort();
}
