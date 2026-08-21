import ts from 'typescript';

import { lowerTypeScriptSource } from '../../compiler-semantic/src/index.js';
import type { IrFunctionDeclaration, IrNamedVariable } from '../../compiler-types/src/index.js';
import { validateIrFunctionVariableInitialization } from './compilerVariableHoistingInitialization.js';

describe('validateIrFunctionVariableInitialization', () => {
  it('accepts ordered and balanced initialization without changing the function body', () => {
    const declaration = lowerFunction(
      `
        export function select(flag: boolean): number {
          var value: number;
          if (flag) value = 1;
          else value = 2;
          return value;
        }
      `,
    );
    const snapshot = structuredClone(declaration.body);

    expect(
      validateIrFunctionVariableInitialization(declaration.body, getFunctionVariables(declaration), declaration.origin),
    ).toBeUndefined();
    expect(declaration.body).toEqual(snapshot);
  });

  it('rejects direct, conditional, short-circuit, and early-capture reads before initialization', () => {
    for (const source of [
      'export function select(): number { return value; var value: number = 1; }',
      'export function select(flag: boolean): number { if (flag) { var value: number = 1; } return value; }',
      'export function select(flag: boolean): number { var value: number; flag && (value = 1); return value; }',
      'export function select(): () => number { const callback = (): number => value; var value: number = 1; return callback; }',
    ]) {
      const declaration = lowerFunction(source);

      expect(() =>
        validateIrFunctionVariableInitialization(
          declaration.body,
          getFunctionVariables(declaration),
          declaration.origin,
        ),
      ).toThrow('function-scoped variable value may be read before initialization');
    }
  });

  it('propagates initialization through mandatory loop breaks', () => {
    for (const source of [
      `
        export function select(): number {
          var value: number;
          do { value = 1; break; } while (false);
          return value;
        }
      `,
      `
        export function select(): number {
          var value: number;
          for (;;) { value = 1; break; }
          return value;
        }
      `,
    ]) {
      const declaration = lowerFunction(source);

      expect(
        validateIrFunctionVariableInitialization(
          declaration.body,
          getFunctionVariables(declaration),
          declaration.origin,
        ),
      ).toBeUndefined();
    }
  });

  it('validates continue back-edges before loop conditions and increments', () => {
    for (const source of [
      `
        export function select(): void {
          do { continue; var value: number = 1; } while (value > 0);
        }
      `,
      `
        export function select(): void {
          for (;; value += 1) { continue; var value: number = 1; }
        }
      `,
    ]) {
      const declaration = lowerFunction(source);

      expect(() =>
        validateIrFunctionVariableInitialization(
          declaration.body,
          getFunctionVariables(declaration),
          declaration.origin,
        ),
      ).toThrow('function-scoped variable value may be read before initialization');
    }
  });

  it('joins switch entry, fallthrough, default, and break initialization', () => {
    for (const source of [
      `
        export function select(mode: number): number {
          var value: number;
          switch (mode) {
            case 0: value = 1; break;
            case 1: value = 2;
            default: value = 3;
          }
          return value;
        }
      `,
      `
        export function select(mode: number): number {
          var value: number;
          switch (mode) { case (value = 1): break; default: break; }
          return value;
        }
      `,
    ]) {
      const declaration = lowerFunction(source);

      expect(
        validateIrFunctionVariableInitialization(
          declaration.body,
          getFunctionVariables(declaration),
          declaration.origin,
        ),
      ).toBeUndefined();
    }
  });

  it('rejects switch no-match and direct-entry paths without initialization', () => {
    for (const source of [
      `
        export function select(mode: number): number {
          var value: number;
          switch (mode) { case 0: value = 1; break; }
          return value;
        }
      `,
      `
        export function select(mode: number): number {
          var value: number;
          switch (mode) {
            case 0: value = 1;
            case 1: return value;
            default: return 0;
          }
        }
      `,
    ]) {
      const declaration = lowerFunction(source);

      expect(() =>
        validateIrFunctionVariableInitialization(
          declaration.body,
          getFunctionVariables(declaration),
          declaration.origin,
        ),
      ).toThrow('function-scoped variable value may be read before initialization');
    }
  });
});

function getFunctionVariables(declaration: Readonly<IrFunctionDeclaration>): ReadonlyMap<string, IrNamedVariable> {
  const variables = new Map<string, IrNamedVariable>();
  const visit = (statements: readonly IrFunctionDeclaration['body'][number][]): void => {
    for (const statement of statements) {
      if (statement.kind === 'variable') {
        for (const variable of statement.declarations) {
          if (!('pattern' in variable) && variable.binding.scope === 'function') {
            variables.set(variable.binding.id, variable);
          }
        }
      }
      if (statement.kind === 'block') visit(statement.statements);
      if (statement.kind === 'do' || statement.kind === 'while') visit([statement.body]);
      if (statement.kind === 'for' || statement.kind === 'forIn' || statement.kind === 'forOf') {
        if (statement.kind === 'for' && Array.isArray(statement.initializer)) {
          for (const variable of statement.initializer) {
            if (!('pattern' in variable) && variable.binding.scope === 'function') {
              variables.set(variable.binding.id, variable);
            }
          }
        }
        if (
          (statement.kind === 'forIn' || statement.kind === 'forOf') &&
          !('pattern' in statement.variable) &&
          statement.variable.binding.scope === 'function'
        ) {
          variables.set(statement.variable.binding.id, statement.variable);
        }
        visit([statement.body]);
      }
      if (statement.kind === 'if') {
        visit([statement.consequent]);
        if (statement.otherwise) visit([statement.otherwise]);
      }
      if (statement.kind === 'switch') {
        for (const switchCase of statement.cases) visit(switchCase.statements);
      }
      if (statement.kind === 'try') {
        visit([statement.tryBody]);
        if (statement.catchClause) visit([statement.catchClause.body]);
        if (statement.finallyBody) visit([statement.finallyBody]);
      }
    }
  };
  visit(declaration.body);
  return variables;
}

function lowerFunction(source: string): IrFunctionDeclaration {
  const module = lowerTypeScriptSource(
    ts.createSourceFile('/flight/packages/hoisting/src/initialization.ts', source, ts.ScriptTarget.Latest, true),
    { packageName: '@flighthq/hoisting', upstreamDirectory: '/flight' },
  ).module;
  const declaration = module.declarations[0];
  if (declaration?.kind !== 'function') throw new Error('Expected function declaration');
  return declaration;
}
