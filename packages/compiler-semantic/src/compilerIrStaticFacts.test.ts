import ts from 'typescript';

import type { CompilerStaticFactAudit, IrExpression, IrModule } from '../../compiler-types/src/index.js';
import { analyzeIrModulesStaticFacts, combineCompilerStaticFactAudits } from './compilerIrStaticFacts.js';
import { lowerTypeScriptSource } from './typeScriptSemanticLowering.js';

describe('analyzeIrModulesStaticFacts', () => {
  it('counts neutral truthiness, numeric relation, and indexed-access facts deterministically', () => {
    const sourceFile = ts.createSourceFile(
      '/flight/packages/math/src/facts.ts',
      `
        export function inspect(values: number[], left: boolean, right: boolean): number {
          let result: number = values[0];
          values[1] = result;
          values[2] += 1;
          if (left && right) result += values[3];
          while (!left) { values[4]++; break; }
          result = left ? values[5] : values[6];
          if (result < 10) result += 1;
          return result;
        }
      `,
      ts.ScriptTarget.Latest,
      true,
    );
    const lowered = lowerTypeScriptSource(sourceFile, {
      packageName: '@flighthq/math',
      upstreamDirectory: '/flight',
    });
    const snapshot = structuredClone(lowered.module);

    expect(lowered.diagnostics).toEqual([]);
    expect(analyzeIrModulesStaticFacts([lowered.module])).toEqual({
      facts: [
        { access: 'read', count: 4, kind: 'indexedAccess', receivers: ['array'] },
        { access: 'readWrite', count: 2, kind: 'indexedAccess', receivers: ['array'] },
        { access: 'write', count: 1, kind: 'indexedAccess', receivers: ['array'] },
        {
          count: 1,
          kind: 'logicalExpression',
          left: 'boolean',
          operator: '&&',
          result: 'boolean',
          right: 'boolean',
        },
        {
          // Three, not one: with the ambient surface loaded the checker types an indexed read of a
          // `number[]`, so every `+=` over one is arithmetic rather than an unknown operand.
          count: 3,
          kind: 'numericArithmetic',
          left: { declared: 'number', flow: 'number' },
          operation: 'assignment',
          operator: '+=',
          result: 'number',
          right: { declared: 'number', flow: 'number' },
        },
        {
          count: 1,
          kind: 'numericArithmetic',
          operand: { declared: 'number', flow: 'number' },
          operation: 'postfixUnary',
          operator: '++',
          result: 'number',
        },
        { count: 1, domain: 'number', kind: 'numericRelation' },
        { context: 'conditionalExpression', count: 1, domain: 'unknown', kind: 'truthiness' },
        { context: 'controlFlowCondition', count: 3, domain: 'boolean', kind: 'truthiness' },
        { context: 'logicalOperand', count: 1, domain: 'boolean', kind: 'truthiness' },
        { context: 'negationOperand', count: 1, domain: 'boolean', kind: 'truthiness' },
      ],
      modules: 1,
      schema: 'flight-compiler-static-facts/5',
    });
    expect(analyzeIrModulesStaticFacts([lowered.module])).toEqual(analyzeIrModulesStaticFacts([lowered.module]));
    expect(lowered.module).toEqual(snapshot);
  });

  it('keeps tuple projection distinct from open and fixed-width array access', () => {
    const sourceFile = ts.createSourceFile(
      '/flight/packages/math/src/tuple-facts.ts',
      'export function first(values: [number, string]): number { return values[0]; }',
      ts.ScriptTarget.Latest,
      true,
    );
    const lowered = lowerTypeScriptSource(sourceFile, {
      packageName: '@flighthq/math',
      upstreamDirectory: '/flight',
    });

    expect(analyzeIrModulesStaticFacts([lowered.module]).facts).toEqual([
      { access: 'read', count: 1, kind: 'indexedAccess', receivers: ['tuple'] },
    ]);
  });

  it('audits arithmetic operation shape and narrowed storage without target policy', () => {
    const sourceFile = ts.createSourceFile(
      '/flight/packages/math/src/arithmetic.ts',
      `
        export function calculate(value: number | string, other: number | boolean, text: string): number {
          if (typeof value === 'number' && typeof other === 'number') {
            value += other;
            value + other;
            value + other;
            value++;
            -value;
            +text;
            text + text;
            return value;
          }
          return 0;
        }
        export function subtract(left: bigint, right: bigint): bigint { return left - right; }
      `,
      ts.ScriptTarget.Latest,
      true,
    );
    const lowered = lowerTypeScriptSource(sourceFile, {
      packageName: '@flighthq/math',
      upstreamDirectory: '/flight',
    });
    const facts = analyzeIrModulesStaticFacts([lowered.module]).facts.filter(
      (fact) => fact.kind === 'numericArithmetic',
    );

    expect(lowered.diagnostics).toEqual([]);
    expect(facts).toEqual([
      {
        count: 1,
        kind: 'numericArithmetic',
        left: { declared: 'unknown', flow: 'number' },
        operation: 'assignment',
        operator: '+=',
        result: 'number',
        right: { declared: 'unknown', flow: 'number' },
      },
      {
        count: 2,
        kind: 'numericArithmetic',
        left: { declared: 'unknown', flow: 'number' },
        operation: 'binary',
        operator: '+',
        result: 'number',
        right: { declared: 'unknown', flow: 'number' },
      },
      {
        count: 1,
        kind: 'numericArithmetic',
        left: { declared: 'bigint', flow: 'bigint' },
        operation: 'binary',
        operator: '-',
        result: 'bigint',
        right: { declared: 'bigint', flow: 'bigint' },
      },
      {
        count: 1,
        kind: 'numericArithmetic',
        operand: { declared: 'unknown', flow: 'number' },
        operation: 'postfixUnary',
        operator: '++',
        result: 'number',
      },
      {
        count: 1,
        kind: 'numericArithmetic',
        operand: { declared: 'unknown', flow: 'number' },
        operation: 'prefixUnary',
        operator: '-',
        result: 'number',
      },
    ]);
  });

  it('separates unknown and object truthiness and omits nullish coalescing from truthiness', () => {
    const sourceFile = ts.createSourceFile(
      '/flight/packages/math/src/domains.ts',
      'export const choose = (value: unknown): unknown => ({} && value) ? value : value ?? false;',
      ts.ScriptTarget.Latest,
      true,
    );
    const lowered = lowerTypeScriptSource(sourceFile, {
      packageName: '@flighthq/math',
      upstreamDirectory: '/flight',
    });

    expect(analyzeIrModulesStaticFacts([lowered.module])).toMatchObject({
      facts: [
        {
          count: 1,
          kind: 'logicalExpression',
          left: 'object',
          operator: '&&',
          result: 'unknown',
          right: 'unknown',
        },
        { context: 'conditionalExpression', count: 1, domain: 'unknown', kind: 'truthiness' },
        { context: 'logicalOperand', count: 1, domain: 'object', kind: 'truthiness' },
      ],
    });
    expect(analyzeIrModulesStaticFacts([])).toEqual({
      facts: [],
      modules: 0,
      schema: 'flight-compiler-static-facts/5',
    });
  });

  it('characterizes every neutral expression value domain used by control flow', () => {
    const sourceFile = ts.createSourceFile(
      '/flight/packages/math/src/value-domains.ts',
      `
        class Box {
          inspect(value: boolean): void { if (this) value; }
        }
        export async function classify(value: boolean, values: boolean[]): Promise<void> {
          let numeric = 0;
          if ([]) {}
          if (() => 1) {}
          if (new Box()) {}
          if ({}) {}
          if (/x/) {}
          if ((numeric = 1)) {}
          if (1 + 2) {}
          if ((1 as unknown)) {}
          if (value ? 1 : 2) {}
          if (1) {}
          if (value ? 1 : 'x') {}
          if (value) {}
          if (await Promise.resolve(value)) {}
          if (Boolean(value)) {}
          if (values[0]) {}
          if ({ value }.value) {}
          if (undefined) {}
          if (null) {}
          if (true) {}
          if (!value) {}
          if ('x') {}
          if (\`x${'${value}'}\`) {}
        }
      `,
      ts.ScriptTarget.Latest,
      true,
    );
    const lowered = lowerTypeScriptSource(sourceFile, {
      packageName: '@flighthq/math',
      upstreamDirectory: '/flight',
    });
    const controlFlowFacts = analyzeIrModulesStaticFacts([lowered.module]).facts.filter(
      (fact) => fact.kind === 'truthiness' && fact.context === 'controlFlowCondition',
    );

    expect(lowered.diagnostics).toEqual([]);
    expect(controlFlowFacts).toEqual([
      { context: 'controlFlowCondition', count: 2, domain: 'boolean', kind: 'truthiness' },
      { context: 'controlFlowCondition', count: 1, domain: 'null', kind: 'truthiness' },
      { context: 'controlFlowCondition', count: 5, domain: 'number', kind: 'truthiness' },
      { context: 'controlFlowCondition', count: 6, domain: 'object', kind: 'truthiness' },
      { context: 'controlFlowCondition', count: 2, domain: 'string', kind: 'truthiness' },
      { context: 'controlFlowCondition', count: 1, domain: 'undefined', kind: 'truthiness' },
      { context: 'controlFlowCondition', count: 6, domain: 'unknown', kind: 'truthiness' },
    ]);

    const spreadSource = ts.createSourceFile(
      '/flight/packages/math/src/spread-domain.ts',
      'export function inspect(): void { if (true) {} }',
      ts.ScriptTarget.Latest,
      true,
    );
    const spreadLowered = lowerTypeScriptSource(spreadSource, {
      packageName: '@flighthq/math',
      upstreamDirectory: '/flight',
    });
    const declaration = spreadLowered.module.declarations[0];
    if (declaration?.kind !== 'function' || declaration.body[0]?.kind !== 'if') {
      throw new Error('Expected the fixture to lower to a function containing an if statement');
    }
    const statement = declaration.body[0];
    const moduleWithSpreadCondition: IrModule = {
      ...spreadLowered.module,
      declarations: [
        {
          ...declaration,
          body: [
            {
              ...statement,
              condition: { expression: statement.condition, kind: 'spread' },
            },
          ],
        },
      ],
    };

    expect(
      analyzeIrModulesStaticFacts([moduleWithSpreadCondition]).facts.filter(
        (fact) => fact.kind === 'truthiness' && fact.context === 'controlFlowCondition',
      ),
    ).toEqual([{ context: 'controlFlowCondition', count: 1, domain: 'unknown', kind: 'truthiness' }]);
  });

  it('walks declaration, statement, expression, and default-export containers without changing them', () => {
    const sourceFile = ts.createSourceFile(
      '/flight/packages/math/src/containers.ts',
      `
        export interface Marker {}
        export type Alias = number;
        export enum Choice { first }
        export class Box {
          field: number = [1, , 2][0]!;
          constructor(value: number = 1) { do { value; } while (false); }
          method(values: number[]): unknown {
            let total: number = 0;
            const [selected = values[1]] = values;
            selected;
            for (total = 0; total < 1; total++) { if (total) continue; }
            for (const value of values) { value; }
            for (const key in { a: 1 }) { key; }
            switch (total) { case 0: break; default: throw total; }
            try { new Box(); } catch (error) { error; } finally { /x/.test(\`${'${total}'}\`); }
            const nested = async (input: number = values[0]): Promise<number> =>
              await Promise.resolve(({ ...{ input }, [input]: input } as object)).then(() => input);
            return nested;
          }
        }
        export default true ? new Box().field : [1, ...values];
      `,
      ts.ScriptTarget.Latest,
      true,
    );
    const lowered = lowerTypeScriptSource(sourceFile, {
      packageName: '@flighthq/math',
      upstreamDirectory: '/flight',
    });
    const snapshot = structuredClone(lowered.module);

    expect(lowered.diagnostics).toEqual([]);
    expect(analyzeIrModulesStaticFacts([lowered.module]).facts).toEqual(
      expect.arrayContaining([
        { access: 'read', count: 3, kind: 'indexedAccess', receivers: ['array'] },
        { count: 1, domain: 'number', kind: 'numericRelation' },
        { context: 'conditionalExpression', count: 1, domain: 'boolean', kind: 'truthiness' },
        { context: 'controlFlowCondition', count: 2, domain: 'boolean', kind: 'truthiness' },
        { context: 'controlFlowCondition', count: 1, domain: 'unknown', kind: 'truthiness' },
      ]),
    );
    expect(lowered.module).toEqual(snapshot);
  });

  it('analyzes nested function statement bodies and every new-expression argument', () => {
    const sourceFile = ts.createSourceFile(
      '/flight/packages/math/src/nested-facts.ts',
      `
        class Holder { constructor(value: number) { value; } }
        export function create(flag: boolean, values: number[]): Holder {
          const nested = (): number => { if (flag) return values[0]; return 0; };
          return new Holder(values[1] + nested());
        }
      `,
      ts.ScriptTarget.Latest,
      true,
    );
    const lowered = lowerTypeScriptSource(sourceFile, {
      packageName: '@flighthq/math',
      upstreamDirectory: '/flight',
    });

    expect(lowered.diagnostics).toEqual([]);
    expect(analyzeIrModulesStaticFacts([lowered.module]).facts).toEqual([
      { access: 'read', count: 2, kind: 'indexedAccess', receivers: ['array'] },
      // The ambient surface types an indexed read, so adding two of them is arithmetic rather than an
      // operation over unknowns.
      {
        count: 1,
        kind: 'numericArithmetic',
        left: { declared: 'number', flow: 'number' },
        operation: 'binary',
        operator: '+',
        result: 'number',
        right: { declared: 'number', flow: 'number' },
      },
      { context: 'controlFlowCondition', count: 1, domain: 'unknown', kind: 'truthiness' },
    ]);
  });

  it('analyzes variable-list for initializers and alternate branches', () => {
    const sourceFile = ts.createSourceFile(
      '/flight/packages/math/src/loop-facts.ts',
      `
        export function scan(values: number[], flag: boolean): number {
          let result = 0;
          for (let index = values[0]; index < 1; index++) {
            if (flag) result = index;
            else result += values[1];
          }
          return result;
        }
      `,
      ts.ScriptTarget.Latest,
      true,
    );
    const lowered = lowerTypeScriptSource(sourceFile, {
      packageName: '@flighthq/math',
      upstreamDirectory: '/flight',
    });

    expect(lowered.diagnostics).toEqual([]);
    expect(analyzeIrModulesStaticFacts([lowered.module]).facts.filter((fact) => fact.kind === 'indexedAccess')).toEqual(
      [{ access: 'read', count: 2, kind: 'indexedAccess', receivers: ['array'] }],
    );
  });

  it('analyzes computed object-binding defaults through exhaustive shared traversal', () => {
    const sourceFile = ts.createSourceFile(
      '/flight/packages/math/src/object-binding-facts.ts',
      `
        export function select(values: number[], key: string): number {
          const { [key]: selected = values[0] } = { [key]: values[1] };
          return selected;
        }
      `,
      ts.ScriptTarget.Latest,
      true,
    );
    const lowered = lowerTypeScriptSource(sourceFile, {
      packageName: '@flighthq/math',
      upstreamDirectory: '/flight',
    });

    expect(lowered.diagnostics).toEqual([]);
    expect(analyzeIrModulesStaticFacts([lowered.module]).facts).toEqual([
      { access: 'read', count: 2, kind: 'indexedAccess', receivers: ['array'] },
    ]);
  });

  it('counts typed-array set calls by normalized receiver set', () => {
    const sourceFile = ts.createSourceFile(
      '/flight/packages/math/src/typed-array-set.ts',
      'type Mixed = Uint8Array | Float32Array; export function copy(target: Mixed, source: number[]): void { target.set(source); target.set(source); }',
      ts.ScriptTarget.Latest,
      true,
    );
    const lowered = lowerTypeScriptSource(sourceFile, {
      packageName: '@flighthq/math',
      upstreamDirectory: '/flight',
    });

    expect(lowered.diagnostics).toEqual([]);
    expect(analyzeIrModulesStaticFacts([lowered.module]).facts).toEqual([
      {
        count: 2,
        kind: 'typedArraySet',
        receivers: ['float32Array', 'uint8Array'],
      },
    ]);
  });

  it('distinguishes logical-expression semantics from operand truthiness and logical assignment', () => {
    const sourceFile = ts.createSourceFile(
      '/flight/packages/math/src/logical-expressions.ts',
      `
        export function choose(left: boolean, right: boolean, value: unknown): unknown {
          left || right;
          ({} && value);
          left ||= right;
          return value ?? right;
        }
      `,
      ts.ScriptTarget.Latest,
      true,
    );
    const lowered = lowerTypeScriptSource(sourceFile, {
      packageName: '@flighthq/math',
      upstreamDirectory: '/flight',
    });

    expect(lowered.diagnostics).toEqual([]);
    expect(analyzeIrModulesStaticFacts([lowered.module]).facts).toEqual([
      {
        count: 1,
        kind: 'logicalExpression',
        left: 'object',
        operator: '&&',
        result: 'unknown',
        right: 'unknown',
      },
      {
        count: 1,
        kind: 'logicalExpression',
        left: 'boolean',
        operator: '||',
        result: 'boolean',
        right: 'boolean',
      },
      { context: 'logicalOperand', count: 2, domain: 'boolean', kind: 'truthiness' },
      { context: 'logicalOperand', count: 1, domain: 'object', kind: 'truthiness' },
    ]);
  });

  it('classifies IR-only expression domains from lowering passes', () => {
    const base = lowerTypeScriptSource(
      ts.createSourceFile(
        '/flight/packages/math/src/ir-only-domains.ts',
        'export function inspect(): void { if (true) {} }',
        ts.ScriptTarget.Latest,
        true,
      ),
      { packageName: '@flighthq/math', upstreamDirectory: '/flight' },
    );
    const declaration = base.module.declarations[0];
    if (declaration?.kind !== 'function' || declaration.body[0]?.kind !== 'if') {
      throw new Error('Expected function with if statement');
    }
    const statement = declaration.body[0];
    const ident: IrExpression = { kind: 'identifier', reference: { kind: 'ambient', name: 'value' } };
    const conditions: IrExpression[] = [
      { kind: 'tupleRest', object: ident, start: 0 },
      { kind: 'tupleSuffix', object: ident, start: 0, width: 1 },
      {
        fallback: { kind: 'literal', value: 0 },
        kind: 'undefinedDefault',
        value: { kind: 'undefinedValue', type: { kind: 'undefined' } },
      },
      { fallback: { kind: 'literal', value: 0 }, kind: 'undefinedDefault', value: { kind: 'literal', value: 42 } },
      { fallback: { kind: 'literal', value: 0 }, kind: 'undefinedDefault', value: ident },
    ];
    const modules = conditions.map(
      (condition): IrModule => ({
        ...base.module,
        declarations: [{ ...declaration, body: [{ ...statement, condition }] }],
      }),
    );
    const facts = analyzeIrModulesStaticFacts(modules).facts.filter((fact) => fact.kind === 'truthiness');

    expect(facts).toEqual([
      { context: 'controlFlowCondition', count: 2, domain: 'number', kind: 'truthiness' },
      { context: 'controlFlowCondition', count: 2, domain: 'object', kind: 'truthiness' },
      { context: 'controlFlowCondition', count: 1, domain: 'unknown', kind: 'truthiness' },
    ]);
  });

  it('counts mixed-width typed-array writes without classifying reads, deletes, or equal widths', () => {
    const sourceFile = ts.createSourceFile(
      '/flight/packages/math/src/indexed-writes.ts',
      `
        type Mixed = Uint32Array | Uint16Array;
        type EqualWidth = Float32Array | Int32Array;
        type Open = Uint32Array | number[];
        export function write(mixed: Mixed, equalWidth: EqualWidth, open: Open, index: number): number {
          mixed[index] = 1;
          mixed[index] += 1;
          mixed[index]++;
          equalWidth[index] = 1;
          open[index] = 1;
          delete mixed[index];
          return mixed[index];
        }
      `,
      ts.ScriptTarget.Latest,
      true,
    );
    const lowered = lowerTypeScriptSource(sourceFile, {
      packageName: '@flighthq/math',
      upstreamDirectory: '/flight',
    });

    expect(lowered.diagnostics).toEqual([]);
    expect(analyzeIrModulesStaticFacts([lowered.module]).facts).toEqual([
      {
        access: 'read',
        count: 1,
        kind: 'indexedAccess',
        receivers: ['uint16Array', 'uint32Array'],
      },
      {
        access: 'readWrite',
        count: 2,
        kind: 'indexedAccess',
        receivers: ['uint16Array', 'uint32Array'],
      },
      {
        access: 'write',
        count: 1,
        kind: 'indexedAccess',
        receivers: ['array', 'uint32Array'],
      },
      {
        access: 'write',
        count: 1,
        kind: 'indexedAccess',
        receivers: ['float32Array', 'int32Array'],
      },
      {
        access: 'write',
        count: 1,
        kind: 'indexedAccess',
        receivers: ['uint16Array', 'uint32Array'],
      },
      {
        count: 3,
        kind: 'mixedWidthIndexedWrite',
        receivers: ['uint16Array', 'uint32Array'],
        widths: [16, 32],
      },
      {
        count: 1,
        kind: 'numericArithmetic',
        left: { declared: 'number', flow: 'number' },
        operation: 'assignment',
        operator: '+=',
        result: 'number',
        right: { declared: 'number', flow: 'number' },
      },
      {
        count: 1,
        kind: 'numericArithmetic',
        operand: { declared: 'number', flow: 'number' },
        operation: 'postfixUnary',
        operator: '++',
        result: 'number',
      },
    ]);
  });
});

describe('combineCompilerStaticFactAudits', () => {
  it('combines every fact identity deterministically without changing its inputs', () => {
    const first = createAudit(1, 1);
    const second = createAudit(2, 2, true);
    const snapshot = structuredClone([first, second]);
    const combined = combineCompilerStaticFactAudits([first, second]);

    expect(combined).toEqual({
      facts: [
        { access: 'write', count: 3, kind: 'indexedAccess', receivers: ['uint16Array', 'uint32Array'] },
        {
          count: 3,
          kind: 'logicalExpression',
          left: 'boolean',
          operator: '&&',
          result: 'boolean',
          right: 'boolean',
        },
        {
          count: 3,
          kind: 'mixedWidthIndexedWrite',
          receivers: ['uint16Array', 'uint32Array'],
          widths: [16, 32],
        },
        {
          count: 3,
          kind: 'numericArithmetic',
          left: { declared: 'unknown', flow: 'number' },
          operation: 'assignment',
          operator: '+=',
          result: 'number',
          right: { declared: 'unknown', flow: 'number' },
        },
        {
          count: 3,
          kind: 'numericArithmetic',
          left: { declared: 'unknown', flow: 'number' },
          operation: 'binary',
          operator: '+',
          result: 'number',
          right: { declared: 'unknown', flow: 'number' },
        },
        {
          count: 3,
          kind: 'numericArithmetic',
          operand: { declared: 'unknown', flow: 'number' },
          operation: 'postfixUnary',
          operator: '++',
          result: 'number',
        },
        {
          count: 3,
          kind: 'numericArithmetic',
          operand: { declared: 'unknown', flow: 'number' },
          operation: 'prefixUnary',
          operator: '-',
          result: 'number',
        },
        { count: 3, domain: 'number', kind: 'numericRelation' },
        { context: 'controlFlowCondition', count: 3, domain: 'boolean', kind: 'truthiness' },
        { count: 3, kind: 'typedArraySet', receivers: ['uint16Array', 'uint32Array'] },
      ],
      modules: 3,
      schema: 'flight-compiler-static-facts/5',
    });
    expect([first, second]).toEqual(snapshot);
    expect(combined.facts[0]).not.toBe(first.facts[0]);
    if (combined.facts[0]?.kind !== 'indexedAccess' || first.facts[0]?.kind !== 'indexedAccess') {
      throw new Error('Expected indexed-access facts');
    }
    expect(combined.facts[0].receivers).not.toBe(first.facts[0].receivers);
    const combinedArithmetic = combined.facts.find(
      (fact) => fact.kind === 'numericArithmetic' && fact.operation === 'binary',
    );
    const firstArithmetic = first.facts.find(
      (fact) => fact.kind === 'numericArithmetic' && fact.operation === 'binary',
    );
    if (
      combinedArithmetic?.kind !== 'numericArithmetic' ||
      combinedArithmetic.operation !== 'binary' ||
      firstArithmetic?.kind !== 'numericArithmetic' ||
      firstArithmetic.operation !== 'binary'
    ) {
      throw new Error('Expected binary numeric-arithmetic facts');
    }
    expect(combinedArithmetic.left).not.toBe(firstArithmetic.left);
    expect(combinedArithmetic.right).not.toBe(firstArithmetic.right);
    const combinedUnary = combined.facts.find(
      (fact) => fact.kind === 'numericArithmetic' && fact.operation === 'prefixUnary',
    );
    const firstUnary = first.facts.find(
      (fact) => fact.kind === 'numericArithmetic' && fact.operation === 'prefixUnary',
    );
    if (combinedUnary?.operation !== 'prefixUnary' || firstUnary?.operation !== 'prefixUnary') {
      throw new Error('Expected prefix numeric-arithmetic facts');
    }
    expect(combinedUnary.operand).not.toBe(firstUnary.operand);
    expect(combineCompilerStaticFactAudits([second, first])).toEqual(combineCompilerStaticFactAudits([first, second]));
  });

  it('has an empty identity and composes associatively', () => {
    const first = createAudit(1, 1);
    const second = createAudit(2, 2);
    const third = createAudit(3, 3);

    expect(combineCompilerStaticFactAudits([])).toEqual({
      facts: [],
      modules: 0,
      schema: 'flight-compiler-static-facts/5',
    });
    expect(combineCompilerStaticFactAudits([combineCompilerStaticFactAudits([first, second]), third])).toEqual(
      combineCompilerStaticFactAudits([first, combineCompilerStaticFactAudits([second, third])]),
    );
  });
});

function createAudit(count: number, modules: number, reverse = false): CompilerStaticFactAudit {
  const facts: CompilerStaticFactAudit['facts'] = [
    { access: 'write', count, kind: 'indexedAccess', receivers: ['uint16Array', 'uint32Array'] },
    {
      count,
      kind: 'logicalExpression',
      left: 'boolean',
      operator: '&&',
      result: 'boolean',
      right: 'boolean',
    },
    {
      count,
      kind: 'mixedWidthIndexedWrite',
      receivers: ['uint16Array', 'uint32Array'],
      widths: [16, 32],
    },
    {
      count,
      kind: 'numericArithmetic',
      left: { declared: 'unknown', flow: 'number' },
      operation: 'assignment',
      operator: '+=',
      result: 'number',
      right: { declared: 'unknown', flow: 'number' },
    },
    {
      count,
      kind: 'numericArithmetic',
      left: { declared: 'unknown', flow: 'number' },
      operation: 'binary',
      operator: '+',
      result: 'number',
      right: { declared: 'unknown', flow: 'number' },
    },
    {
      count,
      kind: 'numericArithmetic',
      operand: { declared: 'unknown', flow: 'number' },
      operation: 'postfixUnary',
      operator: '++',
      result: 'number',
    },
    {
      count,
      kind: 'numericArithmetic',
      operand: { declared: 'unknown', flow: 'number' },
      operation: 'prefixUnary',
      operator: '-',
      result: 'number',
    },
    { count, domain: 'number', kind: 'numericRelation' },
    { context: 'controlFlowCondition', count, domain: 'boolean', kind: 'truthiness' },
    { count, kind: 'typedArraySet', receivers: ['uint16Array', 'uint32Array'] },
  ];
  return {
    facts: reverse ? [...facts].reverse() : facts,
    modules,
    schema: 'flight-compiler-static-facts/5',
  };
}
