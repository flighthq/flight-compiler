import ts from 'typescript';

import { compareTextCodeUnits } from '../../compiler-canonical-form/src/index.js';
import { lowerTypeScriptSource, lowerTypeScriptSources } from '../../compiler-semantic/src/index.js';
import type { CompilerModuleResolutionPlan, IrExpression, IrModule } from '../../compiler-types/src/index.js';
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

  it('promotes an observed reverse result only when the original array identity remains live', () => {
    const shared = lower(
      'reverse-result-shared.ts',
      `export function sharedReverse(): number {
         const values = [1, 2, 3];
         const returned = values.reverse();
         returned.push(4);
         return values.length;
       }`,
    );
    const moved = lower(
      'reverse-result-moved.ts',
      `export function movedReverse(): number {
         const values = [1, 2, 3];
         const returned = values.reverse();
         return returned.length;
       }`,
    );

    expect(
      getModulePlan(createCompilerRustReferenceRepresentationPlan({ modules: [shared] }), shared)
        .sharedArrayBindings.map(({ binding }) => binding.name)
        .sort(),
    ).toEqual(['returned', 'values']);
    expect(
      getModulePlan(createCompilerRustReferenceRepresentationPlan({ modules: [moved] }), moved).sharedArrayBindings,
    ).toEqual([]);
  });

  it('promotes an observed fill result only when the original array identity remains live', () => {
    const shared = lower(
      'fill-result-shared.ts',
      `export function sharedFill(): number {
         const values = [1, 2, 3];
         const returned = values.fill(0);
         returned.push(4);
         return values.length;
       }`,
    );
    const moved = lower(
      'fill-result-moved.ts',
      `export function movedFill(): number {
         const values = [1, 2, 3];
         const returned = values.fill(0);
         return returned.length;
       }`,
    );

    expect(
      getModulePlan(createCompilerRustReferenceRepresentationPlan({ modules: [shared] }), shared)
        .sharedArrayBindings.map(({ binding }) => binding.name)
        .sort(),
    ).toEqual(['returned', 'values']);
    expect(
      getModulePlan(createCompilerRustReferenceRepresentationPlan({ modules: [moved] }), moved).sharedArrayBindings,
    ).toEqual([]);
  });

  it('promotes an observed copyWithin result only when the original array identity remains live', () => {
    const shared = lower(
      'copy-within-result-shared.ts',
      `export function sharedCopy(): number {
         const values = [1, 2, 3];
         const returned = values.copyWithin(0, 1);
         returned.push(4);
         return values.length;
       }`,
    );
    const moved = lower(
      'copy-within-result-moved.ts',
      `export function movedCopy(): number {
         const values = [1, 2, 3];
         const returned = values.copyWithin(0, 1);
         return returned.length;
       }`,
    );

    expect(
      getModulePlan(createCompilerRustReferenceRepresentationPlan({ modules: [shared] }), shared)
        .sharedArrayBindings.map(({ binding }) => binding.name)
        .sort(),
    ).toEqual(['returned', 'values']);
    expect(
      getModulePlan(createCompilerRustReferenceRepresentationPlan({ modules: [moved] }), moved).sharedArrayBindings,
    ).toEqual([]);
  });

  it('promotes an observed sort result only when the original array identity remains live', () => {
    const shared = lower(
      'sort-result-shared.ts',
      `export function sharedSort(): number {
         const values = [3, 1, 2];
         const returned = values.sort((left, right) => left - right);
         returned.push(4);
         return values.length;
       }`,
    );
    const moved = lower(
      'sort-result-moved.ts',
      `export function movedSort(): number {
         const values = [3, 1, 2];
         const returned = values.sort((left, right) => left - right);
         return returned.length;
       }`,
    );

    expect(
      getModulePlan(createCompilerRustReferenceRepresentationPlan({ modules: [shared] }), shared)
        .sharedArrayBindings.map(({ binding }) => binding.name)
        .sort(),
    ).toEqual(['returned', 'values']);
    expect(
      getModulePlan(createCompilerRustReferenceRepresentationPlan({ modules: [moved] }), moved).sharedArrayBindings,
    ).toEqual([]);
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

  it('refuses a shared-array slice bound that reads the receiver alias group', () => {
    const module = lower(
      'alias-slice-conflict.ts',
      `export function aliasSliceConflict(): number[] {
         const values = [1, 2, 3];
         const alias = values;
         const result = alias.slice(values.length);
         values.push(4);
         return result;
       }`,
    );

    expect(
      getModulePlan(createCompilerRustReferenceRepresentationPlan({ modules: [module] }), module).refusals,
    ).toEqual([expect.objectContaining({ code: 'rust-reference-shared-array-borrow-conflict' })]);
  });

  it('represents every direct shared concat argument and refuses a nested alias read in a later position', () => {
    const direct = lower(
      'alias-concat-pack.ts',
      `export function aliasConcatPack(): number[] {
         const values = [1, 2];
         const alias = values;
         const result = alias.concat(values, alias, values);
         values.push(3);
         return result;
       }`,
    );
    const nested = lower(
      'alias-concat-nested.ts',
      `export function aliasConcatNested(): number[] {
         const values = [1, 2];
         const alias = values;
         const result = alias.concat([0], values.slice());
         values.push(3);
         return result;
       }`,
    );

    expect(
      getModulePlan(createCompilerRustReferenceRepresentationPlan({ modules: [direct] }), direct).refusals,
    ).toEqual([]);
    expect(
      getModulePlan(createCompilerRustReferenceRepresentationPlan({ modules: [nested] }), nested).refusals,
    ).toEqual([expect.objectContaining({ code: 'rust-reference-shared-array-borrow-conflict' })]);
  });

  it('represents an independent mapped Array.from callback over a shared source', () => {
    const module = lower(
      'array-from-mapped-shared.ts',
      `export function mapped(): number {
         const values = [1, 2];
         const alias = values;
         const result = Array.from(alias, (value: number, index: number): number => value + index);
         values.push(3);
         result.push(9);
         return alias.length * 10 + result.length;
       }`,
    );
    const modulePlan = getModulePlan(createCompilerRustReferenceRepresentationPlan({ modules: [module] }), module);

    expect(modulePlan.refusals).toEqual([]);
    expect(modulePlan.sharedArrayBindings.map(({ binding }) => binding.name).sort()).toEqual(['alias', 'values']);
  });

  it('refuses direct and transitive mapped Array.from captures of the shared source alias group', () => {
    const direct = lower(
      'array-from-mapped-direct-conflict.ts',
      `export function mapped(): number[] {
         const values = [1, 2];
         const alias = values;
         const result = Array.from(alias, (value: number): number => value + values.length);
         values.push(3);
         return result;
       }`,
    );
    const transitive = lower(
      'array-from-mapped-transitive-conflict.ts',
      `export function mapped(): number[] {
         const values = [1, 2];
         const alias = values;
         const read = (): number => values.length;
         const result = Array.from(alias, (value: number): number => value + read());
         values.push(3);
         return result;
       }`,
    );

    expect(
      getModulePlan(createCompilerRustReferenceRepresentationPlan({ modules: [direct] }), direct).refusals,
    ).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'rust-reference-shared-array-borrow-conflict' })]),
    );
    expect(
      getModulePlan(createCompilerRustReferenceRepresentationPlan({ modules: [transitive] }), transitive).refusals,
    ).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'rust-reference-shared-array-borrow-conflict' })]),
    );
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

  it('elects a shared RefCell class carrier and a mutable class call parameter', () => {
    const module = lower(
      'alias-class.ts',
      `class Counter { value = 0; }
       function write(counter: Counter): void { counter.value = 2; }
       export function aliasCounter(): number {
         const values = new Counter();
         const alias = values;
         write(alias);
         return values.value;
       }`,
    );
    const plan = createCompilerRustReferenceRepresentationPlan({ modules: [module] });
    const modulePlan = getModulePlan(plan, module);

    expect(modulePlan.refusals).toEqual([]);
    expect(modulePlan.callables).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          binding: expect.objectContaining({ name: 'write' }),
          parameters: [{ position: 0, representation: 'mutable-borrowed-class' }],
        }),
      ]),
    );
    expect(
      modulePlan.sharedClassBindings.map(({ binding, representation }) => [binding.name, representation]).sort(),
    ).toEqual([
      ['alias', 'shared-ref-cell-class'],
      ['values', 'shared-ref-cell-class'],
    ]);
  });

  it('plans readonly and method-mutating exact class parameters', () => {
    const module = lower(
      'class-parameters.ts',
      `class Counter {
         value = 0;
         label = "ready";
         increment(): void { this.value += 1; }
       }
       function inspect(counter: Counter): string { return counter.label; }
       function write(counter: Counter): void { counter.increment(); }
       export function run(): number {
         const values = new Counter();
         const alias = values;
         const label = inspect(alias);
         write(alias);
         return values.value + (label === "ready" ? 1 : 0);
       }`,
    );
    const modulePlan = getModulePlan(createCompilerRustReferenceRepresentationPlan({ modules: [module] }), module);

    expect(modulePlan.refusals).toEqual([]);
    expect(modulePlan.callables).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          binding: expect.objectContaining({ name: 'inspect' }),
          parameters: [{ position: 0, representation: 'borrowed-class' }],
        }),
        expect.objectContaining({
          binding: expect.objectContaining({ name: 'write' }),
          parameters: [{ position: 0, representation: 'mutable-borrowed-class' }],
        }),
      ]),
    );
    expect(modulePlan.sharedClassBindings.map(({ binding }) => binding.name).sort()).toEqual(['alias', 'values']);
  });

  it('plans exact local and imported shared class returns', () => {
    const provider = lower(
      'return-provider.ts',
      `export class Counter { value = 0; }
       export function makeCounter(): Counter { const value = new Counter(); const alias = value; alias.value = 1; return value; }`,
    );
    const consumer = lower(
      'return-consumer.ts',
      `import { Counter, makeCounter } from './return-provider.js';
       export function run(): number { const value: Counter = makeCounter(); const alias: Counter = value; alias.value = 2; return value.value; }`,
    );
    const plan = createCompilerRustReferenceRepresentationPlan({
      moduleResolution: resolve('./return-provider.js', provider, consumer),
      modules: [provider, consumer],
    });
    const providerPlan = getModulePlan(plan, provider);
    const consumerPlan = getModulePlan(plan, consumer);

    expect(providerPlan.refusals).toEqual([]);
    expect(consumerPlan.refusals).toEqual([]);
    expect(providerPlan.callables).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          binding: expect.objectContaining({ name: 'makeCounter' }),
          parameters: [],
          returns: 'shared-ref-cell-class',
        }),
      ]),
    );
    expect(consumerPlan.callables).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          binding: expect.objectContaining({ name: 'makeCounter' }),
          parameters: [],
          returns: 'shared-ref-cell-class',
        }),
      ]),
    );
    expect(providerPlan.sharedClassBindings.map(({ binding }) => binding.name).sort()).toEqual(['alias', 'value']);
    expect(consumerPlan.sharedClassBindings.map(({ binding }) => binding.name).sort()).toEqual(['alias', 'value']);
  });

  it('plans exact shared class returns used by direct readonly and mutating method calls', () => {
    const module = lower(
      'direct-return-methods.ts',
      `class Counter {
         value = 0;
         current(): number { return this.value; }
         increment(): number { this.value += 1; return this.value; }
       }
       function makeCounter(): Counter { return new Counter(); }
       export function read(): number { return makeCounter().current(); }
       export function mutate(): number { return makeCounter().increment(); }`,
    );
    const modulePlan = getModulePlan(createCompilerRustReferenceRepresentationPlan({ modules: [module] }), module);

    expect(modulePlan.refusals).toEqual([]);
    expect(modulePlan.callables).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          binding: expect.objectContaining({ name: 'makeCounter' }),
          parameters: [],
          returns: 'shared-ref-cell-class',
        }),
      ]),
    );
  });

  it('plans exact shared class identity comparisons', () => {
    const module = lower(
      'class-identity.ts',
      `class Counter { value = 0; }
       export function compare(): boolean {
         const first = new Counter();
         const alias = first;
         const second = new Counter();
         return first === alias && first !== second && first == alias && first != second;
       }`,
    );
    const modulePlan = getModulePlan(createCompilerRustReferenceRepresentationPlan({ modules: [module] }), module);

    expect(modulePlan.refusals).toEqual([]);
    expect(modulePlan.sharedClassBindings.map(({ binding }) => binding.name).sort()).toEqual([
      'alias',
      'first',
      'second',
    ]);
  });

  it('plans required, undefined, and null shared-class aliases with strict identity semantics', () => {
    const module = lower(
      'optional-class-local.ts',
      `class Counter { value = 0; }
       export function compare(): boolean {
         const required: Counter = new Counter();
         const requiredAlias = required;
         const maybeUndefined: Counter | undefined = requiredAlias;
         const undefinedAlias: Counter | undefined = maybeUndefined;
         const maybeNull: Counter | null = requiredAlias;
         const nullAlias: Counter | null = maybeNull;
         requiredAlias.value = 1;
         return maybeUndefined === undefinedAlias &&
           maybeNull === nullAlias &&
           maybeUndefined !== undefined &&
           maybeNull !== null &&
           maybeUndefined !== maybeNull &&
           maybeUndefined === requiredAlias;
       }`,
    );
    const input = { modules: [module] } as const;
    const snapshot = structuredClone(input);
    const first = createCompilerRustReferenceRepresentationPlan(input);
    const second = createCompilerRustReferenceRepresentationPlan({ modules: [module] });
    const modulePlan = getModulePlan(first, module);

    expect(first).toEqual(second);
    expect(input).toEqual(snapshot);
    expect(isDeeplyFrozen(first, new WeakSet())).toBe(true);
    expect(modulePlan.refusals).toEqual([]);
    expect(
      modulePlan.sharedClassBindings
        .map(({ binding, representation }) => [binding.name, representation])
        .sort(([left], [right]) => compareTextCodeUnits(String(left), String(right))),
    ).toEqual([
      ['maybeNull', 'optional-null-shared-ref-cell-class'],
      ['maybeUndefined', 'optional-undefined-shared-ref-cell-class'],
      ['nullAlias', 'optional-null-shared-ref-cell-class'],
      ['required', 'shared-ref-cell-class'],
      ['requiredAlias', 'shared-ref-cell-class'],
      ['undefinedAlias', 'optional-undefined-shared-ref-cell-class'],
    ]);
  });

  it('plans optional class parameters and returns across a module boundary', () => {
    const provider = lower(
      'optional-class-provider.ts',
      `export class Counter {
         value = 0;
         increment(): void { this.value += 1; }
       }
       export function increment(value: Counter | undefined): void {
         if (value !== undefined) value.increment();
       }
       export function echoUndefined(value: Counter | undefined): Counter | undefined { return value; }
       export function echoNull(value: Counter | null): Counter | null { return value; }
       export function make(): Counter { return new Counter(); }
       export function compare(left: Counter | undefined, right: Counter | null): boolean {
         return left === right;
       }`,
    );
    const consumer = lower(
      'optional-class-consumer.ts',
      `import { Counter, compare, echoNull, echoUndefined, increment, make } from './optional-class-provider.js';
       export function run(flag: boolean): boolean {
         const required: Counter = new Counter();
         const maybeUndefined: Counter | undefined = flag ? required : undefined;
         const maybeNull: Counter | null = flag ? required : null;
         increment(maybeUndefined);
         const returnedUndefined: Counter | undefined = echoUndefined(maybeUndefined);
         const returnedNull: Counter | null = echoNull(maybeNull);
         const lifted: Counter | undefined = make();
         return compare(returnedUndefined, returnedNull) &&
           returnedUndefined === maybeUndefined &&
           returnedNull === maybeNull &&
           lifted === maybeUndefined &&
           returnedUndefined !== returnedNull;
       }`,
    );
    const moduleResolution = resolve('./optional-class-provider.js', provider, consumer);
    const first = createCompilerRustReferenceRepresentationPlan({
      moduleResolution,
      modules: [provider, consumer],
    });
    const second = createCompilerRustReferenceRepresentationPlan({
      moduleResolution,
      modules: [consumer, provider],
    });
    const providerPlan = getModulePlan(first, provider);
    const consumerPlan = getModulePlan(first, consumer);

    expect(second).toEqual(first);
    expect(isDeeplyFrozen(first, new WeakSet())).toBe(true);
    expect(providerPlan.refusals).toEqual([]);
    expect(consumerPlan.refusals).toEqual([]);
    expect(providerPlan.callables).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          binding: expect.objectContaining({ name: 'increment' }),
          parameters: [{ position: 0, representation: 'optional-undefined-shared-ref-cell-class' }],
        }),
        expect.objectContaining({
          binding: expect.objectContaining({ name: 'echoUndefined' }),
          parameters: [{ position: 0, representation: 'optional-undefined-shared-ref-cell-class' }],
          returns: 'optional-undefined-shared-ref-cell-class',
        }),
        expect.objectContaining({
          binding: expect.objectContaining({ name: 'echoNull' }),
          parameters: [{ position: 0, representation: 'optional-null-shared-ref-cell-class' }],
          returns: 'optional-null-shared-ref-cell-class',
        }),
        expect.objectContaining({
          binding: expect.objectContaining({ name: 'compare' }),
          parameters: [
            { position: 0, representation: 'optional-undefined-shared-ref-cell-class' },
            { position: 1, representation: 'optional-null-shared-ref-cell-class' },
          ],
        }),
      ]),
    );
    expect(consumerPlan.callables).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          binding: expect.objectContaining({ name: 'increment' }),
          parameters: [{ position: 0, representation: 'optional-undefined-shared-ref-cell-class' }],
        }),
        expect.objectContaining({
          binding: expect.objectContaining({ name: 'echoUndefined' }),
          parameters: [{ position: 0, representation: 'optional-undefined-shared-ref-cell-class' }],
          returns: 'optional-undefined-shared-ref-cell-class',
        }),
        expect.objectContaining({
          binding: expect.objectContaining({ name: 'echoNull' }),
          parameters: [{ position: 0, representation: 'optional-null-shared-ref-cell-class' }],
          returns: 'optional-null-shared-ref-cell-class',
        }),
      ]),
    );
    expect(
      consumerPlan.sharedClassBindings.map(({ binding, representation }) => [binding.name, representation]),
    ).toEqual(
      expect.arrayContaining([
        ['required', 'shared-ref-cell-class'],
        ['maybeUndefined', 'optional-undefined-shared-ref-cell-class'],
        ['maybeNull', 'optional-null-shared-ref-cell-class'],
        ['returnedUndefined', 'optional-undefined-shared-ref-cell-class'],
        ['returnedNull', 'optional-null-shared-ref-cell-class'],
        ['lifted', 'optional-undefined-shared-ref-cell-class'],
      ]),
    );
  });

  it('composes fixed class ABI positions with trailing primitive parameter adjuncts', () => {
    const provider = lower(
      'mixed-class-provider.ts',
      `export class Counter { value = 1; }
       export function update(value: Counter, amount = 1, label?: string): void {
         value.value += amount + (label === undefined ? 0 : 2);
       }
       export function echo(value: Counter | null, keep = true): Counter | null {
         return keep ? value : null;
       }`,
    );
    const consumer = lower(
      'mixed-class-consumer.ts',
      `import { Counter, echo, update } from './mixed-class-provider.js';
       export function run(): boolean {
         const value: Counter = new Counter();
         update(value);
         update(value, 2, "ok");
         const present: Counter | null = echo(value);
         const absent: Counter | null = echo(value, false);
         return present === value && absent === null;
       }`,
    );
    const moduleResolution = resolve('./mixed-class-provider.js', provider, consumer);
    const plan = createCompilerRustReferenceRepresentationPlan({
      moduleResolution,
      modules: [provider, consumer],
    });
    const providerPlan = getModulePlan(plan, provider);
    const consumerPlan = getModulePlan(plan, consumer);

    expect(providerPlan.refusals).toEqual([]);
    expect(consumerPlan.refusals).toEqual([]);
    for (const modulePlan of [providerPlan, consumerPlan]) {
      expect(modulePlan.callables).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            binding: expect.objectContaining({ name: 'update' }),
            parameters: [{ position: 0, representation: 'mutable-borrowed-class' }],
          }),
          expect.objectContaining({
            binding: expect.objectContaining({ name: 'echo' }),
            parameters: [{ position: 0, representation: 'optional-null-shared-ref-cell-class' }],
            returns: 'optional-null-shared-ref-cell-class',
          }),
        ]),
      );
    }
  });

  it('plans synthesized optional class parameters with omission, forwarding, and primitive adjuncts', () => {
    const module = lower(
      'syntactic-optional-class.ts',
      `class Counter { value = 2; }
       function inspect(value?: Counter, scale = 1, label?: string): number {
         return value === undefined ? 0 : value.value * scale + (label === undefined ? 0 : 1);
       }
       function forward(value?: Counter): number { return inspect(value); }
       export function run(): number {
         const value = new Counter();
         return inspect() + inspect(undefined) + inspect(value, 2, "ok") + forward() + forward(value);
       }`,
    );
    const input = { modules: [module] } as const;
    const snapshot = structuredClone(input);
    const plan = createCompilerRustReferenceRepresentationPlan(input);
    const modulePlan = getModulePlan(plan, module);

    expect(input).toEqual(snapshot);
    expect(modulePlan.refusals).toEqual([]);
    expect(modulePlan.callables).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          binding: expect.objectContaining({ name: 'inspect' }),
          parameters: [{ position: 0, representation: 'optional-undefined-shared-ref-cell-class' }],
        }),
        expect.objectContaining({
          binding: expect.objectContaining({ name: 'forward' }),
          parameters: [{ position: 0, representation: 'optional-undefined-shared-ref-cell-class' }],
        }),
      ]),
    );
    expect(modulePlan.sharedClassBindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          binding: expect.objectContaining({ name: 'value' }),
          representation: 'shared-ref-cell-class',
        }),
      ]),
    );
  });

  it('keeps flexible and nontrailing class-call shapes inside the stable refusal boundary', () => {
    const cases = [
      `class Counter { value = 1; }
       function inspect(value: Counter, ...extras: number[]): number { return value.value + extras.length; }
       export function run(): number { return inspect(new Counter()); }`,
      `class Counter { value = 1; }
       function inspect(value: Counter, extra?: number): number { return value.value; }
       export function run(): number {
         const values: [Counter, number] = [new Counter(), 1];
         return inspect(...values);
       }`,
      `class Counter { value = 1; }
       function inspect<Value>(value: Counter, extra?: Value): number { return value.value; }
       export function run(): number { return inspect(new Counter()); }`,
      `class Counter { value = 1; }
       function inspect(value: Counter): number;
       function inspect(value: Counter, extra?: number): number;
       function inspect(value: Counter, extra?: number): number { return value.value; }
       export function run(): number { return inspect(new Counter()); }`,
      `class Counter { value = 1; }
       async function inspect(value: Counter, extra?: number): Promise<number> { return value.value; }
       export function run(): number { inspect(new Counter()); return 0; }`,
      `class Counter { value = 1; }
       function inspect(extra: number = 1, value: Counter): number { return value.value + extra; }
       export function run(): number { return inspect(undefined, new Counter()); }`,
      `class Counter { value = 1; }
       function inspect(value: Counter, extra: number = value.value): number { return extra; }
       export function run(): number { return inspect(new Counter()); }`,
    ];

    for (const [index, source] of cases.entries()) {
      const module = lower(`mixed-class-refusal-${String(index)}.ts`, source);
      expect(
        getModulePlan(createCompilerRustReferenceRepresentationPlan({ modules: [module] }), module).refusals,
      ).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: 'rust-reference-shared-class-call-unrepresented' })]),
      );
    }
  });

  it('keeps broader optional and default class parameter forms inside the stable refusal boundary', () => {
    const module = lower(
      'mixed-class-flexible-parameter-refusals.ts',
      `class Counter { value = 1; }
       function redundant(value?: Counter | undefined): void {}
       function nullable(value?: Counter | null): void {}
       function nontrailing(flag?: boolean, value?: Counter): void {}
       function defaulted(value: Counter = new Counter()): void {}
       export function run(): void {
         redundant(new Counter());
         nullable(new Counter());
         nontrailing(undefined, new Counter());
         defaulted();
       }`,
    );
    const refusals = getModulePlan(
      createCompilerRustReferenceRepresentationPlan({ modules: [module] }),
      module,
    ).refusals.filter(({ code }) => code === 'rust-reference-shared-class-call-unrepresented');

    expect(refusals).toHaveLength(4);
    expect(refusals.map(({ message }) => message)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('redundant'),
        expect.stringContaining('nullable'),
        expect.stringContaining('nontrailing'),
        expect.stringContaining('defaulted'),
      ]),
    );
  });

  it('refuses synthesized optional class calls without exact invocation evidence', () => {
    const module = lower(
      'syntactic-optional-class-evidence.ts',
      `class Counter { value = 1; }
       function inspect(value?: Counter): void {}
       export function run(value: Counter): void { inspect(value); }`,
    );
    const run = module.declarations.find(
      (declaration) => declaration.kind === 'function' && declaration.binding.name === 'run',
    );
    const call = run?.kind === 'function' && run.body[0]?.kind === 'expression' ? run.body[0].expression : undefined;
    if (call?.kind !== 'call') throw new Error('Expected optional class call');
    delete (call.semantics as { optionalParameters?: unknown }).optionalParameters;

    expect(
      getModulePlan(createCompilerRustReferenceRepresentationPlan({ modules: [module] }), module).refusals,
    ).toEqual([
      expect.objectContaining({
        code: 'rust-reference-shared-class-call-unrepresented',
        message: expect.stringContaining('lacks exact optional-parameter invocation evidence'),
      }),
    ]);
  });

  it('keeps local and imported optional interfaces outside shared-class planning', () => {
    const provider = lower(
      'optional-interface-provider.ts',
      `export interface Box { value: number; }
       export function read(value: Box | undefined): number {
         return value === undefined ? 0 : value.value;
       }`,
    );
    const consumer = lower(
      'optional-interface-consumer.ts',
      `import { Box, read } from './optional-interface-provider.js';
       export function inspect(value: Box | undefined): number { return read(value); }`,
    );
    const plan = createCompilerRustReferenceRepresentationPlan({
      moduleResolution: resolve('./optional-interface-provider.js', provider, consumer),
      modules: [provider, consumer],
    });

    for (const module of [provider, consumer]) {
      const modulePlan = getModulePlan(plan, module);
      expect(modulePlan.callables).toEqual([]);
      expect(modulePlan.refusals).toEqual([]);
      expect(modulePlan.sharedClassBindings).toEqual([]);
    }
  });

  it('refuses unsupported class identity comparisons', () => {
    const cases = [
      lower(
        'identity-cross-owner.ts',
        `class Counter { value = 0; } class Other { value = 0; }
         export function compare(): boolean { const left = new Counter(); const right = new Other(); return left === right; }`,
      ),
      lower(
        'identity-inheritance.ts',
        `class Base { value = 0; } class Counter extends Base {}
         export function compare(): boolean { const left = new Counter(); const right = new Counter(); return left === right; }`,
      ),
      lower(
        'identity-accessor.ts',
        `class Counter { stored = 0; get value(): number { return this.stored; } }
         export function compare(): boolean { const left = new Counter(); const right = new Counter(); return left === right; }`,
      ),
      lower(
        'identity-field.ts',
        `class Child { value = 0; } class Counter { child = new Child(); }
         export function compare(): boolean { const left = new Counter(); const right = new Counter(); return left === right; }`,
      ),
      lower(
        'identity-dynamic.ts',
        `class Counter { value = 0; }
         export function compare(left: Counter, right: any): boolean { return left === right; }`,
      ),
      lower(
        'identity-union.ts',
        `class Counter { value = 0; } class Other { value = 0; }
         export function compare(left: Counter | Other, right: Counter): boolean { return left === right; }`,
      ),
      lower(
        'identity-optional.ts',
        `class Counter { value = 0; }
         export function compare(left: Counter | undefined, right: Counter): boolean { return left === right; }`,
      ),
      lower(
        'identity-nullish.ts',
        `class Counter { value = 0; }
         export function compare(left: Counter): boolean { return left === null; }`,
      ),
      lower(
        'identity-object.ts',
        `class Counter { value = 0; }
         export function compare(left: Counter, right: object): boolean { return left === right; }`,
      ),
      lower(
        'identity-ordering.ts',
        `class Counter { value = 0; }
         export function compare(): boolean { const left = new Counter(); const right = new Counter(); return left < right; }`,
      ),
      lower(
        'identity-borrowed.ts',
        `class Counter { value = 0; }
         export function compare(left: Counter, right: Counter): boolean { return left === right; }`,
      ),
    ];

    for (const module of cases) {
      expect(
        getModulePlan(createCompilerRustReferenceRepresentationPlan({ modules: [module] }), module).refusals,
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: 'rust-reference-shared-class-identity-unrepresented' }),
        ]),
      );
    }
  });

  it('refuses coercive or unsupported loose class equality comparisons', () => {
    const cases = [
      lower(
        'loose-identity-cross-owner.ts',
        `class Counter { value = 0; } class Other { value = 0; }
         export function compare(): boolean { const left = new Counter(); const right = new Other(); return left == right; }`,
      ),
      lower(
        'loose-identity-inheritance.ts',
        `class Base { value = 0; } class Counter extends Base {}
         export function compare(): boolean { const left = new Counter(); const right = new Counter(); return left != right; }`,
      ),
      lower(
        'loose-identity-accessor.ts',
        `class Counter { stored = 0; get value(): number { return this.stored; } }
         export function compare(): boolean { const left = new Counter(); const right = new Counter(); return left == right; }`,
      ),
      lower(
        'loose-identity-field.ts',
        `class Child { value = 0; } class Counter { child = new Child(); }
         export function compare(): boolean { const left = new Counter(); const right = new Counter(); return left != right; }`,
      ),
      lower(
        'loose-identity-dynamic.ts',
        `class Counter { value = 0; }
         export function compare(left: Counter, right: any): boolean { return left == right; }`,
      ),
      lower(
        'loose-identity-union.ts',
        `class Counter { value = 0; } class Other { value = 0; }
         export function compare(left: Counter | Other, right: Counter): boolean { return left != right; }`,
      ),
      lower(
        'loose-identity-optional.ts',
        `class Counter { value = 0; }
         export function compare(left: Counter | undefined, right: Counter): boolean { return left == right; }`,
      ),
      lower(
        'loose-identity-nullish.ts',
        `class Counter { value = 0; }
         export function compare(left: Counter): boolean { return left == null; }`,
      ),
      lower(
        'loose-identity-object.ts',
        `class Counter { value = 0; }
         export function compare(left: Counter, right: object): boolean { return left != right; }`,
      ),
      lower(
        'loose-identity-primitive.ts',
        `class Counter { value = 0; }
         export function compare(): boolean { const left = new Counter(); return left == 0; }`,
      ),
      lower(
        'loose-identity-borrowed.ts',
        `class Counter { value = 0; }
         export function compare(left: Counter, right: Counter): boolean { return left == right; }`,
      ),
    ];

    for (const module of cases) {
      expect(
        getModulePlan(createCompilerRustReferenceRepresentationPlan({ modules: [module] }), module).refusals,
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: 'rust-reference-shared-class-identity-unrepresented' }),
        ]),
      );
    }
  });

  it('refuses unsupported class return boundaries', () => {
    const cases = [
      lower(
        'return-dynamic.ts',
        `class Counter { value = 0; }
         export function make(): any { return new Counter(); }`,
      ),
      lower(
        'return-union.ts',
        `class Counter { value = 0; }
         class Other { value = 1; }
         export function make(flag: boolean): Counter | Other { return flag ? new Counter() : new Other(); }`,
      ),
      lower(
        'return-generic.ts',
        `class Counter { value = 0; }
         export function make<T>(): Counter { return new Counter(); }`,
      ),
      lower(
        'return-async.ts',
        `class Counter { value = 0; }
         export async function make(): Promise<Counter> { return new Counter(); }`,
      ),
      lower(
        'return-owner.ts',
        `class Counter { value = 0; }
         class Other { value = 1; }
         export function make(): Counter { return new Other(); }`,
      ),
      lower(
        'return-inheritance.ts',
        `class Base { value = 0; }
         class Counter extends Base {}
         export function make(): Counter { return new Counter(); }`,
      ),
      lower(
        'return-accessor.ts',
        `class Counter { stored = 0; get value(): number { return this.stored; } }
         export function make(): Counter { return new Counter(); }`,
      ),
      lower(
        'return-identity-field.ts',
        `class Child { value = 0; }
         class Counter { child = new Child(); }
         export function make(): Counter { return new Counter(); }`,
      ),
      lower(
        'return-borrowed.ts',
        `class Counter { value = 0; }
         export function identity(counter: Counter): Counter { return counter; }`,
      ),
      lower(
        'return-control-flow.ts',
        `class Counter { value = 0; }
         export function make(flag: boolean): Counter { if (flag) return new Counter(); return new Counter(); }`,
      ),
    ];

    for (const module of cases) {
      expect(
        getModulePlan(createCompilerRustReferenceRepresentationPlan({ modules: [module] }), module).refusals,
      ).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: 'rust-reference-shared-class-return-unrepresented' })]),
      );
    }
  });

  it('keeps optional shared-class carriers inside the stable refusal boundary', () => {
    const cases: readonly [Readonly<IrModule>, string][] = [
      [
        lower(
          'optional-class-dual-sentinel.ts',
          `class Counter { value = 0; }
           export function inspect(value: Counter | null | undefined): boolean { return value === null; }`,
        ),
        'rust-reference-shared-class-type-unrepresented',
      ],
      [
        lower(
          'optional-class-multiple-classes.ts',
          `class Counter { value = 0; } class Other { value = 1; }
           export function inspect(value: Counter | Other | undefined): boolean { return value === undefined; }`,
        ),
        'rust-reference-shared-class-type-unrepresented',
      ],
      [
        lower(
          'optional-class-nested.ts',
          `class Counter { value = 0; }
           export function inspect(values: Array<Counter | undefined>): number { return values.length; }`,
        ),
        'rust-reference-shared-class-type-unrepresented',
      ],
      [
        lower(
          'optional-class-ambiguous.ts',
          `class Counter { value = 0; }
           export function inspect(flag: boolean): boolean {
             const left: Counter | undefined = new Counter();
             const right: Counter | undefined = new Counter();
             const value: Counter | undefined = flag ? left : right;
             return value === left;
           }`,
        ),
        'rust-reference-shared-class-alias-ambiguous',
      ],
      [
        lower(
          'optional-class-borrow-conflict.ts',
          `class Counter { value = 0; }
           export function update(): number {
             const value: Counter | undefined = new Counter();
             const alias: Counter | undefined = value;
             if (alias !== undefined && value !== undefined) alias.value = value.value;
             return alias === undefined ? 0 : alias.value;
           }`,
        ),
        'rust-reference-shared-class-borrow-conflict',
      ],
      [
        lower(
          'optional-class-escape.ts',
          `class Counter { value = 0; }
           export function create(): () => number {
             const value: Counter | null = new Counter();
             return (): number => value === null ? 0 : value.value;
           }`,
        ),
        'rust-reference-shared-class-closure-escape-unrepresented',
      ],
      [
        lower(
          'optional-class-suspension.ts',
          `class Counter { value = 0; }
           export async function inspect(): Promise<number> {
             const value: Counter | undefined = new Counter();
             await Promise.resolve();
             return value === undefined ? 0 : value.value;
           }`,
        ),
        'rust-reference-shared-class-suspension-unrepresented',
      ],
      [
        lower(
          'optional-class-call-sentinel.ts',
          `class Counter { value = 0; }
           function inspect(value: Counter | undefined): boolean { return value === undefined; }
           export function run(): boolean { const value: Counter | null = null; return inspect(value as never); }`,
        ),
        'rust-reference-shared-class-call-unrepresented',
      ],
      [
        lower(
          'optional-class-return-sentinel.ts',
          `class Counter { value = 0; }
           export function wrong(): Counter | undefined { const value: Counter | null = null; return value; }`,
        ),
        'rust-reference-shared-class-return-unrepresented',
      ],
    ];

    for (const [module, code] of cases) {
      expect(
        getModulePlan(createCompilerRustReferenceRepresentationPlan({ modules: [module] }), module).refusals,
      ).toEqual(expect.arrayContaining([expect.objectContaining({ code })]));
    }
  });

  it('refuses unsafe class-parameter boundaries and overlapping or wrong-owner borrows', () => {
    const cases: readonly [Readonly<IrModule>, string][] = [
      [
        lower(
          'class-parameter-return.ts',
          `class Counter { value = 0; }
           function escape(counter: Counter): Counter { return counter; }
           export function run(): number { const value = new Counter(); const alias = value; escape(alias); return value.value; }`,
        ),
        'rust-reference-shared-class-call-unrepresented',
      ],
      [
        lower(
          'class-parameter-storage.ts',
          `class Counter { value = 0; }
           function store(counter: Counter): { counter: Counter } { return { counter }; }
           export function run(): number { const value = new Counter(); const alias = value; store(alias); return value.value; }`,
        ),
        'rust-reference-shared-class-call-unrepresented',
      ],
      [
        lower(
          'class-parameter-dynamic.ts',
          `class Counter { value = 0; }
           class Other { value = 1; }
           function inspect(counter: Counter | Other): number { return counter.value; }
           export function run(): number { const value = new Counter(); const alias = value; return inspect(alias); }`,
        ),
        'rust-reference-shared-class-call-unrepresented',
      ],
      [
        lower(
          'class-parameter-default.ts',
          `class Counter { value = 0; }
           function inspect(counter: Counter = new Counter()): number { return counter.value; }
           export function run(): number { const value = new Counter(); const alias = value; return inspect(alias); }`,
        ),
        'rust-reference-shared-class-call-unrepresented',
      ],
      [
        lower(
          'class-parameter-generic-rest.ts',
          `class Counter { value = 0; }
           function inspect<T>(counter: Counter, ...extra: T[]): number { return counter.value + extra.length; }
           export function run(): number { const value = new Counter(); const alias = value; return inspect(alias); }`,
        ),
        'rust-reference-shared-class-call-unrepresented',
      ],
      [
        lower(
          'class-parameter-async.ts',
          `class Counter { value = 0; }
           async function inspect(counter: Counter): Promise<number> { return counter.value; }
           export function run(): number { const value = new Counter(); const alias = value; inspect(alias); return value.value; }`,
        ),
        'rust-reference-shared-class-call-unrepresented',
      ],
      [
        lower(
          'class-parameter-owner.ts',
          `class Counter { value = 0; }
           class Other { value = 1; }
           function inspect(counter: Counter): number { return counter.value; }
           export function run(): number { const value = new Other(); const alias = value; return inspect(alias); }`,
        ),
        'rust-reference-shared-class-call-unrepresented',
      ],
      [
        lower(
          'class-parameter-overlap.ts',
          `class Counter { value = 0; }
           function copy(left: Counter, right: Counter): void { left.value = right.value; }
           export function run(): number { const value = new Counter(); const alias = value; copy(alias, value); return value.value; }`,
        ),
        'rust-reference-shared-class-borrow-conflict',
      ],
      [
        lower(
          'class-parameter-inheritance.ts',
          `class Base { value = 0; }
           class Counter extends Base {}
           function inspect(counter: Counter): number { return counter.value; }
           export function run(): number { const value = new Counter(); const alias = value; return inspect(alias); }`,
        ),
        'rust-reference-shared-class-type-unrepresented',
      ],
      [
        lower(
          'class-parameter-accessor.ts',
          `class Counter { stored = 0; get value(): number { return this.stored; } }
           function inspect(counter: Counter): number { return counter.value; }
           export function run(): number { const value = new Counter(); const alias = value; return inspect(alias); }`,
        ),
        'rust-reference-shared-class-member-unrepresented',
      ],
      [
        lower(
          'class-parameter-identity-field.ts',
          `class Child { value = 0; }
           class Counter { child = new Child(); }
           function inspect(counter: Counter): number { return counter.child.value; }
           export function run(): number { const value = new Counter(); const alias = value; return inspect(alias); }`,
        ),
        'rust-reference-shared-class-field-unrepresented',
      ],
    ];

    for (const [module, code] of cases) {
      expect(
        getModulePlan(createCompilerRustReferenceRepresentationPlan({ modules: [module] }), module).refusals,
      ).toEqual(expect.arrayContaining([expect.objectContaining({ code })]));
    }
  });

  it('elects the class carrier for exact primitive constructor arguments', () => {
    const module = lower(
      'alias-class-constructor.ts',
      `class Pair {
         first: number;
         label: string;
         constructor(first: number, label: string) { this.first = first; this.label = label; }
       }
       export function aliasPair(): number {
         const values = new Pair(1, "second");
         const alias = values;
         alias.first = 3;
         return values.first;
       }`,
    );
    const modulePlan = getModulePlan(createCompilerRustReferenceRepresentationPlan({ modules: [module] }), module);

    expect(modulePlan.refusals).toEqual([]);
    expect(modulePlan.sharedClassBindings.map(({ binding }) => binding.name).sort()).toEqual(['alias', 'values']);
  });

  it('plans exact readonly class constructor projections locally and across modules', () => {
    const local = lower(
      'class-constructor-owner.ts',
      `class Owner { value: number; label: string; constructor(value: number, label: string) { this.value = value; this.label = label; } }
       class Snapshot {
         value: number; label: string; order: number;
         constructor(order: number, owner: Owner) { this.order = order; this.value = owner.value; this.label = owner.label; }
       }
       export function run(): number {
         const owner = new Owner(1, "ready"); const ownerAlias = owner;
         const value = new Snapshot(2, ownerAlias); const alias = value;
         alias.value = 3; return owner.value + value.value;
       }`,
    );
    const provider = lower(
      'constructor-owner-provider.ts',
      `export class Owner { value: number; label: string; constructor(value: number, label: string) { this.value = value; this.label = label; } }
       export class Snapshot {
         value: number; label: string;
         constructor(owner: Owner) { this.value = owner.value; this.label = owner.label; }
       }`,
    );
    const consumer = lower(
      'constructor-owner-consumer.ts',
      `import { Owner, Snapshot } from './constructor-owner-provider.js';
       export function run(): number {
         const owner: Owner = new Owner(1, "ready"); const ownerAlias: Owner = owner;
         const value: Snapshot = new Snapshot(ownerAlias); const alias: Snapshot = value;
         alias.value = 3; return owner.value + value.value;
       }`,
    );
    const localPlan = getModulePlan(createCompilerRustReferenceRepresentationPlan({ modules: [local] }), local);
    const crossModulePlan = createCompilerRustReferenceRepresentationPlan({
      moduleResolution: resolve('./constructor-owner-provider.js', provider, consumer),
      modules: [provider, consumer],
    });

    expect(localPlan.refusals).toEqual([]);
    expect(getModulePlan(crossModulePlan, provider).refusals).toEqual([]);
    expect(getModulePlan(crossModulePlan, consumer).refusals).toEqual([]);
  });

  it('plans one trailing synthesized optional constructor owner with exact invocation evidence', () => {
    const module = lower(
      'optional-class-constructor-owner.ts',
      `class Owner { value: number; constructor(value: number) { this.value = value; } }
       class Snapshot {
         order: number; value: number;
         constructor(order: number, owner?: Owner) {
           this.order = order;
           this.value = owner === undefined ? 0 : owner.value;
         }
       }
       export function run(): number {
         const owner = new Owner(4); const ownerAlias = owner;
         const missing = new Snapshot(1); const missingAlias = missing;
         const explicit = new Snapshot(2, undefined);
         const present = new Snapshot(3, ownerAlias);
         return missingAlias.value + explicit.value + present.value;
       }`,
    );

    expect(
      getModulePlan(createCompilerRustReferenceRepresentationPlan({ modules: [module] }), module).refusals,
    ).toEqual([]);
  });

  it('refuses an optional constructor owner call without exact invocation evidence', () => {
    const module = lower(
      'optional-class-constructor-evidence.ts',
      `class Owner { value = 1; }
       class Snapshot {
         value: number;
         constructor(owner?: Owner) { this.value = owner === undefined ? 0 : owner.value; }
       }
       export function run(): number {
         const value = new Snapshot(); const alias = value; alias.value = 2; return value.value;
       }`,
    );
    const run = module.declarations.find(
      (declaration) => declaration.kind === 'function' && declaration.binding.name === 'run',
    );
    const statement = run?.kind === 'function' ? run.body[0] : undefined;
    const construction = statement?.kind === 'variable' ? statement.declarations[0]?.initializer : undefined;
    if (construction?.kind !== 'new') throw new Error('Expected optional constructor call');
    delete (construction.semantics as { optionalParameters?: unknown }).optionalParameters;

    expect(
      getModulePlan(createCompilerRustReferenceRepresentationPlan({ modules: [module] }), module).refusals,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'rust-reference-shared-class-construction-unrepresented' }),
      ]),
    );
  });

  it('refuses class constructor owners outside readonly nonescaping primitive projection', () => {
    const cases = [
      `class Owner { value = 1; } class Snapshot { owner: Owner; constructor(owner: Owner) { this.owner = owner; } }`,
      `class Owner { value = 1; } class Snapshot { value: number; constructor(owner: Owner) { owner.value = 2; this.value = owner.value; } }`,
      `class Owner { value = 1; } class Snapshot { same: boolean; constructor(owner: Owner) { this.same = owner === owner; } }`,
      `class Owner { value = 1; current(): number { return this.value; } } class Snapshot { value: number; constructor(owner: Owner) { const read = owner.current; this.value = read(); } }`,
      `class Owner { value = 1; } class Snapshot { value: number; constructor(owner: Owner) { const read = (): number => owner.value; this.value = read(); } }`,
      `class Owner { value = 1; } class Snapshot { value: number; constructor(owner?: Owner) { this.value = owner!.value; } }`,
      `class Owner { value = 1; } class Snapshot { value: number; constructor(owner: Owner = new Owner()) { this.value = owner.value; } }`,
      `class Owner { value = 1; } class Snapshot { value: number; constructor(...owners: Owner[]) { this.value = owners[0]!.value; } }`,
      `class Owner { value = 1; } class Snapshot<T> { value: number; constructor(owner: Owner) { this.value = owner.value; } }`,
      `class Owner { value = 1; } class Snapshot { value: number; constructor(owner: Owner | undefined) { this.value = owner!.value; } }`,
      `class Owner { value = 1; } class Snapshot { value: number; constructor(owner: any) { this.value = owner.value; } }`,
      `class Base { value = 1; } class Owner extends Base {} class Snapshot { value: number; constructor(owner: Owner) { this.value = owner.value; } }`,
      `class Owner { stored = 1; get value(): number { return this.stored; } } class Snapshot { value: number; constructor(owner: Owner) { this.value = owner.value; } }`,
      `class Child { value = 1; } class Owner { child = new Child(); } class Snapshot { child: Child; constructor(owner: Owner) { this.child = owner.child; } }`,
    ];

    for (const [index, declarations] of cases.entries()) {
      const module = lower(
        `class-constructor-owner-refusal-${String(index)}.ts`,
        `${declarations}
         export function run(): number {
           const owner = new Owner(); const ownerAlias = owner;
           const value = new Snapshot(ownerAlias as never); const alias = value;
           return alias === value ? 1 : 0;
         }`,
      );
      expect(
        getModulePlan(createCompilerRustReferenceRepresentationPlan({ modules: [module] }), module).refusals,
      ).not.toEqual([]);
    }
  });

  it('refuses wrong, overlapping, and suspended constructor owners', () => {
    const wrongOwner = lower(
      'class-constructor-wrong-owner.ts',
      `class Owner { value = 1; } class Other { value = 2; }
       class Snapshot { value: number; constructor(owner: Owner) { this.value = owner.value; } }
       export function run(): number { const other = new Other(); const value = new Snapshot(other as never); const alias = value; alias.value = 3; return value.value; }`,
    );
    const overlap = lower(
      'class-constructor-owner-overlap.ts',
      `class Owner { value = 1; label = "ready"; }
       class Snapshot { value: number; label: string; constructor(left: Owner, right: Owner) { this.value = left.value; this.label = right.label; } }
       export function run(): number { const owner = new Owner(); const ownerAlias = owner; const value = new Snapshot(owner, ownerAlias); return value.value; }`,
    );
    const suspension = lower(
      'class-constructor-owner-suspension.ts',
      `class Owner { value = 1; }
       class Snapshot { value: number; constructor(owner: Owner) { this.value = owner.value; } }
       async function makeOwner(): Promise<Owner> { return new Owner(); }
       export async function run(): Promise<number> { const value = new Snapshot(await makeOwner()); const alias = value; return alias.value; }`,
    );

    expect(
      getModulePlan(createCompilerRustReferenceRepresentationPlan({ modules: [wrongOwner] }), wrongOwner).refusals,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'rust-reference-shared-class-construction-unrepresented' }),
      ]),
    );
    expect(
      getModulePlan(createCompilerRustReferenceRepresentationPlan({ modules: [overlap] }), overlap).refusals,
    ).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'rust-reference-shared-class-borrow-conflict' })]),
    );
    expect(
      getModulePlan(createCompilerRustReferenceRepresentationPlan({ modules: [suspension] }), suspension).refusals,
    ).not.toEqual([]);
  });

  it('plans one readonly trailing optional class method parameter locally and across modules', () => {
    const local = lower(
      'optional-class-method.ts',
      `class Counter {
         value: number;
         constructor(value: number) { this.value = value; }
         inspect(other?: Counter): number { return other === undefined ? this.value : other.value; }
       }
       export function run(): number {
         const receiver = new Counter(1); const receiverAlias = receiver;
         const other = new Counter(4); const otherAlias = other;
         return receiverAlias.inspect() + receiver.inspect(undefined) + receiverAlias.inspect(otherAlias);
       }`,
    );
    const providerSource = ts.createSourceFile(
      '/flight/packages/math/src/optional-class-method-provider.ts',
      `export class Counter {
         value: number;
         constructor(value: number) { this.value = value; }
         inspect(other?: Counter): number { return other !== undefined ? other.value : this.value; }
         write(other?: Counter): void { if (other !== undefined) other.value += 1; }
       }`,
      ts.ScriptTarget.Latest,
      true,
    );
    const consumerSource = ts.createSourceFile(
      '/flight/packages/math/src/optional-class-method-consumer.ts',
      `import { Counter } from './optional-class-method-provider.js';
       function relay(receiver: Counter, other?: Counter): void {
         if (other === undefined) return;
         receiver.write(other);
       }
       export function run(): number {
         const receiver: Counter = new Counter(1); const receiverAlias: Counter = receiver;
         const other: Counter = new Counter(4); const otherAlias: Counter = other;
         relay(receiverAlias, otherAlias);
         return receiverAlias.inspect(otherAlias) + receiver.inspect();
       }`,
      ts.ScriptTarget.Latest,
      true,
    );
    const moduleResolution = {
      edges: [
        {
          importer: {
            name: 'Optional-class-method-consumer',
            packageName: '@flighthq/math',
            source: 'packages/math/src/optional-class-method-consumer.ts',
          },
          specifier: './optional-class-method-provider.js',
          target: {
            packageName: '@flighthq/math',
            source: 'packages/math/src/optional-class-method-provider.ts',
          },
        },
      ],
      schema: 'flight-compiler-module-resolution/1',
    } as const;
    const [providerResult, consumerResult] = lowerTypeScriptSources(
      [
        { packageName: '@flighthq/math', sourceFile: providerSource, upstreamDirectory: '/flight' },
        { packageName: '@flighthq/math', sourceFile: consumerSource, upstreamDirectory: '/flight' },
      ],
      moduleResolution,
    );
    expect(providerResult!.diagnostics).toEqual([]);
    expect(consumerResult!.diagnostics).toEqual([]);
    const provider = providerResult!.module;
    const consumer = consumerResult!.module;

    expect(getModulePlan(createCompilerRustReferenceRepresentationPlan({ modules: [local] }), local).refusals).toEqual(
      [],
    );
    const importedPlan = createCompilerRustReferenceRepresentationPlan({
      moduleResolution,
      modules: [provider, consumer],
    });
    expect(getModulePlan(importedPlan, provider).refusals).toEqual([]);
    expect(getModulePlan(importedPlan, consumer).refusals).toEqual([]);
    expect(getModulePlan(importedPlan, provider).callables).toEqual([]);
    expect(getModulePlan(importedPlan, consumer).referentMutatedBindings.map(({ name }) => name)).toEqual(
      expect.arrayContaining(['other', 'otherAlias']),
    );
  });

  it('plans required explicit single-sentinel class method parameters locally and across modules', () => {
    const local = lower(
      'explicit-sentinel-class-method.ts',
      `class Counter {
         value = 0;
         inspectNull(scale: number, other: Counter | null): number {
           return other === null ? this.value : other.value * scale;
         }
         writeUndefined(other: Counter | undefined): void {
           if (other === undefined) return;
           other.value += 1;
         }
       }
       export function run(): number {
         const receiver = new Counter(); const receiverAlias = receiver;
         const other = new Counter(); const otherAlias = other;
         receiverAlias.writeUndefined(undefined);
         receiver.writeUndefined(otherAlias);
         return receiverAlias.inspectNull(2, null) + receiver.inspectNull(3, otherAlias);
       }`,
    );
    const providerSource = ts.createSourceFile(
      '/flight/packages/math/src/explicit-sentinel-class-method-provider.ts',
      `export class Counter {
         value = 0;
         inspect(other: Counter | undefined): number {
           return other === undefined ? this.value : other.value;
         }
         write(other: Counter | null): void { if (other !== null) other.value += 1; }
       }`,
      ts.ScriptTarget.Latest,
      true,
    );
    const consumerSource = ts.createSourceFile(
      '/flight/packages/math/src/explicit-sentinel-class-method-consumer.ts',
      `import { Counter } from './explicit-sentinel-class-method-provider.js';
       function relay(receiver: Counter, other: Counter | null): void { receiver.write(other); }
       export function run(): number {
         const receiver = new Counter(); const receiverAlias = receiver;
         const other = new Counter(); const otherAlias = other;
         const nullable: Counter | null = otherAlias;
         relay(receiverAlias, nullable);
         return receiver.inspect(undefined) + receiverAlias.inspect(otherAlias);
       }`,
      ts.ScriptTarget.Latest,
      true,
    );
    const moduleResolution = {
      edges: [
        {
          importer: {
            name: 'Explicit-sentinel-class-method-consumer',
            packageName: '@flighthq/math',
            source: 'packages/math/src/explicit-sentinel-class-method-consumer.ts',
          },
          specifier: './explicit-sentinel-class-method-provider.js',
          target: {
            packageName: '@flighthq/math',
            source: 'packages/math/src/explicit-sentinel-class-method-provider.ts',
          },
        },
      ],
      schema: 'flight-compiler-module-resolution/1',
    } as const;
    const [providerResult, consumerResult] = lowerTypeScriptSources(
      [
        { packageName: '@flighthq/math', sourceFile: providerSource, upstreamDirectory: '/flight' },
        { packageName: '@flighthq/math', sourceFile: consumerSource, upstreamDirectory: '/flight' },
      ],
      moduleResolution,
    );
    expect(providerResult!.diagnostics).toEqual([]);
    expect(consumerResult!.diagnostics).toEqual([]);
    const provider = providerResult!.module;
    const consumer = consumerResult!.module;
    const localPlan = getModulePlan(createCompilerRustReferenceRepresentationPlan({ modules: [local] }), local);
    const importedPlan = createCompilerRustReferenceRepresentationPlan({
      moduleResolution,
      modules: [provider, consumer],
    });

    expect(localPlan.refusals).toEqual([]);
    expect(localPlan.callables).toEqual([]);
    expect(localPlan.referentMutatedBindings.map(({ name }) => name)).toEqual(expect.arrayContaining(['other']));
    expect(getModulePlan(importedPlan, provider).refusals).toEqual([]);
    expect(getModulePlan(importedPlan, provider).callables).toEqual([]);
    expect(getModulePlan(importedPlan, consumer).refusals).toEqual([]);
    expect(getModulePlan(importedPlan, consumer).callables).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          binding: expect.objectContaining({ name: 'relay' }),
          parameters: [
            { position: 0, representation: 'borrowed-class' },
            { position: 1, representation: 'optional-null-shared-ref-cell-class' },
          ],
        }),
      ]),
    );
    expect(getModulePlan(importedPlan, consumer).referentMutatedBindings.map(({ name }) => name)).toEqual(
      expect.arrayContaining(['other', 'nullable']),
    );
  });

  it('plans required plain class method borrows and mutation propagation locally and across modules', () => {
    const local = lower(
      'required-class-method.ts',
      `class Counter {
         value = 1;
         label = "ready";
         inspect(scale: number, other: Counter): number { return other.value * scale; }
         write(scale: number, other: Counter): void {
           other.value = this.value * scale;
           other.value += 1;
           other.label += "!";
         }
       }
       function forward(receiver: Counter, scale: number, other: Counter): void { receiver.write(scale, other); }
       function relay(receiver: Counter, scale: number, other: Counter): void { forward(receiver, scale, other); }
       export function run(): number {
         const receiver = new Counter(); const receiverAlias = receiver;
         const other = new Counter(); const otherAlias = other;
         relay(receiverAlias, 2, otherAlias);
         return receiver.inspect(3, other) + otherAlias.value;
       }`,
    );
    const providerSource = ts.createSourceFile(
      '/flight/packages/math/src/required-class-method-provider.ts',
      `export class Counter {
         value = 1;
         inspect(scale: number, other: Counter): number { return other.value * scale; }
         write(scale: number, other: Counter): void { other.value = this.value * scale; }
       }`,
      ts.ScriptTarget.Latest,
      true,
    );
    const consumerSource = ts.createSourceFile(
      '/flight/packages/math/src/required-class-method-consumer.ts',
      `import { Counter } from './required-class-method-provider.js';
       function relay(receiver: Counter, scale: number, other: Counter): void { receiver.write(scale, other); }
       export function run(): number {
         const receiver = new Counter(); const receiverAlias = receiver;
         const other = new Counter(); const otherAlias = other;
         relay(receiverAlias, 2, otherAlias);
         return receiver.inspect(3, other);
       }`,
      ts.ScriptTarget.Latest,
      true,
    );
    const moduleResolution = {
      edges: [
        {
          importer: {
            name: 'Required-class-method-consumer',
            packageName: '@flighthq/math',
            source: 'packages/math/src/required-class-method-consumer.ts',
          },
          specifier: './required-class-method-provider.js',
          target: {
            packageName: '@flighthq/math',
            source: 'packages/math/src/required-class-method-provider.ts',
          },
        },
      ],
      schema: 'flight-compiler-module-resolution/1',
    } as const;
    const [providerResult, consumerResult] = lowerTypeScriptSources(
      [
        { packageName: '@flighthq/math', sourceFile: providerSource, upstreamDirectory: '/flight' },
        { packageName: '@flighthq/math', sourceFile: consumerSource, upstreamDirectory: '/flight' },
      ],
      moduleResolution,
    );
    expect(providerResult!.diagnostics).toEqual([]);
    expect(consumerResult!.diagnostics).toEqual([]);
    const provider = providerResult!.module;
    const consumer = consumerResult!.module;
    const localPlan = getModulePlan(createCompilerRustReferenceRepresentationPlan({ modules: [local] }), local);
    const importedPlan = createCompilerRustReferenceRepresentationPlan({
      moduleResolution,
      modules: [provider, consumer],
    });

    expect(localPlan.refusals).toEqual([]);
    expect(localPlan.callables).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          binding: expect.objectContaining({ name: 'forward' }),
          parameters: [
            { position: 0, representation: 'borrowed-class' },
            { position: 2, representation: 'mutable-borrowed-class' },
          ],
        }),
        expect.objectContaining({
          binding: expect.objectContaining({ name: 'relay' }),
          parameters: [
            { position: 0, representation: 'borrowed-class' },
            { position: 2, representation: 'mutable-borrowed-class' },
          ],
        }),
      ]),
    );
    expect(localPlan.referentMutatedBindings.map(({ name }) => name)).toEqual(expect.arrayContaining(['other']));
    expect(getModulePlan(importedPlan, provider).refusals).toEqual([]);
    expect(getModulePlan(importedPlan, provider).callables).toEqual([]);
    expect(getModulePlan(importedPlan, consumer).refusals).toEqual([]);
    expect(getModulePlan(importedPlan, consumer).callables).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          binding: expect.objectContaining({ name: 'relay' }),
          parameters: [
            { position: 0, representation: 'borrowed-class' },
            { position: 2, representation: 'mutable-borrowed-class' },
          ],
        }),
      ]),
    );
  });

  it('plans exact owned class method returns and activates local and imported result aliases', () => {
    const local = lower(
      'class-method-return.ts',
      `function makeCounter(value: number, label: string): Counter { return new Counter(value, label); }
       class Counter {
         value: number;
         label: string;
         constructor(value: number, label: string) { this.value = value; this.label = label; }
         snapshot(useLocal: boolean): Counter {
           const result = new Counter(this.value, this.label);
           const alias = result;
           const finalAlias = alias;
           return useLocal ? finalAlias : makeCounter(this.value, this.label);
         }
         forwarded(): Counter { return this.snapshot(true); }
         current(): number { return this.value; }
       }
       export function run(): boolean {
         const receiver = new Counter(2, "ready"); const receiverAlias = receiver;
         const result = receiverAlias.snapshot(true); const resultAlias = result;
         resultAlias.value += 1;
         const direct = receiver.snapshot(false);
         return result === resultAlias && result !== receiver && result.current() === 3 && direct.value === 2;
       }`,
    );
    const providerSource = ts.createSourceFile(
      '/flight/packages/math/src/class-method-return-provider.ts',
      `function makeCounter(value: number): Counter { return new Counter(value); }
       export class Counter {
         value: number;
         constructor(value: number) { this.value = value; }
         snapshot(useLocal: boolean): Counter {
           const result = new Counter(this.value);
           const alias = result;
           return useLocal ? alias : makeCounter(this.value);
         }
         forwarded(): Counter { return this.snapshot(true); }
       }`,
      ts.ScriptTarget.Latest,
      true,
    );
    const consumerSource = ts.createSourceFile(
      '/flight/packages/math/src/class-method-return-consumer.ts',
      `import { Counter } from './class-method-return-provider.js';
       class Factory {
         marker = 0;
         copy(): Counter { const receiver = new Counter(2); return receiver.forwarded(); }
       }
       export function run(): number {
         const receiver = new Counter(2); const receiverAlias = receiver;
         const result = receiverAlias.snapshot(true); const resultAlias = result;
         const factory = new Factory(); const forwarded = factory.copy();
         resultAlias.value += 1;
         return result.value + forwarded.value;
       }`,
      ts.ScriptTarget.Latest,
      true,
    );
    const moduleResolution = {
      edges: [
        {
          importer: {
            name: 'Class-method-return-consumer',
            packageName: '@flighthq/math',
            source: 'packages/math/src/class-method-return-consumer.ts',
          },
          specifier: './class-method-return-provider.js',
          target: {
            packageName: '@flighthq/math',
            source: 'packages/math/src/class-method-return-provider.ts',
          },
        },
      ],
      schema: 'flight-compiler-module-resolution/1',
    } as const;
    const [providerResult, consumerResult] = lowerTypeScriptSources(
      [
        { packageName: '@flighthq/math', sourceFile: providerSource, upstreamDirectory: '/flight' },
        { packageName: '@flighthq/math', sourceFile: consumerSource, upstreamDirectory: '/flight' },
      ],
      moduleResolution,
    );
    expect(providerResult!.diagnostics).toEqual([]);
    expect(consumerResult!.diagnostics).toEqual([]);
    const provider = providerResult!.module;
    const consumer = consumerResult!.module;
    const localPlan = getModulePlan(createCompilerRustReferenceRepresentationPlan({ modules: [local] }), local);
    const importedPlan = createCompilerRustReferenceRepresentationPlan({
      moduleResolution,
      modules: [provider, consumer],
    });

    expect(localPlan.refusals).toEqual([]);
    expect(localPlan.callables).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          binding: expect.objectContaining({ name: 'makeCounter' }),
          returns: 'shared-ref-cell-class',
        }),
      ]),
    );
    expect(localPlan.sharedClassBindings.map(({ binding }) => binding.name)).toEqual(
      expect.arrayContaining(['receiver', 'receiverAlias', 'result', 'alias', 'finalAlias', 'resultAlias', 'direct']),
    );
    expect(getModulePlan(importedPlan, provider).refusals).toEqual([]);
    expect(getModulePlan(importedPlan, consumer).refusals).toEqual([]);
    expect(getModulePlan(importedPlan, consumer).sharedClassBindings.map(({ binding }) => binding.name)).toEqual(
      expect.arrayContaining(['receiver', 'receiverAlias', 'result', 'resultAlias', 'forwarded']),
    );
  });

  it('plans exact optional class method roots and same-sentinel forwarding locally and across modules', () => {
    const providerSource = ts.createSourceFile(
      '/flight/packages/math/src/optional-class-method-return-provider.ts',
      `function makeNullable(empty: boolean): Counter | null { return empty ? null : new Counter(5); }
       export class Counter {
         value: number;
         constructor(value: number) { this.value = value; }
         fresh(): Counter { return new Counter(this.value); }
         maybeNull(empty: boolean): Counter | null { return empty ? null : new Counter(this.value); }
         maybeUndefined(value?: Counter): Counter | undefined { return value; }
         aliasUndefined(value?: Counter): Counter | undefined { const alias = value; return alias; }
         absentUndefined(): Counter | undefined { return undefined; }
         aliasNull(): Counter | null {
           const result: Counter | null = new Counter(this.value); const alias = result; return alias;
         }
         liftNull(): Counter | null { return this.fresh(); }
         forwardNull(): Counter | null { return this.maybeNull(false); }
         forwardUndefined(): Counter | undefined { return this.absentUndefined(); }
         fromFunction(): Counter | null { return makeNullable(false); }
       }`,
      ts.ScriptTarget.Latest,
      true,
    );
    const consumerSource = ts.createSourceFile(
      '/flight/packages/math/src/optional-class-method-return-consumer.ts',
      `import { Counter } from './optional-class-method-return-provider.js';
       class Factory {
         marker = 0;
         copy(): Counter | null { const receiver = new Counter(7); return receiver.forwardNull(); }
       }
       export function run(): boolean {
         const receiver = new Counter(2); const other = new Counter(3);
         const nullable = receiver.liftNull(); const nullableAlias = nullable;
         const optional = receiver.forwardUndefined(); const optionalAlias = optional;
         const parameter = receiver.aliasUndefined(other);
         const aliasRoot = receiver.aliasNull();
         const factory = new Factory(); const importedForward = factory.copy();
         if (nullable !== null) nullable.value += 1;
         if (optional !== undefined) optional.value += 1;
         return nullable === nullableAlias && optional === optionalAlias && parameter === other &&
           importedForward !== null;
       }`,
      ts.ScriptTarget.Latest,
      true,
    );
    const moduleResolution = {
      edges: [
        {
          importer: {
            name: 'Optional-class-method-return-consumer',
            packageName: '@flighthq/math',
            source: 'packages/math/src/optional-class-method-return-consumer.ts',
          },
          specifier: './optional-class-method-return-provider.js',
          target: {
            packageName: '@flighthq/math',
            source: 'packages/math/src/optional-class-method-return-provider.ts',
          },
        },
      ],
      schema: 'flight-compiler-module-resolution/1',
    } as const;
    const [providerResult, consumerResult] = lowerTypeScriptSources(
      [
        { packageName: '@flighthq/math', sourceFile: providerSource, upstreamDirectory: '/flight' },
        { packageName: '@flighthq/math', sourceFile: consumerSource, upstreamDirectory: '/flight' },
      ],
      moduleResolution,
    );
    expect(providerResult!.diagnostics).toEqual([]);
    expect(consumerResult!.diagnostics).toEqual([]);
    const provider = providerResult!.module;
    const consumer = consumerResult!.module;
    const first = createCompilerRustReferenceRepresentationPlan({ moduleResolution, modules: [provider, consumer] });
    const second = createCompilerRustReferenceRepresentationPlan({ moduleResolution, modules: [consumer, provider] });

    expect(second).toEqual(first);
    expect(getModulePlan(first, provider).refusals).toEqual([]);
    expect(getModulePlan(first, consumer).refusals).toEqual([]);
    expect(
      getModulePlan(first, consumer).sharedClassBindings.map(({ binding, representation }) => [
        binding.name,
        representation,
      ]),
    ).toEqual(
      expect.arrayContaining([
        ['nullable', 'optional-null-shared-ref-cell-class'],
        ['nullableAlias', 'optional-null-shared-ref-cell-class'],
        ['optional', 'optional-undefined-shared-ref-cell-class'],
        ['optionalAlias', 'optional-undefined-shared-ref-cell-class'],
        ['parameter', 'optional-undefined-shared-ref-cell-class'],
        ['aliasRoot', 'optional-null-shared-ref-cell-class'],
        ['importedForward', 'optional-null-shared-ref-cell-class'],
      ]),
    );
  });

  it('refuses borrowed and inexact class method return roots', () => {
    const cases = [
      `class Counter { value = 0; copy(): Counter { return this; } }`,
      `class Counter { value = 0; copy(): Counter { const alias = this; return alias; } }`,
      `class Counter { value = 0; copy(other: Counter): Counter { return other; } }`,
      `class Counter { value = 0; copy(other: Counter): Counter { const alias = other; return alias; } }`,
      `class Counter { value = 0; }
       class Other { value = 1; }
       class Factory { copy(flag: boolean): Counter | Other { return flag ? new Counter() : new Other(); } }`,
      `class Counter { value = 0; async copy(): Promise<Counter> { return new Counter(); } }`,
      `class Counter { value = 0; copy<T>(): Counter { return new Counter(); } }`,
      `class Counter {
         value = 0;
         copy(flag: boolean): Counter { if (flag) return new Counter(); return new Counter(); }
       }`,
      `class Counter { value = 0; }
       class Other { value = 1; }
       class Factory { copy(): Counter { return new Other(); } }`,
      `class Counter {
         value = 0;
         fresh(): Counter { return new Counter(); }
         copy(other: Counter): Counter { return other.fresh(); }
       }`,
      `class Counter {
         value = 0;
         fresh(other?: Counter): Counter { return new Counter(); }
         copy(): Counter { return this.fresh(); }
       }`,
      `class Counter {
         value = 0;
         fresh<T>(): Counter { return new Counter(); }
         copy(): Counter { return this.fresh<number>(); }
       }`,
      `class Counter {
         value = 0;
         fresh(): Counter { return new Counter(); }
         receiver(): Counter { return new Counter(); }
         copy(): Counter { return this.receiver().fresh(); }
       }`,
      `class Counter {
         value = 0;
         fresh(): Counter { return new Counter(); }
         copy(): Counter {
           const receiver: Counter | undefined = new Counter();
           return receiver!.fresh();
         }
       }`,
      `class Counter {
         value = 0;
         static fresh(): Counter { return new Counter(); }
         copy(): Counter { return Counter.fresh(); }
       }`,
      `class Counter { value = 0; }
       class Other { value = 1; fresh(): Other { return new Other(); } }
       class Factory { marker = 0; copy(): Counter { const receiver = new Other(); return receiver.fresh(); } }`,
      `class Counter { value = 0; copy(other: Counter): Counter | null { return other; } }`,
      `class Counter {
         value = 0;
         maybe(): Counter | undefined { return undefined; }
         copy(): Counter | null { return this.maybe(); }
       }`,
      `class Counter {
         value = 0;
         maybe(): Counter | null { return null; }
         copy(): Counter { return this.maybe(); }
       }`,
      `class Counter { value = 0; copy(): Counter | null | undefined { return new Counter(); } }`,
      `class Counter { value = 0; }
       class Other { value = 1; maybe(): Other | null { return null; } }
       class Factory { marker = 0; copy(): Counter | null { const receiver = new Other(); return receiver.maybe(); } }`,
    ];

    for (const [index, declaration] of cases.entries()) {
      const module = lower(
        `class-method-return-refusal-${String(index)}.ts`,
        `${declaration} export function run(): number { return 0; }`,
      );
      expect(
        getModulePlan(createCompilerRustReferenceRepresentationPlan({ modules: [module] }), module).refusals,
        `case ${String(index)}`,
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code:
              index === 5
                ? 'rust-async-method-owner-carrier-unrepresented'
                : 'rust-reference-shared-class-return-unrepresented',
          }),
        ]),
      );
    }
  });

  it('refuses self, mutual, and imported class-return forwarding cycles deterministically', () => {
    const local = lower(
      'class-method-return-cycle.ts',
      `class Counter {
         value = 0;
         self(): Counter { return this.self(); }
         first(): Counter { return this.second(); }
         second(): Counter { return this.first(); }
         optionalSelf(): Counter | null { return this.optionalSelf(); }
         optionalFirst(): Counter | undefined { return this.optionalSecond(); }
         optionalSecond(): Counter | undefined { return this.optionalFirst(); }
       }
       export function run(): number { return 0; }`,
    );
    const localRefusals = getModulePlan(
      createCompilerRustReferenceRepresentationPlan({ modules: [local] }),
      local,
    ).refusals.filter(({ code }) => code === 'rust-reference-shared-class-return-unrepresented');
    expect(localRefusals.map(({ subject }) => subject)).toEqual(
      expect.arrayContaining([
        expect.stringContaining(':method:self'),
        expect.stringContaining(':method:first'),
        expect.stringContaining(':method:second'),
        expect.stringContaining(':method:optionalSelf'),
        expect.stringContaining(':method:optionalFirst'),
        expect.stringContaining(':method:optionalSecond'),
      ]),
    );

    const providerSource = ts.createSourceFile(
      '/flight/packages/math/src/class-method-cycle-provider.ts',
      `import { Relay } from './class-method-cycle-consumer.js';
       export class Counter { value = 0; }
       export class Provider {
         marker = 0;
         forward(): Counter | null { const relay = new Relay(); return relay.forward(); }
       }`,
      ts.ScriptTarget.Latest,
      true,
    );
    const consumerSource = ts.createSourceFile(
      '/flight/packages/math/src/class-method-cycle-consumer.ts',
      `import { Counter, Provider } from './class-method-cycle-provider.js';
       export class Relay {
         marker = 0;
         forward(): Counter | null { const provider = new Provider(); return provider.forward(); }
       }`,
      ts.ScriptTarget.Latest,
      true,
    );
    const moduleResolution = {
      edges: [
        {
          importer: {
            name: 'Class-method-cycle-provider',
            packageName: '@flighthq/math',
            source: 'packages/math/src/class-method-cycle-provider.ts',
          },
          specifier: './class-method-cycle-consumer.js',
          target: {
            packageName: '@flighthq/math',
            source: 'packages/math/src/class-method-cycle-consumer.ts',
          },
        },
        {
          importer: {
            name: 'Class-method-cycle-consumer',
            packageName: '@flighthq/math',
            source: 'packages/math/src/class-method-cycle-consumer.ts',
          },
          specifier: './class-method-cycle-provider.js',
          target: {
            packageName: '@flighthq/math',
            source: 'packages/math/src/class-method-cycle-provider.ts',
          },
        },
      ],
      schema: 'flight-compiler-module-resolution/1',
    } as const;
    const [providerResult, consumerResult] = lowerTypeScriptSources(
      [
        { packageName: '@flighthq/math', sourceFile: providerSource, upstreamDirectory: '/flight' },
        { packageName: '@flighthq/math', sourceFile: consumerSource, upstreamDirectory: '/flight' },
      ],
      moduleResolution,
    );
    expect(providerResult!.diagnostics).toEqual([]);
    expect(consumerResult!.diagnostics).toEqual([]);
    const provider = providerResult!.module;
    const consumer = consumerResult!.module;
    const first = createCompilerRustReferenceRepresentationPlan({
      moduleResolution,
      modules: [provider, consumer],
    });
    const second = createCompilerRustReferenceRepresentationPlan({
      moduleResolution,
      modules: [consumer, provider],
    });

    expect(second).toEqual(first);
    for (const module of [provider, consumer]) {
      expect(getModulePlan(first, module).refusals).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: 'rust-reference-shared-class-return-unrepresented' })]),
      );
    }
  });

  it('propagates optional class method argument mutation through local function wrappers', () => {
    const module = lower(
      'optional-class-method-mutation-propagation.ts',
      `class Counter {
         value = 0;
         label = "";
         write(amount: number, other?: Counter): void {
           if (other === undefined) return;
           other.value = amount;
           other.value += amount;
           other.label += "!";
         }
       }
       function forward(receiver: Counter, other?: Counter): void {
         if (other === undefined) return;
         receiver.write(2, other);
       }
       function relay(receiver: Counter, other?: Counter): void { forward(receiver, other); }
       export function run(): number {
         const receiver = new Counter(); const receiverAlias = receiver;
         const other = new Counter(); const otherAlias = other;
         relay(receiverAlias, otherAlias);
         return other.value;
       }`,
    );
    const modulePlan = getModulePlan(createCompilerRustReferenceRepresentationPlan({ modules: [module] }), module);

    expect(modulePlan.refusals).toEqual([]);
    expect(modulePlan.callables).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          binding: expect.objectContaining({ name: 'forward' }),
          parameters: [
            { position: 0, representation: 'borrowed-class' },
            { position: 1, representation: 'optional-undefined-shared-ref-cell-class' },
          ],
        }),
        expect.objectContaining({
          binding: expect.objectContaining({ name: 'relay' }),
          parameters: [
            { position: 0, representation: 'borrowed-class' },
            { position: 1, representation: 'optional-undefined-shared-ref-cell-class' },
          ],
        }),
      ]),
    );
    expect(modulePlan.referentMutatedBindings.map(({ name }) => name)).toEqual(
      expect.arrayContaining(['other', 'other']),
    );
  });

  it('requires exact optional class method evidence and refuses receiver overlap', () => {
    const missingEvidence = lower(
      'optional-class-method-evidence.ts',
      `class Counter {
         value = 1;
         inspect(other?: Counter): number { return other === undefined ? this.value : other.value; }
       }
       export function run(): number { const value = new Counter(); return value.inspect(); }`,
    );
    const run = missingEvidence.declarations.find(
      (declaration) => declaration.kind === 'function' && declaration.binding.name === 'run',
    );
    const returned = run?.kind === 'function' ? run.body[1] : undefined;
    const call = returned?.kind === 'return' ? returned.expression : undefined;
    if (call?.kind !== 'call') throw new Error('Expected optional class method call');
    delete (call.semantics as { optionalParameters?: unknown }).optionalParameters;
    const overlap = lower(
      'optional-class-method-overlap.ts',
      `class Counter {
         value = 1;
         inspect(other?: Counter): number { return other === undefined ? this.value : other.value; }
       }
       export function run(): number { const value = new Counter(); return value.inspect(value); }`,
    );

    expect(
      getModulePlan(createCompilerRustReferenceRepresentationPlan({ modules: [missingEvidence] }), missingEvidence)
        .refusals,
    ).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'rust-reference-shared-class-call-unrepresented' })]),
    );
    expect(
      getModulePlan(createCompilerRustReferenceRepresentationPlan({ modules: [overlap] }), overlap).refusals,
    ).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'rust-reference-shared-class-borrow-conflict' })]),
    );
  });

  it('requires explicit class method arity, sentinel, identity, and disjoint receiver ownership', () => {
    const missingArgument = lower(
      'explicit-sentinel-class-method-missing.ts',
      `class Counter { value = 1; inspect(other: Counter | null): number { return other === null ? 0 : other.value; } }
       export function run(): number { const value = new Counter(); return value.inspect(null); }`,
    );
    const run = missingArgument.declarations.find(
      (declaration) => declaration.kind === 'function' && declaration.binding.name === 'run',
    );
    const returned = run?.kind === 'function' ? run.body[1] : undefined;
    const call = returned?.kind === 'return' ? returned.expression : undefined;
    if (call?.kind !== 'call') throw new Error('Expected explicit sentinel class method call');
    (call.arguments as IrExpression[]).length = 0;
    const wrongSentinel = lower(
      'explicit-sentinel-class-method-wrong-sentinel.ts',
      `class Counter { value = 1; inspect(other: Counter | null): number { return other === null ? 0 : other.value; } }
       export function run(): number { const value = new Counter(); return value.inspect(undefined as never); }`,
    );
    const wrongIdentity = lower(
      'explicit-sentinel-class-method-wrong-identity.ts',
      `class Counter { value = 1; inspect(other: Counter | null): number { return other === null ? 0 : other.value; } }
       class Other { value = 2; }
       export function run(): number { const value = new Counter(); return value.inspect(new Other() as never); }`,
    );
    const overlap = lower(
      'explicit-sentinel-class-method-overlap.ts',
      `class Counter { value = 1; inspect(other: Counter | null): number { return other === null ? 0 : other.value; } }
       export function run(): number { const value = new Counter(); return value.inspect(value); }`,
    );

    for (const module of [missingArgument, wrongSentinel, wrongIdentity]) {
      expect(
        getModulePlan(createCompilerRustReferenceRepresentationPlan({ modules: [module] }), module).refusals,
      ).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: 'rust-reference-shared-class-call-unrepresented' })]),
      );
    }
    expect(
      getModulePlan(createCompilerRustReferenceRepresentationPlan({ modules: [overlap] }), overlap).refusals,
    ).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'rust-reference-shared-class-borrow-conflict' })]),
    );
  });

  it('requires exact required class method arity, identity, and disjoint mutable borrows', () => {
    const missingArgument = lower(
      'required-class-method-missing.ts',
      `class Counter { value = 1; inspect(scale: number, other: Counter): number { return other.value * scale; } }
       export function run(): number { const value = new Counter(); return value.inspect(2, value); }`,
    );
    const run = missingArgument.declarations.find(
      (declaration) => declaration.kind === 'function' && declaration.binding.name === 'run',
    );
    const returned = run?.kind === 'function' ? run.body[1] : undefined;
    const call = returned?.kind === 'return' ? returned.expression : undefined;
    if (call?.kind !== 'call') throw new Error('Expected required class method call');
    (call.arguments as IrExpression[]).length = 1;
    const wrongSentinel = lower(
      'required-class-method-wrong-sentinel.ts',
      `class Counter { value = 1; inspect(scale: number, other: Counter): number { return other.value * scale; } }
       export function run(): number { const value = new Counter(); return value.inspect(2, undefined as never); }`,
    );
    const wrongIdentity = lower(
      'required-class-method-wrong-identity.ts',
      `class Counter { value = 1; inspect(scale: number, other: Counter): number { return other.value * scale; } }
       class Other { value = 2; }
       export function run(): number { const value = new Counter(); return value.inspect(2, new Other() as never); }`,
    );
    const overlap = lower(
      'required-class-method-overlap.ts',
      `class Counter { value = 1; inspect(scale: number, other: Counter): number { return other.value * scale; } }
       export function run(): number {
         const value = new Counter(); const alias = value;
         return value.inspect(2, alias);
       }`,
    );
    const mutablePrefixAlias = lower(
      'required-class-method-prefix-alias.ts',
      `class Counter {
         value = 1;
         write(scale: number, other: Counter): void { other.value = this.value * scale; }
       }
       export function run(): number {
         const receiver = new Counter(); const other = new Counter(); const alias = other;
         receiver.write(other.value, alias);
         return other.value;
       }`,
    );

    for (const module of [missingArgument, wrongSentinel, wrongIdentity]) {
      expect(
        getModulePlan(createCompilerRustReferenceRepresentationPlan({ modules: [module] }), module).refusals,
      ).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: 'rust-reference-shared-class-call-unrepresented' })]),
      );
    }
    for (const module of [overlap, mutablePrefixAlias]) {
      expect(
        getModulePlan(createCompilerRustReferenceRepresentationPlan({ modules: [module] }), module).refusals,
      ).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: 'rust-reference-shared-class-borrow-conflict' })]),
      );
    }
  });

  it('refuses required class method parameters outside final direct primitive projection', () => {
    const cases = [
      `class Counter { value = 1; read(other: Counter, scale: number): number { return other.value * scale; } }`,
      `class Counter { value = 1; read(first: Counter, second: Counter): number { return first.value + second.value; } }`,
      `class Counter { value = 1; read(other: Counter): number { const captured = (): number => other.value; return captured(); } }`,
      `class Counter { value = 1; read(other: Counter): number { return other === this ? 1 : 0; } }`,
      `class Counter { value = 1; current(): number { return this.value; } read(other: Counter): number { return other.current(); } }`,
      `class Counter { value = 1; read(other: Counter): Counter { return other; } }`,
      `class Counter { value = 1; read(other: Counter): number { const escaped = other; return escaped.value; } }`,
    ];

    for (const [index, declaration] of cases.entries()) {
      const module = lower(
        `required-class-method-refusal-${String(index)}.ts`,
        `${declaration} export function run(): number { const value = new Counter(); return value.value; }`,
      );
      expect(
        getModulePlan(createCompilerRustReferenceRepresentationPlan({ modules: [module] }), module).refusals,
      ).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: 'rust-reference-shared-class-member-unrepresented' })]),
      );
    }
  });

  it('preserves optional class method mutation conflict, result, operator, and domain refusals', () => {
    const cases = [
      [
        `class Counter { value = 1; write(other?: Counter): void { if (other !== undefined) other.value += other.value; } }`,
        'rust-reference-shared-class-borrow-conflict',
      ],
      [
        `class Counter { value = 1; write(other?: Counter): number { return other === undefined ? 0 : (other.value += 1); } }`,
        'rust-reference-shared-class-mutator-result-unrepresented',
      ],
      [
        `class Counter { value = 1; write(other?: Counter): void { if (other !== undefined) other.value **= 2; } }`,
        'rust-reference-shared-class-use-unrepresented',
      ],
      [
        `class Counter { label = ""; write(other?: Counter): void { if (other !== undefined) other.label += 1; } }`,
        'rust-reference-shared-class-use-unrepresented',
      ],
    ] as const;

    for (const [index, [declaration, code]] of cases.entries()) {
      const module = lower(
        `optional-class-method-mutation-refusal-${String(index)}.ts`,
        `${declaration} export function run(): number { const value = new Counter(); return ${index === 3 ? 'value.label.length' : 'value.value'}; }`,
      );
      expect(
        getModulePlan(createCompilerRustReferenceRepresentationPlan({ modules: [module] }), module).refusals,
      ).toEqual(expect.arrayContaining([expect.objectContaining({ code })]));
    }
  });

  it('refuses optional class method parameters outside narrowed direct primitive projection', () => {
    const cases = [
      `class Counter { value = 1; read(other?: Counter): number { other!.value = 2; return other!.value; } }`,
      `class Counter { value = 1; current(): number { return this.value; } read(other?: Counter): number { return other === undefined ? 0 : other.current(); } }`,
      `class Counter { value = 1; read(other?: Counter): number { const captured = (): number => other === undefined ? 0 : other.value; return captured(); } }`,
      `class Counter { value = 1; read(other?: Counter): number { const escaped = other; return escaped === undefined ? 0 : escaped.value; } }`,
      `class Counter { value = 1; read(other?: Counter): number { return other?.value ?? 0; } }`,
      `class Counter { value = 1; read(other: Counter | undefined, scale: number): number { return other === undefined ? 0 : other.value * scale; } }`,
      `class Counter { value = 1; read(other: Counter | null | undefined): number { return other == null ? 0 : other.value; } }`,
      `class Counter { value = 1; read(other: Counter = new Counter()): number { return other.value; } }`,
      `class Counter { value = 1; read(other?: Counter, scale?: number): number { return other === undefined ? 0 : other.value * (scale ?? 1); } }`,
      `class Counter { value = 1; read(first?: Counter, second?: Counter): number { return first === undefined || second === undefined ? 0 : first.value + second.value; } }`,
    ];

    for (const [index, declaration] of cases.entries()) {
      const module = lower(
        `optional-class-method-refusal-${String(index)}.ts`,
        `${declaration} export function run(): number { const value = new Counter(); return value.value; }`,
      );
      expect(
        getModulePlan(createCompilerRustReferenceRepresentationPlan({ modules: [module] }), module).refusals,
      ).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: 'rust-reference-shared-class-member-unrepresented' })]),
      );
    }

    const rest = lower(
      'optional-class-method-rest-refusal.ts',
      `class Counter { value = 1; read(other?: Counter): number { return other === undefined ? 0 : other.value; } }
       export function run(): number { const value = new Counter(); return value.value; }`,
    );
    const declaration = rest.declarations.find(
      (candidate) => candidate.kind === 'class' && candidate.binding.name === 'Counter',
    );
    const method = declaration?.kind === 'class' ? declaration.methods.find(({ name }) => name === 'read') : undefined;
    const parameter = method?.parameters[0];
    if (!parameter) throw new Error('Expected optional class method parameter');
    (parameter as { rest: boolean }).rest = true;
    expect(getModulePlan(createCompilerRustReferenceRepresentationPlan({ modules: [rest] }), rest).refusals).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'rust-reference-shared-class-member-unrepresented' })]),
    );
  });

  it('elects the class carrier when readonly aliases remain live through fields and methods', () => {
    const module = lower(
      'readonly-alias-class.ts',
      `class Counter {
         value = 4;
         label = "ready";
         current(): number { return this.value; }
       }
       export function inspect(): number {
         const value = new Counter();
         const alias = value;
         const before = value.value;
         const label = alias.label;
         return before * 100 + value.current() * 10 + (label === "ready" ? alias.value : 0);
       }`,
    );
    const modulePlan = getModulePlan(createCompilerRustReferenceRepresentationPlan({ modules: [module] }), module);

    expect(modulePlan.refusals).toEqual([]);
    expect(modulePlan.sharedClassBindings.map(({ binding }) => binding.name).sort()).toEqual(['alias', 'value']);
  });

  it('elects one class carrier for exact synchronous primitive instance methods', () => {
    const module = lower(
      'alias-class-method.ts',
      `class Counter {
         value = 0;
         increment(amount: number): number { this.value += amount; return this.value; }
         current(): number { return this.value; }
       }
       export function run(): number {
         const values = new Counter();
         const alias = values;
         alias.increment(2);
         return values.current();
       }`,
    );
    const modulePlan = getModulePlan(createCompilerRustReferenceRepresentationPlan({ modules: [module] }), module);

    expect(modulePlan.refusals).toEqual([]);
    expect(modulePlan.sharedClassBindings.map(({ binding }) => binding.name).sort()).toEqual(['alias', 'values']);
  });

  it('refuses overlapping shared-class field borrows and observed assignment results', () => {
    const conflict = lower(
      'alias-class-conflict.ts',
      `class Counter { value = 0; }
       export function aliasConflict(): number {
         const values = new Counter();
         const alias = values;
         alias.value = values.value + 1;
         return alias.value;
       }`,
    );
    const observed = lower(
      'alias-class-result.ts',
      `class Counter { value = 0; }
       export function aliasResult(): number {
         const values = new Counter();
         const alias = values;
         return (alias.value = 2);
       }`,
    );

    expect(
      getModulePlan(createCompilerRustReferenceRepresentationPlan({ modules: [conflict] }), conflict).refusals,
    ).toEqual([expect.objectContaining({ code: 'rust-reference-shared-class-borrow-conflict' })]);
    expect(
      getModulePlan(createCompilerRustReferenceRepresentationPlan({ modules: [observed] }), observed).refusals,
    ).toEqual([expect.objectContaining({ code: 'rust-reference-shared-class-mutator-result-unrepresented' })]);
  });

  it('refuses class accessors, identity-valued fields, generics, and unsupported construction', () => {
    const cases = [
      [
        lower(
          'alias-class-accessor.ts',
          `class Counter { stored = 0; get value(): number { return this.stored; } set value(next: number) { this.stored = next; } }
           export function run(): number { const values = new Counter(); const alias = values; alias.value = 2; return values.value; }`,
        ),
        'rust-reference-shared-class-member-unrepresented',
      ],
      [
        lower(
          'alias-class-field.ts',
          `class Holder { values: number[] = []; }
           export function run(): number { const values = new Holder(); const alias = values; alias.values = [1]; return values.values.length; }`,
        ),
        'rust-reference-shared-class-field-unrepresented',
      ],
      [
        lower(
          'alias-class-generic.ts',
          `class Box<T> { value: T; constructor() { this.value = undefined as T; } }
           export function run(): number { const values = new Box<number>(); const alias = values; alias.value = 1; return values.value; }`,
        ),
        'rust-reference-shared-class-type-unrepresented',
      ],
      [
        lower(
          'alias-class-inheritance.ts',
          `class Base { value = 0; } class Counter extends Base {}
           export function run(): number { const values = new Counter(); const alias = values; alias.value = 1; return values.value; }`,
        ),
        'rust-reference-shared-class-type-unrepresented',
      ],
      [
        lower(
          'alias-class-construction.ts',
          `class Counter { value: number; constructor(value: number = 0) { this.value = value; } }
           export function run(): number { const values = new Counter(); const alias = values; alias.value = 1; return values.value; }`,
        ),
        'rust-reference-shared-class-construction-unrepresented',
      ],
    ] as const;

    for (const [module, code] of cases) {
      expect(
        getModulePlan(createCompilerRustReferenceRepresentationPlan({ modules: [module] }), module).refusals,
      ).toEqual(expect.arrayContaining([expect.objectContaining({ code })]));
    }
  });

  it('keeps unsupported class method boundaries as stable focused refusals', () => {
    const methodCases = [
      `class Counter { value = 0; read<T>(input: T): number { return this.value; } }`,
      `class Counter { value = 0; read(input: number): number; read(input: number): number { return this.value; } }`,
      `class Counter { value = 0; merge(other: Counter): number { return this.value; } }`,
      `class Counter { value = 0; values(): number[] { return [this.value]; } }`,
      `class Counter { value = 0; leak(): number { consume(this); return this.value; } } function consume(value: Counter): void { value.value = 1; }`,
      `class Counter { value = 0; callback(): number { const read = (): number => this.value; return read(); } }`,
    ];

    for (const [index, declaration] of methodCases.entries()) {
      const module = lower(
        `alias-class-method-refusal-${String(index)}.ts`,
        `${declaration}
         export function run(): number {
           const values = new Counter();
           const alias = values;
           alias.value = 2;
           return values.value;
         }`,
      );
      expect(
        getModulePlan(createCompilerRustReferenceRepresentationPlan({ modules: [module] }), module).refusals,
      ).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: 'rust-reference-shared-class-member-unrepresented' })]),
      );
    }
  });

  it('exempts only an exact async method receiver from the shared-class suspension refusal', () => {
    const represented = lower(
      'async-method-reference-plan.ts',
      `class Counter {
         value = 0;
         async advance(task: Promise<number>): Promise<number> {
           this.value += 1;
           const amount = await task;
           this.value += amount;
           return this.value;
         }
       }
       export async function run(task: Promise<number>): Promise<number> {
         const counter = new Counter();
         const pending = counter.advance(task);
         await pending;
         await pending;
         return counter.value;
       }`,
    );
    const ordinarySuspension = lower(
      'ordinary-class-suspension-plan.ts',
      `class Counter { value = 0; async read(): Promise<number> { return this.value; } }
       export async function run(task: Promise<void>): Promise<number> {
         const counter = new Counter();
         const alias = counter;
         await task;
         alias.value = 1;
         return counter.value;
       }`,
    );
    const representedPlan = getModulePlan(
      createCompilerRustReferenceRepresentationPlan({ modules: [represented] }),
      represented,
    );
    const ordinaryPlan = getModulePlan(
      createCompilerRustReferenceRepresentationPlan({ modules: [ordinarySuspension] }),
      ordinarySuspension,
    );

    expect(representedPlan.refusals).toEqual([]);
    expect(representedPlan.sharedClassBindings).toHaveLength(1);
    expect(ordinaryPlan.refusals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'rust-reference-shared-class-suspension-unrepresented' }),
      ]),
    );
  });

  it('uses dedicated async method owner, body, and call refusals', () => {
    const owner = lower(
      'async-method-owner-plan.ts',
      'class Counter { value = 0; static async read(): Promise<number> { return 1; } }',
    );
    const body = lower(
      'async-method-body-plan.ts',
      'class Counter { value = 0; async read(task: Promise<number>): Promise<number> { return this.value + await task; } }',
    );
    const call = lower(
      'async-method-call-plan.ts',
      `class Counter { value = 0; async read(task: Promise<number>): Promise<number> { return await task; } }
       export function run(task: Promise<number>): void { const counter = new Counter(); counter.read?.(task); }`,
    );

    expect(getModulePlan(createCompilerRustReferenceRepresentationPlan({ modules: [owner] }), owner).refusals).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'rust-async-method-owner-carrier-unrepresented' })]),
    );
    expect(getModulePlan(createCompilerRustReferenceRepresentationPlan({ modules: [body] }), body).refusals).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'rust-async-method-body-unrepresented' })]),
    );
    expect(getModulePlan(createCompilerRustReferenceRepresentationPlan({ modules: [call] }), call).refusals).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'rust-async-method-call-unrepresented' })]),
    );
  });

  it('refuses dynamic, optional, and overlapping shared-class method calls', () => {
    const dynamic = lower(
      'alias-class-dynamic-method.ts',
      `class Counter { value = 0; increment(amount: number): number { this.value += amount; return this.value; } }
       export function run(): number {
         const values = new Counter(); const alias = values;
         const increment = alias.increment;
         increment(1);
         return values.value;
       }`,
    );
    const optional = lower(
      'alias-class-optional-method.ts',
      `class Counter { value = 0; increment(amount: number): number { this.value += amount; return this.value; } }
       export function run(): number {
         const values = new Counter(); const alias = values;
         alias.increment?.(1);
         return values.value;
       }`,
    );
    const overlapping = lower(
      'alias-class-overlapping-method.ts',
      `class Counter { value = 0; increment(amount: number): number { this.value += amount; return this.value; } }
       export function run(): number {
         const values = new Counter(); const alias = values;
         alias.increment(values.value);
         return values.value;
       }`,
    );

    expect(
      getModulePlan(createCompilerRustReferenceRepresentationPlan({ modules: [dynamic] }), dynamic).refusals,
    ).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'rust-reference-shared-class-member-unrepresented' })]),
    );
    expect(
      getModulePlan(createCompilerRustReferenceRepresentationPlan({ modules: [optional] }), optional).refusals,
    ).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'rust-reference-shared-class-use-unrepresented' })]),
    );
    expect(
      getModulePlan(createCompilerRustReferenceRepresentationPlan({ modules: [overlapping] }), overlapping).refusals,
    ).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'rust-reference-shared-class-borrow-conflict' })]),
    );
  });

  it('refuses unbound instance method values for every exact class receiver form', () => {
    const cases = [
      lower(
        'singleton-class-method-value.ts',
        `class Counter { value = 0; current(): number { return this.value; } }
         export function run(): number { const value = new Counter(); const current = value.current; return 0; }`,
      ),
      lower(
        'alias-class-method-value.ts',
        `class Counter { value = 0; current(): number { return this.value; } }
         export function run(): number {
           const value = new Counter(); const alias = value; const current = alias.current; return value.value;
         }`,
      ),
      lower(
        'temporary-class-method-value.ts',
        `class Counter { value = 0; current(): number { return this.value; } }
         export function run(): number { const current = new Counter().current; return 0; }`,
      ),
      lower(
        'returned-class-method-value.ts',
        `class Counter { value = 0; current(): number { return this.value; } }
         function make(): Counter { return new Counter(); }
         export function run(): number { const current = make().current; return 0; }`,
      ),
    ];

    for (const module of cases) {
      expect(
        getModulePlan(createCompilerRustReferenceRepresentationPlan({ modules: [module] }), module).refusals,
      ).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: 'rust-reference-shared-class-member-unrepresented' })]),
      );
    }

    const provider = lower(
      'method-value-provider.ts',
      `export class Counter { value = 0; current(): number { return this.value; } }`,
    );
    const consumer = lower(
      'method-value-consumer.ts',
      `import { Counter } from './method-value-provider.js';
       export function run(): number { const value: Counter = new Counter(); const current = value.current; return 0; }`,
    );
    const moduleResolution = {
      edges: [
        {
          importer: { name: consumer.name, packageName: consumer.packageName, source: consumer.source },
          specifier: './method-value-provider.js',
          target: { packageName: provider.packageName, source: provider.source },
        },
      ],
      schema: 'flight-compiler-module-resolution/1',
    } as const;
    const consumerPlan = getModulePlan(
      createCompilerRustReferenceRepresentationPlan({ moduleResolution, modules: [consumer, provider] }),
      consumer,
    );

    expect(consumerPlan.refusals).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'rust-reference-shared-class-member-unrepresented' })]),
    );
  });

  it('retains callback-escape and suspension refusals for shared-class methods', () => {
    const callbackEscape = lower(
      'alias-class-method-callback.ts',
      `class Counter {
         value = 0;
         increment(): void { this.value += 1; }
         current(): number { return this.value; }
       }
       export function run(): () => number {
         const values = new Counter(); const alias = values;
         alias.increment();
         return (): number => values.current();
       }`,
    );
    const suspension = lower(
      'alias-class-method-suspension.ts',
      `class Counter {
         value = 0;
         increment(): void { this.value += 1; }
         current(): number { return this.value; }
       }
       export async function run(): Promise<number> {
         const values = new Counter(); const alias = values;
         alias.increment();
         await Promise.resolve(0);
         return values.current();
       }`,
    );

    expect(
      getModulePlan(createCompilerRustReferenceRepresentationPlan({ modules: [callbackEscape] }), callbackEscape)
        .refusals,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'rust-reference-shared-class-closure-escape-unrepresented' }),
      ]),
    );
    expect(
      getModulePlan(createCompilerRustReferenceRepresentationPlan({ modules: [suspension] }), suspension).refusals,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'rust-reference-shared-class-suspension-unrepresented' }),
      ]),
    );
  });

  it('refuses inexact primitive constructor invocation and constructor escape shapes', () => {
    const cases = [
      lower(
        'class-constructor-argument.ts',
        `class Pair { first: number; second: string; constructor(first: number, second: string) { this.first = first; this.second = second; } }
         export function run(): number { const values = new Pair({} as any, "second"); const alias = values; alias.first = 3; return values.first; }`,
      ),
      lower(
        'class-constructor-object.ts',
        `class Counter { value: number; constructor(input: { value: number }) { this.value = input.value; } }
         export function run(): number { const values = new Counter({ value: 1 }); const alias = values; alias.value = 3; return values.value; }`,
      ),
      lower(
        'class-constructor-identity.ts',
        `class Counter { value: number; constructor(input: number[]) { this.value = input.length; } }
         export function run(): number { const values = new Counter([1]); const alias = values; alias.value = 3; return values.value; }`,
      ),
      lower(
        'class-constructor-rest.ts',
        `class Counter { value: number; constructor(...input: number[]) { this.value = input[0]!; } }
         export function run(): number { const values = new Counter(1); const alias = values; alias.value = 3; return values.value; }`,
      ),
      lower(
        'class-constructor-overload.ts',
        `class Counter { value: number; constructor(value: number); constructor(value: number) { this.value = value; } }
         export function run(): number { const values = new Counter(1); const alias = values; alias.value = 3; return values.value; }`,
      ),
      lower(
        'class-constructor-spread.ts',
        `class Pair { first: number; second: number; constructor(first: number, second: number) { this.first = first; this.second = second; } }
         export function run(input: [number, number]): number { const values = new Pair(...input); const alias = values; alias.first = 3; return values.first; }`,
      ),
      lower(
        'class-constructor-escape.ts',
        `function consume(_value: Counter): void {}
         class Counter { value: number; constructor(value: number) { consume(this); this.value = value; } }
         export function run(): number { const values = new Counter(1); const alias = values; alias.value = 3; return values.value; }`,
      ),
    ];

    for (const module of cases) {
      expect(
        getModulePlan(createCompilerRustReferenceRepresentationPlan({ modules: [module] }), module).refusals,
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: 'rust-reference-shared-class-construction-unrepresented' }),
        ]),
      );
    }
  });

  it('refuses an unresolved imported constructor owner', () => {
    const module = lower(
      'class-constructor-unresolved.ts',
      `import { Pair } from './missing.js';
       export function run(): number { const values: Pair = new Pair(1, 2); const alias: Pair = values; alias.first = 3; return alias.first; }`,
    );

    expect(
      getModulePlan(createCompilerRustReferenceRepresentationPlan({ modules: [module] }), module).refusals,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'rust-reference-shared-class-construction-unrepresented' }),
      ]),
    );
  });

  it('refuses shared-class storage, reassignment, dynamic calls, suspension, and ambiguous owners', () => {
    const cases = [
      [
        lower(
          'class-storage.ts',
          `class Counter { value = 0; }
           export function run(): number { const values = new Counter(); const alias = values; alias.value = 1; const stored = { alias }; return stored.alias.value; }`,
        ),
        'rust-reference-shared-class-use-unrepresented',
      ],
      [
        lower(
          'class-dynamic-call.ts',
          `class Counter { value = 0; }
           export function run(mutate: (value: Counter) => void): number { const values = new Counter(); const alias = values; mutate(alias); return values.value; }`,
        ),
        'rust-reference-shared-class-call-unrepresented',
      ],
      [
        lower(
          'class-optional-call.ts',
          `class Counter { value = 0; }
           export function run(mutate?: (value: Counter) => void): number { const values = new Counter(); const alias = values; mutate?.(alias); return values.value; }`,
        ),
        'rust-reference-shared-class-call-unrepresented',
      ],
      [
        lower(
          'class-suspension.ts',
          `class Counter { value = 0; }
           export async function run(task: Promise<void>): Promise<number> { const values = new Counter(); const alias = values; await task; alias.value = 1; return values.value; }`,
        ),
        'rust-reference-shared-class-suspension-unrepresented',
      ],
      [
        lower(
          'class-escape.ts',
          `class Counter { value = 0; }
           export function run(consume: (callback: () => void) => void): number { const values = new Counter(); const alias = values; consume(() => { alias.value = 1; }); return values.value; }`,
        ),
        'rust-reference-shared-class-closure-escape-unrepresented',
      ],
      [
        lower(
          'class-reassignment.ts',
          `class Counter { value = 0; }
           export function run(): number { let values = new Counter(); const alias = values; values = new Counter(); alias.value = 1; return values.value; }`,
        ),
        'rust-reference-shared-class-binding-reassignment-unrepresented',
      ],
      [
        lower(
          'class-ambiguous.ts',
          `class Counter { value = 0; }
           export function run(flag: boolean): number { const left = new Counter(); const right = new Counter(); const alias = flag ? left : right; alias.value = 1; return alias.value; }`,
        ),
        'rust-reference-shared-class-alias-ambiguous',
      ],
    ] as const;

    for (const [module, code] of cases) {
      expect(
        getModulePlan(createCompilerRustReferenceRepresentationPlan({ modules: [module] }), module).refusals,
      ).toEqual(expect.arrayContaining([expect.objectContaining({ code })]));
    }
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

  it('plans one shared HashSet carrier and one mutable HashSet borrow across a module boundary', () => {
    const provider = lower('set-provider.ts', 'export function fill(values: Set<string>): void { values.add("key"); }');
    const consumer = lower(
      'set-consumer.ts',
      `import { fill } from './set-provider.js';
       export function aliasSet(): number {
         const values = new Set<string>();
         const alias = values;
         fill(alias);
         return values.size;
       }`,
    );
    const moduleResolution = resolve('./set-provider.js', provider, consumer);
    const plan = createCompilerRustReferenceRepresentationPlan({ moduleResolution, modules: [provider, consumer] });
    const first = getModulePlan(plan, consumer);
    const second = createCompilerRustReferenceRepresentationPlan({
      moduleResolution: structuredClone(moduleResolution),
      modules: [structuredClone(provider), structuredClone(consumer)],
    });

    expect(second).toEqual(plan);
    expect(isDeeplyFrozen(plan, new WeakSet())).toBe(true);
    expect(getModulePlan(plan, provider).callables).toEqual([
      expect.objectContaining({
        binding: expect.objectContaining({ name: 'fill' }),
        parameters: [{ position: 0, representation: 'mutable-borrowed-hash-set' }],
      }),
    ]);
    expect(first.refusals).toEqual([]);
    expect(first.sharedSetBindings.map(({ binding, representation }) => [binding.name, representation]).sort()).toEqual(
      [
        ['alias', 'shared-ref-cell-hash-set'],
        ['values', 'shared-ref-cell-hash-set'],
      ],
    );
  });

  it('refuses observed Set mutator results and overlapping shared Set borrows', () => {
    const observed = lower(
      'set-result.ts',
      `export function setResult(): Set<string> {
         const values = new Set<string>();
         const alias = values;
         return alias.add("key");
       }`,
    );
    const conflict = lower(
      'set-conflict.ts',
      `export function setConflict(): number {
         const values = new Set<string>();
         const alias = values;
         alias.add(values.has("key") ? "present" : "absent");
         return alias.size;
       }`,
    );
    const callConflict = lower(
      'set-call-conflict.ts',
      `function fill(values: Set<string>, size: number): void { values.add(size.toString()); }
       export function setCallConflict(): number {
         const values = new Set<string>();
         const alias = values;
         fill(alias, values.size);
         return alias.size;
       }`,
    );

    expect(
      getModulePlan(createCompilerRustReferenceRepresentationPlan({ modules: [observed] }), observed).refusals,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'rust-reference-shared-set-mutator-result-unrepresented' }),
      ]),
    );
    expect(
      getModulePlan(createCompilerRustReferenceRepresentationPlan({ modules: [conflict] }), conflict).refusals,
    ).toEqual([expect.objectContaining({ code: 'rust-reference-shared-set-borrow-conflict' })]);
    expect(
      getModulePlan(createCompilerRustReferenceRepresentationPlan({ modules: [callConflict] }), callConflict).refusals,
    ).toEqual([expect.objectContaining({ code: 'rust-reference-shared-set-borrow-conflict' })]);
  });

  it('refuses non-exact and identity-valued shared Set element domains', () => {
    const namedAlias = lower(
      'set-named-alias.ts',
      `type Values = Set<string>;
       export function setNamedAlias(): number {
         const values: Values = new Set<string>();
         const alias = values;
         alias.add("key");
         return values.size;
       }`,
    );
    const numberElement = lower(
      'set-number.ts',
      `export function setNumber(): number {
         const values = new Set<number>();
         const alias = values;
         alias.add(0);
         return values.size;
       }`,
    );
    const identityElement = lower(
      'set-object.ts',
      `export function setObject(): number {
         const values = new Set<{ id: number }>();
         const alias = values;
         alias.add({ id: 1 });
         return values.size;
       }`,
    );

    expect(
      getModulePlan(createCompilerRustReferenceRepresentationPlan({ modules: [namedAlias] }), namedAlias).refusals,
    ).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'rust-reference-shared-set-use-unrepresented' })]),
    );
    for (const module of [numberElement, identityElement]) {
      expect(
        getModulePlan(createCompilerRustReferenceRepresentationPlan({ modules: [module] }), module).refusals,
      ).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: 'rust-reference-shared-set-element-unrepresented' })]),
      );
    }
  });

  it('refuses shared Set iteration, dynamic calls, suspension, escape, reassignment, and ambiguous aliases', () => {
    const cases: Array<readonly [IrModule, string]> = [
      [
        lower(
          'set-iteration.ts',
          `export function setIteration(): number {
             const values = new Set<string>();
             const alias = values;
             alias.add("key");
             for (const entry of values) { entry; }
             return alias.size;
           }`,
        ),
        'rust-reference-shared-set-use-unrepresented',
      ],
      [
        lower(
          'set-non-root.ts',
          `function create(): Set<string> { return new Set<string>(); }
           export function setNonRoot(): number {
             const values = create();
             const alias = values;
             alias.add("key");
             return values.size;
           }`,
        ),
        'rust-reference-shared-set-use-unrepresented',
      ],
      [
        lower(
          'set-dynamic.ts',
          `export function setDynamic(mutate: (value: Set<string>) => void): number {
             const values = new Set<string>();
             const alias = values;
             mutate(alias);
             return values.size;
           }`,
        ),
        'rust-reference-shared-set-call-unrepresented',
      ],
      [
        lower(
          'set-optional-call.ts',
          `export function setOptionalCall(mutate: ((value: Set<string>) => void) | undefined): number {
             const values = new Set<string>();
             const alias = values;
             mutate?.(alias);
             return values.size;
           }`,
        ),
        'rust-reference-shared-set-call-unrepresented',
      ],
      [
        lower(
          'set-suspension.ts',
          `export async function setSuspension(task: Promise<void>): Promise<number> {
             const values = new Set<string>();
             const alias = values;
             await task;
             alias.add("key");
             return values.size;
           }`,
        ),
        'rust-reference-shared-set-suspension-unrepresented',
      ],
      [
        lower(
          'set-escape.ts',
          `export function setEscape(consume: (callback: () => void) => void): number {
             const values = new Set<string>();
             const alias = values;
             consume(() => alias.add("key"));
             return values.size;
           }`,
        ),
        'rust-reference-shared-set-closure-escape-unrepresented',
      ],
      [
        lower(
          'set-reassignment.ts',
          `export function setReassignment(): number {
             let values = new Set<string>();
             const alias = values;
             values = new Set<string>();
             alias.add("key");
             return values.size;
           }`,
        ),
        'rust-reference-shared-set-binding-reassignment-unrepresented',
      ],
      [
        lower(
          'set-ambiguous.ts',
          `export function setAmbiguous(flag: boolean): number {
             const left = new Set<string>();
             const right = new Set<string>();
             const alias = flag ? left : right;
             alias.add("key");
             return alias.size;
           }`,
        ),
        'rust-reference-shared-set-alias-ambiguous',
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
