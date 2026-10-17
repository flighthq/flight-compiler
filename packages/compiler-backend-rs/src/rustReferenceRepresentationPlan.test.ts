import ts from 'typescript';

import { lowerTypeScriptSource } from '../../compiler-semantic/src/index.js';
import type { CompilerModuleResolutionPlan, IrModule } from '../../compiler-types/src/index.js';
import { createCompilerRustReferenceRepresentationPlan } from './rustReferenceRepresentationPlan.js';

describe('createCompilerRustReferenceRepresentationPlan', () => {
  it('plans one mutable Vec borrow across a module boundary deterministically', () => {
    const provider = lower('provider.ts', 'export function append(values: number[]): void { values.push(2); }');
    const consumer = lower(
      'consumer.ts',
      `import { append } from './provider.js';
       export function count(): number {
         const values = [1];
         append(values);
         return values.length;
       }`,
    );
    const moduleResolution = resolve('./provider.js', provider, consumer);
    const input = { moduleResolution, modules: [provider, consumer] } as const;
    const snapshot = structuredClone(input);

    const first = createCompilerRustReferenceRepresentationPlan(input);
    const second = createCompilerRustReferenceRepresentationPlan({
      moduleResolution,
      modules: [consumer, provider],
    });
    const providerPlan = getModulePlan(first, provider);
    const consumerPlan = getModulePlan(first, consumer);

    expect(first.schema).toBe('flight-rust-reference-representation-plan/1');
    expect(second).toEqual(first);
    expect(input).toEqual(snapshot);
    expect(isDeeplyFrozen(first, new WeakSet())).toBe(true);
    expect(providerPlan.refusals).toEqual([]);
    expect(consumerPlan.refusals).toEqual([]);
    expect(providerPlan.callables).toEqual([
      expect.objectContaining({
        binding: expect.objectContaining({ name: 'append' }),
        parameters: [{ position: 0, representation: 'mutable-borrowed-vec' }],
      }),
    ]);
    expect(consumerPlan.callables).toEqual([
      expect.objectContaining({
        binding: expect.objectContaining({ name: 'append' }),
        parameters: [{ position: 0, representation: 'mutable-borrowed-vec' }],
      }),
    ]);
    expect(consumerPlan.referentMutatedBindings).toEqual([expect.objectContaining({ name: 'values' })]);
  });

  it('refuses ambiguous and unresolved imported array call targets', () => {
    const firstProvider = lower(
      'first-provider.ts',
      'export function append(values: number[]): void { values.push(1); }',
    );
    const secondProvider = lower(
      'second-provider.ts',
      'export function append(values: number[]): void { values.push(2); }',
    );
    const consumer = lower(
      'consumer.ts',
      `import { append } from '@fixture/provider';
       export function run(values: number[]): void { append(values); }`,
    );
    const target = (module: Readonly<IrModule>) => ({ packageName: module.packageName, source: module.source });
    const ambiguousResolution: CompilerModuleResolutionPlan = {
      edges: [
        { importer: identity(consumer), specifier: '@fixture/provider', target: target(firstProvider) },
        { importer: identity(consumer), specifier: '@fixture/provider', target: target(secondProvider) },
      ],
      schema: 'flight-compiler-module-resolution/1',
    };

    expect(
      getModulePlan(
        createCompilerRustReferenceRepresentationPlan({
          moduleResolution: ambiguousResolution,
          modules: [consumer, firstProvider, secondProvider],
        }),
        consumer,
      ).refusals,
    ).toEqual([expect.objectContaining({ code: 'rust-reference-array-call-target-ambiguous' })]);
    expect(
      getModulePlan(createCompilerRustReferenceRepresentationPlan({ modules: [consumer] }), consumer).refusals,
    ).toEqual([expect.objectContaining({ code: 'rust-reference-array-call-target-unresolved' })]);
  });

  it('refuses imported mutation outside the focused Vec representation', () => {
    const provider = lower(
      'provider.ts',
      'export function clear(values: Map<string, number>): void { values.clear(); }',
    );
    const consumer = lower(
      'consumer.ts',
      `import { clear } from './provider.js';
       export function run(values: Map<string, number>): void { clear(values); }`,
    );
    const plan = createCompilerRustReferenceRepresentationPlan({
      moduleResolution: resolve('./provider.js', provider, consumer),
      modules: [provider, consumer],
    });

    expect(getModulePlan(plan, consumer).refusals).toEqual([
      expect.objectContaining({ code: 'rust-reference-mutating-parameter-unrepresented' }),
    ]);
  });

  it('requires the versioned module-resolution contract', () => {
    const module = lower('value.ts', 'export const value = 1;');
    expect(() =>
      createCompilerRustReferenceRepresentationPlan({
        moduleResolution: { edges: [], schema: 'wrong' } as never,
        modules: [module],
      }),
    ).toThrow('Rust reference representation planning requires flight-compiler-module-resolution/1');
  });
});

function resolve(
  specifier: string,
  provider: Readonly<IrModule>,
  consumer: Readonly<IrModule>,
): CompilerModuleResolutionPlan {
  return {
    edges: [
      {
        importer: identity(consumer),
        specifier,
        target: { packageName: provider.packageName, source: provider.source },
      },
    ],
    schema: 'flight-compiler-module-resolution/1',
  };
}

function getModulePlan(
  plan: ReturnType<typeof createCompilerRustReferenceRepresentationPlan>,
  module: Readonly<IrModule>,
) {
  const found = plan.modules.find((candidate) => candidate.module.source === module.source);
  if (!found) throw new Error(`Missing plan for ${module.source}`);
  return found;
}

function identity(module: Readonly<IrModule>) {
  return { name: module.name, packageName: module.packageName, source: module.source };
}

function lower(file: string, source: string): IrModule {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const result = lowerTypeScriptSource(sourceFile, { packageName: '@fixture/reference', upstreamDirectory: '.' });
  if (result.diagnostics.length > 0) throw new Error(result.diagnostics.map((item) => item.message).join('\n'));
  return result.module;
}

function isDeeplyFrozen(value: unknown, seen: WeakSet<object>): boolean {
  if (!value || typeof value !== 'object' || seen.has(value)) return true;
  seen.add(value);
  return Object.isFrozen(value) && Object.values(value).every((child) => isDeeplyFrozen(child, seen));
}
