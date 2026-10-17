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

  it('refuses unsupported exact class return boundaries', () => {
    const cases = [
      lower(
        'return-optional.ts',
        `class Counter { value = 0; }
         export function make(flag: boolean): Counter | undefined { return flag ? new Counter() : undefined; }`,
      ),
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
      `class Counter { value = 0; async read(): Promise<number> { return this.value; } }`,
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
