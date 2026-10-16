import ts from 'typescript';

import { lowerTypeScriptSource } from '../../compiler-semantic/src/index.js';
import type {
  CompilerCppPublicBindingPlan,
  CompilerModuleFacadePlan,
  CompilerModuleFacadeSlot,
  CompilerModuleIdentity,
  IrModule,
} from '../../compiler-types/src/index.js';
import { createCompilerHaxeDualBindingPlan } from './haxeDualBindingPlan.js';

describe('createCompilerHaxeDualBindingPlan', () => {
  it('joins JS and C++ target plans behind one collision-safe Haxe surface with structured availability', () => {
    const native = lower(
      '@fixture/native',
      'native.ts',
      `
        export interface Token { value: number }
        export const Token = 1;
        export interface foo_bar { left: number }
        export interface fooBar { right: number }
        export interface café { third: number }
        export interface cafè { fourth: number }
        export const classValue = 2;
      `,
    );
    const browser = lower(
      '@fixture/browser',
      'browser.ts',
      'export function browserOnly(value?: number): string { return String(value); }',
    );
    const entry = lower(
      '@fixture/api',
      'contract.ts',
      `
        export interface Direct { local: number }
        export type { Token as PublicToken, foo_bar, fooBar, café, cafè } from '@fixture/native';
        export { Token, classValue as class } from '@fixture/native';
        export { browserOnly } from '@fixture/browser';
      `,
    );
    const modules = [browser, entry, native];
    const facade = createFacade(entry, native, browser);
    const snapshot = structuredClone({ facade, modules });
    const cpp = createCppPlan(facade, browser);
    const input = {
      cpp,
      facade,
      modules,
      options: { rootPackage: 'flight' },
      packageSpecifiers: { '@fixture/api': '@fixture/api/browser' },
    } as const;
    const inputSnapshot = structuredClone(input);

    const first = createCompilerHaxeDualBindingPlan(input);
    const second = createCompilerHaxeDualBindingPlan({ ...input, modules: [...modules].reverse() });
    const byExport = (name: string, space: 'type' | 'value') =>
      first.bindings.find((binding) => {
        const cppBinding = cpp.bindings.find((candidate) => candidate.key === binding.key)!;
        const slot = facade.modules[0]!.slots.find((candidate) => candidate.identity === cppBinding.facadeIdentity);
        return slot?.exportName === name && slot.lane === space;
      })!;

    expect(first.schema).toBe('flight-haxe-dual-binding-plan/1');
    expect(second).toEqual(first);
    expect({ facade, modules }).toEqual(snapshot);
    expect(input).toEqual(inputSnapshot);
    expect(isDeeplyFrozen(first, new WeakSet())).toBe(true);
    expect(first.bindings.map((binding) => binding.key)).toEqual(
      [...first.bindings.map((binding) => binding.key)].sort(),
    );
    expect(byExport('PublicToken', 'type').publicHaxe).toMatchObject({
      kind: 'type',
      owner: 'flight',
      qualifiedName: 'flight.PublicToken',
      typeIdentity: 'flight.PublicToken',
    });
    expect(byExport('Token', 'type').publicHaxe.qualifiedName).toBe('flight.Token');
    expect(byExport('Token', 'value').publicHaxe).toMatchObject({
      kind: 'value',
      name: 'Token',
      owner: 'flight.Api',
      qualifiedName: 'flight.Api.Token',
      typeIdentity: 'Dynamic',
    });
    expect(byExport('class', 'value').publicHaxe.name).toBe('class_');
    const collisionNames = [byExport('foo_bar', 'type'), byExport('fooBar', 'type')].map(
      (binding) => binding.publicHaxe.name,
    );
    expect(new Set(collisionNames).size).toBe(2);
    expect(collisionNames.every((name) => name.startsWith('FooBar_flight_'))).toBe(true);
    const unicodeCollisionNames = [byExport('café', 'type'), byExport('cafè', 'type')].map(
      (binding) => binding.publicHaxe.name,
    );
    expect(new Set(unicodeCollisionNames).size).toBe(2);
    expect(unicodeCollisionNames.every((name) => name.startsWith('Caf_flight_'))).toBe(true);
    expect(byExport('browserOnly', 'value')).toMatchObject({
      cpp: {
        availability: 'refused',
        refusal: { code: 'cpp-module-refused', detailCode: 'cpp-browser-only' },
      },
      javascript: {
        availability: 'available',
        locator: { exportedName: 'browserOnly', specifier: '@fixture/api/browser' },
      },
      publicHaxe: {
        kind: 'function',
        name: 'browserOnly',
        owner: 'flight.Api',
        signature: 'function browserOnly(?value:Float):String;',
        typeIdentity: '(?Float)->String',
      },
    });
    expect(byExport('PublicToken', 'type').cpp).toMatchObject({
      availability: 'available',
      locator: { include: 'flight/api/contract.hpp', namespace: 'flight::api', spelling: 'PublicToken' },
    });

    const jsRefused = createCompilerHaxeDualBindingPlan({
      ...input,
      javascriptRefusals: [{ code: 'js-test-refusal', message: 'ESM export omitted', module: identity(browser) }],
    });
    const browserKey = byExport('browserOnly', 'value').key;
    expect(jsRefused.bindings.find((binding) => binding.key === browserKey)?.javascript).toMatchObject({
      availability: 'refused',
      refusal: { code: 'js-module-refused', detailCode: 'js-test-refusal' },
    });

    const missingCpp = createCompilerHaxeDualBindingPlan({
      ...input,
      cpp: { ...cpp, bindings: cpp.bindings.filter((binding) => binding.key !== browserKey) },
    });
    expect(missingCpp.bindings.find((binding) => binding.publicHaxe.name === 'browserOnly')?.cpp).toMatchObject({
      availability: 'refused',
      refusal: { code: 'cpp-input-missing' },
    });
  });
});

function createFacade(
  entry: Readonly<IrModule>,
  native: Readonly<IrModule>,
  browser: Readonly<IrModule>,
): CompilerModuleFacadePlan {
  const specs = [
    ['Token', 'Token', 'type', native],
    ['PublicToken', 'Token', 'type', native],
    ['Token', 'Token', 'value', native],
    ['foo_bar', 'foo_bar', 'type', native],
    ['fooBar', 'fooBar', 'type', native],
    ['café', 'café', 'type', native],
    ['cafè', 'cafè', 'type', native],
    ['class', 'classValue', 'value', native],
    ['browserOnly', 'browserOnly', 'value', browser],
  ] as const;
  const slots: CompilerModuleFacadeSlot[] = specs.map(([exportName, imported, lane, target]) => {
    const declaration = target.declarations.find(
      (candidate) => 'binding' in candidate && candidate.binding.name === imported,
    );
    if (!declaration || !('binding' in declaration)) throw new Error(`Missing declaration ${imported}`);
    const specifier = target.packageName;
    return {
      exportName,
      identity: `fixture:${lane}:${exportName}`,
      lane,
      module: identity(entry),
      route: { binding: declaration.binding, kind: 'binding' as const, module: identity(target) },
      source: { imported, kind: 'module-binding' as const, specifier },
      via: [
        {
          kind: 'named-reexport' as const,
          module: identity(entry),
          specifier,
          target: identity(target),
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

function createCppPlan(
  facade: Readonly<CompilerModuleFacadePlan>,
  browser: Readonly<IrModule>,
): CompilerCppPublicBindingPlan {
  return {
    bindings: facade.modules[0]!.slots.map((slot) => {
      if (slot.route.kind !== 'binding') throw new Error('Expected binding route');
      const browserOnly = slot.route.module.source === browser.source;
      return {
        binding: browserOnly
          ? {
              availability: 'refused' as const,
              refusal: {
                code: 'cpp-module-refused' as const,
                detailCode: 'cpp-browser-only',
                message: 'browser API has no native carrier',
                subject: slot.identity,
              },
            }
          : {
              availability: 'available' as const,
              locator: {
                carrier: slot.lane === 'type' ? ('interface' as const) : ('value' as const),
                include: 'flight/api/contract.hpp',
                namespace: 'flight::api',
                spelling: slot.exportName,
              },
            },
        facadeIdentity: slot.identity,
        identity: {
          declarationIdentity: slot.route.binding.id,
          exportRoute: slot.identity,
          packageName: slot.module.packageName,
          source: slot.module.source,
          space: slot.lane,
        },
        key: `source-export:${slot.identity}`,
      };
    }),
    schema: 'flight-cpp-public-binding-plan/1',
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
