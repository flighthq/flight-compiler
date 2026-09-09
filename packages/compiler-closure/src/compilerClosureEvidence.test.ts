import ts from 'typescript';

import { lowerTypeScriptSource } from '../../compiler-semantic/src/index.js';
import type { CompilerClosureEvidence, IrModule } from '../../compiler-types/src/index.js';
import { analyzeIrModuleClosureEvidence } from './compilerClosureEvidence.js';

describe('analyzeIrModuleClosureEvidence', () => {
  it('distinguishes closure origins, recursion, module capture, and lexical this capture', () => {
    const evidence = analyzeIrModuleClosureEvidence(
      lower(`
        let global: number = 0;
        export function recurse(input: number): number {
          global += input;
          if (input > 0) return recurse(input - 1);
          return global;
        }
        export class Box {
          constructor(value: number) { value; }
          method(): () => Box { return () => this; }
          static read(): number { return global; }
        }
      `),
    );
    const recurse = evidence.closures.find((closure) => closure.origin.kind === 'functionDeclaration');
    const constructor = evidence.closures.find((closure) => closure.origin.kind === 'classConstructor');
    const method = evidence.closures.find(
      (closure) => closure.origin.kind === 'classMethod' && closure.origin.method === 'method',
    );
    const arrow = evidence.closures.find((closure) => closure.thisMode === 'lexical');
    const staticMethod = evidence.closures.find(
      (closure) => closure.origin.kind === 'classMethod' && closure.origin.method === 'read',
    );

    expect(evidence.schema).toBe('flight-compiler-closure-evidence/1');
    expect(recurse).toMatchObject({
      escape: 'mayEscape',
      thisMode: 'dynamic',
      valueUses: expect.arrayContaining([expect.objectContaining({ kind: 'exported' })]),
    });
    expect(recurse?.captures.find((capture) => capture.binding.name === 'global')).toMatchObject({
      lifetimeBoundaries: ['moduleLifetime'],
      mutation: 'bindingReassigned',
    });
    expect(recurse?.selfReferences).toHaveLength(1);
    expect(constructor).toMatchObject({
      escape: 'mayEscape',
      valueUses: [{ kind: 'classStorage', path: expect.any(Array) }],
    });
    expect(method).toMatchObject({ thisMode: 'dynamic', thisUses: [] });
    expect(arrow).toMatchObject({ escape: 'mayEscape', thisMode: 'lexical' });
    expect(arrow?.thisUses).toHaveLength(1);
    expect(staticMethod?.captures.find((capture) => capture.binding.name === 'global')?.lifetimeBoundaries).toEqual([
      'moduleLifetime',
    ]);
  });

  it('reports capture mutation, external mutation, escape retention, and suspension retention independently', () => {
    const evidence = analyzeIrModuleClosureEvidence(
      lower(`
        export function make(seed: number): () => Promise<number> {
          let scalar: number = seed;
          let record: { count: number; extra?: number } = { count: seed, extra: seed };
          scalar++;
          const closure = async (): Promise<number> => {
            await Promise.resolve();
            scalar++;
            record.count++;
            delete record.extra;
            return scalar + record.count;
          };
          scalar--;
          return closure;
        }
      `),
    );
    const closure = evidence.closures.find((candidate) => candidate.async);
    const scalar = closure?.captures.find((capture) => capture.binding.name === 'scalar');
    const record = closure?.captures.find((capture) => capture.binding.name === 'record');

    expect(closure).toMatchObject({
      escape: 'mayEscape',
      suspensions: [expect.any(Array)],
      valueUses: expect.arrayContaining([
        expect.objectContaining({ kind: 'storedBinding' }),
        expect.objectContaining({ kind: 'returned' }),
      ]),
    });
    expect(scalar).toMatchObject({
      lifetimeBoundaries: ['closureEscape', 'suspension'],
      mutation: 'bindingReassigned',
      outsideMutations: [
        expect.objectContaining({ kind: 'rebind', lexicalRelation: 'beforeCreation' }),
        expect.objectContaining({ kind: 'rebind', lexicalRelation: 'afterCreation' }),
      ],
    });
    expect(record).toMatchObject({
      lifetimeBoundaries: ['closureEscape', 'suspension'],
      mutation: 'referentMutated',
      outsideMutations: [],
    });
  });

  it('retains imported, per-iteration, and catch bindings through their exact closure boundaries', () => {
    const evidence = analyzeIrModuleClosureEvidence(
      lower(`
        import { external } from './external.js';
        import type { External } from './external-type.js';
        type Local = External;
        export function collect(): Array<() => number> {
          const callbacks: Array<() => number> = [];
          for (let index: number = 0; index < 2; index++) callbacks.push(() => index + external);
          try { throw 1; } catch (error) { callbacks.push(() => error as number); }
          return callbacks;
        }
      `),
    );
    const iteration = evidence.closures.find((closure) =>
      closure.captures.some((capture) => capture.binding.name === 'index'),
    );
    const caught = evidence.closures.find((closure) =>
      closure.captures.some((capture) => capture.binding.name === 'error'),
    );

    expect(iteration).toMatchObject({
      escape: 'mayEscape',
      valueUses: expect.arrayContaining([expect.objectContaining({ kind: 'passedArgument' })]),
    });
    expect(iteration?.captures.find((capture) => capture.binding.name === 'index')?.lifetimeBoundaries).toEqual([
      'iteration',
      'closureEscape',
    ]);
    expect(iteration?.captures.find((capture) => capture.binding.name === 'external')?.lifetimeBoundaries).toEqual([
      'moduleLifetime',
    ]);
    expect(caught?.captures.find((capture) => capture.binding.name === 'error')).toMatchObject({
      lifetimeBoundaries: ['closureEscape'],
    });
  });

  it('classifies direct, discarded, exported, passed, aggregate, alias, property, and unknown value uses', () => {
    const evidence = analyzeIrModuleClosureEvidence(
      lower(`
        export function classify(seed: number, consume: (callback: () => number) => void): object {
          (() => seed)();
          const stored = () => seed;
          stored();
          const alias = stored;
          const aggregate = { callback: () => seed };
          consume(() => seed);
          const box: { callback?: () => number } = {};
          box.callback = () => seed;
          let assigned: () => number;
          assigned = () => seed;
          assigned();
          (() => seed);
          if (seed) return () => seed;
          return aggregate;
        }
        export default () => 1;
      `),
    );
    const kinds = new Set(evidence.closures.flatMap((closure) => closure.valueUses.map((use) => use.kind)));
    const nonEscaping = evidence.closures.filter((closure) => closure.escape === 'knownNonEscaping');
    const defaultExport = evidence.closures.find((closure) => closure.path[0] === 'exports');

    expect(kinds).toEqual(
      new Set([
        'directInvocation',
        'discarded',
        'exported',
        'passedArgument',
        'returned',
        'storedAggregate',
        'storedAlias',
        'storedBinding',
        'storedProperty',
        'unknown',
      ]),
    );
    expect(nonEscaping.some((closure) => hasValueUse(closure, 'directInvocation'))).toBe(true);
    expect(nonEscaping.some((closure) => hasValueUse(closure, 'discarded'))).toBe(true);
    expect(defaultExport).toMatchObject({
      escape: 'mayEscape',
      valueUses: [expect.objectContaining({ kind: 'exported' })],
    });
  });

  it('attributes a transitive capture only to its actual lexical user and returns deterministic immutable evidence', () => {
    const module = lower(`
      export function nested(value: number): () => () => number {
        const middle = () => {
          const inner = () => value;
          return inner;
        };
        return middle;
      }
    `);
    const snapshot = structuredClone(module);

    const first = analyzeIrModuleClosureEvidence(module);
    const second = analyzeIrModuleClosureEvidence(module);
    const expressions = first.closures.filter((closure) => closure.origin.kind === 'functionExpression');

    expect(expressions).toHaveLength(2);
    expect(
      expressions.filter((closure) => closure.captures.some((capture) => capture.binding.name === 'value')),
    ).toHaveLength(1);
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(isDeeplyFrozen(first, new WeakSet())).toBe(true);
    expect(module).toEqual(snapshot);
  });

  it('covers named, destructured, repeated, conditional, and every loop-binding closure form', () => {
    const evidence = analyzeIrModuleClosureEvidence(
      lower(`
        enum Choice { first }
        type Hidden = number;
        export type { Hidden };
        const exportedLater = () => Choice.first;
        export { exportedLater };
        function getRecord(): { count: number } { return { count: 0 }; }
        export async function variants(values: number[]): Promise<Array<() => number>> {
          var repeated: number = 0;
          var repeated: number;
          const [first] = values;
          const { length } = values;
          let both: { count: number } = { count: first };
          const named = function named(value: number): number {
            return value ? named(value - 1) : both.count;
          };
          const closures: Array<() => number> = [];
          for (const value of values) {
            const bodyValue = value;
            closures.push(() => value, () => bodyValue);
          }
          for (const key in { first }) closures.push(() => key.length);
          for await (const value of values) closures.push(() => value);
          for (var hoisted = 0; hoisted < 1; hoisted++) closures.push(() => hoisted);
          const conditional = first ? () => first : () => length;
          const mutate = () => {
            both = { count: 0 };
            both.count++;
            getRecord().count = 1;
            getRecord().count++;
            return named(both.count);
          };
          closures.push(conditional, mutate);
          return closures;
        }
      `),
    );
    const iterationCaptures = evidence.closures.flatMap((closure) =>
      closure.captures.filter((capture) => capture.lifetimeBoundaries.includes('iteration')),
    );
    const both = evidence.closures
      .flatMap((closure) => closure.captures)
      .find((capture) => capture.binding.name === 'both' && capture.mutation === 'bindingAndReferent');

    expect(
      evidence.closures.some((closure) => closure.origin.kind === 'functionExpression' && closure.origin.binding),
    ).toBe(true);
    expect(evidence.closures.some((closure) => closure.valueUses.some((use) => use.kind === 'unknown'))).toBe(true);
    expect(iterationCaptures.map((capture) => capture.binding.name)).toEqual(['value', 'bodyValue', 'key', 'value']);
    expect(
      evidence.closures.flatMap((closure) => closure.captures).find((capture) => capture.binding.name === 'hoisted')
        ?.lifetimeBoundaries,
    ).not.toContain('iteration');
    expect(both).toBeDefined();
  });
  it('excludes type-only exports and non-binding declarations from the exported binding set', () => {
    const evidence = analyzeIrModuleClosureEvidence(
      lower(`
        export type Opaque = number;
        interface Local { value: number }
        const hidden = () => 1;
        export { type Local };
        export default () => 2;
      `),
    );
    const defaultClosure = evidence.closures.find((closure) => closure.path[0] === 'exports');
    expect(defaultClosure?.escape).toBe('mayEscape');
    expect(defaultClosure?.valueUses).toEqual([expect.objectContaining({ kind: 'exported' })]);
    const hiddenClosure = evidence.closures.find(
      (closure) => closure.origin.kind === 'functionExpression' && closure.path[0] !== 'exports',
    );
    expect(hiddenClosure?.escape).toBe('knownNonEscaping');
    expect(hiddenClosure?.valueUses.some((use) => use.kind === 'exported')).toBe(false);
  });

  it('marks class constructors as non-async even when methods are async', () => {
    const evidence = analyzeIrModuleClosureEvidence(
      lower(`
        let state: number = 0;
        export class Worker {
          constructor(value: number) { state = value; }
          async run(): Promise<number> { return state; }
        }
      `),
    );
    const constructor = evidence.closures.find((closure) => closure.origin.kind === 'classConstructor');
    const method = evidence.closures.find((closure) => closure.origin.kind === 'classMethod');
    expect(constructor?.async).toBe(false);
    expect(method?.async).toBe(true);
  });

  it('registers enum declarations as bindings available for capture', () => {
    const evidence = analyzeIrModuleClosureEvidence(
      lower(`
        enum Direction { up, down }
        export const reader = (): number => Direction.up;
      `),
    );
    const reader = evidence.closures.find((closure) => closure.origin.kind === 'functionExpression');
    expect(reader?.captures.some((capture) => capture.binding.name === 'Direction')).toBe(true);
  });

  it('tracks variable-function host bindings for storedBinding classification', () => {
    const evidence = analyzeIrModuleClosureEvidence(
      lower(`
        export function outer(seed: number): number {
          const fn = function inner(value: number): number { return value + seed; };
          return fn(seed);
        }
      `),
    );
    const fn = evidence.closures.find(
      (closure) => closure.origin.kind === 'functionExpression' && closure.origin.binding?.name === 'inner',
    );
    expect(fn?.valueUses.some((use) => use.kind === 'storedBinding')).toBe(true);
    expect(fn?.valueUses.some((use) => use.kind === 'directInvocation')).toBe(true);
  });

  it('adds try-catch bindings only when a catch clause with a binding exists', () => {
    const evidence = analyzeIrModuleClosureEvidence(
      lower(`
        export function trapping(seed: number): () => number {
          let result: number = seed;
          try { result = seed + 1; } finally { result = seed; }
          try { throw seed; } catch (error) { return () => error as number; }
          return () => result;
        }
      `),
    );
    const caughtClosure = evidence.closures.find((closure) =>
      closure.captures.some((capture) => capture.binding.name === 'error'),
    );
    expect(caughtClosure).toBeDefined();
    const resultClosure = evidence.closures.find((closure) =>
      closure.captures.some((capture) => capture.binding.name === 'result'),
    );
    expect(resultClosure?.captures.find((capture) => capture.binding.name === 'result')).toMatchObject({
      mutation: 'none',
    });
  });

  it('detects delete and increment/decrement as referent mutations on distinct operand kinds', () => {
    const evidence = analyzeIrModuleClosureEvidence(
      lower(`
        export function mutations(record: { count: number; extra?: number }): () => number {
          return () => {
            record.count++;
            record.count--;
            delete record.extra;
            return record.count;
          };
        }
      `),
    );
    const closure = evidence.closures.find((candidate) => candidate.origin.kind === 'functionExpression');
    const capture = closure?.captures.find((c) => c.binding.name === 'record');
    expect(capture?.mutation).toBe('referentMutated');
  });

  it('distinguishes assignment to a plain binding from assignment to a property', () => {
    const evidence = analyzeIrModuleClosureEvidence(
      lower(`
        export function assign(seed: number): () => number {
          let plain: number = seed;
          const record: { value: number } = { value: 0 };
          const closure = () => plain + record.value;
          plain = seed + 1;
          record.value = seed;
          return closure;
        }
      `),
    );
    const closure = evidence.closures.find((candidate) => candidate.origin.kind === 'functionExpression');
    const plain = closure?.captures.find((c) => c.binding.name === 'plain');
    const record = closure?.captures.find((c) => c.binding.name === 'record');
    expect(plain?.outsideMutations).toEqual([
      expect.objectContaining({ kind: 'rebind', lexicalRelation: 'afterCreation' }),
    ]);
    expect(record?.outsideMutations).toEqual([
      expect.objectContaining({ kind: 'referentMutation', lexicalRelation: 'afterCreation' }),
    ]);
  });

  it('reports for-await-of as a suspension point for lifetime analysis', () => {
    const evidence = analyzeIrModuleClosureEvidence(
      lower(`
        export function consume(items: number[]): () => Promise<number> {
          let total: number = 0;
          return async () => {
            for await (const item of items) total += item;
            return total;
          };
        }
      `),
    );
    const closure = evidence.closures.find((candidate) => candidate.async);
    const capture = closure?.captures.find((c) => c.binding.name === 'total');
    expect(capture?.lifetimeBoundaries).toContain('suspension');
    expect(capture?.lifetimeBoundaries).toContain('closureEscape');
  });

  it('distinguishes for-in body, for initializer, and for-of variable iteration lifetime correctly', () => {
    const evidence = analyzeIrModuleClosureEvidence(
      lower(`
        export function loops(): Array<() => unknown> {
          const results: Array<() => unknown> = [];
          for (const key in { a: 1 }) results.push(() => key);
          for (let i: number = 0; i < 1; i++) { const v: number = i; results.push(() => v); }
          for (const val of [1]) results.push(() => val);
          return results;
        }
      `),
    );
    const forInCapture = evidence.closures.flatMap((c) => c.captures).find((c) => c.binding.name === 'key');
    const forBodyCapture = evidence.closures.flatMap((c) => c.captures).find((c) => c.binding.name === 'v');
    const forOfCapture = evidence.closures.flatMap((c) => c.captures).find((c) => c.binding.name === 'val');
    expect(forInCapture?.lifetimeBoundaries).toContain('iteration');
    expect(forBodyCapture?.lifetimeBoundaries).toContain('iteration');
    expect(forOfCapture?.lifetimeBoundaries).toContain('iteration');
  });

  it('does not over-report escape, mutation, or lifetime for closures that do none of it', () => {
    // The near-neighbours matter more than the positive cases here. Rust ownership will be elected
    // from this evidence, and an over-reported escape or mutation costs a borrow that the source
    // never needed — a cost nothing downstream can detect, because the output still compiles.
    const evidence = analyzeIrModuleClosureEvidence(
      lower(`
        export function contained(seed: number): number {
          const read: number = seed;
          let written: number = seed;
          const observer = (): number => read;
          const writer = (): number => {
            written = read;
            return written;
          };
          return observer() + writer();
        }
      `),
    );
    const observer = evidence.closures.find(
      (candidate) =>
        candidate.captures.some((capture) => capture.binding.name === 'read') &&
        !candidate.captures.some((capture) => capture.binding.name === 'written'),
    );
    const writer = evidence.closures.find((candidate) =>
      candidate.captures.some((capture) => capture.binding.name === 'written'),
    );
    const read = observer?.captures.find((capture) => capture.binding.name === 'read');
    const written = writer?.captures.find((capture) => capture.binding.name === 'written');

    expect(observer).toMatchObject({ async: false, escape: 'knownNonEscaping', suspensions: [] });
    expect(writer).toMatchObject({ async: false, escape: 'knownNonEscaping' });
    // A capture that is only read is not a mutation, and nothing here outlives its frame.
    expect(read).toMatchObject({ mutation: 'none', outsideMutations: [] });
    expect(read?.lifetimeBoundaries).toEqual([]);
    // A capture the closure writes is a rebinding of the binding, not a mutation of a referent.
    expect(written).toMatchObject({ mutation: 'bindingReassigned', outsideMutations: [] });
    expect(written?.lifetimeBoundaries).toEqual([]);
  });
});

function hasValueUse(
  closure: Readonly<CompilerClosureEvidence>,
  kind: CompilerClosureEvidence['valueUses'][number]['kind'],
): boolean {
  return closure.valueUses.some((use) => use.kind === kind);
}

function isDeeplyFrozen(value: unknown, seen: WeakSet<object>): boolean {
  if (!value || typeof value !== 'object' || seen.has(value)) return true;
  seen.add(value);
  return Object.isFrozen(value) && Object.values(value).every((child) => isDeeplyFrozen(child, seen));
}

function lower(source: string): IrModule {
  const sourceFile = ts.createSourceFile(
    '/flight/packages/closure/src/evidence.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const result = lowerTypeScriptSource(sourceFile, {
    packageName: '@flighthq/closure',
    upstreamDirectory: '/flight',
  });
  expect(result.diagnostics).toEqual([]);
  return result.module;
}
