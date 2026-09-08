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

  it('rejects direct, conditional, and short-circuit reads before initialization', () => {
    for (const source of [
      'export function select(): number { return value; var value: number = 1; }',
      'export function select(flag: boolean): number { if (flag) { var value: number = 1; } return value; }',
      'export function select(flag: boolean): number { var value: number; flag && (value = 1); return value; }',
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

  it('checks immediate and local deferred closure captures at invocation or escape', () => {
    const immediate = lowerFunction(`
      export function select(): number {
        var value: number;
        return ((input: number): number => value)(value = 1);
      }
    `);
    const tooEarly = lowerFunction(`
      export function select(): number {
        return ((): number => value)();
        var value: number = 1;
      }
    `);
    const deferred = lowerFunction(`
      export function select(): () => number {
        const callback = (): number => value;
        var value: number = 1;
        return callback;
      }
    `);

    expect(
      validateIrFunctionVariableInitialization(immediate.body, getFunctionVariables(immediate), immediate.origin),
    ).toBeUndefined();
    expect(() =>
      validateIrFunctionVariableInitialization(tooEarly.body, getFunctionVariables(tooEarly), tooEarly.origin),
    ).toThrow('function-scoped variable value may be read before initialization');
    expect(
      validateIrFunctionVariableInitialization(deferred.body, getFunctionVariables(deferred), deferred.origin),
    ).toBeUndefined();
  });

  it('tracks local deferred closure calls after arguments and rejects premature calls or escapes', () => {
    const accepted = [
      `
        export function select(): number {
          var value: number;
          const callback = (): number => value;
          return callback(value = 1);
        }
      `,
      `
        export function select(): () => number {
          const callback = (): number => value;
          var value: number = 1;
          return callback;
        }
      `,
      `
        export function select(): number {
          const callback = (): number => value;
          var value: number;
          value = 1;
          return callback();
        }
      `,
    ].map(lowerFunction);
    const rejected = [
      `
        export function select(): number {
          const callback = (): number => value;
          var value: number;
          return callback();
        }
      `,
      `
        export function select(): () => number {
          const callback = (): number => value;
          return callback;
          var value: number = 1;
        }
      `,
      `
        export function select(consume: (callback: () => number) => number): number {
          const callback = (): number => value;
          consume(callback);
          var value: number = 1;
          return 0;
        }
      `,
    ].map(lowerFunction);

    for (const declaration of accepted) {
      expect(
        validateIrFunctionVariableInitialization(
          declaration.body,
          getFunctionVariables(declaration),
          declaration.origin,
        ),
      ).toBeUndefined();
    }
    for (const declaration of rejected) {
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

  it('transfers explicit throw initialization into catch and applies finally on every completion', () => {
    for (const source of [
      `
        export function select(): number {
          var value: number;
          try { value = 1; throw 0; }
          catch { value += 1; }
          return value;
        }
      `,
      `
        export function select(flag: boolean): number {
          var value: number;
          try {
            value = 1;
            if (flag) return value;
            throw 0;
          } finally { value += 1; }
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

  it('includes implicit expression failures in catch entry initialization', () => {
    const declaration = lowerFunction(`
      export function select(callback: () => void): number {
        var value: number;
        try { callback(); value = 1; throw 0; }
        catch { return value; }
      }
    `);

    expect(() =>
      validateIrFunctionVariableInitialization(declaration.body, getFunctionVariables(declaration), declaration.origin),
    ).toThrow('function-scoped variable value may be read before initialization');
  });

  it('does not invent catch entries for nonthrowing operators', () => {
    const declaration = lowerFunction(`
      export function select(): number {
        var value: number;
        try {
          let local = true;
          0 === 0;
          local &&= true;
          value = 1;
        } catch { return value; }
        return value;
      }
    `);

    expect(
      validateIrFunctionVariableInitialization(declaration.body, getFunctionVariables(declaration), declaration.origin),
    ).toBeUndefined();
  });

  it('includes iteration protocol failures in catch entry initialization', () => {
    const declaration = lowerFunction(`
      export function select(values: number[]): number {
        var value: number;
        try { for (const item of values) value = item; }
        catch { return value; }
        return value;
      }
    `);

    expect(() =>
      validateIrFunctionVariableInitialization(declaration.body, getFunctionVariables(declaration), declaration.origin),
    ).toThrow('function-scoped variable value may be read before initialization');
  });

  it('tracks initialization through diverse expression kinds', () => {
    const declaration = lowerFunction(`
      export function compute(
        flag: boolean,
        items: number[],
        obj: { x: number },
        fn: (n: number) => number,
      ): number {
        var value: number;
        obj.x = (value = 1);
        items[0] = value;
        const arr = [value, ...items];
        const sum = value + 1;
        fn(value);
        new Error(String(value));
        const ternary = flag ? value : 0;
        const indexed = items[value];
        const composed = { y: value, [String(value)]: 1, ...obj };
        const prop = obj.x;
        const msg = \`count: \${value}\`;
        const neg = -value;
        const not = !flag;
        typeof value;
        value++;
        return value;
      }
    `);

    expect(
      validateIrFunctionVariableInitialization(declaration.body, getFunctionVariables(declaration), declaration.origin),
    ).toBeUndefined();
  });

  it('tracks initialization through while loops and for-expression initializers', () => {
    for (const source of [
      `
        export function whileVar(): number {
          var value: number;
          value = 1;
          while (value > 0) { value -= 1; }
          return value;
        }
      `,
      `
        export function forExprInit(): number {
          var value: number;
          value = 0;
          for (value += 1; value < 10; value++) { break; }
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

  it('tracks var iteration variables in forIn and forOf loops', () => {
    for (const source of [
      `
        export function forOfVar(items: number[]): void {
          for (var item of items) { item; }
        }
      `,
      `
        export function forInVar(obj: Record<string, number>): void {
          for (var key in obj) { key; }
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

  it('collects deferred closures from diverse statement containers', () => {
    const declaration = lowerFunction(`
      export function collect(): number {
        var value: number;
        value = 1;
        { const inBlock = (): number => value; inBlock; }
        if (true) { const inIf = (): number => value; inIf; }
        else { const inElse = (): number => value; inElse; }
        for (let i = 0; i < 1; i++) { const inFor = (): number => value; inFor; }
        for (const k in {}) { const inForIn = (): number => value; inForIn; }
        for (const item of [1]) { const inForOf = (): number => value; item; inForOf; }
        while (false) { const inWhile = (): number => value; inWhile; }
        do { const inDo = (): number => value; inDo; } while (false);
        try { const inTry = (): number => value; inTry; }
        catch { const inCatch = (): number => value; inCatch; }
        finally { const inFinally = (): number => value; inFinally; }
        switch (0) { case 0: const inSwitch = (): number => value; inSwitch; break; }
        return value;
      }
    `);

    expect(
      validateIrFunctionVariableInitialization(declaration.body, getFunctionVariables(declaration), declaration.origin),
    ).toBeUndefined();
  });

  it('validates closure captures through diverse expression and statement visitors', () => {
    const declaration = lowerFunction(`
      export async function captures(task: Promise<number>): Promise<number> {
        var value: number;
        value = 1;
        const complex = async (): Promise<number> => {
          const arr = [value, ...[]];
          const obj = { x: value, [String(value)]: 1, ...{y: 2} };
          const ternary = value > 0 ? value : 0;
          const elem = arr[0];
          const prop = obj.x;
          const tpl = \`\${value}\`;
          const neg = -value;
          const not = !true;
          typeof value;
          const casted = value as number;
          const awaited = await task;
          const inner = (): number => value;
          if (value > 0) { value; } else { 0; }
          for (let i = 0; i < 1; i++) { value; }
          for (const k in obj) { k; }
          for (const item of arr) { item; }
          for (value += 1; value < 10;) { break; }
          while (false) { value; }
          do { value; } while (false);
          try { value; } catch { 0; } finally { 0; }
          switch (value) { case 0: value; break; default: 0; }
          { value; }
          value + 1;
          throw new Error(String(value));
        };
        return await complex();
      }
    `);

    expect(
      validateIrFunctionVariableInitialization(declaration.body, getFunctionVariables(declaration), declaration.origin),
    ).toBeUndefined();
  });

  it('tracks initialization through await, cast, spread, and IIFE expressions', () => {
    const declaration = lowerFunction(`
      export async function awaitCast(task: Promise<number>, items: number[]): Promise<number> {
        var value: number;
        value = await task;
        const casted = value as number;
        const spread = [...items];
        return casted + spread.length;
      }
    `);

    expect(
      validateIrFunctionVariableInitialization(declaration.body, getFunctionVariables(declaration), declaration.origin),
    ).toBeUndefined();
  });

  it('propagates break, continue, and return through try/catch inside loops', () => {
    for (const source of [
      `
        export function tryBreak(): number {
          var value: number;
          for (;;) { try { value = 1; break; } catch { value = 2; break; } }
          return value;
        }
      `,
      `
        export function tryContinue(): number {
          var value: number;
          value = 0;
          for (let i = 0; i < 1; i++) {
            try { value += 1; continue; } catch { value = 0; continue; }
          }
          return value;
        }
      `,
      `
        export function tryReturn(): number {
          var value: number;
          while (true) { try { value = 1; return value; } catch { return 0; } }
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

  it('rejects while-loop reads and switch-without-default paths before initialization', () => {
    for (const source of [
      `
        export function whileRead(): void {
          while (value > 0) { break; }
          var value: number = 1;
        }
      `,
      `
        export function switchNoDefault(mode: number): number {
          var value: number;
          switch (mode) { case 0: value = 1; break; }
          return value;
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
