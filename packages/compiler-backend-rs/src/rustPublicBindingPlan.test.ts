import ts from 'typescript';

import { lowerTypeScriptSource } from '../../compiler-semantic/src/index.js';
import type {
  CompilerModuleFacadePlan,
  CompilerModuleFacadeSlot,
  CompilerModuleIdentity,
  CompilerRustModuleEvaluationExecutionPlan,
  CompilerRustModuleEvaluationRepresentationRefusal,
  CompilerRustPublicBindingPlan,
  CompilerRustPublicBindingPlanInput,
  CompilerRustPublicBindingPlanInputV3,
  CompilerRustPublicBindingPlanningFailureCode,
  CompilerRustPublicCrateIdentity,
  IrModule,
} from '../../compiler-types/src/index.js';
import {
  createCompilerRustPublicBindingPlan,
  createCompilerRustPublicBindingPlanV3,
  isCompilerRustPublicBindingPlanningFailure,
} from './rustPublicBindingPlan.js';

describe('createCompilerRustPublicBindingPlan', () => {
  it('plans scoped crates, directory-preserving modules, facade dependencies, and public bindings deterministically', () => {
    const widget = lower(
      '@alpha/model',
      'packages/model/src/geometry/widget.ts',
      `
        export interface Widget { value: number }
        export function makeWidget(value: number): Widget { return { value }; }
      `,
    );
    const widgetState = lower(
      '@alpha/model',
      'packages/model/src/state/src/widget.ts',
      'export interface WidgetState { active: boolean }',
    );
    const status = lower('@beta/model', 'packages/model/src/state/status.ts', 'export const status = 1;');
    const entry = lower('@scope/api', 'packages/api/src/public/contract.ts', 'export const localStatus = 2;');
    const facade = createFacade(entry, [
      bindingSlot(entry, widget, 'PublicWidget', 'Widget', 'type'),
      bindingSlot(entry, widget, 'makeWidget', 'makeWidget', 'value'),
      bindingSlot(entry, widgetState, 'WidgetState', 'WidgetState', 'type'),
      bindingSlot(entry, status, 'status', 'status', 'value'),
      localSlot(entry, 'localStatus', 'value'),
      namespaceSlot(entry, widget, 'geometry'),
    ]);
    const modules = [entry, status, widgetState, widget];
    const input = { facade, modules } as const;
    const snapshot = structuredClone(input);

    const first = createCompilerRustPublicBindingPlan(input);
    const second = createCompilerRustPublicBindingPlan({
      facade: {
        ...facade,
        modules: [...facade.modules].reverse().map((module) => ({ ...module, slots: [...module.slots].reverse() })),
      },
      modules: [...modules].reverse(),
    });
    const available = (facadeIdentity: string) => {
      const result = first.bindings.find((binding) => binding.facadeIdentity === facadeIdentity)?.binding;
      if (result?.availability !== 'available') throw new Error(`Expected available binding ${facadeIdentity}`);
      return result.locator;
    };

    expect(first.schema).toBe('flight-rust-public-binding-plan/2');
    expect(second).toEqual(first);
    expect(input).toEqual(snapshot);
    expect(isDeeplyFrozen(first, new WeakSet())).toBe(true);
    expect(first.crates).toEqual([
      { cargoName: 'alpha-model', packageName: '@alpha/model', rustName: 'alpha_model' },
      { cargoName: 'beta-model', packageName: '@beta/model', rustName: 'beta_model' },
      { cargoName: 'scope-api', packageName: '@scope/api', rustName: 'scope_api' },
    ]);
    expect(first.modules.map((module) => [module.identity.packageName, module.locator.modulePath])).toEqual([
      ['@alpha/model', ['geometry', 'widget']],
      ['@alpha/model', ['state', 'src', 'widget']],
      ['@beta/model', ['state', 'status']],
      ['@scope/api', ['public', 'contract']],
    ]);
    expect(first.dependencies).toHaveLength(4);
    expect(first.dependencies.map((edge) => edge.target.modulePath)).toEqual([
      ['geometry', 'widget'],
      ['state', 'src', 'widget'],
      ['state', 'status'],
      ['geometry', 'widget'],
    ]);
    expect(first.dependencies.find((edge) => edge.kind === 'namespace-reexport')).toMatchObject({
      from: { crate: { cargoName: 'scope-api' }, modulePath: ['public', 'contract'] },
      specifier: '@alpha/model',
      target: { crate: { cargoName: 'alpha-model' }, modulePath: ['geometry', 'widget'] },
    });
    expect(available('fixture:type:PublicWidget')).toMatchObject({
      carrier: 'interface',
      module: { crate: { cargoName: 'scope-api' }, modulePath: ['public', 'contract'] },
      spelling: 'PublicWidget',
    });
    expect(available('fixture:value:makeWidget')).toMatchObject({ carrier: 'function', spelling: 'make_widget' });
    expect(available('fixture:value:status')).toMatchObject({ carrier: 'value', spelling: 'status' });
    expect(available('fixture:value:localStatus')).toMatchObject({ carrier: 'value', spelling: 'LOCAL_STATUS' });
    expect(available('fixture:value:geometry')).toMatchObject({
      carrier: 'module',
      module: { crate: { cargoName: 'scope-api' }, modulePath: ['public', 'contract'] },
      spelling: 'geometry',
      target: { crate: { cargoName: 'alpha-model' }, modulePath: ['geometry', 'widget'] },
    });
    expect(first.bindings.map((binding) => binding.key)).toEqual(
      [...first.bindings.map((binding) => binding.key)].sort(),
    );

    const refused = createCompilerRustPublicBindingPlan({
      ...input,
      refusals: [{ code: 'rust-test-refusal', message: 'widget carrier unavailable', module: identity(widget) }],
    });
    expect(
      refused.bindings.find((binding) => binding.facadeIdentity === 'fixture:type:PublicWidget')?.binding,
    ).toMatchObject({
      availability: 'refused',
      refusal: { code: 'rust-module-refused', detailCode: 'rust-test-refusal' },
    });

    const missing = createCompilerRustPublicBindingPlan({ facade, modules: [entry] });
    expect(
      missing.bindings.find((binding) => binding.facadeIdentity === 'fixture:type:PublicWidget')?.binding,
    ).toMatchObject({ availability: 'refused', refusal: { code: 'rust-declaration-missing' } });
    expect(
      missing.bindings.find((binding) => binding.facadeIdentity === 'fixture:value:geometry')?.binding,
    ).toMatchObject({ availability: 'refused', refusal: { code: 'rust-module-missing' } });
  });

  it('fails loudly when package or source normalization aliases distinct Rust locators', () => {
    const firstScope = lower('@scope-a/model', 'packages/first/src/value.ts', 'export const first = 1;');
    const secondScope = lower('@scope_a/model', 'packages/second/src/value.ts', 'export const second = 2;');
    expectPlanningFailure(
      { facade: createFacade(firstScope, []), modules: [firstScope, secondScope] },
      'rust-public-crate-collision',
    );

    const dashed = lower('@scope/model', 'packages/model/src/values/foo-bar.ts', 'export const first = 1;');
    const underscored = lower('@scope/model', 'packages/model/src/values/foo_bar.ts', 'export const second = 2;');
    expectPlanningFailure(
      { facade: createFacade(dashed, []), modules: [dashed, underscored] },
      'rust-public-module-collision',
    );

    const moduleFile = lower('@scope/model', 'packages/model/src/values.ts', 'export const file = 1;');
    const moduleDirectory = lower('@scope/model', 'packages/model/src/values/index.ts', 'export const directory = 2;');
    expectPlanningFailure(
      {
        facade: createFacade(moduleFile, []),
        modules: [moduleFile, moduleDirectory],
      },
      'rust-public-module-collision',
    );
  });

  it('plans root indexes, nested indexes, and nested modules deterministically', () => {
    const root = lower('@scope/model', 'packages/model/src/index.ts', 'export const root = 1;');
    const nestedIndex = lower('@scope/model', 'packages/model/src/geometry/index.ts', 'export const nested = 2;');
    const nestedModule = lower('@scope/model', 'packages/model/src/geometry/lineSegment.ts', 'export const line = 3;');
    const modules = [nestedModule, root, nestedIndex];
    const first = createCompilerRustPublicBindingPlan({
      facade: createFacade(root, []),
      modules,
    });
    const second = createCompilerRustPublicBindingPlan({
      facade: createFacade(root, []),
      modules: [...modules].reverse(),
    });

    expect(second).toEqual(first);
    expect(first.modules.map((module) => [module.identity.source, module.locator.modulePath])).toEqual([
      ['packages/model/src/geometry/index.ts', ['geometry']],
      ['packages/model/src/geometry/lineSegment.ts', ['geometry', 'line_segment']],
      ['packages/model/src/index.ts', []],
    ]);
  });

  it('spells an imported local export with the facade module allocation', () => {
    const entry = lower(
      '@scope/api',
      'packages/api/src/contract.ts',
      "import { F0 } from '@scope/model';\nexport const f0: F0 = new F0();\nexport { F0 as PublicF0 };",
    );
    const provider = lower('@scope/model', 'packages/model/src/index.ts', 'export class F0 { value: number = 0; }');
    const imported = entry.imports[0]?.bindings[0]?.binding;
    const declaration = provider.declarations.find(
      (candidate) => 'binding' in candidate && candidate.binding.name === 'F0',
    );
    if (!imported || !declaration || !('binding' in declaration)) throw new Error('Missing F0 bindings');
    const importedSlot = (lane: 'type' | 'value'): CompilerModuleFacadeSlot => ({
      exportName: 'PublicF0',
      identity: `fixture:${lane}:PublicF0`,
      lane,
      module: identity(entry),
      route: { binding: declaration.binding, kind: 'binding', module: identity(provider) },
      source: { bindingId: imported.id, kind: 'local-binding' },
      via: [
        {
          kind: 'import',
          module: identity(entry),
          specifier: '@scope/model',
          target: identity(provider),
        },
      ],
    });
    const plan = createCompilerRustPublicBindingPlan({
      facade: createFacade(entry, [importedSlot('type'), importedSlot('value')]),
      modules: [entry, provider],
    });
    const locators = plan.bindings.map((binding) => {
      if (binding.binding.availability !== 'available') throw new Error('Expected available PublicF0 binding');
      return binding.binding.locator;
    });

    expect(locators).toEqual([
      expect.objectContaining({ carrier: 'class', spelling: 'F0_2' }),
      expect.objectContaining({ carrier: 'class', spelling: 'F0_2' }),
    ]);
  });

  it('fails loudly when two facade slots normalize to one public Rust spelling', () => {
    const first = lower('@scope/model', 'packages/model/src/first.ts', 'export function first(): number { return 1; }');
    const second = lower(
      '@scope/model',
      'packages/model/src/second.ts',
      'export function second(): number { return 2; }',
    );
    const entry = lower('@scope/api', 'packages/api/src/contract.ts', 'export const direct = 0;');
    const facade = createFacade(entry, [
      bindingSlot(entry, first, 'fooBar', 'first', 'value'),
      bindingSlot(entry, second, 'foo_bar', 'second', 'value'),
    ]);

    expectPlanningFailure({ facade, modules: [entry, first, second] }, 'rust-public-binding-collision');

    const firstNamespace = lower('@scope/model', 'packages/model/src/first-namespace.ts', 'export const first = 1;');
    const secondNamespace = lower('@scope/model', 'packages/model/src/second-namespace.ts', 'export const second = 2;');
    const namespaceFacade = createFacade(entry, [
      namespaceSlot(entry, firstNamespace, 'fooBar'),
      namespaceSlot(entry, secondNamespace, 'foo_bar'),
    ]);
    expectPlanningFailure(
      { facade: namespaceFacade, modules: [entry, firstNamespace, secondNamespace] },
      'rust-public-binding-collision',
    );
  });

  it('requires the versioned neutral facade contract', () => {
    const module = lower('@scope/api', 'packages/api/src/contract.ts', 'export const direct = 0;');
    expect(() =>
      createCompilerRustPublicBindingPlan({
        facade: { ...createFacade(module, []), schema: 'wrong' } as never,
        modules: [module],
      }),
    ).toThrow('Rust public binding planning requires flight-compiler-module-facade/1');
  });
});

it('keeps refused identities in the plan when their locators collide', () => {
  const myWidget = lower('@scope/math', 'packages/math/src/myWidget.ts', 'export const a = 1;');
  const myWidgetLower = lower('@scope/math', 'packages/math/src/my_widget.ts', 'export const b = 2;');
  const facade: CompilerModuleFacadePlan = {
    modules: [],
    schema: 'flight-compiler-module-facade/1',
    semantics: {
      bindingAccess: 'live',
      explicitPrecedence: 'named-over-star',
      starAmbiguity: 'refuse-distinct-resolutions',
      starDefault: 'excluded',
      typeValueLanes: 'independent',
    },
  };
  const modules = [myWidget, myWidgetLower];
  const refusals = modules.map((module) => ({
    code: 'duplicate-emitted-path',
    message: 'source path collision',
    module: identity(module),
  }));

  const plan = createCompilerRustPublicBindingPlan({ facade, modules, refusals });
  expect(plan.modules).toHaveLength(2);
  expect(new Set(plan.modules.map((module) => module.locator.modulePath.join('/')))).toEqual(new Set(['my_widget']));

  // One refused and one available identity sharing a locator is unambiguous: only the available
  // module can emit a file. Two available identities remain a defect.
  expect(createCompilerRustPublicBindingPlan({ facade, modules, refusals: [refusals[0]!] }).modules).toHaveLength(2);
  expect(() => createCompilerRustPublicBindingPlan({ facade, modules })).toThrow(
    expect.objectContaining({ code: 'rust-public-module-collision', kind: 'rust-public-binding-planning' }),
  );
});

describe('isCompilerRustPublicBindingPlanningFailure', () => {
  it('recognizes a planning collision and rejects incomplete or unrelated failures', () => {
    const failure = Object.assign(new Error('collision'), {
      code: 'rust-public-module-collision',
      kind: 'rust-public-binding-planning',
      subjects: ['first', 'second'],
    });

    expect(isCompilerRustPublicBindingPlanningFailure(failure)).toBe(true);
    for (const value of [
      undefined,
      new Error('unrelated'),
      { ...failure },
      Object.assign(new Error('unknown code'), { ...failure, code: 'unknown' }),
      Object.assign(new Error('missing subject'), { ...failure, subjects: ['first'] }),
      Object.assign(new Error('empty subject'), { ...failure, subjects: ['first', ''] }),
    ]) {
      expect(isCompilerRustPublicBindingPlanningFailure(value)).toBe(false);
    }
  });
});

function createFacade(entry: Readonly<IrModule>, slots: readonly CompilerModuleFacadeSlot[]): CompilerModuleFacadePlan {
  return {
    modules: [{ module: identity(entry), slots }],
    schema: 'flight-compiler-module-facade/1',
    semantics: {
      bindingAccess: 'live',
      explicitPrecedence: 'named-over-star',
      starAmbiguity: 'refuse-distinct-resolutions',
      starDefault: 'excluded',
      typeValueLanes: 'independent',
    },
  };
}

function bindingSlot(
  entry: Readonly<IrModule>,
  target: Readonly<IrModule>,
  exportName: string,
  imported: string,
  lane: 'type' | 'value',
): CompilerModuleFacadeSlot {
  const declaration = target.declarations.find(
    (candidate) => 'binding' in candidate && candidate.binding.name === imported,
  );
  if (!declaration || !('binding' in declaration)) throw new Error(`Missing declaration ${imported}`);
  return {
    exportName,
    identity: `fixture:${lane}:${exportName}`,
    lane,
    module: identity(entry),
    route: { binding: declaration.binding, kind: 'binding', module: identity(target) },
    source: { imported, kind: 'module-binding', specifier: target.packageName },
    via: [
      {
        kind: 'named-reexport',
        module: identity(entry),
        specifier: target.packageName,
        target: identity(target),
      },
    ],
  };
}

function localSlot(entry: Readonly<IrModule>, exported: string, lane: 'type' | 'value'): CompilerModuleFacadeSlot {
  const declaration = entry.declarations.find(
    (candidate) => 'binding' in candidate && candidate.binding.name === exported,
  );
  if (!declaration || !('binding' in declaration)) throw new Error(`Missing declaration ${exported}`);
  return {
    exportName: exported,
    identity: `fixture:${lane}:${exported}`,
    lane,
    module: identity(entry),
    route: { binding: declaration.binding, kind: 'binding', module: identity(entry) },
    source: { bindingId: declaration.binding.id, kind: 'local-binding' },
    via: [],
  };
}

function namespaceSlot(
  entry: Readonly<IrModule>,
  target: Readonly<IrModule>,
  exported: string,
): CompilerModuleFacadeSlot {
  return {
    exportName: exported,
    identity: `fixture:value:${exported}`,
    lane: 'value',
    module: identity(entry),
    route: { kind: 'namespace', module: identity(target) },
    source: { kind: 'module-namespace', specifier: target.packageName },
    via: [
      {
        kind: 'namespace-reexport',
        module: identity(entry),
        specifier: target.packageName,
        target: identity(target),
      },
    ],
  };
}

function identity(module: Readonly<IrModule>): CompilerModuleIdentity {
  return { name: module.name, packageName: module.packageName, source: module.source };
}

function lower(packageName: string, file: string, source: string): IrModule {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const result = lowerTypeScriptSource(sourceFile, { packageName, upstreamDirectory: '.' });
  if (result.diagnostics.length > 0) throw new Error(result.diagnostics.map((item) => item.message).join('\n'));
  return result.module;
}

function expectPlanningFailure(
  input: Readonly<CompilerRustPublicBindingPlanInput>,
  code: 'rust-public-binding-collision' | 'rust-public-crate-collision' | 'rust-public-module-collision',
): void {
  try {
    createCompilerRustPublicBindingPlan(input);
  } catch (error) {
    expect(isCompilerRustPublicBindingPlanningFailure(error)).toBe(true);
    if (!isCompilerRustPublicBindingPlanningFailure(error)) throw error;
    expect(error.code).toBe(code);
    expect([...error.subjects]).toEqual([...error.subjects].sort());
    return;
  }
  throw new Error(`Expected ${code}`);
}

function isDeeplyFrozen(value: unknown, seen: WeakSet<object>): boolean {
  if (!value || typeof value !== 'object' || seen.has(value)) return true;
  seen.add(value);
  return Object.isFrozen(value) && Object.values(value).every((child) => isDeeplyFrozen(child, seen));
}

describe('createCompilerRustPublicBindingPlanV3', () => {
  it('carries the finalized execution plan verbatim and gates value and module access', () => {
    const fixture = createV3Fixture();
    const planV2 = createCompilerRustPublicBindingPlan({ facade: fixture.facade, modules: fixture.modules });
    const execution = createExecutionPlan(planV2);
    const snapshot = structuredClone({ facade: fixture.facade, modules: fixture.modules, execution });

    const plan = createCompilerRustPublicBindingPlanV3({
      execution,
      facade: fixture.facade,
      modules: fixture.modules,
    });

    expect(plan.schema).toBe('flight-rust-public-binding-plan/3');
    expect(plan.crates).toEqual(planV2.crates);
    expect(plan.modules).toEqual(planV2.modules);
    expect(plan.dependencies).toEqual(planV2.dependencies);
    expect(plan.initialization).toEqual({
      availability: 'available',
      plan: execution,
      required: 'before-value-access',
    });
    const initialization = plan.initialization;
    if (initialization.availability !== 'available') throw new Error('Expected available initialization');
    expect(initialization.plan).not.toBe(execution);
    expect(JSON.stringify(initialization.plan)).toBe(JSON.stringify(execution));
    expect(initialization.plan.phases.map((phase) => phase.kind)).toEqual(['instantiate', 'evaluate']);
    expect(initialization.plan.entries).toEqual(execution.entries);
    expect(initialization.plan.modules).toEqual(execution.modules);

    const accessByCarrier = (carrier: string, space: 'type' | 'value') => {
      const binding = plan.bindings.find(
        (candidate) =>
          candidate.binding.availability === 'available' &&
          candidate.binding.locator.carrier === carrier &&
          candidate.identity.space === space,
      );
      if (!binding) throw new Error(`Missing ${carrier} binding`);
      return binding.access;
    };
    expect(accessByCarrier('interface', 'type')).toEqual({ kind: 'immediate' });
    expect(accessByCarrier('function', 'value')).toEqual({ kind: 'after-bootstrap' });
    expect(accessByCarrier('module', 'value')).toEqual({ kind: 'after-bootstrap' });
    expect(plan.bindings.every((binding) => 'access' in binding)).toBe(true);
    expect(
      plan.bindings.every((binding) => binding.identity.space !== 'value' || binding.access.kind !== 'immediate'),
    ).toBe(true);
    expect(isDeeplyFrozen(plan, new WeakSet())).toBe(true);
    expect(structuredClone({ facade: fixture.facade, modules: fixture.modules, execution })).toEqual(snapshot);
  });

  it('keeps type access usable while refusing value, module, and already-refused bindings', () => {
    const fixture = createV3Fixture();
    const refusals = [
      { code: 'duplicate-emitted-path', message: 'source path collision', module: identity(fixture.provider) },
    ];
    const planV2 = createCompilerRustPublicBindingPlan({
      facade: fixture.facade,
      modules: fixture.modules,
      refusals,
    });
    const execution = createExecutionPlan(planV2, { refusal: true });
    const plan = createCompilerRustPublicBindingPlanV3({
      execution,
      facade: fixture.facade,
      modules: fixture.modules,
      refusals,
    });

    expect(plan.initialization).toEqual({
      availability: 'refused',
      code: 'rust-public-binding-initialization-refused',
      refusals: execution.availability.outcome === 'refused' ? execution.availability.refusals : [],
    });
    const access = (facadeIdentity: string) => {
      const binding = plan.bindings.find((candidate) => candidate.facadeIdentity === facadeIdentity);
      if (!binding) throw new Error(`Missing ${facadeIdentity}`);
      return binding;
    };
    const typeLocal = access('fixture:type:Local');
    const typeRefused = access('fixture:type:Widget');
    const valueLocal = access('fixture:value:localValue');
    const valueRefused = access('fixture:value:makeWidget');
    const moduleLocal = access('fixture:value:widgetsLocal');
    expect(typeLocal.binding.availability).toBe('available');
    expect(typeLocal.access).toEqual({ kind: 'immediate' });
    expect(typeRefused.binding.availability).toBe('refused');
    expect(typeRefused.access).toEqual({ kind: 'refused' });
    expect(valueLocal.binding.availability).toBe('available');
    expect(valueLocal.access).toEqual({ kind: 'refused' });
    expect(valueRefused.access).toEqual({ kind: 'refused' });
    expect(moduleLocal.binding.availability).toBe('available');
    expect(moduleLocal.access).toEqual({ kind: 'refused' });
  });

  it.each([
    ['the execution schema', { schema: 'flight-rust-module-evaluation-execution-plan/2' as const }],
    ['the public binding schema', { publicBindingSchema: 'flight-rust-public-binding-plan/2' as const }],
    [
      'the representation schema',
      { representationSchema: 'flight-rust-module-evaluation-representation-plan/2' as const },
    ],
    ['the runtime ABI schema', { runtimeAbiSchema: 'flight-rust-runtime-abi/3' as const }],
    ['the phase order', { reversePhases: true as const }],
  ])('rejects a stale %s in the execution plan', (_name, override) => {
    const fixture = createV3Fixture();
    const planV2 = createCompilerRustPublicBindingPlan({ facade: fixture.facade, modules: fixture.modules });
    const execution = createExecutionPlan(planV2, override);
    expectV3PlanningFailure(
      { execution, facade: fixture.facade, modules: fixture.modules },
      'rust-public-binding-execution-schema-mismatch',
    );
  });

  it('rejects execution crates and modules outside the public plan projection', () => {
    const fixture = createV3Fixture();
    const planV2 = createCompilerRustPublicBindingPlan({ facade: fixture.facade, modules: fixture.modules });
    expectV3PlanningFailure(
      {
        execution: createExecutionPlan(planV2, {
          entryCrate: { cargoName: 'ghost', packageName: '@scope/ghost', rustName: 'ghost' },
        }),
        facade: fixture.facade,
        modules: fixture.modules,
      },
      'rust-public-binding-execution-projection-mismatch',
    );
    expectV3PlanningFailure(
      {
        execution: createExecutionPlan(planV2, {
          entryModule: { name: 'Ghost', packageName: '@scope/ghost', source: 'packages/ghost/src/ghost.ts' },
        }),
        facade: fixture.facade,
        modules: fixture.modules,
      },
      'rust-public-binding-execution-projection-mismatch',
    );
  });

  it('validates the execution error crate against the selected runtime crate', () => {
    const fixture = createV3Fixture();
    const planV2 = createCompilerRustPublicBindingPlan({ facade: fixture.facade, modules: fixture.modules });
    expectV3PlanningFailure(
      {
        execution: createExecutionPlan(planV2, { errorCrate: 'flight_runtime' }),
        facade: fixture.facade,
        modules: fixture.modules,
        runtimeCrate: 'custom_runtime',
      },
      'rust-public-binding-execution-projection-mismatch',
    );
    expect(() =>
      createCompilerRustPublicBindingPlanV3({
        execution: createExecutionPlan(planV2, { errorCrate: 'custom_runtime' }),
        facade: fixture.facade,
        modules: fixture.modules,
        runtimeCrate: 'custom_runtime',
      }),
    ).not.toThrow();
  });

  it('rejects a malformed refused-availability projection', () => {
    const fixture = createV3Fixture();
    const planV2 = createCompilerRustPublicBindingPlan({ facade: fixture.facade, modules: fixture.modules });
    expectV3PlanningFailure(
      {
        execution: createExecutionPlan(planV2, { refusal: true, refusalsOverride: [] }),
        facade: fixture.facade,
        modules: fixture.modules,
      },
      'rust-public-binding-initialization-projection-mismatch',
    );
    expectV3PlanningFailure(
      {
        execution: createExecutionPlan(planV2, {
          refusal: true,
          refusalsOverride: [
            { code: 'rust-module-evaluation-entry-invocation-unbound', message: '', subject: 'entry' },
          ],
        }),
        facade: fixture.facade,
        modules: fixture.modules,
      },
      'rust-public-binding-initialization-projection-mismatch',
    );
  });

  it('stays deterministic and independent of facade or module order', () => {
    const fixture = createV3Fixture();
    const planV2 = createCompilerRustPublicBindingPlan({ facade: fixture.facade, modules: fixture.modules });
    const execution = createExecutionPlan(planV2);
    const first = createCompilerRustPublicBindingPlanV3({
      execution,
      facade: fixture.facade,
      modules: fixture.modules,
    });
    const second = createCompilerRustPublicBindingPlanV3({
      execution,
      facade: {
        ...fixture.facade,
        modules: [...fixture.facade.modules].reverse().map((module) => ({
          ...module,
          slots: [...module.slots].reverse(),
        })),
      },
      modules: [...fixture.modules].reverse(),
    });

    expect(second).toEqual(first);
  });
});

function createV3Fixture(): Readonly<{
  entry: IrModule;
  facade: CompilerModuleFacadePlan;
  modules: readonly IrModule[];
  provider: IrModule;
  widgets: IrModule;
}> {
  const provider = lower(
    '@scope/model',
    'packages/model/src/widgets.ts',
    'export interface Widget { value: number }\nexport function makeWidget(value: number): Widget { return { value }; }',
  );
  const widgets = lower('@scope/model', 'packages/model/src/geometry.ts', 'export const geometry = 1;');
  const entry = lower(
    '@scope/api',
    'packages/api/src/contract.ts',
    'export interface Local { id: number }\nexport const localValue = 1;',
  );
  const facade = createFacade(entry, [
    bindingSlot(entry, provider, 'Widget', 'Widget', 'type'),
    bindingSlot(entry, provider, 'makeWidget', 'makeWidget', 'value'),
    namespaceSlot(entry, provider, 'widgets'),
    localSlot(entry, 'Local', 'type'),
    localSlot(entry, 'localValue', 'value'),
    namespaceSlot(entry, widgets, 'widgetsLocal'),
  ]);
  return { entry, facade, modules: [entry, provider, widgets], provider, widgets };
}

const executionSignature = {
  parameters: [],
  result: 'Result<(), FlightModuleEvaluationError>',
} as const;

function createExecutionPlan(
  plan: Readonly<CompilerRustPublicBindingPlan>,
  options: {
    entryCrate?: CompilerRustPublicCrateIdentity;
    entryModule?: CompilerModuleIdentity;
    errorCrate?: string;
    refusal?: boolean;
    refusalsOverride?: readonly CompilerRustModuleEvaluationRepresentationRefusal[];
    reversePhases?: boolean;
    schema?: 'flight-rust-module-evaluation-execution-plan/2';
    publicBindingSchema?: 'flight-rust-public-binding-plan/2';
    representationSchema?: 'flight-rust-module-evaluation-representation-plan/2';
    runtimeAbiSchema?: 'flight-rust-runtime-abi/3';
  } = {},
): CompilerRustModuleEvaluationExecutionPlan {
  const providerCrate = plan.crates.find((crate) => crate.packageName === '@scope/model')!;
  const providerModule = plan.modules.find((module) => module.identity.packageName === '@scope/model')!;
  const crate = options.entryCrate ?? providerCrate;
  const module = options.entryModule ?? providerModule.identity;
  const locator = {
    filePath: providerModule.identity.source,
    modulePath: providerModule.locator.modulePath,
    packageName: providerModule.identity.packageName,
  };
  const refusal = {
    code: 'rust-module-evaluation-entry-invocation-unbound' as const,
    message: 'entry invocation is unbound',
    subject: 'entry',
  };
  const refusals = options.refusalsOverride ?? [refusal];
  const invocation = (phase: 'evaluate' | 'instantiate') => ({
    crate,
    cyclic: false,
    groupIndex: 0,
    locator: {
      modulePath: [] as const,
      spelling: `__flight_${phase}_group_0` as const,
      visibility: 'public-doc-hidden' as const,
    },
    modules: [module],
    signature: executionSignature,
  });
  const phases = options.refusal
    ? [
        { invocations: [], kind: 'instantiate' },
        { invocations: [], kind: 'evaluate' },
      ]
    : options.reversePhases
      ? [
          { invocations: [invocation('evaluate')], kind: 'evaluate' },
          { invocations: [invocation('instantiate')], kind: 'instantiate' },
        ]
      : [
          { invocations: [invocation('instantiate')], kind: 'instantiate' },
          { invocations: [invocation('evaluate')], kind: 'evaluate' },
        ];
  const value = {
    availability: options.refusal ? { outcome: 'refused', refusals, subjects: ['entry'] } : { outcome: 'available' },
    entries: options.refusal ? [] : [{ crate, groupIndex: 0, locator, module }],
    error: {
      crateName: options.errorCrate ?? 'flight_runtime',
      result: executionSignature.result,
      targetName: 'FlightModuleEvaluationError',
    },
    modules: options.refusal
      ? []
      : [
          {
            crate,
            groupIndex: 0,
            lifecycle: {
              evaluate: { signature: executionSignature, spelling: '__flight_evaluate_once', visibility: 'crate' },
              instantiate: {
                signature: executionSignature,
                spelling: '__flight_instantiate_once',
                visibility: 'crate',
              },
              state: {
                spelling: '__flight_module_evaluation_state',
                states: ['uninstantiated', 'instantiating', 'instantiated', 'evaluating', 'evaluated', 'errored'],
                visibility: 'private',
              },
            },
            locator,
            module,
          },
        ],
    phases,
    publicBindingSchema: options.publicBindingSchema ?? 'flight-rust-public-binding-plan/3',
    representationSchema: options.representationSchema ?? 'flight-rust-module-evaluation-representation-plan/1',
    runtimeAbiSchema: options.runtimeAbiSchema ?? 'flight-rust-runtime-abi/4',
    schema: options.schema ?? 'flight-rust-module-evaluation-execution-plan/1',
    semantics: {
      concurrency: 'serialized-by-bootstrap',
      facadeAccess: 'successful-bootstrap-before-value-access',
      failure: 'cache-first-error-stop-without-retry',
      groupOrder: 'flight-compiler-module-evaluation/1',
      phaseOrder: ['instantiate', 'evaluate'],
      reentrancy: 'reject',
      repeatedInvocation: 'cache-first-result',
      reservedNamespace: '__flight_',
    },
  };
  return value as unknown as CompilerRustModuleEvaluationExecutionPlan;
}

function expectV3PlanningFailure(
  input: Readonly<CompilerRustPublicBindingPlanInputV3>,
  code: CompilerRustPublicBindingPlanningFailureCode,
): void {
  try {
    createCompilerRustPublicBindingPlanV3(input);
  } catch (error) {
    expect(isCompilerRustPublicBindingPlanningFailure(error)).toBe(true);
    if (!isCompilerRustPublicBindingPlanningFailure(error)) throw error;
    expect(error.code).toBe(code);
    expect([...error.subjects]).toEqual([...error.subjects].sort());
    return;
  }
  throw new Error(`Expected ${code}`);
}
