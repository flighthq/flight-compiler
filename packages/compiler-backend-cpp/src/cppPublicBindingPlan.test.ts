import ts from 'typescript';

import { lowerTypeScriptSource } from '../../compiler-semantic/src/index.js';
import type {
  CompilerModuleFacadePlan,
  CompilerModuleFacadeSlot,
  CompilerModuleIdentity,
  IrModule,
} from '../../compiler-types/src/index.js';
import { createCppCompilerPublicBindingPlan, emitIrModuleCpp } from './cppCompilerBackend.js';

describe('createCppCompilerPublicBindingPlan', () => {
  it('plans canonical direct and re-exported locators, collisions, refusals, and immutable deterministic output', () => {
    const origin = lower(
      '@fixture/model',
      'model.ts',
      `
        export interface Widget { value: number }
        export interface FooBar { first: number }
        export interface Foo_Bar { second: number }
        export interface café { third: number }
        export interface cafè { fourth: number }
        export function concept(): number { return 1; }
        export function fooBar(): number { return 2; }
        export function foo_bar(): number { return 3; }
        export const status = 4;
      `,
    );
    const entry = lower(
      '@fixture/api',
      'contract.ts',
      `
        export interface Direct { local: number }
        export type { Widget as RenamedWidget, FooBar, Foo_Bar, café, cafè } from '@fixture/model';
        export { concept, fooBar, foo_bar, status as browserStatus } from '@fixture/model';
      `,
    );
    const modules = [entry, origin];
    const facade = createFacade(entry, origin);
    const snapshot = structuredClone({ facade, modules });
    const before = emitIrModuleCpp(origin).contents;

    const input = {
      facade,
      modules,
      options: {
        packageTargets: {
          '@fixture/api': { includePrefix: 'flight/api', namespace: 'flight::api' },
          '@fixture/model': { includePrefix: 'flight/model', namespace: 'flight::model' },
        },
      },
    } as const;
    const inputSnapshot = structuredClone(input);
    const first = createCppCompilerPublicBindingPlan(input);
    const second = createCppCompilerPublicBindingPlan({ ...input, modules: [...modules].reverse() });
    const byName = (name: string, space: 'type' | 'value') =>
      first.bindings.find((binding) => {
        const slot = facade.modules[0]!.slots.find((candidate) => candidate.identity === binding.facadeIdentity);
        return slot?.exportName === name && slot.lane === space;
      })!;

    expect(first.schema).toBe('flight-cpp-public-binding-plan/1');
    expect(second).toEqual(first);
    expect({ facade, modules }).toEqual(snapshot);
    expect(input).toEqual(inputSnapshot);
    expect(isDeeplyFrozen(first, new WeakSet())).toBe(true);
    expect(first.bindings.map((binding) => binding.key)).toEqual(
      [...first.bindings.map((binding) => binding.key)].sort(),
    );
    expect(byName('RenamedWidget', 'type')).toMatchObject({
      binding: {
        availability: 'available',
        locator: {
          carrier: 'interface',
          include: 'flight/api/contract.hpp',
          namespace: 'flight::api',
          spelling: 'RenamedWidget',
        },
      },
      identity: { packageName: '@fixture/api', source: 'contract.ts', space: 'type' },
    });
    expect(byName('Direct', 'type')).toMatchObject({
      binding: {
        availability: 'available',
        locator: { include: 'flight/api/contract.hpp', namespace: 'flight::api', spelling: 'Direct' },
      },
    });
    expect(byName('browserStatus', 'value').binding).toMatchObject({
      availability: 'refused',
      refusal: { code: 'cpp-renamed-value-reexport-unsupported' },
    });
    expect(byName('concept', 'value').binding).toMatchObject({
      availability: 'available',
      locator: { spelling: 'concept_' },
    });
    const caseCollision = [byName('fooBar', 'value'), byName('foo_bar', 'value')].map((binding) =>
      binding.binding.availability === 'available' ? binding.binding.locator.spelling : '',
    );
    const typeCollision = [byName('FooBar', 'type'), byName('Foo_Bar', 'type')].map((binding) =>
      binding.binding.availability === 'available' ? binding.binding.locator.spelling : '',
    );
    const unicodeCollision = [byName('café', 'type'), byName('cafè', 'type')].map((binding) =>
      binding.binding.availability === 'available' ? binding.binding.locator.spelling : '',
    );
    expect(new Set(caseCollision).size).toBe(2);
    expect(new Set(typeCollision).size).toBe(2);
    expect(new Set(unicodeCollision).size).toBe(2);
    expect(caseCollision.every((name) => name.includes('_flight_'))).toBe(true);
    expect(typeCollision.every((name) => name.includes('_flight_'))).toBe(true);
    expect(unicodeCollision.every((name) => name.includes('_flight_'))).toBe(true);
    expect(before).toContain('concept_()');
    expect(emitIrModuleCpp(origin).contents).toBe(before);

    const refused = createCppCompilerPublicBindingPlan({
      ...input,
      refusals: [{ code: 'cpp-test-refusal', message: 'browser implementation only', module: identity(origin) }],
    });
    expect(refused.bindings.find((binding) => binding.facadeIdentity === 'fixture:type:Direct')?.binding).toMatchObject(
      {
        availability: 'available',
      },
    );
    expect(refused.bindings.find((binding) => binding.facadeIdentity !== 'fixture:type:Direct')?.binding).toMatchObject(
      {
        availability: 'refused',
        refusal: { code: 'cpp-module-refused', detailCode: 'cpp-test-refusal' },
      },
    );
  });
});

function createFacade(entry: Readonly<IrModule>, origin: Readonly<IrModule>): CompilerModuleFacadePlan {
  const specs = [
    ['RenamedWidget', 'Widget', 'type'],
    ['FooBar', 'FooBar', 'type'],
    ['Foo_Bar', 'Foo_Bar', 'type'],
    ['café', 'café', 'type'],
    ['cafè', 'cafè', 'type'],
    ['concept', 'concept', 'value'],
    ['fooBar', 'fooBar', 'value'],
    ['foo_bar', 'foo_bar', 'value'],
    ['browserStatus', 'status', 'value'],
  ] as const;
  const slots: CompilerModuleFacadeSlot[] = specs.map(([exportName, imported, lane]) => {
    const declaration = origin.declarations.find(
      (candidate) => 'binding' in candidate && candidate.binding.name === imported,
    );
    if (!declaration || !('binding' in declaration)) throw new Error(`Missing declaration ${imported}`);
    return {
      exportName,
      identity: `fixture:${lane}:${exportName}`,
      lane,
      module: identity(entry),
      route: { binding: declaration.binding, kind: 'binding' as const, module: identity(origin) },
      source: { imported, kind: 'module-binding' as const, specifier: '@fixture/model' },
      via: [
        {
          kind: 'named-reexport' as const,
          module: identity(entry),
          specifier: '@fixture/model',
          target: identity(origin),
        },
      ],
    };
  });
  const direct = entry.declarations.find((candidate) => 'binding' in candidate && candidate.binding.name === 'Direct');
  if (!direct || !('binding' in direct)) throw new Error('Missing declaration Direct');
  slots.push({
    exportName: 'Direct',
    identity: 'fixture:type:Direct',
    lane: 'type',
    module: identity(entry),
    route: { binding: direct.binding, kind: 'binding', module: identity(entry) },
    source: { bindingId: direct.binding.id, kind: 'local-binding' },
    via: [],
  });
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

function identity(module: Readonly<IrModule>): CompilerModuleIdentity {
  return { name: module.name, packageName: module.packageName, source: module.source };
}

function lower(packageName: string, file: string, source: string): IrModule {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const result = lowerTypeScriptSource(sourceFile, { packageName, upstreamDirectory: '.' });
  if (result.diagnostics.length > 0) throw new Error(result.diagnostics.map((item) => item.message).join('\n'));
  return result.module;
}

function isDeeplyFrozen(value: unknown, seen: WeakSet<object>): boolean {
  if (!value || typeof value !== 'object' || seen.has(value)) return true;
  seen.add(value);
  return Object.isFrozen(value) && Object.values(value).every((child) => isDeeplyFrozen(child, seen));
}
