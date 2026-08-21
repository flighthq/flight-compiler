import path from 'node:path';

import ts from 'typescript';

import { compareTextCodeUnits, normalizePathPortable } from '../../compiler-canonical-form/src/index.js';
import type {
  AnalyzeFlightPackageImportsOptions,
  PackageImportRecord,
  WorkspaceSource,
} from '../../compiler-types/src/index.js';
import { createCompilerInventoryFailure } from './compilerInventoryFailure.js';

export function analyzeFlightPackageImports(
  options: Readonly<AnalyzeFlightPackageImportsOptions>,
  workspace: WorkspaceSource,
): readonly PackageImportRecord[] {
  const upstreamDirectory = path.resolve(options.upstreamDirectory);
  const packageDirectory = path.resolve(upstreamDirectory, options.manifest.directory);
  const relativePackageDirectory = path.relative(upstreamDirectory, packageDirectory);
  if (
    relativePackageDirectory === '' ||
    relativePackageDirectory === '..' ||
    relativePackageDirectory.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePackageDirectory)
  ) {
    throw createCompilerInventoryFailure(
      'invalid-package-directory',
      options.manifest.directory,
      `Package directory is outside upstream checkout: ${options.manifest.directory}`,
    );
  }

  const records = new Map<string, PackageImportRecord>();
  for (const file of walkProductionTypeScriptFiles(path.join(packageDirectory, 'src'), workspace)) {
    const source = ts.createSourceFile(
      file,
      workspace.readTextFile(file).replace(/^\uFEFF/u, ''),
      ts.ScriptTarget.Latest,
      true,
      file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const portableSource = normalizePathPortable(path.relative(upstreamDirectory, file));
    const add = (record: Omit<PackageImportRecord, 'source'>): void => {
      const complete = { ...record, source: portableSource };
      records.set(JSON.stringify([complete.source, complete.specifier, complete.kind, complete.typeOnly]), complete);
    };
    const visit = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        add({
          kind: 'import',
          specifier: node.moduleSpecifier.text,
          typeOnly: node.importClause?.isTypeOnly === true,
        });
      } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        add({ kind: 'reexport', specifier: node.moduleSpecifier.text, typeOnly: node.isTypeOnly });
      } else if (
        ts.isImportEqualsDeclaration(node) &&
        ts.isExternalModuleReference(node.moduleReference) &&
        node.moduleReference.expression &&
        ts.isStringLiteral(node.moduleReference.expression)
      ) {
        add({
          kind: 'importEquals',
          specifier: node.moduleReference.expression.text,
          typeOnly: node.isTypeOnly,
        });
      } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const argument = node.arguments[0];
        if (node.arguments.length !== 1 || !argument || !ts.isStringLiteral(argument)) {
          const position = source.getLineAndCharacterOfPosition(node.getStart(source));
          const subject = `${portableSource}:${String(position.line + 1)}:${String(position.character + 1)}`;
          throw createCompilerInventoryFailure(
            'unsupported-dynamic-import',
            subject,
            `Dynamic import requires one string literal in ${subject}`,
          );
        }
        add({ kind: 'dynamic', specifier: argument.text, typeOnly: false });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return [...records.values()].sort(comparePackageImportRecords);
}

function comparePackageImportRecords(
  left: Readonly<PackageImportRecord>,
  right: Readonly<PackageImportRecord>,
): number {
  return (
    compareTextCodeUnits(left.source, right.source) ||
    compareTextCodeUnits(left.specifier, right.specifier) ||
    compareTextCodeUnits(left.kind, right.kind) ||
    Number(left.typeOnly) - Number(right.typeOnly)
  );
}

function walkProductionTypeScriptFiles(directory: string, workspace: WorkspaceSource): string[] {
  if (!workspace.isDirectory(directory)) return [];
  const files: string[] = [];
  for (const entry of workspace.listDirectory(directory)) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory) files.push(...walkProductionTypeScriptFiles(target, workspace));
    else if (
      !entry.isDirectory &&
      /\.tsx?$/u.test(entry.name) &&
      !/\.(?:test|spec)\.tsx?$/u.test(entry.name) &&
      !entry.name.endsWith('.d.ts')
    ) {
      files.push(target);
    }
  }
  return files.sort(compareTextCodeUnits);
}
