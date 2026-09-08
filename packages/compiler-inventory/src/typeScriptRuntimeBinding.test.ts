import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import ts from 'typescript';

import { isCompilerInventoryFailure } from './compilerInventoryFailure.js';
import { createTypeScriptProject } from './typeScriptProject.js';
import {
  analyzeTypeScriptSourceRuntimeExports,
  getTypeScriptSymbolRuntimeBindingDeclaration,
  hasTypeScriptDeclarationRuntimeBinding,
  isTypeScriptExportExplicitlyTypeOnly,
} from './typeScriptRuntimeBinding.js';

describe('analyzeTypeScriptSourceRuntimeExports', () => {
  it('classifies exports and orders their identities by code unit rather than locale', () => {
    withProject(({ checker, options, source }) => {
      const decisions = analyzeTypeScriptSourceRuntimeExports(source, checker, options);

      expect([...decisions.keys()]).toEqual(['ConstMode', 'Mode', 'Shape', 'Zulu', 'alpha', 'value', 'éclair']);
      expect(decisions.get('value')).toMatchObject({ runtime: true });
      expect(decisions.get('Mode')).toMatchObject({ runtime: true });
      expect(decisions.get('ConstMode')).toEqual({ runtime: false });
      expect(decisions.get('Shape')).toEqual({ runtime: false });
    });
  });

  it('fails with a tagged classification error when the checker has no module symbol', () => {
    const source = ts.createSourceFile('/value.ts', 'export const value = 1;', ts.ScriptTarget.Latest, true);
    const checker = { getSymbolAtLocation: () => undefined } as unknown as ts.TypeChecker;
    let failure: unknown;

    try {
      analyzeTypeScriptSourceRuntimeExports(source, checker, {});
    } catch (error) {
      failure = error;
    }

    expect(isCompilerInventoryFailure(failure)).toBe(true);
    expect(failure).toMatchObject({
      code: 'runtime-export-classification',
      kind: 'compiler-inventory',
      subject: '/value.ts',
    });
  });
});

describe('getTypeScriptSymbolRuntimeBindingDeclaration', () => {
  it('returns the concrete value declaration and a sentinel for type-only symbols', () => {
    withProject(({ checker, options, valueSource }) => {
      const module = checker.getSymbolAtLocation(valueSource);
      if (!module) throw new Error('Expected value module symbol');
      const exports = new Map(checker.getExportsOfModule(module).map((symbol) => [symbol.getName(), symbol]));

      const valueDeclaration = getTypeScriptSymbolRuntimeBindingDeclaration(exports.get('value')!, options);
      const shapeDeclaration = getTypeScriptSymbolRuntimeBindingDeclaration(exports.get('Shape')!, options);

      expect(ts.isVariableDeclaration(valueDeclaration!)).toBe(true);
      expect(shapeDeclaration).toBeUndefined();
    });
  });
});

describe('hasTypeScriptDeclarationRuntimeBinding', () => {
  it('distinguishes emitted declarations, ambient declarations, source files, and const-enum options', () => {
    const source = ts.createSourceFile(
      '/value.ts',
      'export const value = 1; export function read() {} export interface Shape {} export const enum Mode { A }',
      ts.ScriptTarget.Latest,
      true,
    );
    const [variableStatement, function_, interface_, constEnum] = source.statements;
    const declarationFile = ts.createSourceFile(
      '/value.d.ts',
      'export declare const value: number;',
      ts.ScriptTarget.Latest,
      true,
    );
    if (
      !variableStatement ||
      !ts.isVariableStatement(variableStatement) ||
      !function_ ||
      !ts.isFunctionDeclaration(function_) ||
      !interface_ ||
      !ts.isInterfaceDeclaration(interface_) ||
      !constEnum ||
      !ts.isEnumDeclaration(constEnum)
    ) {
      throw new Error('Expected declaration fixtures');
    }
    const variable = variableStatement.declarationList.declarations[0];
    if (!variable) throw new Error('Expected variable declaration fixture');

    expect(hasTypeScriptDeclarationRuntimeBinding(source, {})).toBe(true);
    expect(hasTypeScriptDeclarationRuntimeBinding(declarationFile, {})).toBe(false);
    expect(hasTypeScriptDeclarationRuntimeBinding(variable!, {})).toBe(true);
    expect(hasTypeScriptDeclarationRuntimeBinding(function_!, {})).toBe(true);
    expect(hasTypeScriptDeclarationRuntimeBinding(interface_!, {})).toBe(false);
    expect(hasTypeScriptDeclarationRuntimeBinding(constEnum!, {})).toBe(false);
    expect(hasTypeScriptDeclarationRuntimeBinding(constEnum!, { preserveConstEnums: true })).toBe(true);
    expect(hasTypeScriptDeclarationRuntimeBinding(constEnum!, { isolatedModules: true })).toBe(true);
  });

  it('rejects ambient declarations within a non-declaration source file', () => {
    const source = ts.createSourceFile(
      '/ambient.ts',
      'declare const external: number; export const value = external;',
      ts.ScriptTarget.Latest,
      true,
    );
    const [declareStatement, variableStatement] = source.statements;
    if (
      !declareStatement ||
      !ts.isVariableStatement(declareStatement) ||
      !variableStatement ||
      !ts.isVariableStatement(variableStatement)
    ) {
      throw new Error('Expected ambient declaration fixtures');
    }
    const ambient = declareStatement.declarationList.declarations[0]!;
    const concrete = variableStatement.declarationList.declarations[0]!;

    expect(hasTypeScriptDeclarationRuntimeBinding(ambient, {})).toBe(false);
    expect(hasTypeScriptDeclarationRuntimeBinding(concrete, {})).toBe(true);
  });
});

describe('isTypeScriptExportExplicitlyTypeOnly', () => {
  it('recognizes explicit type-only aliases without misclassifying value aliases', () => {
    withProject(({ checker, source }) => {
      const module = checker.getSymbolAtLocation(source);
      if (!module) throw new Error('Expected index module symbol');
      const exports = new Map(checker.getExportsOfModule(module).map((symbol) => [symbol.getName(), symbol]));

      expect(isTypeScriptExportExplicitlyTypeOnly(exports.get('Shape')!)).toBe(true);
      expect(isTypeScriptExportExplicitlyTypeOnly(exports.get('value')!)).toBe(false);
    });
  });

  it('returns false for symbols without export specifier declarations', () => {
    withProject(({ checker, valueSource }) => {
      const module = checker.getSymbolAtLocation(valueSource);
      if (!module) throw new Error('Expected value module symbol');
      const exports = new Map(checker.getExportsOfModule(module).map((symbol) => [symbol.getName(), symbol]));

      expect(isTypeScriptExportExplicitlyTypeOnly(exports.get('value')!)).toBe(false);
    });
  });

  it('recognizes per-specifier type-only exports', () => {
    withPerSpecifierTypeOnly(({ checker, source }) => {
      const module = checker.getSymbolAtLocation(source);
      if (!module) throw new Error('Expected module symbol');
      const exports = new Map(checker.getExportsOfModule(module).map((symbol) => [symbol.getName(), symbol]));

      expect(isTypeScriptExportExplicitlyTypeOnly(exports.get('Shape')!)).toBe(true);
      expect(isTypeScriptExportExplicitlyTypeOnly(exports.get('value')!)).toBe(false);
    });
  });
});

function withProject(
  run: (fixture: {
    checker: ts.TypeChecker;
    options: ts.CompilerOptions;
    source: ts.SourceFile;
    valueSource: ts.SourceFile;
  }) => void,
): void {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'flight-compiler-runtime-binding-'));
  try {
    write(
      directory,
      'tsconfig.json',
      JSON.stringify({
        compilerOptions: { module: 'ESNext', moduleResolution: 'Bundler', strict: true, target: 'ES2022' },
        include: ['src/**/*.ts'],
      }),
    );
    write(
      directory,
      'src/value.ts',
      'export const Zulu = 1; export const alpha = 1; export const éclair = 1; export const value = 1; export enum Mode { A } export const enum ConstMode { A } export interface Shape {}',
    );
    write(
      directory,
      'src/index.ts',
      "export { alpha, ConstMode, éclair, Mode, value, Zulu } from './value.js'; export type { Shape } from './value.js';",
    );
    const project = createTypeScriptProject(path.join(directory, 'tsconfig.json'));
    const source = project.program.getSourceFile(path.join(directory, 'src', 'index.ts'));
    const valueSource = project.program.getSourceFile(path.join(directory, 'src', 'value.ts'));
    if (!source || !valueSource) throw new Error('Expected project source files');
    run({ checker: project.checker, options: project.options, source, valueSource });
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

function withPerSpecifierTypeOnly(run: (fixture: { checker: ts.TypeChecker; source: ts.SourceFile }) => void): void {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'flight-compiler-per-specifier-type-only-'));
  try {
    write(
      directory,
      'tsconfig.json',
      JSON.stringify({
        compilerOptions: { module: 'ESNext', moduleResolution: 'Bundler', strict: true, target: 'ES2022' },
        include: ['src/**/*.ts'],
      }),
    );
    write(directory, 'src/value.ts', 'export const value = 1; export interface Shape {}');
    write(directory, 'src/index.ts', "export { value, type Shape } from './value.js';");
    const project = createTypeScriptProject(path.join(directory, 'tsconfig.json'));
    const source = project.program.getSourceFile(path.join(directory, 'src', 'index.ts'));
    if (!source) throw new Error('Expected project source file');
    run({ checker: project.checker, source });
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

function write(directory: string, file: string, contents: string): void {
  const target = path.join(directory, file);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, contents);
}
