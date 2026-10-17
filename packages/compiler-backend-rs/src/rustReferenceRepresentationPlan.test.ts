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

  it('plans one mutable HashMap borrow across a module boundary', () => {
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

    expect(getModulePlan(plan, provider).callables).toEqual([
      expect.objectContaining({
        binding: expect.objectContaining({ name: 'clear' }),
        parameters: [{ position: 0, representation: 'mutable-borrowed-hash-map' }],
      }),
    ]);
    expect(getModulePlan(plan, consumer).refusals).toEqual([]);
    expect(getModulePlan(plan, consumer).callables).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          binding: expect.objectContaining({ name: 'clear' }),
          parameters: [{ position: 0, representation: 'mutable-borrowed-hash-map' }],
        }),
      ]),
    );
  });

  it('elects one shared RefCell Vec carrier for a mutated local alias group', () => {
    const module = lower(
      'alias-array.ts',
      `export function aliasArray(): number {
         const values = [1];
         const alias = values;
         alias.push(2);
         return values.length;
       }`,
    );
    const first = createCompilerRustReferenceRepresentationPlan({ modules: [module] });
    const second = createCompilerRustReferenceRepresentationPlan({ modules: [structuredClone(module)] });
    const modulePlan = getModulePlan(first, module);

    expect(second).toEqual(first);
    expect(isDeeplyFrozen(first, new WeakSet())).toBe(true);
    expect(modulePlan.refusals).toEqual([]);
    expect(
      modulePlan.sharedArrayBindings.map(({ binding, representation }) => [binding.name, representation]).sort(),
    ).toEqual([
      ['alias', 'shared-ref-cell-vec'],
      ['values', 'shared-ref-cell-vec'],
    ]);
  });

  it('refuses overlapping shared-array borrows before emitting RefCell runtime failure', () => {
    const module = lower(
      'alias-conflict.ts',
      `export function aliasConflict(): number {
         const values = [1];
         const alias = values;
         alias.push(values.length);
         return alias.length;
       }`,
    );

    expect(
      getModulePlan(createCompilerRustReferenceRepresentationPlan({ modules: [module] }), module).refusals,
    ).toEqual([expect.objectContaining({ code: 'rust-reference-shared-array-borrow-conflict' })]);
  });

  it('refuses shared-array suspension and escaping closure capture', () => {
    const suspended = lower(
      'alias-suspended.ts',
      `export async function aliasSuspended(task: Promise<void>): Promise<number> {
         const values = [1];
         const alias = values;
         await task;
         alias.push(2);
         return values.length;
       }`,
    );
    const escaping = lower(
      'alias-escape.ts',
      `export function aliasEscape(consume: (callback: () => void) => void): number {
         const values = [1];
         const alias = values;
         consume(() => alias.push(2));
         return values.length;
       }`,
    );

    expect(
      getModulePlan(createCompilerRustReferenceRepresentationPlan({ modules: [suspended] }), suspended).refusals,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'rust-reference-shared-array-suspension-unrepresented' }),
      ]),
    );
    expect(
      getModulePlan(createCompilerRustReferenceRepresentationPlan({ modules: [escaping] }), escaping).refusals,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'rust-reference-shared-array-closure-escape-unrepresented' }),
      ]),
    );
  });

  it('refuses a mutable alias whose source identity group is ambiguous', () => {
    const module = lower(
      'alias-ambiguous.ts',
      `export function aliasAmbiguous(flag: boolean): number {
         const left = [1];
         const right = [2];
         const alias = flag ? left : right;
         alias.push(3);
         return alias.length;
       }`,
    );

    expect(
      getModulePlan(createCompilerRustReferenceRepresentationPlan({ modules: [module] }), module).refusals,
    ).toEqual([expect.objectContaining({ code: 'rust-reference-shared-array-alias-ambiguous' })]);
  });

  it('elects one shared RefCell HashMap carrier for a mutated local alias group', () => {
    const module = lower(
      'alias-map.ts',
      `export function aliasMap(): number {
         const values = new Map<string, number>();
         const alias = values;
         alias.set("key", 2);
         return values.size;
       }`,
    );
    const first = createCompilerRustReferenceRepresentationPlan({ modules: [module] });
    const second = createCompilerRustReferenceRepresentationPlan({ modules: [structuredClone(module)] });
    const modulePlan = getModulePlan(first, module);

    expect(second).toEqual(first);
    expect(isDeeplyFrozen(first, new WeakSet())).toBe(true);
    expect(modulePlan.refusals).toEqual([]);
    expect(
      modulePlan.sharedMapBindings.map(({ binding, representation }) => [binding.name, representation]).sort(),
    ).toEqual([
      ['alias', 'shared-ref-cell-hash-map'],
      ['values', 'shared-ref-cell-hash-map'],
    ]);
  });

  it('refuses observed Map mutator results and overlapping shared Map borrows', () => {
    const observed = lower(
      'map-result.ts',
      `export function mapResult(): Map<string, number> {
         const values = new Map<string, number>();
         const alias = values;
         return alias.set("key", 2);
       }`,
    );
    const conflict = lower(
      'map-conflict.ts',
      `export function mapConflict(): number {
         const values = new Map<string, number>();
         const alias = values;
         alias.set("size", values.size);
         return alias.size;
       }`,
    );
    const callConflict = lower(
      'map-call-conflict.ts',
      `function fill(values: Map<string, number>, size: number): void { values.set("size", size); }
       export function mapCallConflict(): number {
         const values = new Map<string, number>();
         const alias = values;
         fill(alias, values.size);
         return alias.size;
       }`,
    );

    expect(
      getModulePlan(createCompilerRustReferenceRepresentationPlan({ modules: [observed] }), observed).refusals,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'rust-reference-shared-map-mutator-result-unrepresented' }),
      ]),
    );
    expect(
      getModulePlan(createCompilerRustReferenceRepresentationPlan({ modules: [conflict] }), conflict).refusals,
    ).toEqual([expect.objectContaining({ code: 'rust-reference-shared-map-borrow-conflict' })]);
    expect(
      getModulePlan(createCompilerRustReferenceRepresentationPlan({ modules: [callConflict] }), callConflict).refusals,
    ).toEqual([expect.objectContaining({ code: 'rust-reference-shared-map-borrow-conflict' })]);
  });

  it('refuses unsupported shared Map key and identity-valued value domains', () => {
    const namedAlias = lower(
      'map-named-alias.ts',
      `type Values = Map<string, number>;
       export function mapNamedAlias(): number {
         const values: Values = new Map<string, number>();
         const alias = values;
         alias.set("key", 2);
         return values.size;
       }`,
    );
    const sameValueZeroKey = lower(
      'map-number-key.ts',
      `export function mapNumberKey(): number {
         const values = new Map<number, number>();
         const alias = values;
         alias.set(0, 2);
         return values.size;
       }`,
    );
    const objectKey = lower(
      'map-object-key.ts',
      `export function mapObjectKey(): number {
         const values = new Map<{ id: number }, number>();
         const alias = values;
         alias.set({ id: 1 }, 2);
         return values.size;
       }`,
    );
    const identityValue = lower(
      'map-identity-value.ts',
      `export function mapIdentityValue(): number {
         const values = new Map<string, number[]>();
         const alias = values;
         alias.set("key", [2]);
         return values.size;
       }`,
    );

    expect(
      getModulePlan(createCompilerRustReferenceRepresentationPlan({ modules: [namedAlias] }), namedAlias).refusals,
    ).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'rust-reference-shared-map-use-unrepresented' })]),
    );
    expect(
      getModulePlan(createCompilerRustReferenceRepresentationPlan({ modules: [sameValueZeroKey] }), sameValueZeroKey)
        .refusals,
    ).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'rust-reference-shared-map-key-unrepresented' })]),
    );
    expect(
      getModulePlan(createCompilerRustReferenceRepresentationPlan({ modules: [objectKey] }), objectKey).refusals,
    ).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'rust-reference-shared-map-key-unrepresented' })]),
    );
    expect(
      getModulePlan(createCompilerRustReferenceRepresentationPlan({ modules: [identityValue] }), identityValue)
        .refusals,
    ).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'rust-reference-shared-map-value-unrepresented' })]),
    );
  });

  it('refuses shared Map iteration, dynamic calls, suspension, escape, reassignment, and ambiguous aliases', () => {
    const cases: Array<readonly [IrModule, string]> = [
      [
        lower(
          'map-iteration.ts',
          `export function mapIteration(): number {
             const values = new Map<string, number>();
             const alias = values;
             alias.set("key", 2);
             for (const entry of values) { entry; }
             return alias.size;
           }`,
        ),
        'rust-reference-shared-map-use-unrepresented',
      ],
      [
        lower(
          'map-non-root.ts',
          `function create(): Map<string, number> { return new Map<string, number>(); }
           export function mapNonRoot(): number {
             const values = create();
             const alias = values;
             alias.set("key", 2);
             return values.size;
           }`,
        ),
        'rust-reference-shared-map-use-unrepresented',
      ],
      [
        lower(
          'map-dynamic.ts',
          `export function mapDynamic(mutate: (value: Map<string, number>) => void): number {
             const values = new Map<string, number>();
             const alias = values;
             mutate(alias);
             return values.size;
           }`,
        ),
        'rust-reference-shared-map-call-unrepresented',
      ],
      [
        lower(
          'map-optional-call.ts',
          `export function mapOptionalCall(mutate: ((value: Map<string, number>) => void) | undefined): number {
             const values = new Map<string, number>();
             const alias = values;
             mutate?.(alias);
             return values.size;
           }`,
        ),
        'rust-reference-shared-map-call-unrepresented',
      ],
      [
        lower(
          'map-suspension.ts',
          `export async function mapSuspension(task: Promise<void>): Promise<number> {
             const values = new Map<string, number>();
             const alias = values;
             await task;
             alias.set("key", 2);
             return values.size;
           }`,
        ),
        'rust-reference-shared-map-suspension-unrepresented',
      ],
      [
        lower(
          'map-escape.ts',
          `export function mapEscape(consume: (callback: () => void) => void): number {
             const values = new Map<string, number>();
             const alias = values;
             consume(() => alias.set("key", 2));
             return values.size;
           }`,
        ),
        'rust-reference-shared-map-closure-escape-unrepresented',
      ],
      [
        lower(
          'map-reassignment.ts',
          `export function mapReassignment(): number {
             let values = new Map<string, number>();
             const alias = values;
             values = new Map<string, number>();
             alias.set("key", 2);
             return values.size;
           }`,
        ),
        'rust-reference-shared-map-binding-reassignment-unrepresented',
      ],
      [
        lower(
          'map-ambiguous.ts',
          `export function mapAmbiguous(flag: boolean): number {
             const left = new Map<string, number>();
             const right = new Map<string, number>();
             const alias = flag ? left : right;
             alias.set("key", 2);
             return alias.size;
           }`,
        ),
        'rust-reference-shared-map-alias-ambiguous',
      ],
    ];

    for (const [module, code] of cases) {
      expect(
        getModulePlan(createCompilerRustReferenceRepresentationPlan({ modules: [module] }), module).refusals,
      ).toEqual(expect.arrayContaining([expect.objectContaining({ code })]));
    }
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
