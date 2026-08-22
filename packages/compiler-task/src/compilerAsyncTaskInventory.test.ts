import ts from 'typescript';

import { lowerTypeScriptSource } from '../../compiler-semantic/src/index.js';
import type { IrModule } from '../../compiler-types/src/index.js';
import { analyzeIrModuleAsyncTaskInventory } from './compilerAsyncTaskInventory.js';

describe('analyzeIrModuleAsyncTaskInventory', () => {
  it('owns await and async iteration by the nearest function boundary and recovers task outputs', () => {
    const module = lower(`
      export async function load(values: AsyncIterable<number>): Promise<number> {
        await Promise.resolve(1);
        for await (const value of values) { await Promise.resolve(value); }
        const nested = async (): Promise<string> => await Promise.resolve('nested');
        const synchronous = () => Promise.resolve(2).then(() => 2);
        synchronous();
        await nested();
        return Promise.all([nested()]).then(() => 1);
      }
      export async function inferred() { return 1; }
      export class Worker {
        constructor() { Promise.reject(new Error()); }
        async run(): Promise<void> { await new Promise(() => undefined); }
        sync(): void { Promise.resolve().catch(() => undefined).finally(() => undefined); }
      }
      export const top = Promise.resolve(0);
    `);
    const snapshot = structuredClone(module);

    const inventory = analyzeIrModuleAsyncTaskInventory(module);

    expect(inventory.schema).toBe('flight-compiler-async-task-inventory/1');
    expect(inventory.module).toEqual({
      name: module.name,
      packageName: module.packageName,
      source: module.source,
    });
    expect(inventory.scopes.map((scope) => scope.origin.kind)).toEqual([
      'functionDeclaration',
      'functionExpression',
      'functionDeclaration',
      'classMethod',
    ]);
    expect(inventory.scopes.map((scope) => scope.body)).toEqual(['block', 'expression', 'block', 'block']);
    expect(inventory.scopes.map((scope) => scope.output.kind)).toEqual([
      'recovered',
      'recovered',
      'unresolved',
      'recovered',
    ]);
    expect(inventory.scopes.every((scope) => scope.taskCreation === 'before-body')).toBe(true);
    expect(inventory.suspensions.map((site) => site.kind)).toEqual([
      'await',
      'asyncIteration',
      'await',
      'await',
      'await',
      'await',
    ]);
    expect(inventory.suspensions.every((site) => site.scopePath !== undefined)).toBe(true);
    const nested = inventory.scopes[1]!;
    expect(
      inventory.suspensions.filter((site) => JSON.stringify(site.scopePath) === JSON.stringify(nested.path)),
    ).toHaveLength(1);
    expect(module).toEqual(snapshot);
  });

  it('classifies explicit construction, async invocation, and composition candidates without target policy', () => {
    const inventory = analyzeIrModuleAsyncTaskInventory(
      lower(`
        async function nested(): Promise<number> { return 1; }
        export async function compose(values: number[]): Promise<number> {
          const [first] = values;
          first;
          new Promise(() => undefined);
          Promise.resolve(1);
          Promise.reject(new Error());
          Promise.all([nested()]);
          nested();
          (async (): Promise<number> => 1)();
          const named = async function namedTask(): Promise<number> { return 1; };
          named();
          values.map((value) => value);
          return Promise.resolve(1).then(() => 1).catch(() => 0).finally(() => undefined);
        }
      `),
    );

    expect(inventory.operations.map(({ evidence, operation }) => ({ evidence, operation }))).toEqual(
      expect.arrayContaining([
        { evidence: 'ambient-promise-constructor', operation: 'construct' },
        { evidence: 'ambient-promise-static', operation: 'ready' },
        { evidence: 'ambient-promise-static', operation: 'reject' },
        { evidence: 'ambient-promise-static', operation: 'joinAll' },
        { evidence: 'async-binding', operation: 'invokeAsync' },
        { evidence: 'inline-async-function', operation: 'invokeAsync' },
        { evidence: 'property-name-candidate', operation: 'then' },
        { evidence: 'property-name-candidate', operation: 'catch' },
        { evidence: 'property-name-candidate', operation: 'finally' },
      ]),
    );
    expect(inventory.operations.every((operation) => operation.scopePath !== undefined)).toBe(true);
    expect(inventory.operations.every((operation) => operation.optional === false)).toBe(true);
  });

  it('keeps unowned suspension and task operations explicit across synchronous boundaries', () => {
    const module = lower(`
      export const top = Promise.resolve(1);
      export function synchronous(): void {
        Promise.reject(new Error());
      }
    `);
    const declaration = module.declarations.find((candidate) => candidate.kind === 'function');
    if (declaration?.kind !== 'function') throw new Error('Expected function declaration');
    const awaited = {
      expression: { kind: 'literal', value: 1 },
      kind: 'await',
      semantics: {
        continuation: 'enqueue-after-settlement',
        fulfillment: 'resume-normal-with-value',
        operandEvaluation: 'once-before-suspension',
        rejection: 'resume-throw-with-reason',
        schema: 'flight-compiler-await-semantics/1',
        suspension: 'always-before-continuation',
        taskResolution: 'normalize-value-task-or-thenable',
      },
    } as const;
    const malformedModule: IrModule = {
      ...module,
      declarations: module.declarations.map((candidate) =>
        candidate === declaration
          ? {
              ...declaration,
              body: [...declaration.body, { expression: awaited, kind: 'expression' }],
            }
          : candidate,
      ),
    };

    const inventory = analyzeIrModuleAsyncTaskInventory(malformedModule);

    expect(inventory.scopes).toEqual([]);
    expect(inventory.suspensions).toEqual([expect.not.objectContaining({ scopePath: expect.anything() })]);
    expect(inventory.operations).toHaveLength(2);
    expect(inventory.operations.every((operation) => operation.scopePath === undefined)).toBe(true);
  });

  it('returns a deterministic deeply immutable snapshot with dynamic and optional call evidence', () => {
    const module = lower(`
      export async function invoke(values: number[]): Promise<void> {
        Promise.resolve(...values);
        const task: Promise<number> | undefined = Promise.resolve(1);
        task?.then?.(() => undefined);
      }
    `);

    const first = analyzeIrModuleAsyncTaskInventory(module);
    const second = analyzeIrModuleAsyncTaskInventory(module);

    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(first.operations.some((operation) => operation.argumentCount === 'dynamic')).toBe(true);
    expect(first.operations.some((operation) => operation.optional)).toBe(true);
    expect(isDeeplyFrozen(first, new WeakSet())).toBe(true);
  });
});

function isDeeplyFrozen(value: unknown, seen: WeakSet<object>): boolean {
  if (!value || typeof value !== 'object' || seen.has(value)) return true;
  seen.add(value);
  return Object.isFrozen(value) && Object.values(value).every((child) => isDeeplyFrozen(child, seen));
}

function lower(source: string): IrModule {
  const sourceFile = ts.createSourceFile(
    '/flight/packages/task/src/inventory.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const result = lowerTypeScriptSource(sourceFile, {
    packageName: '@flighthq/task',
    upstreamDirectory: '/flight',
  });
  expect(result.diagnostics).toEqual([]);
  return result.module;
}
