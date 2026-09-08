import ts from 'typescript';

import { lowerTypeScriptSource } from '../../compiler-semantic/src/index.js';
import type {
  CompilerModuleEvaluationInput,
  CompilerModuleFacadeFailureCode,
  CompilerModuleIdentity,
  CompilerModuleLinkDependency,
  IrModule,
} from '../../compiler-types/src/index.js';
import { createCompilerModuleEvaluationPlan } from './compilerModuleEvaluation.js';
import { isCompilerModuleFacadeFailure } from './compilerModuleFacadeIdentity.js';
import { createCompilerModuleFacadePlan } from './compilerModuleFacadeLowering.js';

describe('createCompilerModuleFacadePlan', () => {
  it('resolves local, imported, named, namespace, default, and star routes as immutable live slots', () => {
    const origin = lowerModule(
      'origin.ts',
      `
        export const value = 1;
        export const [head, , ...tail] = [1, 2, 3];
        export const [single] = [4];
        export const { value: objectValue, ...remaining } = { value: 1, other: 2 };
        export class Shape {}
        export enum Choice { first }
        export interface Contract { value: number }
        export default function create(): number { return value; }
      `,
    );
    const relay = lowerModule(
      'relay.ts',
      `
        import { value as local } from './origin.js';
        import * as importedNamespace from './origin.js';
        export { local as imported };
        export { importedNamespace };
        export { Shape as Renamed } from './origin.js';
        export type { Contract } from './origin.js';
        export * as namespace from './origin.js';
        export type * as typeNamespace from './origin.js';
        export * from './origin.js';
      `,
    );
    const entry = lowerModule(
      'entry.ts',
      `
        export { imported as publicValue } from './relay.js';
        export * from './relay.js';
      `,
    );
    const input = createInput(
      [entry, relay, origin],
      [createDependency(entry, './relay.js', relay), createDependency(relay, './origin.js', origin)],
      [entry],
    );
    const evaluation = createCompilerModuleEvaluationPlan(input);
    const snapshot = structuredClone({ evaluation, modules: input.modules });

    const plan = createCompilerModuleFacadePlan({ evaluation, modules: input.modules });
    const entryPlan = plan.modules.find((module) => module.module.source === entry.source)!;
    const originPlan = plan.modules.find((module) => module.module.source === origin.source)!;
    const getSlot = (name: string, lane: 'type' | 'value') =>
      entryPlan.slots.find((slot) => slot.exportName === name && slot.lane === lane);

    expect(plan.semantics).toEqual({
      bindingAccess: 'live',
      explicitPrecedence: 'named-over-star',
      starAmbiguity: 'refuse-distinct-resolutions',
      starDefault: 'excluded',
      typeValueLanes: 'independent',
    });
    expect(getSlot('publicValue', 'value')).toMatchObject({
      route: { binding: { name: 'value' }, kind: 'binding', module: { source: origin.source } },
      via: [
        { kind: 'named-reexport', specifier: './relay.js' },
        { kind: 'import', specifier: './origin.js' },
      ],
    });
    expect(getSlot('Renamed', 'value')?.route).toMatchObject({ binding: { name: 'Shape' }, kind: 'binding' });
    expect(getSlot('Renamed', 'type')?.route).toMatchObject({ binding: { name: 'Shape' }, kind: 'binding' });
    expect(getSlot('value', 'type')).toBeUndefined();
    expect(getSlot('Shape', 'type')).toBeDefined();
    expect(getSlot('Choice', 'type')).toBeDefined();
    expect(getSlot('Choice', 'value')).toBeDefined();
    expect(getSlot('Contract', 'type')?.route).toMatchObject({ binding: { name: 'Contract' }, kind: 'binding' });
    expect(getSlot('namespace', 'value')?.route).toEqual({ kind: 'namespace', module: getIdentity(origin) });
    expect(getSlot('importedNamespace', 'value')?.route).toEqual({ kind: 'namespace', module: getIdentity(origin) });
    expect(getSlot('typeNamespace', 'type')?.route).toEqual({ kind: 'namespace', module: getIdentity(origin) });
    for (const name of ['head', 'tail', 'single', 'objectValue', 'remaining']) {
      expect(getSlot(name, 'value')?.route).toMatchObject({ binding: { name }, module: { source: origin.source } });
    }
    expect(getSlot('default', 'value')).toBeUndefined();
    expect(originPlan.slots.find((slot) => slot.exportName === 'default')?.route).toMatchObject({
      binding: { name: 'create' },
      kind: 'binding',
    });
    expect(new Set(entryPlan.slots.map((slot) => slot.identity)).size).toBe(entryPlan.slots.length);
    expect({ evaluation, modules: input.modules }).toEqual(snapshot);
    expect(isDeeplyFrozen(plan, new WeakSet())).toBe(true);
  });

  it('keeps type-only links out of evaluation groups while using them for facade resolution', () => {
    const types = lowerModule('types.ts', 'export interface Shape { value: number }');
    const entry = lowerModule('entry.ts', "import type { Shape } from './types.js'; export type { Shape };");
    const input = createInput([entry, types], [createDependency(entry, './types.js', types)], [entry]);
    const evaluation = createCompilerModuleEvaluationPlan(input);
    const plan = createCompilerModuleFacadePlan({ evaluation, modules: input.modules });

    expect(evaluation.groups).toEqual([{ cyclic: false, modules: [getIdentity(entry)] }]);
    expect(evaluation.modules.find((module) => module.module.source === entry.source)?.dependencies).toEqual([
      { ...createDependency(getIdentity(entry), './types.js', getIdentity(types)), evaluation: 'type-only' },
    ]);
    expect(plan.modules.find((module) => module.module.source === entry.source)?.slots).toEqual([
      expect.objectContaining({
        exportName: 'Shape',
        lane: 'type',
        route: expect.objectContaining({ binding: expect.objectContaining({ name: 'Shape' }), kind: 'binding' }),
      }),
    ]);
  });

  it('resolves a standalone default expression without inventing a star-visible default slot', () => {
    const expression = lowerModule('expression.ts', 'export default 1;');
    const barrel = lowerModule('barrel.ts', "export * from './expression.js';");
    const input = createInput(
      [barrel, expression],
      [createDependency(barrel, './expression.js', expression)],
      [barrel],
    );
    const plan = createCompilerModuleFacadePlan({
      evaluation: createCompilerModuleEvaluationPlan(input),
      modules: input.modules,
    });

    expect(plan.modules.find((module) => module.module.source === expression.source)?.slots).toEqual([
      expect.objectContaining({
        exportName: 'default',
        lane: 'value',
        route: { kind: 'expression', module: getIdentity(expression), path: ['exports', 0, 'expression'] },
        source: { kind: 'local-expression' },
      }),
    ]);
    expect(plan.modules.find((module) => module.module.source === barrel.source)?.slots).toEqual([]);
  });

  it('accepts identical diamond star resolutions, overrides stars explicitly, and refuses distinct ambiguity', () => {
    const origin = lowerModule(
      'origin.ts',
      'export const value = 1; export default function create(): number { return 2; }',
    );
    const left = lowerModule('left.ts', "export * from './origin.js';");
    const right = lowerModule('right.ts', "export * from './origin.js';");
    const diamond = lowerModule('diamond.ts', "export * from './left.js'; export * from './right.js';");
    const explicit = lowerModule('explicit.ts', "const value = 2; export { value }; export * from './origin.js';");
    const other = lowerModule('other.ts', 'export const value = 3;');
    const ambiguous = lowerModule('ambiguous.ts', "export * from './origin.js'; export * from './other.js';");
    const modules = [diamond, left, right, explicit, ambiguous, origin, other];
    const dependencies = [
      createDependency(diamond, './left.js', left),
      createDependency(diamond, './right.js', right),
      createDependency(left, './origin.js', origin),
      createDependency(right, './origin.js', origin),
      createDependency(explicit, './origin.js', origin),
      createDependency(ambiguous, './origin.js', origin),
      createDependency(ambiguous, './other.js', other),
    ];
    const diamondInput = createInput(modules, dependencies, [diamond, explicit, ambiguous]);
    const evaluation = createCompilerModuleEvaluationPlan(diamondInput);
    const withoutAmbiguous = {
      evaluation: createCompilerModuleEvaluationPlan(
        createInput([diamond, left, right, explicit, origin], dependencies.slice(0, 5), [diamond, explicit]),
      ),
      modules: [diamond, left, right, explicit, origin],
    };

    const plan = createCompilerModuleFacadePlan(withoutAmbiguous);
    const diamondSlot = plan.modules
      .find((module) => module.module.source === diamond.source)
      ?.slots.find((slot) => slot.exportName === 'value');
    const explicitSlot = plan.modules
      .find((module) => module.module.source === explicit.source)
      ?.slots.find((slot) => slot.exportName === 'value');

    expect(diamondSlot?.route).toMatchObject({ binding: { name: 'value' }, module: { source: origin.source } });
    expect(explicitSlot?.route).toMatchObject({ binding: { name: 'value' }, module: { source: explicit.source } });
    expect(
      plan.modules
        .find((module) => module.module.source === diamond.source)
        ?.slots.some((slot) => slot.exportName === 'default'),
    ).toBe(false);
    expect(() => createCompilerModuleFacadePlan({ evaluation, modules })).toThrow(
      expect.objectContaining({ code: 'ambiguous-facade-star', kind: 'compiler-module-facade' }),
    );
  });

  it('resolves star cycles with an eventual local binding and refuses empty named re-export cycles', () => {
    const first = lowerModule('first.ts', "export * from './second.js';");
    const second = lowerModule('second.ts', "export * from './first.js'; export const value = 1;");
    const cyclic = createInput(
      [first, second],
      [createDependency(first, './second.js', second), createDependency(second, './first.js', first)],
      [first],
    );
    const cyclicPlan = createCompilerModuleFacadePlan({
      evaluation: createCompilerModuleEvaluationPlan(cyclic),
      modules: cyclic.modules,
    });
    expect(
      cyclicPlan.modules
        .find((module) => module.module.source === first.source)
        ?.slots.find((slot) => slot.exportName === 'value'),
    ).toMatchObject({ route: { binding: { name: 'value' }, module: { source: second.source } } });

    const namedFirst = lowerModule('named-first.ts', "export { value } from './named-second.js';");
    const namedSecond = lowerModule('named-second.ts', "export { value } from './named-first.js';");
    const named = createInput(
      [namedFirst, namedSecond],
      [
        createDependency(namedFirst, './named-second.js', namedSecond),
        createDependency(namedSecond, './named-first.js', namedFirst),
      ],
      [namedFirst],
    );
    expect(() =>
      createCompilerModuleFacadePlan({
        evaluation: createCompilerModuleEvaluationPlan(named),
        modules: named.modules,
      }),
    ).toThrow(expect.objectContaining({ code: 'missing-facade-export', kind: 'compiler-module-facade' }));
  });

  it('rejects two explicit type-lane routes even when their value-lane syntax identities differ', () => {
    const valueType = lowerModule('value-type.ts', 'export class Shape {}');
    const typeOnly = lowerModule('type-only.ts', 'export interface Shape {}');
    const entry = lowerModule(
      'entry.ts',
      `
        export { Shape as Merged } from './value-type.js';
        export type { Shape as Merged } from './type-only.js';
      `,
    );
    const input = createInput(
      [entry, valueType, typeOnly],
      [createDependency(entry, './value-type.js', valueType), createDependency(entry, './type-only.js', typeOnly)],
      [entry],
    );

    expect(() =>
      createCompilerModuleFacadePlan({
        evaluation: createCompilerModuleEvaluationPlan(input),
        modules: input.modules,
      }),
    ).toThrow(expect.objectContaining({ code: 'duplicate-facade-identity' }));
  });

  it.each([
    ['invalid-facade-evaluation', createInvalidEvaluationInput],
    ['invalid-facade-module', createInvalidModuleInput],
    ['mismatched-facade-module', createMismatchedModuleInput],
    ['missing-facade-binding', createMissingBindingInput],
    ['missing-facade-dependency', createMissingDependencyInput],
    ['missing-facade-export', createMissingExportInput],
  ] as const)('fails with stable %s identity', (code, createFailureInput) => {
    expect(() => createCompilerModuleFacadePlan(createFailureInput())).toThrow(
      expect.objectContaining({ code, kind: 'compiler-module-facade', name: 'CompilerModuleFacadeError' }),
    );
  });

  it('rejects duplicate and malformed evaluation dependency records', () => {
    const target = lowerModule('target.ts', 'export const value = 1;');
    const entry = lowerModule('entry.ts', "export { value } from './target.js';");
    const input = createInput([entry, target], [createDependency(entry, './target.js', target)], [entry]);
    const evaluation = structuredClone(createCompilerModuleEvaluationPlan(input));
    const entryPlan = evaluation.modules.find((module) => module.module.source === entry.source)!;
    const dependency = entryPlan.dependencies[0]!;
    const invalidDependencies = [
      [dependency, dependency],
      [{ ...dependency, importer: target }],
      [{ ...dependency, evaluation: 'sometimes' }],
      [{ ...dependency, evaluation: 'type-only' }],
      [{ ...dependency, specifier: '' }],
      [{ ...dependency, specifier: 1 }],
      [{ ...dependency, specifier: './extra.js' }],
      [dependency, { ...dependency, evaluation: 'type-only', specifier: './extra.js' }],
      [{ ...dependency, target: { ...target, source: 'absent.ts' } }],
    ];

    for (const dependencies of invalidDependencies) {
      const malformed = structuredClone(evaluation);
      Object.assign(malformed.modules.find((module) => module.module.source === entry.source)!, { dependencies });
      expect(() => createCompilerModuleFacadePlan({ evaluation: malformed, modules: input.modules })).toThrow(
        expect.objectContaining({ kind: 'compiler-module-facade' }),
      );
    }
    for (const specifier of ['', 1]) {
      const malformed = structuredClone(evaluation);
      Object.assign(malformed.modules.find((module) => module.module.source === entry.source)!, {
        dependencies: [{ ...dependency, specifier }],
      });
      expect(() => createCompilerModuleFacadePlan({ evaluation: malformed, modules: input.modules })).toThrow(
        expect.objectContaining({ subject: expect.stringMatching(/:dependencies$/u) }),
      );
    }
  });

  it('rejects malformed module sets and evaluation module records at the facade boundary', () => {
    const module = lowerModule('entry.ts', 'export const value = 1;');
    const evaluation = createCompilerModuleEvaluationPlan(createInput([module], [], [module]));
    const malformedArrays = ['declarations', 'exports', 'imports'] as const;

    expect(() => createCompilerModuleFacadePlan(null as never)).toThrow(
      expect.objectContaining({ code: 'invalid-facade-module' }),
    );
    expect(() => createCompilerModuleFacadePlan({ evaluation: {} as never, modules: [] })).toThrow(
      expect.objectContaining({ code: 'invalid-facade-evaluation' }),
    );
    expect(() => createCompilerModuleFacadePlan({ evaluation: 1 as never, modules: [] })).toThrow(
      expect.objectContaining({ code: 'invalid-facade-evaluation' }),
    );
    expect(() =>
      createCompilerModuleFacadePlan({
        evaluation: { ...evaluation, modules: null } as never,
        modules: [module],
      }),
    ).toThrow(expect.objectContaining({ code: 'invalid-facade-evaluation' }));
    expect(() => createCompilerModuleFacadePlan({ evaluation, modules: [module, module] })).toThrow(
      expect.objectContaining({ code: 'invalid-facade-module' }),
    );
    for (const field of malformedArrays) {
      expect(() =>
        createCompilerModuleFacadePlan({
          evaluation,
          modules: [{ ...module, [field]: null } as never],
        }),
      ).toThrow(expect.objectContaining({ code: 'invalid-facade-module' }));
    }
    for (const malformedIdentity of [
      null,
      1,
      {},
      { packageName: module.packageName, source: module.source },
      { ...module, name: undefined },
      { ...module, name: '' },
      { name: module.name, source: module.source },
      { ...module, packageName: undefined },
      { ...module, packageName: '' },
      { name: module.name, packageName: module.packageName },
      { ...module, source: undefined },
      { ...module, source: '' },
    ]) {
      expect(() => createCompilerModuleFacadePlan({ evaluation, modules: [malformedIdentity as never] })).toThrow(
        'Module facade identity is malformed at modules[0]',
      );
    }
    const malformedEvaluation = structuredClone(evaluation);
    Object.assign(malformedEvaluation, { modules: [null] });
    expect(() => createCompilerModuleFacadePlan({ evaluation: malformedEvaluation, modules: [module] })).toThrow(
      expect.objectContaining({ code: 'invalid-facade-evaluation' }),
    );
    const omitted = createCompilerModuleEvaluationPlan({ dependencies: [], entries: [], modules: [] });
    expect(() => createCompilerModuleFacadePlan({ evaluation: omitted, modules: [module] })).toThrow(
      expect.objectContaining({ code: 'mismatched-facade-module', subject: expect.stringContaining('entry.ts') }),
    );
    for (const malformedModulePlan of [1, { dependencies: null }]) {
      const malformed = structuredClone(evaluation);
      Object.assign(malformed, { modules: [malformedModulePlan] });
      expect(() => createCompilerModuleFacadePlan({ evaluation: malformed as never, modules: [module] })).toThrow(
        expect.objectContaining({ code: 'invalid-facade-evaluation' }),
      );
    }
  });

  it('rejects duplicate import introductions before selecting a local import route', () => {
    const target = lowerModule('target.ts', 'export const value = 1;');
    const entry = lowerModule('entry.ts', "import { value } from './target.js'; export { value };");
    const input = createInput([entry, target], [createDependency(entry, './target.js', target)], [entry]);
    const malformed = structuredClone(entry);
    (malformed as { imports: IrModule['imports'] }).imports = [
      ...malformed.imports,
      structuredClone(malformed.imports[0]!),
    ];

    expect(() =>
      createCompilerModuleFacadePlan({
        evaluation: createCompilerModuleEvaluationPlan(input),
        modules: [malformed, target],
      }),
    ).toThrow(expect.objectContaining({ code: 'missing-facade-binding' }));
  });

  it('requires the complete local binding identity rather than accepting an id-only match', () => {
    const module = lowerModule('entry.ts', 'const value = 1; export { value };');
    const malformed = structuredClone(module);
    const exported = malformed.exports[0];
    if (exported?.kind !== 'local') throw new Error('Expected local export');
    Object.assign(exported, { binding: { ...exported.binding, name: 'other' }, exported: 'other' });

    expect(() =>
      createCompilerModuleFacadePlan({
        evaluation: createCompilerModuleEvaluationPlan(createInput([module], [], [module])),
        modules: [malformed],
      }),
    ).toThrow(expect.objectContaining({ code: 'missing-facade-binding' }));
  });
});

function createDependency(
  importer: Readonly<CompilerModuleIdentity>,
  specifier: string,
  target: Readonly<CompilerModuleIdentity>,
): CompilerModuleLinkDependency {
  return { importer, specifier, target };
}

function createInput(
  modules: readonly Readonly<IrModule>[],
  dependencies: readonly Readonly<CompilerModuleLinkDependency>[],
  entries: readonly Readonly<CompilerModuleIdentity>[],
): CompilerModuleEvaluationInput {
  return { dependencies, entries, modules };
}

function createInvalidEvaluationInput() {
  return { evaluation: null as never, modules: [] };
}

function createInvalidModuleInput() {
  return {
    evaluation: createCompilerModuleEvaluationPlan({ dependencies: [], entries: [], modules: [] }),
    modules: null as never,
  };
}

function createMismatchedModuleInput() {
  const module = lowerModule('entry.ts', 'export const value = 1;');
  return {
    evaluation: createCompilerModuleEvaluationPlan(createInput([module], [], [module])),
    modules: [{ ...module, source: 'other.ts' }],
  };
}

function createMissingBindingInput() {
  const module = lowerModule('entry.ts', 'const value = 1; export { value };');
  const malformed = structuredClone(module);
  const exported = malformed.exports[0];
  if (exported?.kind !== 'local') throw new Error('Expected local export');
  Object.assign(exported, { binding: { ...exported.binding, id: 'binding:missing' } });
  return {
    evaluation: createCompilerModuleEvaluationPlan(createInput([module], [], [module])),
    modules: [malformed],
  };
}

function createMissingDependencyInput() {
  const target = lowerModule('target.ts', 'export const value = 1;');
  const entry = lowerModule('entry.ts', "export { value } from './target.js';");
  const input = createInput([entry, target], [createDependency(entry, './target.js', target)], [entry]);
  const evaluation = structuredClone(createCompilerModuleEvaluationPlan(input));
  Object.assign(evaluation.modules.find((module) => module.module.source === entry.source)!, { dependencies: [] });
  return { evaluation, modules: input.modules };
}

function createMissingExportInput() {
  const target = lowerModule('target.ts', 'export const other = 1;');
  const entry = lowerModule('entry.ts', "export { value } from './target.js';");
  const input = createInput([entry, target], [createDependency(entry, './target.js', target)], [entry]);
  return { evaluation: createCompilerModuleEvaluationPlan(input), modules: input.modules };
}

function getIdentity(module: Readonly<IrModule>): CompilerModuleIdentity {
  return { name: module.name, packageName: module.packageName, source: module.source };
}

function isDeeplyFrozen(value: unknown, seen: WeakSet<object>): boolean {
  if (!value || typeof value !== 'object' || seen.has(value)) return true;
  seen.add(value);
  return Object.isFrozen(value) && Object.values(value).every((child) => isDeeplyFrozen(child, seen));
}

function lowerModule(fileName: string, source: string): IrModule {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const lowered = lowerTypeScriptSource(sourceFile, {
    packageName: '@flighthq/module-tests',
    upstreamDirectory: '.',
  });
  if (lowered.diagnostics.length > 0) throw new Error(lowered.diagnostics.map((item) => item.message).join('\n'));
  return lowered.module;
}
