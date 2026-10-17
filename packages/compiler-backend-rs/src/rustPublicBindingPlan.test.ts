import ts from 'typescript';

import { lowerTypeScriptSource } from '../../compiler-semantic/src/index.js';
import type {
  CompilerModuleFacadePlan,
  CompilerModuleFacadeSlot,
  CompilerModuleIdentity,
  CompilerRustPublicBindingPlanInput,
  IrModule,
} from '../../compiler-types/src/index.js';
import {
  createCompilerRustPublicBindingPlan,
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

    expect(first.schema).toBe('flight-rust-public-binding-plan/1');
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
    expect(available('fixture:type:PublicWidget')).toMatchObject({
      carrier: 'interface',
      module: { crate: { cargoName: 'scope-api' }, modulePath: ['public', 'contract'] },
      spelling: 'PublicWidget',
    });
    expect(available('fixture:value:makeWidget')).toMatchObject({ carrier: 'function', spelling: 'make_widget' });
    expect(available('fixture:value:status')).toMatchObject({ carrier: 'value', spelling: 'status' });
    expect(available('fixture:value:localStatus')).toMatchObject({ carrier: 'value', spelling: 'LOCAL_STATUS' });
    expect(
      first.bindings.find((binding) => binding.facadeIdentity === 'fixture:value:geometry')?.binding,
    ).toMatchObject({
      availability: 'refused',
      refusal: { code: 'rust-unsupported-facade-route' },
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
