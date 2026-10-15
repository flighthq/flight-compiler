import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { lowerTypeScriptSources } from '../../compiler-semantic/src/index.js';
import type { CompilerModuleResolutionPlan, IrModule } from '../../compiler-types/src/index.js';
import { createCppCompilerBackend } from './cppCompilerBackend.js';

describe('C++ structural-row weak keys', () => {
  it('retains the audited Renderable union on the current reference-owner plan', () => {
    const results = lowerTypeScriptSources([
      source(
        'Node.ts',
        'export interface Node<Traits extends object = object> { enabled: boolean } export type NodeAny = Node<any>;',
      ),
      source(
        'Node2D.ts',
        "import type { Node } from './Node'; export type Node2D = Node<{ x: number }> & { x: number };",
      ),
      source(
        'Node3D.ts',
        "import type { Node } from './Node'; export type Node3D = Node<{ z: number }> & { z: number };",
      ),
      source('RenderCache.ts', 'export interface RenderCache { kind: string }'),
      source(
        'Renderable.ts',
        "import type { NodeAny } from './Node'; import type { Node2D } from './Node2D'; import type { Node3D } from './Node3D'; import type { RenderCache } from './RenderCache'; export type Renderable = NodeAny | Node2D | Node3D | RenderCache;",
      ),
      source(
        'RenderState.ts',
        "import type { Renderable } from './Renderable'; import type { RenderCache } from './RenderCache'; export interface RenderStateRuntime { renderProxyMap: WeakMap<Renderable, RenderCache> }",
      ),
    ]);
    expect(results.flatMap((result) => result.diagnostics)).toEqual([]);
    const modules = results.map((result) => result.module);

    const emitted = emit(modules, modules[5]!);

    expect(emitted).toContain(
      'flight::WeakMap<flighthq_types::Renderable, flight::Ref<flighthq_types::RenderCache>> render_proxy_map;',
    );
  });

  it('accepts an alias-preserved named row backed by one owner', () => {
    const modules = lowerModules([
      source(
        'accepted.ts',
        `export interface Key { readonly id: number; readonly label?: string }
         export type KeyAlias = Key;
         export type ReadKey = Readonly<KeyAlias>;
         export interface Value { revision: number }
         export interface State {
           directKeys: WeakMap<Readonly<Key>, Value>;
           readonlyKeys: WeakMap<ReadKey, Value>;
         }
         export function remember(state: State, key: ReadKey, value: Value): void {
           state.readonlyKeys.set(key, value);
         }`,
      ),
    ]);

    const emitted = emit(modules, modules[0]!);

    expect(emitted).toContain('using ReadKey = flight::StructuralRef<flight::RowReadonly<flight::RowOf<KeyAlias>>>;');
    expect(emitted).toContain(
      'flight::WeakMap<flight::StructuralRef<flight::RowReadonly<flight::RowOf<flight::Ref<Key>>>>, flight::Ref<Value>> direct_keys;',
    );
    expect(emitted).toContain('flight::WeakMap<ReadKey, flight::Ref<Value>> readonly_keys;');
    expect(emitted).toContain('state->readonly_keys.set(key, value);');
    expect(emitted).not.toContain('flight::materialize_row');
    expect(emitted).not.toContain('flight::make_structural_ref');
  });

  it.each([
    [
      'anonymous row',
      `interface Value { revision: number }
       interface State { values: WeakMap<Readonly<{ id: number }>, Value> }`,
    ],
    [
      'writable construction projection',
      `interface Entity { readonly id: number }
       type EntityConstruction<Type extends Entity> = { -readonly [Name in keyof Type]: Type[Name] };
       interface Value { revision: number }
       interface State<Type extends Entity> { values: WeakMap<EntityConstruction<Type>, Value> }`,
    ],
    [
      'Pick projection whose named owner was erased during lowering',
      // The row planner receives only the projected anonymous object here, not the Key subject. Accepting it
      // would invent the owner identity that the lowered IR no longer carries.
      `interface Key { readonly id: number; readonly label?: string }
       type RequiredKeyId = Required<Pick<Key, 'id'>>;
       interface Value { revision: number }
       interface State { values: WeakMap<RequiredKeyId, Value> }`,
    ],
    [
      'open multi-owner row',
      `interface Node<Traits extends object> { enabled: boolean; traits: Traits }
       type NodeView<Traits extends object> = Node<Traits> & NoInfer<Traits>;
       interface Value { revision: number }
       interface State<Traits extends object> { values: WeakMap<NodeView<Traits>, Value> }`,
    ],
    [
      'erased row',
      `interface Value { revision: number }
       interface State { values: WeakMap<Readonly<object>, Value> }`,
    ],
  ])('refuses a %s without inventing weak identity', (_name, text) => {
    const modules = lowerModules([source('refused.ts', text)]);

    const failure = captureFailure(() => emit(modules, modules[0]!));

    expect(failure).toMatchObject({ rule: 'cpp-weak-map-key-representation-unproven' });
    expect(failure.message).toContain(
      'flight-cpp WeakMap key requires a proven Flight reference or external weak-key policy',
    );
  });

  it('refuses a row whose imported declaration owner is ambiguous', () => {
    const moduleResolution: CompilerModuleResolutionPlan = {
      edges: [
        {
          specifier: './A',
          target: { packageName: '@fixture/a', source: 'packages/a/src/key.ts' },
        },
        {
          specifier: './B',
          target: { packageName: '@fixture/b', source: 'packages/b/src/key.ts' },
        },
        {
          specifier: '@fixture/key',
          target: { packageName: '@fixture/facade', source: 'packages/facade/src/key.ts' },
        },
      ],
      schema: 'flight-compiler-module-resolution/1',
    };
    const results = lowerTypeScriptSources(
      [
        source('key.ts', 'export interface Key { readonly id: number }', '@fixture/a'),
        source('key.ts', 'export interface Key { readonly id: number }', '@fixture/b'),
        source('key.ts', "export type { Key } from './A';", '@fixture/facade'),
        source(
          'use.ts',
          `import type { Key } from '@fixture/key';
           interface Value { revision: number }
           export interface State { values: WeakMap<Readonly<Key>, Value> }`,
          '@fixture/consumer',
        ),
      ],
      moduleResolution,
    );
    expect(results.flatMap((result) => result.diagnostics)).toEqual([]);
    const modules = results.map((result) => result.module);
    modules[2] = {
      ...modules[2]!,
      exports: [
        ...modules[2]!.exports,
        { exported: 'Key', imported: 'Key', kind: 'reexport', specifier: './B', typeOnly: true },
      ],
    };

    const failure = captureFailure(() => emit(modules, modules[3]!, moduleResolution));

    expect(failure).toMatchObject({ rule: 'cpp-weak-map-key-representation-unproven' });
  });
});

function captureFailure(action: () => unknown): Error & { rule?: string | undefined } {
  try {
    action();
  } catch (error) {
    if (error instanceof Error) return error;
    throw error;
  }
  throw new Error('Expected structural-row WeakMap key emission to fail');
}

function emit(modules: readonly IrModule[], module: IrModule, moduleResolution?: CompilerModuleResolutionPlan): string {
  return createCppCompilerBackend().createEmissionSession!({
    ...(moduleResolution ? { moduleResolution } : {}),
    modules,
    options: { runtimeProfile: 'flight-cpp' },
  }).emitModule(module)[0]!.contents;
}

function lowerModules(sources: readonly ReturnType<typeof source>[]): IrModule[] {
  const results = lowerTypeScriptSources(sources);
  expect(results.flatMap((result) => result.diagnostics)).toEqual([]);
  return results.map((result) => result.module);
}

function source(file: string, text: string, packageName = '@flighthq/types') {
  return {
    packageName,
    sourceFile: ts.createSourceFile(
      `/flight/packages/${packageName.slice(packageName.lastIndexOf('/') + 1)}/src/${file}`,
      text,
      ts.ScriptTarget.Latest,
      true,
    ),
    upstreamDirectory: '/flight',
  };
}
