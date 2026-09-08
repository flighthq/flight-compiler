import ts from 'typescript';

import { lowerTypeScriptSource } from '../../compiler-semantic/src/index.js';
import type {
  CompilerModuleEvaluationFailure,
  CompilerModuleEvaluationInput,
  CompilerModuleIdentity,
  CompilerModuleLinkDependency,
  IrModule,
} from '../../compiler-types/src/index.js';
import { createCompilerModuleEvaluationPlan, isCompilerModuleEvaluationFailure } from './compilerModuleEvaluation.js';

describe('createCompilerModuleEvaluationPlan', () => {
  it('plans instantiation, temporal access, live imports, mutation, and source-ordered evaluation', () => {
    const dependency = lowerModule(
      'dependency.ts',
      `
        export var available = 1;
        export var empty: number;
        export function ready(): number { return available; }
        export let temporal = 2;
        export const fixed = 3;
        export class Later {}
        export enum Choice { first }
        export interface Shape { value: number }
        export type Alias = Shape;
        export const [left, , ...right] = [4, 5, 6];
        export const { value: objectValue, ...remaining } = { value: 7, other: 8 };
        export const { value: plain } = { value: 9 };
        export const nested = async (): Promise<number> => 1 + await Promise.resolve(9);
      `,
    );
    const entry = lowerModule(
      'entry.ts',
      `
        import { available, temporal as remote } from './dependency.js';
        export const observed = available + remote;
      `,
    );
    const input = createInput([entry, dependency], [createDependency(entry, './dependency.js', dependency)], [entry]);
    const snapshot = structuredClone(input);
    const plan = createCompilerModuleEvaluationPlan(input);
    const dependencyPlan = plan.modules.find((module) => module.module.source === dependency.source)!;
    const entryPlan = plan.modules.find((module) => module.module.source === entry.source)!;
    const byName = new Map(dependencyPlan.bindings.map((binding) => [binding.binding.name, binding]));

    expect(plan.groups.map((group) => group.modules.map((module) => module.name))).toEqual([['Dependency'], ['Entry']]);
    expect(plan.semantics).toEqual({
      cycles: 'strongly-connected-live-environment',
      dependencyEvaluation: 'depth-first-request-order',
      importAccess: 'read-only-live-alias',
      localExportAccess: 'live-alias',
      phaseOrder: ['link', 'instantiate', 'evaluate-dependencies', 'evaluate'],
      temporalAccess: 'throw-reference-error',
      topLevelAwait: 'refuse',
      typeOnlyLinking: 'link-without-evaluation',
    });
    expect(byName.get('available')).toMatchObject({
      access: 'available-after-instantiation',
      initialization: { kind: 'instantiation', value: 'undefined' },
      mutation: 'mutable',
    });
    expect(byName.get('ready')).toMatchObject({
      access: 'available-after-instantiation',
      initialization: { kind: 'instantiation', value: 'function' },
      mutation: 'mutable',
    });
    expect(byName.get('empty')).toMatchObject({
      access: 'available-after-instantiation',
      initialization: { kind: 'instantiation', value: 'undefined' },
    });
    const emptyDeclarationIndex = dependency.declarations.findIndex(
      (declaration) =>
        declaration.kind === 'variable' && 'binding' in declaration && declaration.binding.name === 'empty',
    );
    expect(dependencyPlan.steps.some((step) => step.path[1] === emptyDeclarationIndex)).toBe(false);
    expect(byName.get('temporal')).toMatchObject({
      access: 'temporal-until-evaluation',
      initialization: { kind: 'evaluation', step: 1 },
      mutation: 'mutable',
    });
    expect(byName.get('fixed')).toMatchObject({
      access: 'temporal-until-evaluation',
      initialization: { kind: 'evaluation', step: 2 },
      mutation: 'immutable',
    });
    expect(byName.get('Later')).toMatchObject({
      access: 'temporal-until-evaluation',
      initialization: { kind: 'evaluation', step: 3 },
      mutation: 'mutable',
    });
    expect(byName.get('Choice')).toMatchObject({
      access: 'available-after-instantiation',
      initialization: { kind: 'instantiation', value: 'undefined' },
      mutation: 'mutable',
    });
    expect(byName.get('left')?.initialization).toEqual({ kind: 'evaluation', step: 5 });
    expect(byName.get('right')?.initialization).toEqual({ kind: 'evaluation', step: 5 });
    expect(byName.get('objectValue')?.initialization).toEqual({ kind: 'evaluation', step: 6 });
    expect(byName.get('remaining')?.initialization).toEqual({ kind: 'evaluation', step: 6 });
    expect(dependencyPlan.steps.map((step) => [step.action, step.declaration])).toEqual([
      ['assign', 'variable'],
      ['initialize', 'variable'],
      ['initialize', 'variable'],
      ['initialize', 'class'],
      ['assign', 'enum'],
      ['initialize', 'variable'],
      ['initialize', 'variable'],
      ['initialize', 'variable'],
      ['initialize', 'variable'],
    ]);
    expect(entryPlan.bindings.filter((binding) => binding.kind === 'import')).toEqual([
      expect.objectContaining({
        access: 'dependency-live',
        initialization: expect.objectContaining({
          imported: 'available',
          module: expect.objectContaining({ source: dependency.source }),
        }),
        mutation: 'read-only',
      }),
      expect.objectContaining({
        access: 'dependency-live',
        initialization: expect.objectContaining({
          imported: 'temporal',
          module: expect.objectContaining({ source: dependency.source }),
        }),
        mutation: 'read-only',
      }),
    ]);
    expect(input).toEqual(snapshot);
    expect(isDeeplyFrozen(plan, new WeakSet())).toBe(true);
  });

  it('orders dependency-first cycle groups from explicit entry and request order', () => {
    const first = lowerModule('first.ts', "import { second } from './second.js'; export const first = second;");
    const second = lowerModule('second.ts', "import { first } from './first.js'; export const second = first;");
    const root = lowerModule(
      'root.ts',
      "import './unrelated.js'; import './first.js'; export { first } from './first.js';",
    );
    const unrelated = lowerModule('unrelated.ts', 'export const unrelated = 1;');
    const dependencies = [
      createDependency(root, './unrelated.js', unrelated),
      createDependency(root, './first.js', first),
      createDependency(first, './second.js', second),
      createDependency(second, './first.js', first),
    ];
    const plan = createCompilerModuleEvaluationPlan(
      createInput([root, unrelated, second, first], dependencies, [root]),
    );
    const permuted = createCompilerModuleEvaluationPlan(
      createInput([first, root, second, unrelated], dependencies, [root]),
    );

    expect(plan).toEqual(permuted);
    expect(plan.groups).toEqual([
      { cyclic: false, modules: [getModuleIdentity(unrelated)] },
      { cyclic: true, modules: [getModuleIdentity(second), getModuleIdentity(first)] },
      { cyclic: false, modules: [getModuleIdentity(root)] },
    ]);

    const self = lowerModule('self.ts', "import './self.js'; export const value = 1;");
    expect(
      createCompilerModuleEvaluationPlan(createInput([self], [createDependency(self, './self.js', self)], [self]))
        .groups,
    ).toEqual([{ cyclic: true, modules: [getModuleIdentity(self)] }]);
  });

  it('links type-only requests without evaluating them and supports side effects or expression-only plans', () => {
    const sideEffect = lowerModule('side.ts', 'export interface RuntimeShape {} export function register(): void {}');
    const types = lowerModule('types.ts', 'export interface Shape { value: number }');
    const entry = lowerModule(
      'entry.ts',
      "import type { Shape } from './types.js'; import { type RuntimeShape } from './side.js'; import './side.js'; export type Alias = Shape & RuntimeShape;",
    );
    const expression = lowerModule('expression.ts', 'export default 1;');
    const reexport = lowerModule('reexport.ts', "export { register } from './side.js';");
    const typeReexport = lowerModule('type-reexport.ts', "export type { Shape } from './types.js';");

    const plan = createCompilerModuleEvaluationPlan(
      createInput(
        [entry, sideEffect, types],
        [createDependency(entry, './types.js', types), createDependency(entry, './side.js', sideEffect)],
        [entry],
      ),
    );
    const expressionPlan = createCompilerModuleEvaluationPlan(createInput([expression], [], [expression]));
    const reexportPlan = createCompilerModuleEvaluationPlan(
      createInput([reexport, sideEffect], [createDependency(reexport, './side.js', sideEffect)], [reexport]),
    );
    const typeReexportPlan = createCompilerModuleEvaluationPlan(
      createInput(
        [typeReexport, types],
        [createDependency(typeReexport, './types.js', types)],
        [typeReexport],
      ),
    );

    expect(plan.modules.find((module) => module.module.source === entry.source)?.dependencies).toEqual([
      {
        ...createDependency(getModuleIdentity(entry), './types.js', getModuleIdentity(types)),
        evaluation: 'type-only',
      },
      {
        ...createDependency(getModuleIdentity(entry), './side.js', getModuleIdentity(sideEffect)),
        evaluation: 'runtime',
      },
    ]);
    expect(expressionPlan.modules[0]?.steps).toEqual([
      {
        action: 'initialize',
        bindings: [],
        completion: 'abrupt-stops-module-evaluation',
        declaration: 'defaultExpression',
        path: ['exports', 0, 'expression'],
      },
    ]);
    expect(reexportPlan.modules.find((module) => module.module.source === reexport.source)?.dependencies).toEqual([
      {
        ...createDependency(getModuleIdentity(reexport), './side.js', getModuleIdentity(sideEffect)),
        evaluation: 'runtime',
      },
    ]);
    expect(typeReexportPlan.groups).toEqual([{ cyclic: false, modules: [getModuleIdentity(typeReexport)] }]);
    expect(typeReexportPlan.modules.find((module) => module.module.source === typeReexport.source)?.dependencies).toEqual([
      {
        ...createDependency(getModuleIdentity(typeReexport), './types.js', getModuleIdentity(types)),
        evaluation: 'type-only',
      },
    ]);
    expect(createCompilerModuleEvaluationPlan(createInput([], [], []))).toEqual(
      expect.objectContaining({ entries: [], groups: [], modules: [] }),
    );
  });

  it.each([
    ['duplicate-binding', createDuplicateBindingInput],
    ['duplicate-dependency', createDuplicateDependencyInput],
    ['duplicate-entry', createDuplicateEntryInput],
    ['duplicate-module', createDuplicateModuleInput],
    ['invalid-declaration-kind', createInvalidDeclarationKindInput],
    ['invalid-dependency', createInvalidDependencyInput],
    ['invalid-entry', createInvalidEntryInput],
    ['invalid-module', createInvalidModuleInput],
    ['missing-dependency', createMissingDependencyInput],
    ['top-level-await', createTopLevelAwaitInput],
    ['unexpected-dependency', createUnexpectedDependencyInput],
    ['unreachable-module', createUnreachableModuleInput],
    ['unsupported-default-expression-order', createDefaultExpressionOrderInput],
  ] as const)('fails with stable %s identity', (code, createInputValue) => {
    try {
      createCompilerModuleEvaluationPlan(createInputValue());
      expect.unreachable(`Expected ${code}`);
    } catch (error) {
      expect(isCompilerModuleEvaluationFailure(error)).toBe(true);
      expect(error).toMatchObject({ code, kind: 'compiler-module-evaluation', name: 'CompilerModuleEvaluationError' });
    }
  });

  it('fails loudly for malformed arrays, edges, module shapes, mutability, and duplicate default expressions', () => {
    const module = lowerModule('entry.ts', 'export const value = 1;');
    const importing = lowerModule('importing.ts', "import './entry.js';");
    const missing = { ...getModuleIdentity(module), source: 'missing.ts' };
    const malformedImports = { ...module, imports: undefined } as never;
    const malformedExports = { ...module, exports: undefined } as never;
    const malformedDeclarations = { ...module, declarations: undefined } as never;
    const mutableConst = structuredClone(module);
    Object.assign(mutableConst.declarations[0]!, { mutable: true });
    const duplicateDefault = lowerModule('default.ts', 'export default 1; export default 2;');
    const invalidInputs: readonly [CompilerModuleEvaluationInput, string][] = [
      [null as never, 'invalid-module'],
      [1 as never, 'invalid-module'],
      [{ dependencies: [], entries: [], modules: {} } as never, 'invalid-module'],
      [{ dependencies: null, entries: [], modules: [] } as never, 'invalid-dependency'],
      [{ dependencies: [], entries: null, modules: [] } as never, 'invalid-entry'],
      [createInput([module], [null as never], [module]), 'invalid-dependency'],
      [
        createInput([module], [{ importer: module, specifier: 1 as never, target: module }], [module]),
        'invalid-dependency',
      ],
      [createInput([module], [{ importer: module, specifier: '', target: module }], [module]), 'invalid-dependency'],
      [
        createInput([importing, module], [createDependency(importing, './entry.js', missing)], [importing]),
        'invalid-dependency',
      ],
      [createInput([module], [createDependency(missing, './entry.js', module)], [module]), 'invalid-dependency'],
      [createInput([malformedImports], [], [malformedImports]), 'invalid-module'],
      [createInput([malformedExports], [], [malformedExports]), 'invalid-module'],
      [createInput([malformedDeclarations], [], [malformedDeclarations]), 'invalid-module'],
      [createInput([mutableConst], [], [mutableConst]), 'invalid-declaration-kind'],
      [createInput([duplicateDefault], [], [duplicateDefault]), 'invalid-module'],
    ];

    for (const [input, code] of invalidInputs) {
      expect(() => createCompilerModuleEvaluationPlan(input)).toThrow(
        expect.objectContaining({ code, kind: 'compiler-module-evaluation' }),
      );
    }
  });

  it('refuses top-level await in default exports and static fields but not inside function or instance-field closures', () => {
    const defaultAwait = lowerModule('default-await.ts', 'export default await Promise.resolve(1);');
    const staticAwait = lowerModule(
      'static-await.ts',
      'export class StaticValue { static value = await Promise.resolve(1); }',
    );
    const nested = lowerModule(
      'nested-await.ts',
      `
        export async function read(): Promise<number> { return await Promise.resolve(1); }
        export class InstanceValue {
          static marker = 1;
          value = async (): Promise<number> => await Promise.resolve(2);
          async read(): Promise<number> { return await Promise.resolve(3); }
        }
      `,
    );

    expect(() => createCompilerModuleEvaluationPlan(createInput([defaultAwait], [], [defaultAwait]))).toThrow(
      expect.objectContaining({ code: 'top-level-await' }),
    );
    expect(() => createCompilerModuleEvaluationPlan(createInput([staticAwait], [], [staticAwait]))).toThrow(
      expect.objectContaining({ code: 'top-level-await' }),
    );
    expect(() => createCompilerModuleEvaluationPlan(createInput([nested], [], [nested]))).not.toThrow();
  });
});

describe('isCompilerModuleEvaluationFailure', () => {
  it('recognizes exact failures and rejects malformed lookalikes', () => {
    let failure: CompilerModuleEvaluationFailure | undefined;
    try {
      createCompilerModuleEvaluationPlan(createMissingDependencyInput());
    } catch (error) {
      if (isCompilerModuleEvaluationFailure(error)) failure = error;
    }
    if (!failure) throw new Error('Expected module evaluation failure');
    const exact = {
      code: failure.code,
      kind: failure.kind,
      module: failure.module,
      subject: failure.subject,
    };

    expect(isCompilerModuleEvaluationFailure(failure)).toBe(true);
    expect(
      isCompilerModuleEvaluationFailure(
        Object.assign(new Error('exact without module'), {
          code: 'invalid-module',
          kind: 'compiler-module-evaluation',
          subject: 'modules',
        }),
      ),
    ).toBe(true);
    const module = failure.module!;
    for (const invalidModule of [
      { ...module, name: '' },
      { ...module, packageName: '' },
      { ...module, source: '' },
      undefined,
    ]) {
      expect(
        isCompilerModuleEvaluationFailure(Object.assign(new Error('invalid module'), exact, { module: invalidModule })),
      ).toBe(invalidModule === undefined);
    }
    expect(isCompilerModuleEvaluationFailure(new Error('ordinary'))).toBe(false);
    expect(isCompilerModuleEvaluationFailure(Object.assign(new Error('lookalike'), exact, { code: 'unknown' }))).toBe(
      false,
    );
    expect(isCompilerModuleEvaluationFailure(Object.assign(new Error('lookalike'), exact, { subject: '' }))).toBe(
      false,
    );
    expect(isCompilerModuleEvaluationFailure(Object.assign(new Error('lookalike'), exact, { module: null }))).toBe(
      false,
    );
  });
});

function createDefaultExpressionOrderInput(): CompilerModuleEvaluationInput {
  const module = lowerModule('default-order.ts', 'const value = 1; export default value;');
  return createInput([module], [], [module]);
}

function createDependency(
  importer: Readonly<CompilerModuleIdentity>,
  specifier: string,
  target: Readonly<CompilerModuleIdentity>,
): CompilerModuleLinkDependency {
  return { importer, specifier, target };
}

function createDuplicateBindingInput(): CompilerModuleEvaluationInput {
  const module = lowerModule('duplicate-binding.ts', 'const value = 1;');
  (module as { declarations: IrModule['declarations'] }).declarations = [
    module.declarations[0]!,
    module.declarations[0]!,
  ];
  return createInput([module], [], [module]);
}

function createDuplicateDependencyInput(): CompilerModuleEvaluationInput {
  const dependency = lowerModule('dependency.ts', 'export const value = 1;');
  const entry = lowerModule('entry.ts', "import './dependency.js';");
  const edge = createDependency(entry, './dependency.js', dependency);
  return createInput([entry, dependency], [edge, edge], [entry]);
}

function createDuplicateEntryInput(): CompilerModuleEvaluationInput {
  const module = lowerModule('entry.ts', 'export const value = 1;');
  return createInput([module], [], [module, module]);
}

function createDuplicateModuleInput(): CompilerModuleEvaluationInput {
  const module = lowerModule('entry.ts', 'export const value = 1;');
  return createInput([module, module], [], [module]);
}

function createInput(
  modules: readonly Readonly<IrModule>[],
  dependencies: readonly Readonly<CompilerModuleLinkDependency>[],
  entries: readonly Readonly<CompilerModuleIdentity>[],
): CompilerModuleEvaluationInput {
  return { dependencies, entries, modules };
}

function createInvalidDeclarationKindInput(): CompilerModuleEvaluationInput {
  const module = lowerModule('invalid-kind.ts', 'const value = 1;');
  Object.assign(module.declarations[0]!, { declarationKind: 'using' });
  return createInput([module], [], [module]);
}

function createInvalidDependencyInput(): CompilerModuleEvaluationInput {
  const module = lowerModule('entry.ts', "import './missing.js';");
  return createInput(
    [module],
    [{ importer: module, specifier: './missing.js', target: { ...module, source: '' } }],
    [module],
  );
}

function createInvalidEntryInput(): CompilerModuleEvaluationInput {
  const module = lowerModule('entry.ts', 'export const value = 1;');
  return createInput([module], [], [{ ...module, source: 'missing.ts' }]);
}

function createInvalidModuleInput(): CompilerModuleEvaluationInput {
  const module = lowerModule('entry.ts', 'export const value = 1;');
  return createInput([{ ...module, name: '' }], [], []);
}

function createMissingDependencyInput(): CompilerModuleEvaluationInput {
  const module = lowerModule('entry.ts', "import './missing.js';");
  return createInput([module], [], [module]);
}

function createTopLevelAwaitInput(): CompilerModuleEvaluationInput {
  const module = lowerModule('await.ts', 'export const value = await Promise.resolve(1);');
  return createInput([module], [], [module]);
}

function createUnexpectedDependencyInput(): CompilerModuleEvaluationInput {
  const entry = lowerModule('entry.ts', 'export const value = 1;');
  const dependency = lowerModule('dependency.ts', 'export const value = 2;');
  return createInput([entry, dependency], [createDependency(entry, './dependency.js', dependency)], [entry]);
}

function createUnreachableModuleInput(): CompilerModuleEvaluationInput {
  const entry = lowerModule('entry.ts', 'export const value = 1;');
  const second = lowerModule('second-unreachable.ts', 'export const value = 2;');
  const first = lowerModule('first-unreachable.ts', 'export const value = 3;');
  return createInput([entry, second, first], [], [entry]);
}

function isDeeplyFrozen(value: unknown, seen: WeakSet<object>): boolean {
  if (!value || typeof value !== 'object' || seen.has(value)) return true;
  seen.add(value);
  return Object.isFrozen(value) && Object.values(value).every((child) => isDeeplyFrozen(child, seen));
}

function getModuleIdentity(module: Readonly<IrModule>): CompilerModuleIdentity {
  return { name: module.name, packageName: module.packageName, source: module.source };
}

function lowerModule(file: string, source: string): IrModule {
  return lowerTypeScriptSource(
    ts.createSourceFile(`/flight/packages/module/src/${file}`, source, ts.ScriptTarget.Latest, true),
    { packageName: '@flighthq/module', upstreamDirectory: '/flight' },
  ).module;
}
