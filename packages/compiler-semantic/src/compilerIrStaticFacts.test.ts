import ts from 'typescript';

import { analyzeIrModulesStaticFacts } from './compilerIrStaticFacts.js';
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
        { count: 1, domain: 'number', kind: 'numericRelation' },
        { context: 'conditionalExpression', count: 1, domain: 'unknown', kind: 'truthiness' },
        { context: 'controlFlowCondition', count: 3, domain: 'boolean', kind: 'truthiness' },
        { context: 'logicalOperand', count: 1, domain: 'boolean', kind: 'truthiness' },
        { context: 'negationOperand', count: 1, domain: 'boolean', kind: 'truthiness' },
      ],
      modules: 1,
      schema: 'flight-compiler-static-facts/3',
    });
    expect(analyzeIrModulesStaticFacts([lowered.module])).toEqual(analyzeIrModulesStaticFacts([lowered.module]));
    expect(lowered.module).toEqual(snapshot);
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
        { context: 'conditionalExpression', count: 1, domain: 'unknown', kind: 'truthiness' },
        { context: 'logicalOperand', count: 1, domain: 'object', kind: 'truthiness' },
      ],
    });
    expect(analyzeIrModulesStaticFacts([])).toEqual({
      facts: [],
      modules: 0,
      schema: 'flight-compiler-static-facts/3',
    });
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
        { access: 'read', count: 2, kind: 'indexedAccess', receivers: ['array'] },
        { count: 1, domain: 'number', kind: 'numericRelation' },
        { context: 'conditionalExpression', count: 1, domain: 'boolean', kind: 'truthiness' },
        { context: 'controlFlowCondition', count: 2, domain: 'boolean', kind: 'truthiness' },
        { context: 'controlFlowCondition', count: 1, domain: 'unknown', kind: 'truthiness' },
      ]),
    );
    expect(lowered.module).toEqual(snapshot);
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
    ]);
  });
});
