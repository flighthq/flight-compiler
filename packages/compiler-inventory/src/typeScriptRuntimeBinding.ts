import ts from 'typescript';

import { compareTextCodeUnits } from '../../compiler-canonical-form/src/index.js';
import type { RuntimeExportDecision } from '../../compiler-types/src/index.js';
import { createCompilerInventoryFailure } from './compilerInventoryFailure.js';

export function analyzeTypeScriptSourceRuntimeExports(
  source: ts.SourceFile,
  checker: ts.TypeChecker,
  options: ts.CompilerOptions,
): ReadonlyMap<string, RuntimeExportDecision> {
  const module = checker.getSymbolAtLocation(source);
  if (!module) {
    throw createCompilerInventoryFailure(
      'runtime-export-classification',
      source.fileName,
      `Cannot resolve TypeScript module symbol: ${source.fileName}`,
    );
  }
  const decisions = new Map<string, RuntimeExportDecision>();
  const exports = [...checker.getExportsOfModule(module)].sort((left, right) =>
    compareTextCodeUnits(left.getName(), right.getName()),
  );
  for (const exported of exports) {
    if (isTypeScriptExportExplicitlyTypeOnly(exported)) {
      decisions.set(exported.getName(), { runtime: false });
      continue;
    }
    const target = exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
    const declaration = getTypeScriptSymbolRuntimeBindingDeclaration(target, options);
    decisions.set(exported.getName(), declaration ? { declaration, runtime: true } : { runtime: false });
  }
  return decisions;
}

export function getTypeScriptSymbolRuntimeBindingDeclaration(
  symbol: ts.Symbol,
  options: ts.CompilerOptions,
): ts.Declaration | ts.SourceFile | undefined {
  if (!(symbol.flags & ts.SymbolFlags.Value)) return undefined;
  const declarations = symbol.declarations ?? [];
  const valueDeclaration = symbol.valueDeclaration;
  if (valueDeclaration && hasTypeScriptDeclarationRuntimeBinding(valueDeclaration, options)) return valueDeclaration;
  return declarations.find((declaration) => hasTypeScriptDeclarationRuntimeBinding(declaration, options));
}

export function hasTypeScriptDeclarationRuntimeBinding(
  declaration: ts.Declaration | ts.SourceFile,
  options: ts.CompilerOptions,
): boolean {
  if (ts.isSourceFile(declaration)) return !declaration.isDeclarationFile;
  if (isAmbientDeclaration(declaration)) return false;
  if (ts.isFunctionDeclaration(declaration)) return declaration.body !== undefined;
  if (ts.isEnumDeclaration(declaration)) {
    const constEnum = hasModifier(declaration, ts.SyntaxKind.ConstKeyword);
    return !constEnum || options.preserveConstEnums === true || options.isolatedModules === true;
  }
  return (
    ts.isClassDeclaration(declaration) ||
    ts.isVariableDeclaration(declaration) ||
    ts.isModuleDeclaration(declaration) ||
    ts.isExportAssignment(declaration)
  );
}

export function isTypeScriptExportExplicitlyTypeOnly(symbol: ts.Symbol): boolean {
  const declarations = (symbol.declarations ?? []).filter(
    (declaration): declaration is ts.ExportSpecifier | ts.NamespaceExport =>
      ts.isExportSpecifier(declaration) || ts.isNamespaceExport(declaration),
  );
  return declarations.length > 0 && declarations.every((declaration) => exportDeclarationIsTypeOnly(declaration));
}

function exportDeclarationIsTypeOnly(declaration: ts.ExportSpecifier | ts.NamespaceExport): boolean {
  if (ts.isExportSpecifier(declaration) && declaration.isTypeOnly) return true;
  const exportDeclaration = declaration.parent.parent;
  return ts.isExportDeclaration(exportDeclaration) && exportDeclaration.isTypeOnly;
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node) && ts.getModifiers(node)?.some((modifier) => modifier.kind === kind) === true;
}

function isAmbientDeclaration(declaration: ts.Declaration): boolean {
  for (let current: ts.Node | undefined = declaration; current && !ts.isSourceFile(current); current = current.parent) {
    if (ts.canHaveModifiers(current) && hasModifier(current, ts.SyntaxKind.DeclareKeyword)) return true;
  }
  return declaration.getSourceFile().isDeclarationFile;
}
