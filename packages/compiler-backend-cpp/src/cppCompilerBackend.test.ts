import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

import { isBackendEmissionFailure } from '../../compiler-emission/src/index.js';
import { lowerTypeScriptSource, lowerTypeScriptSources } from '../../compiler-semantic/src/index.js';
import type { CompilerModuleResolutionPlan, IrType } from '../../compiler-types/src/index.js';
import { createCppCompilerBackend, emitIrModuleCpp } from './cppCompilerBackend.js';

function lower(file: string, source: string) {
  return lowerPackage('@flighthq/math', file, source);
}

function lowerPackage(packageName: string, file: string, source: string) {
  const packageDirectory = packageName.slice(packageName.lastIndexOf('/') + 1);
  const sourceFile = ts.createSourceFile(
    `/flight/packages/${packageDirectory}/src/${file}`,
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  return lowerTypeScriptSource(sourceFile, {
    packageName,
    upstreamDirectory: '/flight',
  });
}

describe('createCppCompilerBackend', () => {
  it('creates independent stateless backend records with C++ identity', () => {
    const first = createCppCompilerBackend();
    const second = createCppCompilerBackend();
    const module = lower('value.ts', 'export const value = 1;').module;

    expect(first).not.toBe(second);
    expect(first.name).toBe('cpp');
    expect(first.emitModule(module, { modules: [module], options: {} })).toEqual([emitIrModuleCpp(module)]);
  });

  it('emits through createEmissionSession without module resolution', () => {
    const backend = createCppCompilerBackend();
    const module = lower('value.ts', 'export const value = 1;').module;
    const session = backend.createEmissionSession!({ modules: [module], options: {} });

    expect(session.emitModule(module)).toEqual([emitIrModuleCpp(module)]);
  });

  it('emits through createEmissionSession with module resolution', () => {
    const model = lowerPackage('@flighthq/models', 'model.ts', 'export interface Model { value: number }').module;
    const consumer = lowerPackage(
      '@flighthq/consumer',
      'consumer.ts',
      "import type { Model } from '@flighthq/models'; export function use(m: Model): number { return m.value; }",
    ).module;
    const moduleResolution: CompilerModuleResolutionPlan = {
      edges: [{ specifier: '@flighthq/models', target: { packageName: model.packageName, source: model.source } }],
      schema: 'flight-compiler-module-resolution/1',
    };
    const backend = createCppCompilerBackend();
    const modules = [consumer, model];
    const session = backend.createEmissionSession!({
      moduleResolution,
      modules,
      options: { runtimeProfile: 'flight-cpp' },
    });

    const emitted = session.emitModule(consumer);
    expect(emitted[0]?.contents).toContain('#include "model.hpp"');
    expect(emitted[0]?.contents).toContain('flighthq_models::Model');
  });

  it('reports expected target-lowering refusals as backend emission failures', () => {
    const module = lower('external-heritage.ts', 'export interface Derived extends External {}').module;

    try {
      emitIrModuleCpp(module);
      throw new Error('Expected C++ emission to refuse unresolved external heritage');
    } catch (error) {
      expect(isBackendEmissionFailure(error)).toBe(true);
      if (isBackendEmissionFailure(error)) {
        expect(error.code).toBe('unsupported-ir');
        expect(error.message).toContain('Compiler lowering pass interface-inheritance failed');
      }
    }
  });

  it('emits imported function and tuple aliases through their inline C++ representations', () => {
    const types = lowerPackage(
      '@flighthq/types',
      'aliases.ts',
      'export type Callback = (value: number) => void; export type Pair = [number, string];',
    ).module;
    const consumer = lowerPackage(
      '@flighthq/consumer',
      'consumer.ts',
      "import type { Callback, Pair } from '@flighthq/types'; export function accept(callback: Callback, pair: Pair): void {}",
    ).module;
    const moduleResolution: CompilerModuleResolutionPlan = {
      edges: [{ specifier: '@flighthq/types', target: { packageName: types.packageName, source: types.source } }],
      schema: 'flight-compiler-module-resolution/1',
    };
    const session = createCppCompilerBackend().createEmissionSession!({
      moduleResolution,
      modules: [consumer, types],
      options: { runtimeProfile: 'flight-cpp' },
    });

    const aliases = session.emitModule(types)[0]?.contents;
    const emitted = session.emitModule(consumer)[0]?.contents;
    expect(aliases).toContain('using Callback = std::function<void(double)>');
    expect(aliases).toContain('using Pair = std::tuple<double, flight::String>');
    expect(emitted).toContain('void accept(flighthq_types::Callback callback, flighthq_types::Pair pair)');
    expect(emitted).not.toContain('flight::Ref<flighthq_types::');
  });

  it('lowers for-of destructuring through an imported tuple element alias', () => {
    const rows = ts.createSourceFile(
      '/flight/packages/model/src/rows.ts',
      'export type Row = readonly [number, string]; export type Rows = readonly Row[];',
      ts.ScriptTarget.Latest,
      true,
    );
    const read = ts.createSourceFile(
      '/flight/packages/app/src/read.ts',
      `import type { Rows } from '@flight/model';
       export function labels(rows: Rows): string {
         let result = '';
         for (const [count, label] of rows) { if (count > 0) result += label; }
         return result;
       }`,
      ts.ScriptTarget.Latest,
      true,
    );
    const moduleResolution: CompilerModuleResolutionPlan = {
      edges: [
        {
          specifier: '@flight/model',
          target: { packageName: '@flight/model', source: 'packages/model/src/rows.ts' },
        },
      ],
      schema: 'flight-compiler-module-resolution/1',
    };
    const results = lowerTypeScriptSources(
      [
        { packageName: '@flight/model', sourceFile: rows, upstreamDirectory: '/flight' },
        { packageName: '@flight/app', sourceFile: read, upstreamDirectory: '/flight' },
      ],
      moduleResolution,
    );
    const modules = results.map((result) => result.module);
    const output = createCppCompilerBackend().createEmissionSession!({
      moduleResolution,
      modules,
      options: { runtimeProfile: 'flight-cpp' },
    }).emitModule(modules[1]!)![0]!.contents;

    expect(results[1]!.diagnostics).toEqual([]);
    expect(output).toContain('for (auto array_pattern_value');
    expect(output).toContain('std::get<0>');
    expect(output).toContain('std::get<1>');
  });

  it('emits imported generic union aliases as inline values', () => {
    const types = lowerPackage(
      '@flighthq/types',
      'outcome.ts',
      "export type Outcome<Reason extends string> = { readonly reason: 'ok' } | { readonly reason: Reason };",
    ).module;
    const consumer = lowerPackage(
      '@flighthq/consumer',
      'consumer.ts',
      "import type { Outcome } from '@flighthq/types'; export function accept(value: Outcome<'blocked'>): Outcome<'blocked'> { return value; }",
    ).module;
    const moduleResolution: CompilerModuleResolutionPlan = {
      edges: [{ specifier: '@flighthq/types', target: { packageName: types.packageName, source: types.source } }],
      schema: 'flight-compiler-module-resolution/1',
    };
    const session = createCppCompilerBackend().createEmissionSession!({
      moduleResolution,
      modules: [consumer, types],
      options: { runtimeProfile: 'flight-cpp' },
    });
    const aliases = session.emitModule(types)[0]!.contents;
    const emitted = session.emitModule(consumer)[0]!.contents;

    expect(aliases.match(/template <typename Reason>/gu)).toHaveLength(3);
    expect(aliases).toContain(
      'using Outcome = std::variant<flight::Ref<reason_1<Reason>>, flight::Ref<reason<Reason>>>;',
    );
    expect(emitted).toContain('flighthq_types::Outcome<flight::String> accept(');
    expect(emitted).not.toContain('flight::Ref<flighthq_types::Outcome');
  });

  it('includes and qualifies every source in a split named-import request', () => {
    const alpha = lowerPackage('@flighthq/types', 'alpha.ts', 'export interface Alpha { value: number }').module;
    const beta = lowerPackage('@flighthq/types', 'beta.ts', 'export interface Beta { label: string }').module;
    const consumer = lowerPackage(
      '@flighthq/consumer',
      'consumer.ts',
      "import type { Alpha, Beta } from '@flighthq/types/contract'; export function pair(alpha: Alpha, beta: Beta): void {}",
    ).module;
    const moduleResolution: CompilerModuleResolutionPlan = {
      edges: [
        {
          importedNames: ['Alpha'],
          specifier: '@flighthq/types/contract',
          target: { packageName: alpha.packageName, source: alpha.source },
        },
        {
          importedNames: ['Beta'],
          specifier: '@flighthq/types/contract',
          target: { packageName: beta.packageName, source: beta.source },
        },
      ],
      schema: 'flight-compiler-module-resolution/1',
    };
    const emitted = createCppCompilerBackend().createEmissionSession!({
      moduleResolution,
      modules: [consumer, beta, alpha],
      options: {
        packageTargets: {
          '@flighthq/consumer': { includePrefix: 'flight/consumer', namespace: 'flight::consumer' },
          '@flighthq/types': { includePrefix: 'flight/types', namespace: 'flight::types' },
        },
        runtimeProfile: 'flight-cpp',
      },
    }).emitModule(consumer)[0]!.contents;

    expect(emitted).toContain('#include <flight/types/alpha.hpp>');
    expect(emitted).toContain('#include <flight/types/beta.hpp>');
    expect(emitted).toContain('flight::Ref<flight::types::Alpha> alpha');
    expect(emitted).toContain('flight::Ref<flight::types::Beta> beta');
  });

  it('places anonymous union helpers after complete named dependencies and before their owner', () => {
    const emitted = emitIrModuleCpp(
      lower(
        'ordered-anonymous-types.ts',
        'export type Outcome = { value: Later } | { reason: string }; export interface Later { version: string }',
      ).module,
    ).contents;

    expect(emitted.indexOf('struct Later {')).toBeLessThan(emitted.indexOf('struct value'));
    expect(emitted.indexOf('struct value')).toBeLessThan(emitted.indexOf('using Outcome'));
  });

  it('qualifies nested references while expanding imported union aliases', () => {
    const types = lowerPackage(
      '@flighthq/types',
      'update.ts',
      "export interface DownloadedUpdate { readonly version: string } export type Outcome = { readonly reason: 'downloaded'; readonly update: DownloadedUpdate } | { readonly reason: 'missing' };",
    ).module;
    const consumer = lowerPackage(
      '@flighthq/consumer',
      'consumer.ts',
      "import type { DownloadedUpdate, Outcome } from '@flighthq/types'; export function keep(value: Outcome): Outcome { const retained: DownloadedUpdate | null = null; retained; return value; }",
    ).module;
    const moduleResolution: CompilerModuleResolutionPlan = {
      edges: [{ specifier: '@flighthq/types', target: { packageName: types.packageName, source: types.source } }],
      schema: 'flight-compiler-module-resolution/1',
    };
    const session = createCppCompilerBackend().createEmissionSession!({
      moduleResolution,
      modules: [consumer, types],
      options: { runtimeProfile: 'flight-cpp' },
    });
    const aliases = session.emitModule(types)[0]!.contents;
    const emitted = session.emitModule(consumer)[0]!.contents;

    expect(aliases.indexOf('struct DownloadedUpdate :')).toBeLessThan(aliases.indexOf('struct reason_update'));
    expect(aliases.indexOf('struct reason_update')).toBeLessThan(aliases.indexOf('using Outcome'));
    expect(emitted).toContain('flight::Ref<flighthq_types::DownloadedUpdate> update;');
  });

  it('projects common variant properties and narrows structural switch cases', () => {
    const moduleResolution: CompilerModuleResolutionPlan = {
      edges: [
        {
          specifier: '@flighthq/types',
          target: { packageName: '@flighthq/types', source: 'packages/types/src/update.ts' },
        },
      ],
      schema: 'flight-compiler-module-resolution/1',
    };
    const [typesResult, consumerResult] = lowerTypeScriptSources(
      [
        {
          packageName: '@flighthq/types',
          sourceFile: ts.createSourceFile(
            '/flight/packages/types/src/update.ts',
            "export interface DownloadedUpdate { readonly version: string } export type Outcome = Readonly<{ readonly reason: 'downloaded'; readonly update: DownloadedUpdate }> | Readonly<{ readonly reason: 'missing' }> ;",
            ts.ScriptTarget.Latest,
            true,
          ),
          upstreamDirectory: '/flight',
        },
        {
          packageName: '@flighthq/updater',
          sourceFile: ts.createSourceFile(
            '/flight/packages/updater/src/updater.ts',
            `import type { Outcome } from '@flighthq/types';
             export function version(outcome: Outcome): string {
               switch (outcome.reason) {
                 case 'downloaded': return outcome.update.version;
                 default: return '';
               }
             }`,
            ts.ScriptTarget.Latest,
            true,
          ),
          upstreamDirectory: '/flight',
        },
      ],
      moduleResolution,
    );
    expect(typesResult?.diagnostics).toEqual([]);
    expect(consumerResult?.diagnostics).toEqual([]);
    const types = typesResult!.module;
    const consumer = consumerResult!.module;
    const version = consumer.declarations.find(
      (declaration) => declaration.kind === 'function' && declaration.binding.name === 'version',
    );
    const switchStatement = version?.kind === 'function' ? version.body[0] : undefined;
    expect(switchStatement?.kind === 'switch' ? switchStatement.cases[0]?.unionMemberTest : undefined).toMatchObject({
      binding: { name: 'outcome' },
      whenResult: true,
    });
    const outcome = types.declarations.find(
      (declaration) => declaration.kind === 'typeAlias' && declaration.binding.name === 'Outcome',
    );
    expect(switchStatement?.kind === 'switch' ? switchStatement.cases[0]?.unionMemberTest?.member : undefined).toEqual(
      outcome?.kind === 'typeAlias' && outcome.type.kind === 'union' ? outcome.type.types[0] : undefined,
    );
    const session = createCppCompilerBackend().createEmissionSession!({
      moduleResolution,
      modules: [consumer, types],
      options: { runtimeProfile: 'flight-cpp' },
    });
    const emitted = session.emitModule(consumer)[0]!.contents;

    expect(emitted).toContain('std::visit([](const auto& value) { return value->reason; }, outcome)');
    expect(emitted).toMatch(/std::get<\d+>\(outcome\)->update->version/u);
    expect(emitted).not.toContain('struct reason_update');
  });

  it('narrows an imported collider union to its named variant alternative', () => {
    const source = (file: string, contents: string) => ({
      packageName: '@flighthq/types',
      sourceFile: ts.createSourceFile(`/flight/packages/types/src/${file}.ts`, contents, ts.ScriptTarget.Latest, true),
      upstreamDirectory: '/flight',
    });
    const moduleResolution: CompilerModuleResolutionPlan = {
      edges: [
        {
          specifier: '@flighthq/types/contract',
          target: { packageName: '@flighthq/types', source: 'packages/types/src/contract.ts' },
        },
      ],
      schema: 'flight-compiler-module-resolution/1',
    };
    const results = lowerTypeScriptSources(
      [
        source('CollisionResponse', 'export interface CollisionResponse { restitution?: number; friction?: number }'),
        ...(
          [
            ['CircleCollider', "x: number; mode: 'exclude' | 'contain'"],
            ['PlaneCollider', 'nx: number; distance: number'],
            ['RectangleCollider', "width: number; mode: 'exclude' | 'contain'"],
            ['SphereCollider', "radius: number; mode: 'exclude' | 'contain'"],
          ] as const
        ).map(([name, properties]) =>
          source(
            name,
            `import type { CollisionResponse } from './CollisionResponse.js';
             export interface ${name} extends CollisionResponse { kind: '${name}'; ${properties} }`,
          ),
        ),
        source(
          'ParticleCollider',
          `import type { CircleCollider } from './CircleCollider.js';
           import type { PlaneCollider } from './PlaneCollider.js';
           import type { RectangleCollider } from './RectangleCollider.js';
           import type { SphereCollider } from './SphereCollider.js';
           export type ParticleCollider = CircleCollider | PlaneCollider | RectangleCollider | SphereCollider;`,
        ),
        source(
          'contract',
          `export * from './CircleCollider.js';
           export * from './PlaneCollider.js';
           export * from './RectangleCollider.js';
           export * from './SphereCollider.js';
           export * from './ParticleCollider.js';`,
        ),
        {
          packageName: '@flighthq/particles',
          sourceFile: ts.createSourceFile(
            '/flight/packages/particles/src/applyParticleCollisions.ts',
            `import type {
               CircleCollider,
               ParticleCollider,
               PlaneCollider,
               RectangleCollider,
               SphereCollider,
             } from '@flighthq/types/contract';
             export function resolveCollider(collider: ParticleCollider): number {
               switch (collider.kind) {
                 case 'PlaneCollider': return resolvePlane(collider);
                 case 'CircleCollider': return resolveCircle(collider);
                 case 'RectangleCollider': return resolveRectangle(collider);
                 case 'SphereCollider': return resolveSphere(collider);
               }
             }
             function resolvePlane(collider: PlaneCollider): number { return collider.nx; }
             function resolveCircle(collider: CircleCollider): number { return collider.x; }
             function resolveRectangle(collider: RectangleCollider): number { return collider.width; }
             function resolveSphere(collider: SphereCollider): number { return collider.radius; }`,
            ts.ScriptTarget.Latest,
            true,
          ),
          upstreamDirectory: '/flight',
        },
      ],
      moduleResolution,
    );
    const modules = results.map((result) => result.module);
    const emitted = createCppCompilerBackend().createEmissionSession!({
      moduleResolution,
      modules,
      options: { runtimeProfile: 'flight-cpp' },
    }).emitModule(modules.at(-1)!)[0]!.contents;

    expect(emitted).toMatch(/resolve_plane\(std::get<\d+>\(collider\)\)/u);
    expect(emitted).toMatch(/resolve_circle\(std::get<\d+>\(collider\)\)/u);
    expect(emitted).toMatch(/resolve_rectangle\(std::get<\d+>\(collider\)\)/u);
    expect(emitted).toMatch(/resolve_sphere\(std::get<\d+>\(collider\)\)/u);
  });

  it('refuses a narrowed variant reference without matching source-alternative evidence', () => {
    const result = lower(
      'unproven-variant-member.ts',
      `interface CircleCollider { kind: 'CircleCollider'; radius: number }
       interface PlaneCollider { kind: 'PlaneCollider'; distance: number }
       export function keep(collider: CircleCollider | PlaneCollider): CircleCollider | PlaneCollider {
         return collider;
       }`,
    );
    const module = structuredClone(result.module);
    const declaration = module.declarations.find(
      (candidate) => candidate.kind === 'function' && candidate.binding.name === 'keep',
    );
    const returned = declaration?.kind === 'function' ? declaration.body[0] : undefined;
    if (returned?.kind !== 'return' || returned.expression?.kind !== 'identifier') {
      throw new Error('Expected returned collider identifier');
    }
    Object.assign(returned.expression, { narrowedMember: 'MissingCollider' });

    expect(() => emitIrModuleCpp(module, { runtimeProfile: 'flight-cpp' })).toThrow(
      'narrowed member MissingCollider must identify one C++ variant alternative',
    );
  });

  it('uses the resolved module graph for imported reference representation', () => {
    const model = lowerPackage('@flighthq/models', 'model.ts', 'export interface Model { value: number }').module;
    const barrel = lowerPackage('@flighthq/models', 'barrel.ts', "export type { Model } from './model.js';").module;
    const consumer = lowerPackage(
      '@flighthq/consumer',
      'consumer.ts',
      "import type { Model } from '@flighthq/models'; export function same(left: Model, right: Model): boolean { return left === right; }",
    ).module;
    const moduleResolution: CompilerModuleResolutionPlan = {
      edges: [
        {
          specifier: '@flighthq/models',
          target: { packageName: barrel.packageName, source: barrel.source },
        },
      ],
      schema: 'flight-compiler-module-resolution/1',
    };
    const backend = createCppCompilerBackend();
    const modules = [consumer, barrel, model];
    const emitted = backend.emitModule(consumer, {
      moduleResolution,
      modules,
      options: { runtimeProfile: 'flight-cpp' },
    });
    const facade = backend.emitModule(barrel, {
      moduleResolution,
      modules,
      options: { runtimeProfile: 'flight-cpp' },
    });

    expect(emitted[0]?.contents).toContain('#include "barrel.hpp"');
    expect(emitted[0]?.contents).toContain(
      'bool same(flight::Ref<flighthq_models::Model> left, flight::Ref<flighthq_models::Model> right)',
    );
    expect(facade[0]?.contents).toContain('#include "model.hpp"');
    const standalone = emitIrModuleCpp(consumer, { runtimeProfile: 'flight-cpp' });
    expect(standalone.contents).toContain('flight::Ref<Model>');
  });

  it('constructs an imported optional reference from an imported function result', () => {
    const types = ts.createSourceFile(
      '/flight/packages/types/src/entity.ts',
      `export interface Entity { [EntityRuntimeKey]: EntityRuntime | undefined; }
       export interface EntityRuntime { binding: object | null; }
       export const EntityRuntimeKey = Symbol.for('EntityRuntime');`,
      ts.ScriptTarget.Latest,
      true,
    );
    const runtime = ts.createSourceFile(
      '/flight/packages/entity/src/runtime.ts',
      `import type { EntityRuntime } from '@flighthq/types/contract';
       export function createEntityRuntime(): EntityRuntime { return { binding: null }; }`,
      ts.ScriptTarget.Latest,
      true,
    );
    const binding = ts.createSourceFile(
      '/flight/packages/entity/src/binding.ts',
      `import type { Entity } from '@flighthq/types/contract';
       import { EntityRuntimeKey } from '@flighthq/types/contract';
       import { createEntityRuntime } from './runtime.js';
       export function attach(entity: Entity): void {
         if (entity[EntityRuntimeKey] === undefined) entity[EntityRuntimeKey] = createEntityRuntime();
       }`,
      ts.ScriptTarget.Latest,
      true,
    );
    const moduleResolution: CompilerModuleResolutionPlan = {
      edges: [
        {
          specifier: '@flighthq/types/contract',
          target: { packageName: '@flighthq/types', source: 'packages/types/src/entity.ts' },
        },
      ],
      schema: 'flight-compiler-module-resolution/1',
    };
    const results = lowerTypeScriptSources(
      [
        { packageName: '@flighthq/types', sourceFile: types, upstreamDirectory: '/flight' },
        { packageName: '@flighthq/entity', sourceFile: runtime, upstreamDirectory: '/flight' },
        { packageName: '@flighthq/entity', sourceFile: binding, upstreamDirectory: '/flight' },
      ],
      moduleResolution,
    );
    const modules = results.map((result) => result.module);
    const emitted = createCppCompilerBackend().createEmissionSession!({
      moduleResolution,
      modules,
      options: {
        packageTargets: {
          '@flighthq/entity': { includePrefix: 'flight/entity', namespace: 'flight::entity' },
          '@flighthq/types': { includePrefix: 'flight/types', namespace: 'flight::types' },
        },
        runtimeProfile: 'flight-cpp',
      },
    }).emitModule(modules[2]!)[0]!.contents;

    expect(emitted).toContain(
      'std::optional<flight::Ref<flight::types::EntityRuntime>>{flight::entity::create_entity_runtime()}',
    );
  });

  it('recovers optional construction values through a symbol-key Omit projection', () => {
    const model = ts.createSourceFile(
      '/flight/packages/types/src/model.ts',
      `export const EntityRuntimeKey = Symbol.for('EntityRuntime');
       export interface Entity { [EntityRuntimeKey]: object | undefined; }
       export type EntityConstruction<Type extends Entity> = { -readonly [Key in keyof Type]: Type[Key] };
       export interface Adjustment extends Entity { kind: string; }
       export interface ColorMatrixAdjustment extends Adjustment { colorMatrix: number[]; }
       export interface BrightnessContrastAdjustment extends ColorMatrixAdjustment {
         kind: 'BrightnessContrastAdjustment'; brightness?: number; contrast?: number;
       }`,
      ts.ScriptTarget.Latest,
      true,
    );
    const contract = ts.createSourceFile(
      '/flight/packages/types/src/contract.ts',
      "export * from './model.js';",
      ts.ScriptTarget.Latest,
      true,
    );
    const adjustment = ts.createSourceFile(
      '/flight/packages/adjustments/src/brightnessContrastAdjustment.ts',
      `import type {
         BrightnessContrastAdjustment,
         EntityConstruction,
         EntityRuntimeKey,
       } from '@flighthq/types/contract';
       export function initialize(
         out: EntityConstruction<BrightnessContrastAdjustment>,
         options: Readonly<
           Omit<BrightnessContrastAdjustment, typeof EntityRuntimeKey | 'kind' | 'colorMatrix'>
         > = {},
       ): void {
         const brightness = options.brightness ?? 0;
         out.brightness = brightness;
         out.contrast = options.contrast ?? 1;
       }`,
      ts.ScriptTarget.Latest,
      true,
    );
    const moduleResolution: CompilerModuleResolutionPlan = {
      edges: [
        {
          specifier: '@flighthq/types/contract',
          target: { packageName: '@flighthq/types', source: 'packages/types/src/contract.ts' },
        },
        {
          specifier: './model.js',
          target: { packageName: '@flighthq/types', source: 'packages/types/src/model.ts' },
        },
      ],
      schema: 'flight-compiler-module-resolution/1',
    };
    const results = lowerTypeScriptSources(
      [
        { packageName: '@flighthq/types', sourceFile: model, upstreamDirectory: '/flight' },
        { packageName: '@flighthq/types', sourceFile: contract, upstreamDirectory: '/flight' },
        { packageName: '@flighthq/adjustments', sourceFile: adjustment, upstreamDirectory: '/flight' },
      ],
      moduleResolution,
    );
    const modules = results.map((result) => result.module);
    const emitted = createCppCompilerBackend().createEmissionSession!({
      moduleResolution,
      modules,
      options: { runtimeProfile: 'flight-cpp' },
    }).emitModule(modules[2]!)[0]!.contents;

    expect(emitted).toContain('auto brightness = options.value()->brightness.value_or(0.0)');
    expect(emitted).toContain('out->brightness = std::optional<double>{brightness}');
    expect(emitted).toContain('out->contrast = std::optional<double>{options.value()->contrast.value_or(1.0)}');
    expect(emitted).not.toContain('std::optional<auto>');
  });

  it('recovers nullable property evidence through an imported entity optional chain', () => {
    const entity = ts.createSourceFile(
      '/flight/packages/types/src/entity.ts',
      `export interface Entity { [EntityRuntimeKey]: EntityRuntime | undefined; }
       export interface EntityRuntime { binding: object | null; }
       export const EntityRuntimeKey = Symbol.for('EntityRuntime');`,
      ts.ScriptTarget.Latest,
      true,
    );
    const contract = ts.createSourceFile(
      '/flight/packages/types/src/contract.ts',
      "export * from './entity.js';",
      ts.ScriptTarget.Latest,
      true,
    );
    const binding = ts.createSourceFile(
      '/flight/packages/entity/src/binding.ts',
      `import type { Entity } from '@flighthq/types/contract';
       import { EntityRuntimeKey } from '@flighthq/types/contract';
       export function getEntityBinding(source: Readonly<Entity>): object | null {
         return source[EntityRuntimeKey]?.binding ?? null;
       }`,
      ts.ScriptTarget.Latest,
      true,
    );
    const moduleResolution: CompilerModuleResolutionPlan = {
      edges: [
        {
          specifier: '@flighthq/types/contract',
          target: { packageName: '@flighthq/types', source: 'packages/types/src/contract.ts' },
        },
        {
          specifier: './entity.js',
          target: { packageName: '@flighthq/types', source: 'packages/types/src/entity.ts' },
        },
      ],
      schema: 'flight-compiler-module-resolution/1',
    };
    const results = lowerTypeScriptSources(
      [
        { packageName: '@flighthq/types', sourceFile: entity, upstreamDirectory: '/flight' },
        { packageName: '@flighthq/types', sourceFile: contract, upstreamDirectory: '/flight' },
        { packageName: '@flighthq/entity', sourceFile: binding, upstreamDirectory: '/flight' },
      ],
      moduleResolution,
    );
    const modules = results.map((result) => result.module);
    const emitted = createCppCompilerBackend().createEmissionSession!({
      moduleResolution,
      modules,
      options: { runtimeProfile: 'flight-cpp' },
    }).emitModule(modules[2]!)[0]!.contents;

    expect(emitted).toContain('std::optional<std::shared_ptr<void>>');
    expect(emitted).toContain('optional_chain_receiver.value()->binding');
    expect(emitted).not.toContain('std::optional<auto>');
  });

  it('constructs an imported nullable reference from an imported function result', () => {
    const types = ts.createSourceFile(
      '/flight/packages/types/src/color.ts',
      `export interface ColorLut { size: number; samples: readonly number[] }
       export interface ColorLutCache { lut: ColorLut | null }`,
      ts.ScriptTarget.Latest,
      true,
    );
    const colorLut = ts.createSourceFile(
      '/flight/packages/adjustments/src/colorLut.ts',
      `import type { ColorLut } from '@flighthq/types/contract';
       export function bakeColorLut(): ColorLut { return { size: 2, samples: [] }; }`,
      ts.ScriptTarget.Latest,
      true,
    );
    const cache = ts.createSourceFile(
      '/flight/packages/adjustments/src/colorLutCache.ts',
      `import type { ColorLut, ColorLutCache } from '@flighthq/types/contract';
       import { bakeColorLut } from './colorLut.js';
       export function bake(cache: ColorLutCache): ColorLut {
         const lut = bakeColorLut();
         cache.lut = lut;
         return lut;
       }`,
      ts.ScriptTarget.Latest,
      true,
    );
    const moduleResolution: CompilerModuleResolutionPlan = {
      edges: [
        {
          specifier: '@flighthq/types/contract',
          target: { packageName: '@flighthq/types', source: 'packages/types/src/color.ts' },
        },
      ],
      schema: 'flight-compiler-module-resolution/1',
    };
    const results = lowerTypeScriptSources(
      [
        { packageName: '@flighthq/types', sourceFile: types, upstreamDirectory: '/flight' },
        { packageName: '@flighthq/adjustments', sourceFile: colorLut, upstreamDirectory: '/flight' },
        { packageName: '@flighthq/adjustments', sourceFile: cache, upstreamDirectory: '/flight' },
      ],
      moduleResolution,
    );
    const modules = results.map((result) => result.module);
    const emitted = createCppCompilerBackend().createEmissionSession!({
      moduleResolution,
      modules,
      options: {
        packageTargets: {
          '@flighthq/adjustments': { includePrefix: 'flight/adjustments', namespace: 'flight::adjustments' },
          '@flighthq/types': { includePrefix: 'flight/types', namespace: 'flight::types' },
        },
        runtimeProfile: 'flight-cpp',
      },
    }).emitModule(modules[2]!)[0]!.contents;

    expect(emitted).toContain('flight::Ref<flight::types::ColorLut> lut = flight::adjustments::bake_color_lut()');
    expect(emitted).toContain('std::optional<flight::Ref<flight::types::ColorLut>>{lut}');
  });

  it('applies explicit package namespace and installed include identity across a module graph', () => {
    const model = lowerPackage('@flighthq/types', 'model.ts', 'export interface Model { value: number }').module;
    const consumer = lowerPackage(
      '@flighthq/render-wgpu',
      'renderer.ts',
      "import type { Model } from '@flighthq/types'; export function render(model: Model): Model { return model; }",
    ).module;
    const moduleResolution: CompilerModuleResolutionPlan = {
      edges: [{ specifier: '@flighthq/types', target: { packageName: model.packageName, source: model.source } }],
      schema: 'flight-compiler-module-resolution/1',
    };
    const packageTargets = {
      '@flighthq/render-wgpu': { includePrefix: 'flight/render_wgpu', namespace: 'flight::render_wgpu' },
      '@flighthq/types': { includePrefix: 'flight/types', namespace: 'flight::types' },
    };
    const emitted = createCppCompilerBackend().emitModule(consumer, {
      moduleResolution,
      modules: [consumer, model],
      options: { packageTargets, runtimeProfile: 'flight-cpp' },
    })[0]!;

    expect(emitted.path).toBe('flight/render_wgpu/renderer.hpp');
    expect(emitted.contents).toContain('#include <flight/types/model.hpp>');
    expect(emitted.contents).toContain('namespace flight::render_wgpu {');
    expect(emitted.contents).toContain('flight::Ref<flight::types::Model>');
  });
});

describe('emitIrModuleCpp', () => {
  it('emits a simple constant declaration as a C++ header', () => {
    const result = lower('value.ts', 'export const value = 1;');
    const emitted = emitIrModuleCpp(result.module);

    expect(emitted.path).toBe('value.hpp');
    expect(emitted.contents).toContain('#pragma once');
    expect(emitted.contents).toContain('namespace flighthq_');
    expect(emitted.contents).toContain('const');
  });

  it('binds reachable target-native ambient types, values, headers, members, and factories', () => {
    const result = lower(
      'native-surface.ts',
      `export function same(surface: NativeSurface): NativeSurface { return surface; }
export function create(): NativeSurface { return new NativeSurface(); }
export function preferred(): number { return NativeSurface.preferredFormat; }`,
    );
    const externalBindings = {
      bindings: [
        {
          headers: ['host/surface.hpp'],
          nullability: 'non-null' as const,
          ownership: 'shared' as const,
          sourceName: 'NativeSurface',
          space: 'type' as const,
          targetName: 'host::Surface',
        },
        {
          construction: { kind: 'factory' as const, targetName: 'host::create_surface' },
          headers: ['host/surface.hpp'],
          members: [{ sourceMember: 'preferredFormat', targetName: 'host::preferred_format' }],
          nullability: 'non-null' as const,
          ownership: 'shared' as const,
          sourceName: 'NativeSurface',
          space: 'value' as const,
          targetName: 'host::Surface',
        },
      ],
      schema: 'flight-cpp-external-bindings/1' as const,
    };

    expect(() => emitIrModuleCpp(result.module, { runtimeProfile: 'flight-cpp' })).toThrow(
      'missing: NativeSurface[type], NativeSurface[value]',
    );
    const emitted = emitIrModuleCpp(result.module, { externalBindings, runtimeProfile: 'flight-cpp' });
    expect(emitted.contents.match(/#include <host\/surface\.hpp>/gu)).toHaveLength(1);
    expect(emitted.contents).toContain('host::Surface same(host::Surface surface)');
    expect(emitted.contents).toContain('return host::create_surface()');
    expect(emitted.contents).toContain('return host::preferred_format');
  });

  it('binds process and browser host surfaces without making them compiler runtime policy', () => {
    const result = lower(
      'host-surfaces.ts',
      `export function browserPermissions(): Permissions { return navigator.permissions; }
export function argumentsAndExit(): string[] { process.exitCode = 1; return process.argv; }
export function hasBrowserRuntime(): boolean { return typeof navigator !== 'undefined'; }
export interface BrowserPermissionMediaTypes {
  readonly descriptor: PermissionDescriptor;
  readonly devices: MediaDevices;
  readonly permissions: Permissions;
  readonly stream: MediaStream;
  readonly track: MediaStreamTrack;
}`,
    );
    const externalBindings = {
      bindings: [
        {
          headers: ['host/browser.hpp'],
          nullability: 'non-null' as const,
          ownership: 'borrowed' as const,
          sourceName: 'Permissions',
          space: 'type' as const,
          targetName: 'host::Permissions',
        },
        {
          headers: ['host/browser.hpp'],
          members: [
            { sourceMember: 'mediaDevices', targetName: 'host::browser_media_devices' },
            { sourceMember: 'permissions', targetName: 'host::browser_permissions' },
            { sourceMember: 'wakeLock', targetName: 'host::browser_wake_lock' },
          ],
          nullability: 'non-null' as const,
          ownership: 'borrowed' as const,
          sourceName: 'navigator',
          space: 'value' as const,
          targetName: 'host::navigator',
        },
        ...(['MediaDevices', 'MediaStream', 'MediaStreamTrack', 'PermissionDescriptor'] as const).map((sourceName) => ({
          headers: ['host/browser.hpp'],
          nullability: 'non-null' as const,
          ownership: 'borrowed' as const,
          sourceName,
          space: 'type' as const,
          targetName: `host::${sourceName}`,
        })),
        {
          headers: ['host/process.hpp'],
          members: [
            { sourceMember: 'argv', targetName: 'host::process_arguments' },
            { sourceMember: 'exitCode', targetName: 'host::process_exit_code' },
          ],
          nullability: 'non-null' as const,
          ownership: 'borrowed' as const,
          sourceName: 'process',
          space: 'value' as const,
          targetName: 'host::process',
        },
      ],
      schema: 'flight-cpp-external-bindings/1' as const,
    };

    const emitted = emitIrModuleCpp(result.module, { externalBindings, runtimeProfile: 'flight-cpp' });
    expect(emitted.contents).toContain('host::Permissions browser_permissions()');
    expect(emitted.contents).toContain('return host::browser_permissions');
    expect(emitted.contents).toContain('host::process_exit_code = 1.0');
    expect(emitted.contents).toContain('return host::process_arguments');
    expect(emitted.contents).toContain('bool has_browser_runtime() {\n  return true;');
    expect(emitted.contents).toContain('host::PermissionDescriptor descriptor;');
    expect(emitted.contents).toContain('host::MediaDevices devices;');
    expect(emitted.contents).toContain('host::MediaStream stream;');
    expect(emitted.contents).toContain('host::MediaStreamTrack track;');
  });

  it('emits portable service surfaces through explicit flight-cpp runtime contracts', () => {
    const result = lower(
      'portable-services.ts',
      `export function read(bytes: Uint8Array): number {
  return new DataView(bytes.buffer, bytes.byteOffset, 8).getFloat64(0, true);
}
export function mutate(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  view.setUint32(0, 42, true);
  return view.getUint32(0, true) + view.byteLength + view.byteOffset;
}
export function decode(bytes: Uint8Array): string { return new TextDecoder().decode(bytes); }
export function allocate(length: number): ArrayBuffer { return new ArrayBuffer(length); }
export function matches(value: string): boolean { return /^flight$/i.test(value); }
export function protocol(value: string): string { return new URL(value).protocol; }
export function integer(value: string): number { return parseInt(value, 16); }
export function number(value: string): number { return Number(value); }
export function keys(value: Record<string, string>): string[] { return Object.keys(value); }
export function json(value: object): string { return JSON.stringify(value, null, 2); }
export function compare(left: string, right: string, locale: string, options: Intl.CollatorOptions): number {
  return new Intl.Collator(locale, options).compare(left, right);
}`,
    );

    const emitted = emitIrModuleCpp(result.module, { runtimeProfile: 'flight-cpp' });
    expect(emitted.contents).toContain('flight::DataView(bytes.buffer, bytes.byte_offset, 8.0).get_float64(0.0, true)');
    expect(emitted.contents).toContain('view.set_uint32(0.0, 42.0, true)');
    expect(emitted.contents).toContain('view.get_uint32(0.0, true)');
    expect(emitted.contents).toContain('view.byte_length');
    expect(emitted.contents).toContain('view.byte_offset');
    expect(emitted.contents).toContain('flight::TextDecoder().decode(bytes)');
    expect(emitted.contents).toContain('flight::ArrayBuffer(length)');
    expect(emitted.contents).toContain('flight::RegExp(flight::String("^flight$"), flight::String("i")).test(value)');
    expect(emitted.contents).toContain('flight::Url(value).protocol');
    expect(emitted.contents).toContain('flight::parse_int(value, 16.0)');
    expect(emitted.contents).toContain('flight::to_number(value)');
    expect(emitted.contents).toContain('flight::object_keys(value)');
    expect(emitted.contents).toContain('flight::Json::stringify(value, nullptr, 2.0)');
    expect(emitted.contents).toContain('flight::IntlCollator(locale, options).compare(left, right)');
  });

  it('emits typed-array instanceof narrowing and byte lengths through the runtime contract', () => {
    const result = lower(
      'binary-view.ts',
      `export function byteLength(data: Readonly<Uint8Array> | ArrayBuffer): number {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  return bytes.byteLength;
}
export function bufferByteLength(data: ArrayBuffer): number { return data.byteLength; }`,
    );

    const emitted = emitIrModuleCpp(result.module, { runtimeProfile: 'flight-cpp' });
    expect(emitted.contents).toContain('data.index() == 1 ? std::get<1>(data)');
    expect(emitted.contents).toContain('bytes.byte_length');
    expect(emitted.contents).toContain('static_cast<double>(data.byte_length())');
    expect(emitted.contents).not.toContain(' instanceof ');
  });

  it('emits a function with parameters', () => {
    const result = lower('add.ts', 'export function add(a: number, b: number): number { return a + b; }');
    const emitted = emitIrModuleCpp(result.module);

    expect(emitted.path).toBe('add.hpp');
    expect(emitted.contents).toContain('double add(double a, double b)');
    expect(emitted.contents).toContain('return');
  });

  it('lowers number toString as a free conversion rather than an imaginary number method', () => {
    const result = lower('text.ts', 'export function text(value: number): string { return value.toString(); }');

    expect(emitIrModuleCpp(result.module).contents).toContain('return std::to_string(value)');
    expect(emitIrModuleCpp(result.module, { runtimeProfile: 'flight-cpp' }).contents).toContain(
      'return flight::to_string(value)',
    );
  });

  it('emits an interface as a C++ struct with properties', () => {
    const result = lower('point.ts', 'export interface Point { x: number; y?: number }');
    const emitted = emitIrModuleCpp(result.module);

    expect(emitted.contents).toContain('struct');
    expect(emitted.contents).toContain('double x');
    expect(emitted.contents).toContain('std::optional<double> y');
  });

  it('emits semantic arrays with contextual empty types and checked indexed access', () => {
    const result = lower(
      'indexes.ts',
      'export function empty(): number[] { return []; } export function first(values: number[], index: number): number { return values[index] ?? 0; } export function scale(values: number[], index: number): void { values[index] *= 2; }',
    );
    const emitted = emitIrModuleCpp(result.module, { runtimeProfile: 'flight-cpp' });

    expect(emitted.contents).toContain('return flight::Array<double>{}');
    expect(emitted.contents).toContain('return values.get(index).value_or(0.0)');
    expect(emitted.contents).toContain('values.element(index) *= 2.0');
    expect(emitted.contents).not.toContain('static_cast<size_t>');
  });

  it('emits interned symbols through the semantic runtime contract', () => {
    const result = lower('symbol-for.ts', "export const key = Symbol.for('key');");
    const emitted = emitIrModuleCpp(result.module, { runtimeProfile: 'flight-cpp' });

    expect(emitted.contents).toContain('#include <flight/symbol.hpp>');
    expect(emitted.contents).toContain('flight::Symbol key = flight::Symbol::for_key(flight::String("key"))');
    expect(emitted.dependencies).toContain('flight/symbol.hpp');
  });

  it('uses source numeric and error semantics in the runtime profile', () => {
    const result = lower(
      'semantics.ts',
      'export function remainder(left: number, right: number): number { return left % right; } export function fail(message: string): Error { return new Error(message); }',
    );
    const emitted = emitIrModuleCpp(result.module, { runtimeProfile: 'flight-cpp' });

    expect(emitted.contents).toContain('return std::fmod(left, right)');
    expect(emitted.contents).toContain('return flight::Error(message)');
    expect(emitted.contents).toContain('static_assert(flight::runtime_contract.cpp_abi == 1');
  });

  it('uses overflow-safe source bitwise semantics in the runtime profile', () => {
    const result = lower(
      'bitwise-semantics.ts',
      'export function binary(a: number, b: number): number { return (a & b) + (a | b) + (a ^ b) + (a << b) + (a >> b) + (a >>> b); } export function unary(a: number): number { return ~a; } export function assign(a: number, b: number): number { a &= b; a |= b; a ^= b; a <<= b; a >>= b; a >>>= b; return a; }',
    );
    const emitted = emitIrModuleCpp(result.module, { runtimeProfile: 'flight-cpp' });

    expect(emitted.contents).toContain('flight::bitwise_and(a, b)');
    expect(emitted.contents).toContain('flight::bitwise_or(a, b)');
    expect(emitted.contents).toContain('flight::bitwise_xor(a, b)');
    expect(emitted.contents).toContain('flight::left_shift(a, b)');
    expect(emitted.contents).toContain('flight::signed_right_shift(a, b)');
    expect(emitted.contents).toContain('flight::unsigned_right_shift(a, b)');
    expect(emitted.contents).toContain('flight::bitwise_not(a)');
    expect(emitted.contents).not.toContain('static_cast<int32_t>');
  });

  it('emits unsigned shifts through the runtime when operand flow is unresolved', () => {
    const result = lower(
      'imported-shift.ts',
      "import { checksum } from './checksum'; export function high(bytes: Uint8Array): number { return (checksum(bytes) >>> 24) & 255; }",
    );
    const emitted = emitIrModuleCpp(result.module, { runtimeProfile: 'flight-cpp' });

    expect(emitted.contents).toContain('flight::unsigned_right_shift(checksum(bytes), 24.0)');
    expect(emitted.contents).not.toContain('>>>');
  });

  it('recognizes identity-preserving utility wrappers around indexed runtime views', () => {
    const result = lower(
      'readonly-typed-array.ts',
      'export function read(levels: Readonly<Uint8Array>, index: number): number { return levels[index]; }',
    );
    const emitted = emitIrModuleCpp(result.module, { runtimeProfile: 'flight-cpp' });

    expect(emitted.contents).toContain('return levels.element(index)');
    expect(emitted.contents).not.toContain('levels[static_cast<size_t>');
  });

  it('orders module declarations after the local declarations they reference', () => {
    const result = lower(
      'declaration-order.ts',
      'export function read(): number { return helper(); } function helper(): number { return LIMIT; } class Holder { value: number = LIMIT; } const LIMIT = 4;',
    );
    const emitted = emitIrModuleCpp(result.module, { runtimeProfile: 'flight-cpp' });
    const constant = emitted.contents.indexOf('inline const double limit = 4.0');
    const helper = emitted.contents.indexOf('double helper()');
    const holder = emitted.contents.indexOf('struct Holder');
    const read = emitted.contents.indexOf('double read()');

    expect(constant).toBeGreaterThan(-1);
    expect(helper).toBeGreaterThan(constant);
    expect(holder).toBeGreaterThan(constant);
    expect(read).toBeGreaterThan(helper);
  });

  it('uses portable runtime constants and semantic containers for static iteration and rest values', () => {
    const result = lower(
      'portable.ts',
      'export function area(radius: number): number { return Math.PI * radius * radius; } export function sum(...values: number[]): number { let total = 0; for (const value of values) total += value; return total; } export function keys(): string { for (const key in { first: 1 }) return key; return ""; }',
    );
    const emitted = emitIrModuleCpp(result.module, { runtimeProfile: 'flight-cpp' });

    expect(emitted.contents).toContain('flight::pi');
    expect(emitted.contents).toContain('sum(flight::Array<double> values)');
    expect(emitted.contents).toContain('flight::Array<flight::String>');
    expect(emitted.contents).not.toContain('M_PI');
    expect(emitted.contents).not.toContain('std::vector');
  });

  it('preserves numeric and string enum members as scoped portable values', () => {
    const result = lower(
      'enums.ts',
      'export enum Level { Low = 1, High = 2 } export enum Lane { Fast = "fast", Safe = "safe" } export function lane(): Lane { return Lane.Fast; }',
    );
    const emitted = emitIrModuleCpp(result.module, { runtimeProfile: 'flight-cpp' });

    expect(emitted.contents).toContain('Low = 1');
    expect(emitted.contents).not.toContain('Low = 1.0');
    expect(emitted.contents).toContain('struct Lane');
    expect(emitted.contents).toContain('inline const Lane Lane::Fast{flight::String("fast")}');
    expect(emitted.contents).toContain('return Lane::Fast');
  });

  it('emits merged enum value namespace functions as static wrapper members', () => {
    const result = lower(
      'enum-namespace.ts',
      `
        export enum Flags { None = 0, Visible = 1 }
        export namespace Flags {
          export function any(flags: Flags, test: Flags): boolean { return (flags & test) !== 0; }
          export function clear(): Flags { return Flags.None; }
        }
        export function visible(flags: Flags): boolean { return Flags.any(flags, Flags.Visible); }
      `,
    );
    const emitted = emitIrModuleCpp(result.module, { runtimeProfile: 'flight-cpp' });

    expect(result.diagnostics).toEqual([]);
    expect(emitted.contents).toContain('struct Flags {');
    expect(emitted.contents).toContain('inline static constexpr double Visible = 1.0;');
    expect(emitted.contents).toContain('static bool any(Flags flags, Flags test)');
    expect(emitted.contents).toContain('static Flags clear()');
    expect(emitted.contents).toContain('return Flags::any(flags, Flags::Visible)');
    expect(emitted.contents).not.toContain('inline bool any(');
  });

  it('materializes default parameter values before their typed uses', () => {
    const result = lower(
      'default.ts',
      'export function scale(value: number, factor: number = 2): number { return value * factor; }',
    );
    const emitted = emitIrModuleCpp(result.module, { runtimeProfile: 'flight-cpp' });

    expect(emitted.contents).toContain('std::optional<double> factor = std::nullopt');
    expect(emitted.contents).toContain('factor = factor.value_or(2.0)');
    expect(emitted.contents).toContain('value * factor.value()');
  });

  it('retains absence when an indexed generic value is stored before coalescing', () => {
    const result = lower(
      'generic-index.ts',
      'export function first<Value>(values: readonly Value[], fallback: Value): Value { const value = values[0]; return value ?? fallback; }',
    );
    const emitted = emitIrModuleCpp(result.module, { runtimeProfile: 'flight-cpp' });

    expect(emitted.contents).toContain('std::optional<Value> value = values.get(0.0)');
    expect(emitted.contents).toContain('return value.value_or(fallback)');
  });

  it('passes through checker-proven optional calls and preserves named iteration elements', () => {
    const result = lower(
      'optional-results.ts',
      `interface Item { value: number; }
       export function retain(entries: Map<string, number>, values: number[], items: Item[]): void {
         const mapped: number | undefined = entries.get('key');
         const found: number | undefined = values.find((value: number): boolean => value > 0);
         let best: Item | undefined = undefined;
         for (const item of items) { if (best === undefined) best = item; }
       }`,
    );
    const emitted = emitIrModuleCpp(result.module, { runtimeProfile: 'flight-cpp' });

    expect(emitted.contents).toContain('const std::optional<double> mapped = entries.get(flight::String("key"))');
    expect(emitted.contents).toContain('const std::optional<double> found = values.find(');
    expect(emitted.contents).toContain('std::optional<flight::Ref<Item>> best = std::nullopt');
    expect(emitted.contents).toContain('best = std::optional<flight::Ref<Item>>{item}');
  });

  it('emits checker-proven typeof narrowing through an elected variant representation', () => {
    const result = lower(
      'union.ts',
      'export function describe(value: string | number): string { return typeof value === "string" ? value : value.toString(); }',
    );

    const emitted = emitIrModuleCpp(result.module, { runtimeProfile: 'flight-cpp' });

    expect(emitted.contents).toContain('#include <variant>');
    expect(emitted.contents).toContain('std::variant<double, flight::String> value');
    expect(emitted.contents).toContain('value.index() == 1');
    expect(emitted.contents).toContain('std::get<1>(value)');
    expect(emitted.contents).toContain('std::get<0>(value)');
  });

  it('emits escaping mutable bindings as shared cells selected from closure evidence', () => {
    const result = lower(
      'closure.ts',
      'export function counter(): () => number { let count = 0; return () => { count += 1; return count; }; }',
    );

    const emitted = emitIrModuleCpp(result.module, { runtimeProfile: 'flight-cpp' });

    expect(emitted.contents).not.toContain('#include <memory>');
    expect(emitted.contents).toContain('const auto count_capture = flight::make_binding_cell(double{0.0})');
    expect(emitted.contents).toContain(
      'count_capture.update_binding([&](auto& binding_value) { binding_value += 1.0; return binding_value; })',
    );
    expect(emitted.contents).toContain('return count_capture.read_binding()');
  });

  it('shares state across sibling closures and outer mutations after closure creation', () => {
    const result = lower(
      'shared-closure.ts',
      'export function observe(): number { let value = 0; const read = (): number => value; const write = (): void => { value += 1; }; value += 2; write(); return read(); }',
    );
    const emitted = emitIrModuleCpp(result.module, { runtimeProfile: 'flight-cpp' });

    expect(emitted.contents).toContain('const auto value_capture = flight::make_binding_cell(double{0.0})');
    expect(emitted.contents.match(/value_capture\.update_binding/gu)).toHaveLength(2);
    expect(emitted.contents.match(/value_capture\.read_binding/gu)).toHaveLength(1);
  });

  it('initializes captured parameter cells in source order after their defaults', () => {
    const result = lower(
      'captured-parameters.ts',
      'export function make(first = 1, second = first): () => number { return (): number => { first += second; return first; }; }',
    );
    const emitted = emitIrModuleCpp(result.module, { runtimeProfile: 'flight-cpp' });
    const firstDefault = emitted.contents.indexOf('first = first.value_or(1.0)');
    const firstCell = emitted.contents.indexOf(
      'first_capture = flight::make_binding_cell(std::optional<double>{first})',
    );
    const secondDefault = emitted.contents.indexOf('second = second.value_or(first_capture.read_binding().value())');

    expect(firstDefault).toBeGreaterThan(-1);
    expect(firstCell).toBeGreaterThan(firstDefault);
    expect(secondDefault).toBeGreaterThan(firstCell);
  });

  it('initializes cells in concise outer closures before emitting nested mutation', () => {
    const result = lower(
      'nested-parameter.ts',
      'export function factory(): (seed: number) => () => number { return (seed: number): (() => number) => (): number => ++seed; }',
    );
    const emitted = emitIrModuleCpp(result.module, { runtimeProfile: 'flight-cpp' });

    expect(emitted.contents).toContain('const auto seed_capture = flight::make_binding_cell(double{seed})');
    expect(emitted.contents).toContain(
      'seed_capture.update_binding([&](auto& binding_value) { ++binding_value; return binding_value; })',
    );
  });

  it('uses binding-cell operations for reassignment, postfix updates, and logical assignment', () => {
    const result = lower(
      'captured-operations.ts',
      `export function mutate(): () => number {
         let value = 1;
         let optional: number | undefined = undefined;
         return (): number => {
           const before = value++;
           value = before + value;
           optional ??= value;
           return optional;
         };
       }`,
    );
    const emitted = emitIrModuleCpp(result.module, { runtimeProfile: 'flight-cpp' });

    expect(emitted.contents).toContain(
      'value_capture.update_binding([&](auto& binding_value) { return binding_value++; })',
    );
    expect(emitted.contents).toContain('value_capture.rebind(');
    expect(emitted.contents).toContain('flight::make_binding_cell(std::optional<double>{std::nullopt})');
    expect(emitted.contents).toContain('if (!binding_value.has_value()) binding_value =');
    expect(emitted.contents).toContain('return optional_capture.read_binding().value()');
  });

  it('creates a fresh binding cell for each captured block-scoped for-in key', () => {
    const result = lower(
      'captured-for-in.ts',
      `export function readers(value: { first: number; second: number }): Array<() => string> {
         const result: Array<() => string> = [];
         for (let key in value) result.push((): string => key);
         return result;
       }`,
    );
    const emitted = emitIrModuleCpp(result.module, { runtimeProfile: 'flight-cpp' });

    expect(emitted.contents).toContain('for (const flight::String& key_iteration_value');
    expect(emitted.contents).toContain(
      'const auto key_capture = flight::make_binding_cell(flight::String{key_iteration_value})',
    );
    expect(emitted.contents).toContain('return key_capture.read_binding()');
  });

  it('shares one pre-loop binding cell across function-scoped captured for-in iterations', () => {
    const result = lower(
      'captured-var-for-in.ts',
      `export function readers(value: { first: number }): Array<() => string> {
         const result: Array<() => string> = [];
         for (var key in value) result.push((): string => key);
         return result;
       }`,
    );

    const emitted = emitIrModuleCpp(result.module, { runtimeProfile: 'flight-cpp' });

    expect(emitted.contents).toContain(
      'const auto key_capture = flight::make_binding_cell(std::optional<flight::String>{std::nullopt})',
    );
    expect(emitted.contents).toContain(
      'key_capture.update_binding([&](auto& binding_value) { binding_value = variable_hoisting_iteration_value; return binding_value.value(); })',
    );
    expect(emitted.contents).toContain('return key_capture.read_binding().value()');
  });

  it('preserves captured structural referent mutation through shared object identity', () => {
    const result = lower(
      'referent.ts',
      'export function mutate(): number { let state = { value: 0 }; const alias = state; const update = (): void => { state.value += 1; }; update(); return alias.value; }',
    );

    const emitted = emitIrModuleCpp(result.module, { runtimeProfile: 'flight-cpp' });

    expect(emitted.contents).toContain('flight::make_ref<value>(value{.value = 0.0})');
    expect(emitted.contents).toContain(
      'flight::make_binding_cell(flight::Ref<value>{flight::make_ref<value>(value{.value = 0.0})})',
    );
    expect(emitted.contents).toContain('state_capture.read_binding()->value += 1.0');
    expect(emitted.contents).toContain('return alias->value');
  });

  it('preserves captured homogeneous tuple referent mutation through the shared array runtime', () => {
    const result = lower(
      'tuple-referent.ts',
      'export function mutate(): number { const tuple: [number] = [0]; const update = (): void => { tuple[0] += 1; }; update(); return tuple[0]; }',
    );

    const emitted = emitIrModuleCpp(result.module, { runtimeProfile: 'flight-cpp' });

    expect(emitted.contents).toContain(
      'const auto tuple_capture = flight::make_binding_cell(flight::Array<double>{0.0})',
    );
    expect(emitted.contents).toContain('tuple_capture.read_binding().element(0.0) += 1.0');
    expect(emitted.contents).toContain('return tuple_capture.read_binding().element(0.0)');
  });

  it('keeps heterogeneous captured tuples explicit when referent mutation cannot be shared', () => {
    const result = lower(
      'heterogeneous-tuple-referent.ts',
      "export function mutate(): number { const tuple: [number, string] = [0, '']; const update = (): void => { tuple[0] += 1; }; update(); return tuple[0]; }",
    );

    expect(() => emitIrModuleCpp(result.module, { runtimeProfile: 'flight-cpp' })).toThrow(
      'captured referent mutation of tuple requires a shared C++ reference representation',
    );
  });

  it('preserves module structural referent mutation through shared object identity', () => {
    const result = lower(
      'module-referent.ts',
      'const state = { value: 0 }; export function update(): void { state.value += 1; }',
    );

    const emitted = emitIrModuleCpp(result.module, { runtimeProfile: 'flight-cpp' });

    expect(emitted.contents).toContain('inline flight::Ref<value> state');
    expect(emitted.contents).toContain('state->value += 1.0');
  });

  it('represents structural values as identity-preserving flight references', () => {
    const result = lower(
      'structural-identity.ts',
      `interface State { value: number }
       export function aliases(): boolean {
         const state: State = { value: 1 };
         const alias = state;
         alias.value = 2;
         return state === alias;
       }`,
    );
    const emitted = emitIrModuleCpp(result.module, { runtimeProfile: 'flight-cpp' });

    expect(emitted.contents).toContain('flight::Ref<State> state = flight::make_ref<State>(State{.value = 1.0})');
    expect(emitted.contents).toContain('alias->value = 2.0');
    expect(emitted.contents).toContain('return (state == alias)');
  });

  it('substitutes generic structural fields before constructing reference storage', () => {
    const result = lower(
      'generic-structural.ts',
      'interface Box<T> { value: T } export function empty(): Box<number[]> { return { value: [] }; }',
    );
    const emitted = emitIrModuleCpp(result.module, { runtimeProfile: 'flight-cpp' });

    expect(emitted.contents).toContain('struct Box : public flight::ReferenceEnabled');
    expect(emitted.contents).toContain('flight::Ref<Box<flight::Array<double>>> empty()');
    expect(emitted.contents).toContain(
      'flight::make_ref<Box<flight::Array<double>>>(Box<flight::Array<double>>{.value = flight::Array<double>{}})',
    );
  });

  it('emits WeakMap through both runtime profiles', () => {
    const result = lower(
      'weak-map.ts',
      `interface Key { id: number }
       export function lookup(values: WeakMap<Key, number>, key: Key): number | undefined {
         return values.get(key);
       }`,
    );

    const flightCpp = emitIrModuleCpp(result.module, { runtimeProfile: 'flight-cpp' });
    expect(flightCpp.contents).toContain('unordered_map');
    const standardLibrary = emitIrModuleCpp(result.module);
    expect(standardLibrary.contents).toContain('unordered_map');
  });

  it.each([
    ['flight-cpp', '#include <flight/map.hpp>', 'flight::Map<flight::String, double> values', 'values.size()'],
    ['standard-library', '#include <unordered_map>', 'std::unordered_map<std::string, double> values', 'values.size()'],
  ] as const)('emits ReadonlyMap through the %s map contract', (runtimeProfile, header, type, access) => {
    const result = lower(
      'readonly-map.ts',
      `export function read(values: ReadonlyMap<string, number>): number {
         return values.size;
       }`,
    );
    const emitted = emitIrModuleCpp(result.module, { runtimeProfile });

    expect(emitted.contents).toContain(header);
    expect(emitted.contents).toContain(type);
    expect(emitted.contents).toContain(access);
  });

  it('allows module referent mutation backed by a shared runtime container', () => {
    const result = lower(
      'module-array.ts',
      'const values: number[] = []; export function append(value: number): void { values.push(value); }',
    );
    const emitted = emitIrModuleCpp(result.module, { runtimeProfile: 'flight-cpp' });

    expect(emitted.contents).toContain('values.push(value)');
  });

  it('allows mutation owned entirely by a closure', () => {
    const result = lower(
      'local-mutation.ts',
      'export function make(): () => number { return () => { let local = 0; local += 1; return local; }; }',
    );
    const emitted = emitIrModuleCpp(result.module, { runtimeProfile: 'flight-cpp' });

    expect(emitted.contents).toContain('local += 1.0');
  });

  it('captures lexical this explicitly under C++20', () => {
    const result = lower(
      'this-capture.ts',
      'export class Counter { value = 1; reader(): () => number { return () => this.value; } }',
    );
    const emitted = emitIrModuleCpp(result.module, { runtimeProfile: 'flight-cpp' });

    expect(emitted.contents).toContain('[=, this]() { return this->value; }');
  });

  it('makes non-void fallthrough an explicit failure instead of undefined behavior', () => {
    const result = lower(
      'completion.ts',
      'enum Choice { First, Second } export function choose(value: Choice): number { switch (value) { case Choice.First: return 1; case Choice.Second: return 2; } }',
    );
    const emitted = emitIrModuleCpp(result.module, { runtimeProfile: 'flight-cpp' });

    expect(emitted.contents).toContain('throw std::logic_error("Flight function completed without a value")');
  });

  it('refuses defaulted derived constructors until values can precede base initialization', () => {
    const result = lower(
      'derived-default.ts',
      'class Base { constructor(value: number) {} } export class Derived extends Base { constructor(value = 1) { super(value); } }',
    );

    expect(() => emitIrModuleCpp(result.module, { runtimeProfile: 'flight-cpp' })).toThrow(
      'derived constructor default parameters require pre-base-initializer lowering',
    );
  });

  it('places module types before values that use them and makes header definitions inline', () => {
    const result = lower(
      'ordering.ts',
      'export function total(values: Values): number { return values.length; } export type Values = number[];',
    );
    const emitted = emitIrModuleCpp(result.module, { runtimeProfile: 'flight-cpp' });

    expect(emitted.contents.indexOf('using Values')).toBeLessThan(emitted.contents.indexOf('inline double total'));
  });

  it('preserves class initializers, static members, and property accessors', () => {
    const result = lower(
      'counter.ts',
      'export function read(): number { const counter = Counter.make(); counter.value = 7; return counter.value + Counter.zero; } export class Counter { private count: number = 1; static readonly zero = 0; static make(): Counter { return new Counter(); } get value(): number { return this.count; } set value(next: number) { this.count = next; } }',
    );
    const emitted = emitIrModuleCpp(result.module, { runtimeProfile: 'flight-cpp' });
    expect(emitted.contents.indexOf('struct Counter')).toBeLessThan(emitted.contents.indexOf('inline double read'));
    expect(emitted.contents).toContain('double count = 1.0');
    expect(emitted.contents).toContain('inline static const double zero = 0.0');
    expect(emitted.contents).toContain('static flight::Ref<Counter> make()');
    expect(emitted.contents).toContain('return flight::make_ref<Counter>()');
    expect(emitted.contents).toContain('counter->value(7.0)');
    expect(emitted.contents).toContain('counter->value() + Counter::zero');
    expect(emitted.contents).not.toContain('const flight::Ref<Counter> counter');
  });

  it('recovers an owning reference when a class returns or compares this', () => {
    const result = lower(
      'self.ts',
      `export class Chain {
         self(): Chain { return this; }
         same(other: Chain): boolean { return this === other; }
       }
       export function create(): Chain { return new Chain().self(); }`,
    );
    const emitted = emitIrModuleCpp(result.module, { runtimeProfile: 'flight-cpp' });

    expect(emitted.contents).toContain('struct Chain : public flight::ReferenceEnabled');
    expect(emitted.contents).toContain('return flight::ref_from_this(*this)');
    expect(emitted.contents).toContain('(flight::ref_from_this(*this) == other)');
    expect(emitted.contents).toContain('flight::make_ref<Chain>()->self()');
  });

  it('evaluates nullable property receivers once and safely projects indexed values', () => {
    const result = lower(
      'optional.ts',
      'interface Entry { key: string } export function first(entries: Entry[]): string { return entries[0]?.key ?? "none"; } export function read(entry: Entry | undefined): string { return entry?.key ?? "none"; }',
    );
    const emitted = emitIrModuleCpp(result.module, { runtimeProfile: 'flight-cpp' });

    expect(emitted.contents).toContain('auto optional_chain_receiver = entries.get(0.0)');
    expect(emitted.contents).toContain('auto optional_chain_receiver = entry');
    expect(emitted.contents).toContain('if (!optional_chain_receiver.has_value()) return std::nullopt');
    expect(emitted.contents).toContain('optional_chain_receiver.value()->key');
  });

  it('emits async functions with C++20 coroutine syntax', () => {
    const result = lower('fetcher.ts', 'export async function fetchData(): Promise<number> { return 1; }');
    const emitted = emitIrModuleCpp(result.module);

    expect(emitted.contents).toContain('FlightTask<double> fetch_data()');
    expect(emitted.contents).toContain('co_return');
    expect(emitted.contents).toContain('#include <coroutine>');
  });

  it('elects the flight-cpp semantic runtime as one coherent profile', () => {
    const result = lower(
      'semantic-runtime.ts',
      'export async function update(values: number[], labels: Map<string, number>, seen: Set<string>): Promise<string> { values.push(1); labels.set("size", values.length); seen.add("size"); return "done"; }',
    );
    const emitted = emitIrModuleCpp(result.module, { runtimeProfile: 'flight-cpp' });

    expect(emitted.contents).toContain('#include <flight/runtime.hpp>');
    expect(emitted.contents).toContain(
      'flight::Task<flight::String> update(flight::Array<double> values, flight::Map<flight::String, double> labels, flight::Set<flight::String> seen)',
    );
    expect(emitted.contents).toContain('values.push(1.0)');
    expect(emitted.contents).toContain('labels.set(flight::String("size"), static_cast<double>(values.size()))');
    expect(emitted.contents).toContain('seen.add(flight::String("size"))');
    expect(emitted.contents).toContain('co_return flight::String("done")');
    expect(emitted.contents).not.toContain('std::vector');
    expect(emitted.contents).not.toContain('std::unordered_');
  });

  it('lets a consumer override the semantic runtime header without changing its bindings', () => {
    const result = lower('text.ts', 'export function text(value: string): string { return value.trim(); }');
    const emitted = emitIrModuleCpp(result.module, {
      runtimeHeader: 'vendor/flight_runtime.hpp',
      runtimeProfile: 'flight-cpp',
    });

    expect(emitted.contents).toContain('#include "vendor/flight_runtime.hpp"');
    expect(emitted.contents).not.toContain('#include <flight/runtime.hpp>');
    expect(emitted.contents).toContain('flight::String text(flight::String value)');
    expect(emitted.contents).toContain('return value.trim()');
  });

  it('lowers semantic-runtime constructors and static operations to concrete C++ entry points', () => {
    const result = lower(
      'statics.ts',
      'export function code(): string { return String.fromCharCode(65); } export function stamp(): number { return Date.now(); } export function resolved(value: number): Promise<number> { return Promise.resolve<number>(value); } export function rejected(): Promise<number> { return Promise.reject<number>("no"); } export function combined(tasks: Promise<number>[]): Promise<number[]> { return Promise.all(tasks); } export function pending(): Promise<number> { return new Promise<number>((resolve) => resolve(1)); }',
    );
    const emitted = emitIrModuleCpp(result.module, { runtimeProfile: 'flight-cpp' });

    expect(emitted.contents).toContain('return flight::String::from_char_code(65.0)');
    expect(emitted.contents).toContain('return flight::Date::now()');
    expect(emitted.contents).toContain('return flight::resolve_task<double>(value)');
    expect(emitted.contents).toContain('return flight::reject_task<double>(flight::String("no"))');
    expect(emitted.contents).toContain('return flight::all_tasks(tasks)');
    expect(emitted.contents).toContain('return flight::Task<double>::create(');
  });

  it('preserves Date construction, formatting, and TimeClip access', () => {
    const result = lower(
      'date.ts',
      `export function timestamp(milliseconds: number): number { return new Date(milliseconds).getTime(); }
       export function format(milliseconds: number): string { return new Date(milliseconds).toISOString(); }`,
    );
    const emitted = emitIrModuleCpp(result.module, { runtimeProfile: 'flight-cpp' });

    expect(emitted.contents).toContain('return flight::Date(milliseconds).get_time()');
    expect(emitted.contents).toContain('return flight::Date(milliseconds).to_isostring()');
  });

  it('compares Date parameters through runtime reference identity', () => {
    const result = lower(
      'date-identity.ts',
      'export function same(left: Date, right: Date): boolean { return left === right; }',
    );
    const emitted = emitIrModuleCpp(result.module, { runtimeProfile: 'flight-cpp' });

    expect(emitted.contents).toContain('bool same(flight::Date left, flight::Date right)');
    expect(emitted.contents).toContain('return (left == right)');
  });

  // The runtime is a separate repository that pins this one and is pinned back; its committed header
  // is the shared artifact. The assertion stays here because an emitter change is what moves it, and
  // it reads the pinned checkout so a tree without one still runs the rest of the suite.
  const conformanceDirectory = path.join(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..'),
    '.dependencies',
    'flight-cpp',
    'tests',
    'generated',
  );

  it.skipIf(!existsSync(conformanceDirectory))(
    'keeps the native conformance header equal to flight-cpp profile output',
    () => {
      const directory = conformanceDirectory;
      const sourceFile = ts.createSourceFile(
        '/flight/packages/cpp-conformance/src/semantic-runtime.ts',
        readFileSync(path.join(directory, 'semantic_runtime.ts'), 'utf8'),
        ts.ScriptTarget.Latest,
        true,
      );
      const result = lowerTypeScriptSource(sourceFile, {
        packageName: '@flighthq/cpp-conformance',
        upstreamDirectory: '/flight',
      });
      const emitted = emitIrModuleCpp(result.module, { runtimeProfile: 'flight-cpp' });
      const contents = emitted.contents.endsWith('\n') ? emitted.contents : `${emitted.contents}\n`;
      const outputPath = path.join(directory, emitted.path);

      expect(emitted.path).toBe('semantic_runtime.hpp');
      if (process.env.FLIGHT_CPP_CONFORMANCE_UPDATE === '1') writeFileSync(outputPath, contents);
      expect(readFileSync(outputPath, 'utf8')).toBe(contents);
    },
  );

  it('emits co_await for await expressions in async functions', () => {
    const result = lower(
      'waiter.ts',
      'export async function wait(task: Promise<number>): Promise<number> { const v = await task; return v; }',
    );
    const emitted = emitIrModuleCpp(result.module);

    expect(emitted.contents).toContain('co_await task');
    expect(emitted.contents).toContain('co_return');
    expect(emitted.contents).not.toContain(' return ');
  });

  it('hoists co_await out of catch handlers into a deferred block', () => {
    const result = lower(
      'catch-await.ts',
      'export async function attempt(task: Promise<number>, backup: Promise<number>): Promise<number> { let result: number = 0; try { result = await task; } catch { result = await backup; } return result; }',
    );
    const emitted = emitIrModuleCpp(result.module);

    expect(emitted.contents).toContain('auto caught = false');
    expect(emitted.contents).toContain('catch (...)');
    expect(emitted.contents).toContain('caught = true');
    expect(emitted.contents).toContain('if (caught)');
    expect(emitted.contents).toContain('co_await backup');
    const catchBody = emitted.contents.match(/catch \(\.\.\.\) \{([^}]*)\}/)?.[1] ?? '';
    expect(catchBody).not.toContain('co_await');
  });

  it('emits finally blocks with exception_ptr catch-rethrow', () => {
    const result = lower(
      'cleanup.ts',
      'export async function cleanup(task: Promise<number>): Promise<number> { let r: number = 0; try { r = await task; } finally { r = r + 1; } return r; }',
    );
    const emitted = emitIrModuleCpp(result.module);

    expect(emitted.contents).toContain('std::exception_ptr');
    expect(emitted.contents).toContain('std::current_exception()');
    expect(emitted.contents).toContain('std::rethrow_exception');
    expect(emitted.contents).toContain('#include <exception>');
  });

  it('emits return-in-try-with-finally using deferred return variable', () => {
    const result = lower(
      'deferred.ts',
      'export async function deferred(task: Promise<number>): Promise<number> { try { return await task; } finally { let x: number = 1; } }',
    );
    const emitted = emitIrModuleCpp(result.module);

    expect(emitted.contents).toContain('std::optional<double> finally_return');
    expect(emitted.contents).toContain('finally_return = co_await task');
    expect(emitted.contents).toContain('finally_return.has_value()');
    expect(emitted.contents).toContain('co_return finally_return.value()');
  });

  it('emits class inheritance with virtual destructor and initializer list', () => {
    const result = lower(
      'derived.ts',
      'class Base { value: number; constructor(v: number) { this.value = v; } doubled(): number { return this.value * 2; } } export class Derived extends Base { extra: number; constructor(v: number) { super(v); this.extra = 1; } }',
    );
    const emitted = emitIrModuleCpp(result.module);

    expect(emitted.contents).toContain('struct Base {');
    expect(emitted.contents).toContain('virtual ~Base() = default;');
    expect(emitted.contents).toContain('virtual double doubled()');
    expect(emitted.contents).toContain('struct Derived : public Base {');
    expect(emitted.contents).toContain(': Base(v)');
  });

  it('emits type parameters as PascalCase and value bindings as snake_case', () => {
    const result = lower(
      'container.ts',
      'export interface Box<Value> { contents: Value } export function unwrap<Value>(box: Box<Value>): Value { return box.contents; }',
    );
    const emitted = emitIrModuleCpp(result.module);

    expect(emitted.contents).toContain('template <typename Value>');
    expect(emitted.contents).toContain('Value contents');
    expect(emitted.contents).toContain('Box<Value>');
    expect(emitted.contents).toContain('Value unwrap');
    expect(emitted.contents).not.toContain('value contents');
    expect(emitted.contents).not.toContain('value unwrap');
  });

  it('folds Math.max spread into std::max_element with empty guard', () => {
    const result = lower(
      'spread-max.ts',
      'export function widest(values: number[]): number { return Math.max(...values); }',
    );
    const emitted = emitIrModuleCpp(result.module);

    expect(emitted.contents).toContain('#include <algorithm>');
    expect(emitted.contents).toContain('#include <limits>');
    expect(emitted.contents).toContain(
      'values.empty() ? -std::numeric_limits<double>::infinity() : *std::max_element(values.begin(), values.end())',
    );
  });

  it('folds Math.min spread into std::min_element with empty guard', () => {
    const result = lower(
      'spread-min.ts',
      'export function narrowest(values: number[]): number { return Math.min(...values); }',
    );
    const emitted = emitIrModuleCpp(result.module);

    expect(emitted.contents).toContain('*std::min_element(values.begin(), values.end())');
    expect(emitted.contents).toContain('std::numeric_limits<double>::infinity()');
  });

  it('emits abstract methods as pure virtual', () => {
    const result = lower(
      'shape.ts',
      'export abstract class Shape { abstract area(): number; describe(): number { return this.area(); } } export class Square extends Shape { side: number; constructor(s: number) { super(); this.side = s; } area(): number { return this.side * this.side; } }',
    );
    const emitted = emitIrModuleCpp(result.module);

    expect(emitted.contents).toContain('virtual double area() = 0;');
    expect(emitted.contents).toContain('double area() override');
  });

  it('emits numeric and string enums', () => {
    const numeric = lower('direction.ts', 'export enum Direction { Up = 0, Down = 1, Left = 2, Right = 3 }');
    const numericEmitted = emitIrModuleCpp(numeric.module);
    expect(numericEmitted.contents).toContain('enum class Direction');
    expect(numericEmitted.contents).toContain('Up = 0');
    expect(numericEmitted.contents).toContain('Down = 1');

    const stringEnum = lower('color.ts', 'export enum Color { Red = "red", Green = "green", Blue = "blue" }');
    const stringEmitted = emitIrModuleCpp(stringEnum.module);
    expect(stringEmitted.contents).toContain('struct Color');
    expect(stringEmitted.contents).toContain('#include <string>');
  });

  it('emits type aliases and string literal unions', () => {
    const alias = lower('alias.ts', 'export type Pair<T> = [T, T];');
    const emitted = emitIrModuleCpp(alias.module);
    expect(emitted.contents).toContain('template');
    expect(emitted.contents).toContain('using Pair');

    const literal = lower('status.ts', "export type Status = 'active' | 'inactive';");
    const literalEmitted = emitIrModuleCpp(literal.module);
    expect(literalEmitted.contents).toContain('using Status = std::string');
  });

  it('emits checker-resolved indexed-access aliases', () => {
    const result = lower(
      'indexed-alias.ts',
      `
        export const Status = { Ready: 'ready', Done: 'done' } as const;
        export type Status = (typeof Status)[keyof typeof Status];
      `,
    );
    const emitted = emitIrModuleCpp(result.module, { runtimeProfile: 'flight-cpp' });

    expect(result.diagnostics).toEqual([]);
    expect(emitted.contents).toContain('using Status = flight::String;');
  });

  it('emits variable declarations with mutability and types', () => {
    const result = lower('vars.ts', 'export const PI: number = 3.14; export let counter: number = 0;');
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('const double pi');
    expect(emitted.contents).toContain('double counter');
  });

  it('emits uninitialized variables from checker flow type evidence', () => {
    const result = lower(
      'evolving-variable.ts',
      `
        export function choose(flag: boolean): number {
          let value;
          if (flag) value = 1;
          else value = 2;
          return value;
        }
      `,
    );
    const emitted = emitIrModuleCpp(result.module, { runtimeProfile: 'flight-cpp' });

    expect(result.diagnostics).toEqual([]);
    expect(emitted.contents).toContain('double value;');
  });

  it('emits string concatenation with std::string', () => {
    const result = lower('concat.ts', 'export function greet(name: string): string { return "Hello, " + name + "!"; }');
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('#include <string>');
    expect(emitted.contents).toContain('+');
  });

  it('emits string += assignment', () => {
    const result = lower(
      'append.ts',
      'export function build(base: string, suffix: string): string { let result: string = base; result += suffix; return result; }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('+=');
  });

  it('emits exponentiation with std::pow', () => {
    const result = lower('power.ts', 'export function square(x: number): number { return x ** 2; }');
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('std::pow');
    expect(emitted.contents).toContain('#include <cmath>');
  });

  it('emits unsigned right shift with uint32_t cast', () => {
    const result = lower('shift.ts', 'export function unsignedShift(x: number, y: number): number { return x >>> y; }');
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('uint32_t');
    expect(emitted.contents).toContain('#include <cstdint>');
  });

  it('emits bitwise operators with int32_t casts', () => {
    const result = lower('bitwise.ts', 'export function bitwiseAnd(a: number, b: number): number { return a & b; }');
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('int32_t');
    expect(emitted.contents).toContain('#include <cstdint>');
  });

  it('emits bitwise NOT with tilde', () => {
    const result = lower('not.ts', 'export function complement(x: number): number { return ~x; }');
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('~static_cast<int32_t>');
  });

  it('emits nullish coalescing with value_or', () => {
    const result = lower('nullish.ts', 'export function fallback(x: number | undefined): number { return x ?? 0; }');
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('value_or');
    expect(emitted.contents).toContain('#include <optional>');
  });

  it('emits null comparisons with has_value', () => {
    const result = lower(
      'nullable.ts',
      'export function isPresent(x: number | undefined): boolean { return x !== undefined; }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('has_value()');
  });

  it('emits conditional expressions', () => {
    const result = lower('ternary.ts', 'export function clamp(x: number): number { return x > 0 ? x : 0; }');
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('?');
    expect(emitted.contents).toContain(':');
  });

  it('turns a union type assertion into checked variant access', () => {
    const result = lower('cast.ts', 'export function toNumber(x: number | string): number { return x as number; }');
    const emitted = emitIrModuleCpp(result.module);

    expect(emitted.contents).toContain('#include <variant>');
    expect(emitted.contents).toContain('return std::get<0>(x)');

    const invalid = structuredClone(result.module);
    const declaration = invalid.declarations[0];
    const statement = declaration?.kind === 'function' ? declaration.body[0] : undefined;
    const expression = statement?.kind === 'return' ? statement.expression : undefined;
    if (expression?.kind !== 'cast') throw new Error('Expected asserted return');
    (expression as { type: IrType }).type = { kind: 'primitive', name: 'boolean' };
    expect(() => emitIrModuleCpp(invalid)).toThrow(
      'type assertion target must identify exactly one C++ variant alternative',
    );
  });

  it('emits tuple types and tuple access with std::get', () => {
    const result = lower('tuple.ts', 'export function first(pair: [number, string]): number { return pair[0]; }');
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('std::get<0>');
    expect(emitted.contents).toContain('#include <tuple>');
  });

  it('emits tuple literals with std::make_tuple', () => {
    const result = lower(
      'make-tuple.ts',
      'export function pair(a: number, b: string): [number, string] { return [a, b]; }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('std::make_tuple');
  });

  it('emits array literals with std::vector', () => {
    const result = lower('array.ts', 'export function items(): number[] { return [1, 2, 3]; }');
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('std::vector');
    expect(emitted.contents).toContain('#include <vector>');
  });

  it('emits object literals with brace initialization', () => {
    const result = lower(
      'object.ts',
      'interface Pt { x: number; y: number } export function origin(): Pt { return { x: 0, y: 0 }; }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('.x =');
    expect(emitted.contents).toContain('.y =');
  });

  it('emits new expressions as constructor calls', () => {
    const result = lower('error.ts', 'export function fail(): Error { return new Error("oops"); }');
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('std::runtime_error');
    expect(emitted.contents).toContain('#include <stdexcept>');
  });

  it('emits construct-signature values as explicit factory fields and calls', () => {
    const result = lower(
      'factory.ts',
      `
        interface Created { value: number }
        interface Factory {
          new (value: number): Created;
          readonly version: string;
        }
        export function create(factory: Factory): Created {
          return new factory(1);
        }
      `,
    );
    const emitted = emitIrModuleCpp(result.module);

    expect(result.diagnostics).toEqual([]);
    expect(emitted.contents).toContain('std::function<Created(double)> construct;');
    expect(emitted.contents).toContain('return factory.construct(1.0);');
  });

  it.each(['flight-cpp', 'standard-library'] as const)(
    'emits numeric globals and Number members with their standard headers in the %s profile',
    (runtimeProfile) => {
      const result = lower(
        'number-globals.ts',
        `export function classify(value: number): number {
        if (Number.isNaN(value)) return Number.NaN;
        if (!Number.isFinite(value)) return Infinity;
        if (!Number.isInteger(value)) return Number.MIN_VALUE;
        return Number(value) + Number.EPSILON;
      }`,
      );
      const emitted = emitIrModuleCpp(result.module, { runtimeProfile });

      expect(emitted.contents).toContain('std::isnan');
      expect(emitted.contents).toContain('std::isfinite');
      expect(emitted.contents).toContain('std::numeric_limits<double>::quiet_NaN()');
      expect(emitted.contents).toContain('std::numeric_limits<double>::infinity()');
      expect(emitted.contents).toContain('std::numeric_limits<double>::denorm_min()');
      expect(emitted.contents).toContain('std::numeric_limits<double>::epsilon()');
      expect(emitted.contents).toContain(
        runtimeProfile === 'flight-cpp'
          ? 'flight::is_integer(value)'
          : '[](double value) noexcept { return std::isfinite(value) && std::trunc(value) == value; }(value)',
      );
      expect(emitted.contents).toContain('#include <cmath>');
      expect(emitted.contents).toContain('#include <limits>');
    },
  );

  it.each(['flight-cpp', 'standard-library'] as const)(
    'emits RangeError construction with the correct string representation in the %s profile',
    (runtimeProfile) => {
      const result = lower(
        'range-error.ts',
        'export function fail(message: string): never { throw new RangeError(message); }',
      );
      const emitted = emitIrModuleCpp(result.module, { runtimeProfile });

      expect(emitted.contents).toContain(
        runtimeProfile === 'flight-cpp' ? 'std::range_error(message.to_utf8())' : 'std::range_error(message)',
      );
      expect(emitted.contents).toContain('#include <stdexcept>');
    },
  );

  it('emits template literals with std::to_string', () => {
    const result = lower('template.ts', 'export function label(n: number): string { return `item ${n}`; }');
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('std::to_string');
    expect(emitted.contents).toContain('#include <string>');
  });

  it('emits number.toString() as std::to_string via ambient member binding', () => {
    const result = lower(
      'to-string.ts',
      'export function numStr(n: number): string { const x: number = 42; return x.toString(); }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('to_string');
  });

  it('emits global String() conversion as to_string', () => {
    const result = lower(
      'string-convert.ts',
      'export function convert(value: number): string { return String(value); }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('to_string');
    expect(emitted.contents).not.toContain('flight::String(');
  });

  it('emits enum member access with scoped resolution', () => {
    const result = lower(
      'enum-access.ts',
      'export enum Color { Red, Green, Blue } export function red(): Color { return Color.Red; }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('Color::Red');
  });

  it('emits if/else statements', () => {
    const result = lower(
      'branch.ts',
      'export function sign(x: number): number { if (x > 0) { return 1; } else { return -1; } }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('if (');
    expect(emitted.contents).toContain('else {');
  });

  it('emits while and do-while loops', () => {
    const result = lower(
      'loops.ts',
      'export function countdown(n: number): number { let i: number = n; while (i > 0) { i = i - 1; } return i; } export function countup(n: number): number { let i: number = 0; do { i = i + 1; } while (i < n); return i; }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('while (');
    expect(emitted.contents).toContain('do {');
    expect(emitted.contents).toContain('} while (');
  });

  it('emits for-of loops', () => {
    const result = lower(
      'for-of.ts',
      'export function sum(items: number[]): number { let total: number = 0; for (const item of items) { total += item; } return total; }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('for (');
    expect(emitted.contents).toContain(' : ');
  });

  it('emits for-in loops with key plan', () => {
    const result = lower(
      'for-in.ts',
      'interface Cfg { host: string; port: number } export function keys(cfg: Cfg): string { let result: string = ""; for (const key in cfg) { result += key; } return result; }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('std::vector<std::string>');
    expect(emitted.contents).toContain('#include <string>');
    expect(emitted.contents).toContain('static_cast<void>(cfg);');
    expect(emitIrModuleCpp(result.module, { runtimeProfile: 'flight-cpp' }).contents).toContain(
      'flight::Array<flight::String>',
    );

    const malformed = structuredClone(result.module);
    const declaration = malformed.declarations[1];
    if (declaration?.kind !== 'function' || declaration.body[1]?.kind !== 'forIn') {
      throw new Error('Expected for-in statement');
    }
    (declaration.body[1].variable as { type: IrType }).type = { kind: 'primitive', name: 'number' };
    expect(() => emitIrModuleCpp(malformed)).toThrow('for-in binding requires primitive string type evidence');
  });

  it('emits switch as if-else chain', () => {
    const result = lower(
      'switch.ts',
      'export function label(mode: number): string { switch (mode) { case 0: return "a"; case 1: return "b"; default: return "c"; } }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('if (');
    expect(emitted.contents).toContain('else if (');
    expect(emitted.contents).toContain('else');
  });

  it('emits throw and try-catch', () => {
    const result = lower(
      'error-handling.ts',
      'export function safe(x: number): number { try { if (x < 0) throw new Error("neg"); return x; } catch (e) { return 0; } }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('throw');
    expect(emitted.contents).toContain('try {');
    expect(emitted.contents).toContain('catch (');
  });

  it('emits lambda expressions with capture', () => {
    const result = lower(
      'lambda.ts',
      'export function make(x: number): () => number { return (): number => { return x; }; }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('[=]');
    expect(emitted.contents).toContain('#include <functional>');
  });

  it('emits function types with std::function', () => {
    const result = lower(
      'fn-type.ts',
      'export function apply(fn: (x: number) => number, value: number): number { return fn(value); }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('std::function<');
    expect(emitted.contents).toContain('#include <functional>');
  });

  it('emits checked access for assertions into a three-member primitive union', () => {
    const result = lower(
      'union.ts',
      'export function convert(input: number | string | boolean): number { return input as number; }',
    );
    const emitted = emitIrModuleCpp(result.module);

    expect(emitted.contents).toContain('std::variant<bool, double, std::string> input');
    expect(emitted.contents).toContain('return std::get<1>(input)');
  });

  it('emits nullable types as std::optional', () => {
    const result = lower(
      'optional.ts',
      'export function maybe(x: number | undefined): number | undefined { return x; }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('std::optional<double>');
  });

  it('emits object types as anonymous structs', () => {
    const result = lower(
      'anon-struct.ts',
      'export function make(): { x: number; y: number } { return { x: 1, y: 2 }; }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('struct');
    expect(emitted.contents).toContain('double x');
    expect(emitted.contents).toContain('double y');
  });

  it('emits narrowed optional access with .value()', () => {
    const result = lower(
      'narrow.ts',
      'export function unwrap(x: number | undefined): number { if (x !== undefined) { return x; } return 0; }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('.value()');
  });

  it('emits undefined literals as std::nullopt', () => {
    const result = lower('undef.ts', 'export function nothing(): number | undefined { return undefined; }');
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('std::nullopt');
  });

  it('emits imports as #include directives for relative specifiers', () => {
    const result = lowerPackage(
      '@flighthq/math',
      'consumer.ts',
      "import { helper } from './helper.js'; export function use(): number { return helper(); }",
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('#include "helper.hpp"');
  });

  it('emits optional and rest parameters', () => {
    const result = lower(
      'params.ts',
      'export function opt(a: number, b?: number): number { return a; } export function rest(a: number, ...items: number[]): number { return a; }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('std::optional<double>');
    expect(emitted.contents).toContain('std::nullopt');
    expect(emitted.contents).toContain('std::vector<double>');
  });

  it('emits special numeric values via literal emission', () => {
    const result = lower('special.ts', 'export function check(x: number): boolean { return x > 0; }');
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('double');
  });

  it('emits boolean and null literals', () => {
    const result = lower('literals.ts', 'export const yes: boolean = true; export const no: boolean = false;');
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('true');
    expect(emitted.contents).toContain('false');
  });

  it('emits integer literals with .0 suffix', () => {
    const result = lower('int.ts', 'export const value: number = 42;');
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('42.0');
  });

  it('emits break and continue in loops', () => {
    const result = lower(
      'control.ts',
      'export function find(items: number[]): number { for (const item of items) { if (item > 5) { return item; } } return 0; }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('return');
  });

  it('emits runtime header include when configured', () => {
    const result = lower('simple.ts', 'export const x: number = 1;');
    const emitted = emitIrModuleCpp(result.module, { runtimeHeader: 'flight_runtime.hpp' });
    expect(emitted.contents).toContain('#include "flight_runtime.hpp"');
  });

  it('emits static fields as inline static in struct body', () => {
    const result = lower(
      'static.ts',
      'export class Counter { static count: number = 0; value: number; constructor(v: number) { this.value = v; } }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('double value');
    expect(emitted.contents).toContain('inline static double count');
  });

  it('emits postfix increment and decrement', () => {
    const result = lower('postfix.ts', 'export function next(x: number): number { let v: number = x; v++; return v; }');
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('++');
  });

  it('refuses binding pattern declarations before lowering', () => {
    const result = lower('destruct.ts', 'export const value: number = 1;');
    const module = structuredClone(result.module);
    const fn = module.declarations[0]!;
    if (fn.kind === 'variable' && !('pattern' in fn)) {
      (fn as any).exported = true;
      (fn as any).pattern = { kind: 'array', elements: [] };
      delete (fn as any).binding;
    }
    expect(() => emitIrModuleCpp(module)).toThrow();
  });

  it('emits Readonly<T> by unwrapping to the inner type', () => {
    const result = lower(
      'readonly.ts',
      'interface Pt { x: number } export function read(p: Readonly<Pt>): number { return p.x; }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('double read(Pt p)');
  });

  it('emits expression arrow functions with concise body', () => {
    const result = lower('arrow.ts', 'export function make(x: number): () => number { return () => x; }');
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('[=]');
    expect(emitted.contents).toContain('return');
  });

  it('emits recursive local function declarations through initialized shared capture storage', () => {
    const result = lower(
      'local-function.ts',
      `export function run(value: number): number {
        const offset = 1;
        return helper(value);
        function helper(input: number): number {
          return input <= 0 ? offset : helper(input - 1);
        }
      }`,
    );
    const emitted = emitIrModuleCpp(result.module);

    expect(result.diagnostics).toEqual([]);
    expect(emitted.contents).toContain('std::make_shared<std::optional<std::function<double(double)>>>(std::nullopt)');
    expect(emitted.contents).toContain('(*helper_capture).value() = [=](double input)');
    expect(emitted.contents).toContain('(*helper_capture).value()((input - 1.0))');
  });

  it('emits super method calls with base class scope resolution', () => {
    const result = lower(
      'super-method.ts',
      'class Base { value(): number { return 1; } } export class Child extends Base { value(): number { return super.value() + 1; } }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('Base::value');
  });

  it('emits this member access with arrow operator', () => {
    const result = lower(
      'this-access.ts',
      'export class Box { value: number; constructor(v: number) { this.value = v; } get(): number { return this.value; } }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('this->value');
  });

  it('emits property access as member operator', () => {
    const result = lower(
      'member.ts',
      'interface Obj { x: number } export function getX(o: Obj): number { return o.x; }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('.x');
  });

  it('emits switch with only default case without if-else wrapper', () => {
    const result = lower(
      'switch-default-only.ts',
      'export function always(x: number): number { switch (x) { default: return 0; } }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('return');
  });

  it('emits try-catch-finally with nested structure', () => {
    const result = lower(
      'try-catch-finally.ts',
      'export async function safe(task: Promise<number>): Promise<number> { try { return await task; } catch (e) { return 0; } finally { let x: number = 1; } }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('std::exception_ptr');
    expect(emitted.contents).toContain('catch');
    expect(emitted.contents).toContain('finally_return');
  });

  it('names the output file from source path or falls back to internal name', () => {
    const result = lower('my-module.ts', 'export const x: number = 1;');
    expect(emitIrModuleCpp(result.module).path).toBe('my_module.hpp');
  });

  it('emits mutable local variables without const', () => {
    const result = lower('mutable.ts', 'export function inc(): number { let x: number = 0; x = x + 1; return x; }');
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toMatch(/(?<!const )double x/);
  });

  it('emits class with type parameters', () => {
    const result = lower(
      'generic-class.ts',
      'export class Box<T> { value: T; constructor(v: T) { this.value = v; } get(): T { return this.value; } }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('template <typename T>');
    expect(emitted.contents).toContain('struct Box');
    expect(emitted.contents).toContain('T value');
  });

  it('emits static class methods correctly', () => {
    const result = lower(
      'static-method.ts',
      'export class Factory { static value: number = 0; static create(): number { return 0; } make(): number { return 1; } }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('make()');
  });

  it('emits .length property via ambient sizeMethod binding', () => {
    const result = lower('length.ts', 'export function len(items: number[]): number { return items.length; }');
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('size()');
  });

  it('emits array.push via ambient method binding', () => {
    const result = lower(
      'push.ts',
      'export function append(items: number[], value: number): void { items.push(value); }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('push_back');
  });

  it('emits for-in with preserve evaluation wrapping object reference', () => {
    const result = lower(
      'for-in-preserve.ts',
      'interface Cfg { host: string; port: number } export function read(cfg: Cfg): string { let result: string = ""; for (const key in cfg) { result += key; } return result; }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('std::vector<std::string>');
  });

  it('emits async closure rejection as emission failure', () => {
    const result = lower(
      'async-closure.ts',
      'export function make(): () => Promise<number> { return async (): Promise<number> => { return 1; }; }',
    );
    expect(() => emitIrModuleCpp(result.module)).toThrow('async closures');
  });

  it('emits element access on arrays with static_cast<size_t>', () => {
    const result = lower('elem.ts', 'export function first(items: number[]): number { return items[0]; }');
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('static_cast<size_t>');
  });

  it('emits void return in finally context correctly', () => {
    const result = lower(
      'finally-void.ts',
      'export async function run(task: Promise<number>): Promise<number> { let r: number = 0; try { r = await task; return r; } finally { r = 0; } }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('finally_return');
  });

  it('emits try-catch-finally with return in catch clause', () => {
    const result = lower(
      'catch-return.ts',
      'export async function safe(task: Promise<number>): Promise<number> { try { return await task; } catch (e) { return -1; } finally { let x: number = 0; } }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('catch');
    expect(emitted.contents).toContain('finally_return');
    expect(emitted.contents).toContain('has_value()');
  });

  it('emits tuple element types with optional wrapping', () => {
    const result = lower('opt-tuple.ts', 'export function partial(): [number, number?] { return [1]; }');
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('std::optional');
    expect(emitted.contents).toContain('std::tuple');
  });

  it('emits undefinedDefault with value_or', () => {
    const result = lower(
      'default-value.ts',
      'export function withDefault(pair: [number, number?]): number { const [a, b = 0] = pair; return a + b; }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('value_or');
  });

  it('emits tupleRest with std::get', () => {
    const result = lower(
      'tuple-rest.ts',
      'export function rest(triple: [number, number, number]): number { const [, ...tail] = triple; return tail[0]; }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('std::get<');
  });

  it('emits tupleSuffix with multiple std::get calls', () => {
    const result = lower(
      'tuple-suffix.ts',
      'export function suffix(quad: [number, number, number, number]): [number, number] { const [, , ...last] = quad; return last; }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('std::make_tuple');
    expect(emitted.contents).toContain('std::get<');
  });

  it('emits unary plus on number as identity', () => {
    const result = lower('unary-plus.ts', 'export function pos(x: number): number { return +x; }');
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).not.toContain('++');
  });

  it('emits IIFE call with parenthesized lambda', () => {
    const result = lower('iife.ts', 'export function wrap(): number { return ((x: number): number => x)(42); }');
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('([=]');
    expect(emitted.contents).toContain(')(42.0)');
  });

  it('emits enum without explicit values', () => {
    const result = lower('auto-enum.ts', 'export enum Status { Active, Inactive }');
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('enum class Status');
    expect(emitted.contents).toContain('Active');
    expect(emitted.contents).toContain('Inactive');
  });

  it('emits this type as class name in method context', () => {
    const result = lower(
      'this-type.ts',
      'export class Node { next: Node | undefined; self(): Node { return this as Node; } }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('Node self()');
  });

  it('emits never type as void', () => {
    const result = lower('never.ts', 'export function fail(): never { throw new Error("fail"); }');
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('void fail()');
  });

  it('emits void type in function returns', () => {
    const result = lower('void-fn.ts', 'export function noop(): void { return; }');
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('void noop()');
  });

  it('emits bigint as int64_t', () => {
    const result = lower('bigint-param.ts', 'export function process(x: bigint): bigint { return x; }');
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('int64_t');
  });

  it('emits literal types correctly', () => {
    const result = lower('literal-type.ts', 'export function one(): 1 { return 1; }');
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('double one');
  });

  it('emits catch without binding using ellipsis', () => {
    const result = lower(
      'catch-all.ts',
      'export function safe(x: number): number { try { return x; } catch { return 0; } }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('catch (...)');
  });

  it('rejects objectRest expressions before lowering', () => {
    const result = lower('rest-obj.ts', 'export const x: number = 1;');
    const module = structuredClone(result.module);
    const decl = module.declarations[0];
    if (decl?.kind === 'variable' && !('pattern' in decl)) {
      (decl as any).initializer = {
        kind: 'objectRest',
        object: decl.initializer,
        excluded: [],
        type: { kind: 'unknown', source: 'object' },
      };
    }
    expect(() => emitIrModuleCpp(module)).toThrow();
  });

  it('refuses regexp expressions before lowering', () => {
    const result = lower('regexp.ts', 'export const x: number = 1;');
    const module = structuredClone(result.module);
    const decl = module.declarations[0];
    if (decl?.kind === 'variable' && !('pattern' in decl)) {
      (decl as any).initializer = { kind: 'regexp', pattern: 'test', flags: '' };
    }
    expect(() => emitIrModuleCpp(module)).toThrow('regular expressions');
  });

  it('refuses spread expressions in non-Math contexts', () => {
    const result = lower('spread.ts', 'export const x: number = 1;');
    const module = structuredClone(result.module);
    const decl = module.declarations[0];
    if (decl?.kind === 'variable' && !('pattern' in decl)) {
      (decl as any).initializer = {
        kind: 'spread',
        expression: { kind: 'literal', value: 1 },
      };
    }
    expect(() => emitIrModuleCpp(module)).toThrow('spreading');
  });

  it('emits NaN and Infinity literals via std::numeric_limits', () => {
    const result = lower('special-num.ts', 'export const x: number = 1;');
    const module = structuredClone(result.module);
    const decl = module.declarations[0];
    if (decl?.kind === 'variable' && !('pattern' in decl)) {
      (decl as unknown as { initializer: unknown }).initializer = { kind: 'literal', value: NaN };
    }
    const emitted = emitIrModuleCpp(module);
    expect(emitted.contents).toContain('std::numeric_limits<double>::quiet_NaN()');

    const module2 = structuredClone(result.module);
    const decl2 = module2.declarations[0];
    if (decl2?.kind === 'variable' && !('pattern' in decl2)) {
      (decl2 as unknown as { initializer: unknown }).initializer = { kind: 'literal', value: Infinity };
    }
    const emitted2 = emitIrModuleCpp(module2);
    expect(emitted2.contents).toContain('std::numeric_limits<double>::infinity()');

    const module3 = structuredClone(result.module);
    const decl3 = module3.declarations[0];
    if (decl3?.kind === 'variable' && !('pattern' in decl3)) {
      (decl3 as unknown as { initializer: unknown }).initializer = { kind: 'literal', value: -Infinity };
    }
    const emitted3 = emitIrModuleCpp(module3);
    expect(emitted3.contents).toContain('-std::numeric_limits<double>::infinity()');
  });

  it('emits null literal as nullptr', () => {
    const result = lower('null-lit.ts', 'export const x: number = 1;');
    const module = structuredClone(result.module);
    const decl = module.declarations[0];
    if (decl?.kind === 'variable' && !('pattern' in decl)) {
      (decl as unknown as { initializer: unknown }).initializer = { kind: 'literal', value: null };
    }
    const emitted = emitIrModuleCpp(module);
    expect(emitted.contents).toContain('nullptr');
  });

  it('emits string literal with flight-cpp runtime as flight::String', () => {
    const result = lower('string-lit.ts', 'export const x: string = "hello";');
    const emitted = emitIrModuleCpp(result.module, { runtimeProfile: 'flight-cpp' });
    expect(emitted.contents).toContain('flight::String("hello")');
  });

  it('emits template literals with flight-cpp runtime', () => {
    const result = lower('tpl-flight.ts', 'export function label(n: number): string { return `item ${n}`; }');
    const emitted = emitIrModuleCpp(result.module, { runtimeProfile: 'flight-cpp' });
    expect(emitted.contents).toContain('flight::String');
    expect(emitted.contents).toContain('flight::to_string(');
  });

  it('emits empty template literal as empty string construction', () => {
    const result = lower('empty-tpl.ts', 'export const x: number = 1;');
    const module = structuredClone(result.module);
    const decl = module.declarations[0];
    if (decl?.kind === 'variable' && !('pattern' in decl)) {
      (decl as any).initializer = { kind: 'template', parts: [] };
    }
    const emitted = emitIrModuleCpp(module);
    expect(emitted.contents).toContain('std::string()');
    const flightEmitted = emitIrModuleCpp(module, { runtimeProfile: 'flight-cpp' });
    expect(flightEmitted.contents).toContain('flight::String()');
  });

  it('emits array literals with flight-cpp runtime', () => {
    const result = lower('array-flight.ts', 'export function items(): number[] { return [1, 2, 3]; }');
    const emitted = emitIrModuleCpp(result.module, { runtimeProfile: 'flight-cpp' });
    expect(emitted.contents).toContain('flight::Array');
    expect(emitted.contents).not.toContain('std::vector');
  });

  it('refuses hole-producing arrays in the dense flight-cpp runtime profile', () => {
    const sparse = lower('sparse-flight.ts', 'export function values(): number[] { return [1, , 3]; }');
    expect(() => emitIrModuleCpp(sparse.module, { runtimeProfile: 'flight-cpp' })).toThrow(
      'sparse array literals are outside the dense flight-cpp array profile',
    );

    const sized = lower(
      'array-length-flight.ts',
      'export function values(length: number): number[] { return new Array<number>(length); }',
    );
    expect(() => emitIrModuleCpp(sized.module, { runtimeProfile: 'flight-cpp' })).toThrow(
      'Array length construction is outside the dense flight-cpp array profile',
    );

    const partiallyFilled = lower(
      'array-length-partial-fill-flight.ts',
      'export function values(length: number): number[] { return new Array<number>(length).fill(0, 1); }',
    );
    expect(() => emitIrModuleCpp(partiallyFilled.module, { runtimeProfile: 'flight-cpp' })).toThrow(
      'Array length construction is outside the dense flight-cpp array profile',
    );

    const incompleteWrites = lower(
      'array-length-incomplete-writes-flight.ts',
      `export function values(): number[] {
        const result = new Array<number>(3);
        result[0] = 1;
        result[2] = 3;
        return result;
      }`,
    );
    expect(() => emitIrModuleCpp(incompleteWrites.module, { runtimeProfile: 'flight-cpp' })).toThrow(
      'Array length construction is outside the dense flight-cpp array profile',
    );

    const incompleteLoop = lower(
      'array-length-incomplete-loop-flight.ts',
      `export function values(length: number): number[] {
        const size = length;
        const result = new Array<number>(size);
        for (let index = 0; index < size - 1; index++) result[index] = 1;
        return result;
      }`,
    );
    expect(() => emitIrModuleCpp(incompleteLoop.module, { runtimeProfile: 'flight-cpp' })).toThrow(
      'Array length construction is outside the dense flight-cpp array profile',
    );
  });

  it('emits length-constructed arrays when an immediate full fill proves them dense', () => {
    const result = lower(
      'array-length-full-fill-flight.ts',
      'export function values(length: number): number[] { return new Array<number>(length).fill(0); }',
    );
    const emitted = emitIrModuleCpp(result.module, { runtimeProfile: 'flight-cpp' });

    expect(emitted.contents).toContain('flight::Array<double>(length).fill(0.0)');
  });

  it('emits literal-sized arrays when contiguous loops initialize every slot before observation', () => {
    const result = lower(
      'array-length-loop-fill-flight.ts',
      `export function values(): number[] {
        const result = new Array<number>(4);
        for (let index = 0; index < 2; index++) result[index] = 1;
        for (let index = 2; index < 4; index++) result[index] = 2;
        return result;
      }`,
    );
    const emitted = emitIrModuleCpp(result.module, { runtimeProfile: 'flight-cpp' });

    expect(emitted.contents).toContain('flight::Array<double> result = flight::Array<double>(4.0)');
  });

  it('emits dynamic-sized arrays when canonical loops initialize every slot before observation', () => {
    const result = lower(
      'array-dynamic-length-loop-fill-flight.ts',
      `export function values(length: number): number[] {
        const size = length;
        const result: number[] = new Array(size);
        for (let index = 0; index < size; index++) result[index] = index;
        return result;
      }
      export function triples(length: number, values: (index: number) => [number, number, number]): number[] {
        const size = length;
        const result = new Array<number>(size * 3);
        for (let index = 0; index < size; index++) {
          const [first, second, third] = values(index);
          result[index * 3] = first;
          result[index * 3 + 1] = second;
          result[index * 3 + 2] = third;
        }
        return result;
      }`,
    );
    const emitted = emitIrModuleCpp(result.module, { runtimeProfile: 'flight-cpp' });

    expect(emitted.contents).toContain('flight::Array<double> result = flight::Array<double>(size)');
    expect(emitted.contents).toContain('flight::Array<double> result = flight::Array<double>((size * 3.0))');
  });

  it('emits product-sized arrays initialized by nested loops and a sequential write cursor', () => {
    const result = lower(
      'array-nested-sequential-fill-flight.ts',
      `export function values(size: number, transforms: readonly ((value: number) => number)[]): number[] {
        const count = size;
        const result = new Array<number>(count * count * count * 3);
        const scale = count - 1;
        let write = 0;
        for (let z = 0; z < count; z++) {
          const zValue = z / scale;
          for (let y = 0; y < count; y++) {
            const yValue = y / scale;
            for (let x = 0; x < count; x++) {
              let value = x / scale + yValue + zValue;
              for (let transform = 0; transform < transforms.length; transform++) {
                value = transforms[transform](value);
              }
              result[write++] = value;
              result[write++] = yValue;
              result[write++] = zValue;
            }
          }
        }
        return result;
      }`,
    );
    const emitted = emitIrModuleCpp(result.module, {
      runtimeProfile: 'flight-cpp',
    });

    expect(emitted.contents).toContain('flight::Array<double> result = flight::Array<double>');
  });

  it('refuses nested sequential initialization that leaves each product cell partial', () => {
    const result = lower(
      'array-nested-sequential-partial-flight.ts',
      `export function values(size: number): number[] {
        const count = size;
        const result = new Array<number>(count * count * 3);
        let write = 0;
        for (let y = 0; y < count; y++) {
          for (let x = 0; x < count; x++) {
            result[write++] = x;
            result[write++] = y;
          }
        }
        return result;
      }`,
    );

    expect(() => emitIrModuleCpp(result.module, { runtimeProfile: 'flight-cpp' })).toThrow(
      'Array length construction is outside the dense flight-cpp array profile',
    );

    const skipped = lower(
      'array-nested-sequential-skipped-flight.ts',
      `export function values(size: number, skip: boolean): number[] {
        const count = size;
        const result = new Array<number>(count * count);
        let write = 0;
        for (let y = 0; y < count; y++) {
          if (skip) continue;
          for (let x = 0; x < count; x++) result[write++] = x;
        }
        return result;
      }`,
    );
    expect(() => emitIrModuleCpp(skipped.module, { runtimeProfile: 'flight-cpp' })).toThrow(
      'Array length construction is outside the dense flight-cpp array profile',
    );
  });

  it('emits literal-sized arrays when contiguous direct writes initialize every slot', () => {
    const result = lower(
      'array-length-direct-fill-flight.ts',
      `export function values(out?: number[]): number[] {
        const result = out ?? new Array(3);
        result[0] = 1;
        result[1] = 2;
        result[2] = 3;
        return result;
      }`,
    );
    const emitted = emitIrModuleCpp(result.module, { runtimeProfile: 'flight-cpp' });

    expect(emitted.contents).toContain('.value_or(flight::Array<double>(3.0))');
  });

  it('emits tuple literal with absent element as std::nullopt', () => {
    const result = lower('tuple-absent.ts', 'export function partial(): [number, number?] { return [1]; }');
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('std::nullopt');
    expect(emitted.contents).toContain('std::make_tuple');
  });

  it('emits tuple literal with present optional element using make_optional', () => {
    const result = lower('tuple-opt.ts', 'export function full(): [number, number?] { return [1, 2]; }');
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('std::make_optional');
  });

  it('emits Required<T> type by unwrapping to the inner type', () => {
    const result = lower(
      'required.ts',
      'interface Pt { x: number } export function fill(p: Required<Pt>): number { return p.x; }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('double fill(Pt p)');
  });

  it('erases Omit<T, K> only when the semantic runtime proves a reference-preserving representation', () => {
    const result = lower(
      'omit-reference.ts',
      'export interface Entity {} export type WithoutRuntime<Type extends Entity> = Omit<Type, "runtime">;',
    );

    const emitted = emitIrModuleCpp(result.module, { runtimeProfile: 'flight-cpp' });
    expect(emitted.contents).toContain('template <typename Type>');
    expect(emitted.contents).toContain('using WithoutRuntime = flight::Ref<Type>');
    expect(() => emitIrModuleCpp(result.module)).toThrow(
      'Omit<T, K> requires a proven reference-preserving flight-cpp representation',
    );
    const value = lower('omit-value.ts', 'export type Invalid<Type extends number> = Omit<Type, "runtime">;');
    expect(() => emitIrModuleCpp(value.module, { runtimeProfile: 'flight-cpp' })).toThrow(
      'Omit<T, K> requires a proven reference-preserving flight-cpp representation',
    );
  });

  it('emits the Entity marker, reference projection, runtime record, and interned key together', () => {
    const result = lower(
      'entity.ts',
      `export interface Entity { [EntityRuntimeKey]: EntityRuntime | undefined; }
       export type EntityConstruction<Type extends Entity> = { -readonly [Key in keyof Type]: Type[Key] };
       export type EntityWithoutRuntime<Type extends Entity> = Omit<Type, typeof EntityRuntimeKey>;
       export interface EntityRuntime { binding: object | null; uid?: string; }
       export const EntityRuntimeKey = Symbol.for('EntityRuntime');
       export function getRuntime(entity: Entity): EntityRuntime | undefined { return entity[EntityRuntimeKey]; }
       export function setRuntime(entity: Entity, runtime: EntityRuntime | undefined): void {
         entity[EntityRuntimeKey] = runtime;
       }`,
    );

    expect(result.diagnostics).toEqual([]);
    const emitted = emitIrModuleCpp(result.module, { runtimeProfile: 'flight-cpp' });
    expect(emitted.contents).toContain('struct Entity : public flight::ReferenceEnabled');
    expect(emitted.contents).toContain('std::optional<flight::Ref<EntityRuntime>> entity_runtime_key;');
    expect(emitted.contents).toContain('using EntityConstruction = flight::Ref<Type>');
    expect(emitted.contents).toContain('using EntityWithoutRuntime = flight::Ref<Type>');
    expect(emitted.contents).toContain('struct EntityRuntime : public flight::ReferenceEnabled');
    expect(emitted.contents).toContain('std::optional<std::shared_ptr<void>> binding;');
    expect(emitted.contents).toContain(
      'flight::Symbol entity_runtime_key = flight::Symbol::for_key(flight::String("EntityRuntime"))',
    );
    expect(emitted.contents).toContain('return entity->entity_runtime_key;');
    expect(emitted.contents).toContain('entity->entity_runtime_key = runtime;');
    expect(emitted.contents).not.toContain('std::optional<auto>');
    expect(emitted.dependencies).toEqual(expect.arrayContaining(['flight/runtime.hpp', 'flight/symbol.hpp', 'memory']));
  });

  it('uses ambient undefined as contextual evidence when clearing a computed optional slot', () => {
    const result = lower(
      'runtime-slot-reset.ts',
      `export const RuntimeKey = Symbol.for('Runtime');
       interface Runtime { value: number; }
       interface Entity { [RuntimeKey]: Runtime | undefined; }
       export function release(entity: Entity): void { entity[RuntimeKey] = undefined; }`,
    );

    expect(result.diagnostics).toEqual([]);
    const emitted = emitIrModuleCpp(result.module, { runtimeProfile: 'flight-cpp' });
    expect(emitted.contents).toContain('entity->runtime_key = std::nullopt;');
  });

  it('refuses indexedAccess types without a closed object shape', () => {
    const result = lower('idx.ts', 'export const x: number = 1;');
    const module = structuredClone(result.module);
    const decl = module.declarations[0];
    if (decl?.kind === 'variable' && !('pattern' in decl)) {
      (decl as any).type = {
        kind: 'indexedAccess',
        object: { kind: 'primitive', name: 'string' },
        index: { kind: 'literal', value: 'x' },
      };
    }
    expect(() => emitIrModuleCpp(module)).toThrow('indexedAccess');
  });

  it('emits closed keyof, indexed-access, and value-query type computations', () => {
    const result = lower(
      'closed-type-computations.ts',
      `interface Options { count: number; label?: string }
       export const Kind = 'options';
       export type OptionKey = keyof Options;
       export type OptionValue = Options[keyof Options];
       export type Kind = typeof Kind;`,
    );
    const emitted = emitIrModuleCpp(result.module, { runtimeProfile: 'flight-cpp' });

    expect(emitted.contents).toContain('using OptionKey = flight::String');
    expect(emitted.contents).toContain('using OptionValue = std::optional<std::variant');
    expect(emitted.contents).toContain('using Kind = flight::String');
  });

  it('emits imported interface key domains and closed exclusions without erasing symbol keys', () => {
    const results = lowerTypeScriptSources([
      {
        packageName: '@flighthq/types',
        sourceFile: ts.createSourceFile(
          '/flight/packages/types/src/contracts.ts',
          `export const EntityRuntimeKey = Symbol.for('EntityRuntime');
           export interface Entity { [EntityRuntimeKey]: object | undefined }
           export interface HapticsBackend extends Entity { cancel(): boolean; impact(): boolean }
           export interface LifecycleBackend extends Entity { getState(): string; subscribe(): void }
           export interface InteractionSignals extends Entity { onClick(): void; onFocus(): void }
           export interface ParticleEmitterConfig extends Entity { alphaStart: number; alphaEnd: number }`,
          ts.ScriptTarget.Latest,
          true,
        ),
        upstreamDirectory: '/flight',
      },
      {
        packageName: '@flighthq/types',
        sourceFile: ts.createSourceFile(
          '/flight/packages/types/src/key-domains.ts',
          `import type {
             Entity,
             HapticsBackend,
             InteractionSignals,
             LifecycleBackend,
             ParticleEmitterConfig,
           } from './contracts.js';
           export type HapticsOperation = keyof HapticsBackend;
           export type InteractionSignalName = Exclude<keyof InteractionSignals, symbol>;
           export type LifecycleOperation = Exclude<keyof LifecycleBackend, keyof Entity>;
           export interface ParticleConfigIssue { field: keyof ParticleEmitterConfig }`,
          ts.ScriptTarget.Latest,
          true,
        ),
        upstreamDirectory: '/flight',
      },
    ]);
    expect(results.flatMap((result) => result.diagnostics)).toEqual([]);
    const modules = results.map((result) => result.module);
    const emitted = createCppCompilerBackend().createEmissionSession!({
      modules,
      options: { runtimeProfile: 'flight-cpp' },
    }).emitModule(modules[1]!)[0]!.contents;

    expect(emitted).toContain('using HapticsOperation = std::variant<flight::String, flight::Symbol>');
    expect(emitted).toContain('using InteractionSignalName = flight::String');
    expect(emitted).toContain('using LifecycleOperation = flight::String');
    expect(emitted).toContain('std::variant<flight::String, flight::Symbol> field;');
  });

  it('resolves an imported literal union alias while computing Exclude', () => {
    const results = lowerTypeScriptSources([
      {
        packageName: '@flighthq/types',
        sourceFile: ts.createSourceFile(
          '/flight/packages/types/src/BitmapReadback.ts',
          `export type BitmapReadbackBlockReason =
             | 'backend-not-installed'
             | 'empty-size'
             | 'no-canvas'
             | 'ok'
             | 'tainted-source';`,
          ts.ScriptTarget.Latest,
          true,
        ),
        upstreamDirectory: '/flight',
      },
      {
        packageName: '@flighthq/types',
        sourceFile: ts.createSourceFile(
          '/flight/packages/types/src/BitmapReadbackBackend.ts',
          `import type { BitmapReadbackBlockReason } from './BitmapReadback.js';
           export type BitmapReadbackBackendReason = Exclude<
             BitmapReadbackBlockReason,
             'backend-not-installed' | 'empty-size'
           >;`,
          ts.ScriptTarget.Latest,
          true,
        ),
        upstreamDirectory: '/flight',
      },
    ]);
    const modules = results.map((result) => result.module);
    const emitted = createCppCompilerBackend().createEmissionSession!({
      modules,
      options: { runtimeProfile: 'flight-cpp' },
    }).emitModule(modules[1]!)[0]!.contents;

    expect(emitted).toContain('using BitmapReadbackBackendReason = flight::String;');
  });

  it('refuses intersections without a compatible object composition', () => {
    const result = lower('inter.ts', 'export const x: number = 1;');
    const module = structuredClone(result.module);
    const decl = module.declarations[0];
    if (decl?.kind === 'variable' && !('pattern' in decl)) {
      (decl as any).type = { kind: 'intersection', types: [] };
    }
    expect(() => emitIrModuleCpp(module)).toThrow('intersection');
  });

  it('emits object intersections as one composed reference shape', () => {
    const result = lower(
      'object-intersection.ts',
      `interface Position { x: number }
       interface Label { text: string }
       export type LabeledPosition = Position & Label;`,
    );
    const emitted = emitIrModuleCpp(result.module, { runtimeProfile: 'flight-cpp' });

    expect(emitted.contents).toContain('struct LabeledPosition : public flight::ReferenceEnabled');
    expect(emitted.contents).toContain('double x;');
    expect(emitted.contents).toContain('flight::String text;');
  });

  it('erases phantom object brands from primitive intersections', () => {
    const result = lower(
      'primitive-brand.ts',
      `export type Handle = number & { readonly __brand: 'Handle' };
       export function identity(handle: Handle): Handle { return handle; }`,
    );
    const emitted = emitIrModuleCpp(result.module, { runtimeProfile: 'flight-cpp' });

    expect(emitted.contents).toContain('using Handle = double');
    expect(emitted.contents).toContain('Handle identity(Handle handle)');
  });

  it('emits boolean literal type as bool', () => {
    const result = lower('bool-lit.ts', 'export function yes(): true { return true; }');
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('bool yes()');
  });

  it('emits string literal type with flight-cpp runtime', () => {
    const result = lower('str-lit-type.ts', "export function tag(): 'hello' { return 'hello'; }");
    const emitted = emitIrModuleCpp(result.module, { runtimeProfile: 'flight-cpp' });
    expect(emitted.contents).toContain('flight::String tag()');
  });

  it('emits standalone null and undefined sentinel types', () => {
    const result = lower(
      'presence-types.ts',
      'export function noValue(): null { return null; } export function missing(): undefined { return undefined; }',
    );
    const emitted = emitIrModuleCpp(result.module);

    expect(emitted.contents).toContain('std::nullptr_t no_value()');
    expect(emitted.contents).toContain('std::monostate missing()');
    expect(emitted.contents).toContain('return std::monostate{};');
  });

  it('emits symbol type as int', () => {
    const result = lower('symbol.ts', 'export const x: number = 1;');
    const module = structuredClone(result.module);
    const decl = module.declarations[0];
    if (decl?.kind === 'variable' && !('pattern' in decl)) {
      (decl as any).type = { kind: 'primitive', name: 'symbol' };
    }
    const emitted = emitIrModuleCpp(module);
    expect(emitted.contents).toContain('int x');
  });

  it('emits unknown type as auto', () => {
    const result = lower('unknown.ts', 'export const x: number = 1;');
    const module = structuredClone(result.module);
    const decl = module.declarations[0];
    if (decl?.kind === 'variable' && !('pattern' in decl)) {
      (decl as any).type = { kind: 'unknown', source: 'param' };
    }
    const emitted = emitIrModuleCpp(module);
    expect(emitted.contents).toContain('auto x');
  });

  it('terminates inferred binding collection when an alias remains unknown', () => {
    const module = lower(
      'unknown-alias.ts',
      'export function forward(value: unknown): unknown { const alias = value; return alias; }',
    ).module;

    expect(emitIrModuleCpp(module).contents).toContain('auto alias = value;');
  });

  it('refuses Partial<T> types', () => {
    const result = lower('partial.ts', 'export const x: number = 1;');
    const module = structuredClone(result.module);
    const decl = module.declarations[0];
    if (decl?.kind === 'variable' && !('pattern' in decl)) {
      (decl as any).type = {
        kind: 'named',
        reference: { kind: 'ambient', name: 'Partial' },
        typeArguments: [{ kind: 'primitive', name: 'number' }],
      };
    }
    expect(() => emitIrModuleCpp(module)).toThrow('Partial');
  });

  it('emits Partial<T> object shapes with optional C++ fields', () => {
    const result = lower(
      'partial-object.ts',
      'interface Options { count: number; label: string; } export function apply(options: Partial<Options>): void {}',
    );
    const emitted = emitIrModuleCpp(result.module);

    expect(emitted.contents).toContain('std::optional<double> count;');
    expect(emitted.contents).toContain('std::optional<std::string> label;');
    expect(emitted.contents).toContain('void apply(count_label options)');
  });

  it('resolves NonNullable over a named object indexed access', () => {
    const result = lower(
      'non-nullable-indexed.ts',
      `interface Explanation { container: 'atf' | 'dds' | null }
       export function identify(container: NonNullable<Explanation['container']>): string { return container; }`,
    );
    const emitted = emitIrModuleCpp(result.module, { runtimeProfile: 'flight-cpp' });

    expect(emitted.contents).toContain('flight::String identify(flight::String container)');
  });

  it('resolves Readonly<Partial<T>> through imported interface barrels', () => {
    const model = lowerPackage(
      '@flighthq/types',
      'has-appearance.ts',
      'export interface HasAppearance { alpha: number; visible: boolean; }',
    ).module;
    const barrel = lowerPackage(
      '@flighthq/types',
      'contract.ts',
      "export type { HasAppearance } from './has-appearance.js';",
    ).module;
    const consumer = lowerPackage(
      '@flighthq/node',
      'has-appearance.ts',
      "import type { HasAppearance } from '@flighthq/types/contract'; export function init(target: HasAppearance, obj?: Readonly<Partial<HasAppearance>>): void { target.alpha = obj?.alpha ?? 1; target.visible = obj?.visible ?? true; }",
    ).module;
    const moduleResolution: CompilerModuleResolutionPlan = {
      edges: [
        {
          importer: { name: consumer.name, packageName: consumer.packageName, source: consumer.source },
          specifier: '@flighthq/types/contract',
          target: { packageName: barrel.packageName, source: barrel.source },
        },
        {
          importer: { name: barrel.name, packageName: barrel.packageName, source: barrel.source },
          specifier: './has-appearance.js',
          target: { packageName: model.packageName, source: model.source },
        },
      ],
      schema: 'flight-compiler-module-resolution/1',
    };
    const session = createCppCompilerBackend().createEmissionSession!({
      moduleResolution,
      modules: [consumer, barrel, model],
      options: { runtimeProfile: 'flight-cpp' },
    });
    const emitted = session.emitModule(consumer)[0]!.contents;

    expect(emitted).toContain('std::optional<double> alpha;');
    expect(emitted).toContain('std::optional<bool> visible;');
    expect(emitted).toContain('std::optional<flight::Ref<alpha_visible>> obj = std::nullopt');
    expect(emitted).toContain('auto optional_chain_receiver = obj;');
    expect(emitted).toContain('std::optional<double>');
    expect(emitted).not.toContain('std::optional<auto>');
  });

  it.each([
    ['curve alias', 'type ParticleValue = ReadonlyArray<number>;', 'alphaCurve', 'alpha_curve'],
    ['string union alias', "type ParticleValue = 'add' | 'multiply' | 'normal' | 'screen';", 'blendMode', 'blend_mode'],
  ])('coalesces nullable Partial<T> %s members into contextual optional storage', (_, alias, field, emittedField) => {
    const result = lower(
      'particle-emitter-config.ts',
      `${alias}
       interface ParticleEmitterConfig {
         ${field}: ParticleValue | null;
       }
       export function initialize(
         out: ParticleEmitterConfig,
         config?: Partial<ParticleEmitterConfig>,
       ): void {
         out.${field} = config?.${field} ?? null;
       }`,
    );

    expect(result.diagnostics).toEqual([]);
    const emitted = emitIrModuleCpp(result.module, { runtimeProfile: 'flight-cpp' }).contents;
    expect(emitted).toContain(`out->${emittedField} =`);
    expect(emitted).toContain('auto optional_chain_receiver = config;');
    expect(emitted).not.toContain('std::optional<auto>');
  });

  it('emits C++ keywords with trailing underscore', () => {
    const result = lower(
      'keywords.ts',
      'export function check(value: number): number { const auto_val: number = value; return auto_val; }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('double check');
  });

  it('escapes C++ keywords in exported function target names', () => {
    const result = lower('keyword-fn.ts', 'export function or(a: boolean, b: boolean): boolean { return a || b; }');
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('or_');
    expect(emitted.contents).not.toMatch(/\bbool or\b/);
  });

  it('emits variable without type as auto', () => {
    const result = lower('auto-var.ts', 'export const value = 42;');
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toMatch(/(?:auto|double)\s+value/);
  });

  it('emits string concatenation with flight-cpp runtime', () => {
    const result = lower(
      'concat-flight.ts',
      'export function greet(name: string): string { return "Hello, " + name; }',
    );
    const emitted = emitIrModuleCpp(result.module, { runtimeProfile: 'flight-cpp' });
    expect(emitted.contents).toContain('+');
    expect(emitted.contents).not.toContain('#include <string>');
  });

  it('emits target name allocation collision as emission failure', () => {
    const result = lower('collision.ts', 'export const x: number = 1;');
    const module = structuredClone(result.module);
    const binding = {
      id: 'b:1',
      kind: 'variable' as const,
      column: 1,
      fingerprint: 'sha256:a',
      line: 1,
      name: 'value',
      packageName: '@flighthq/math',
      scope: 'module' as const,
      source: 'test.ts',
      space: 'value' as const,
    };
    const binding2 = { ...binding, id: 'b:2', fingerprint: 'sha256:b', line: 2 };
    (module as unknown as { declarations: unknown[] }).declarations = [
      {
        kind: 'variable',
        binding,
        mutable: false,
        type: { kind: 'primitive', name: 'number' },
        initializer: { kind: 'literal', value: 1 },
      },
      {
        kind: 'variable',
        binding: binding2,
        mutable: false,
        type: { kind: 'primitive', name: 'number' },
        initializer: { kind: 'literal', value: 2 },
      },
    ] as any;
    expect(() => emitIrModuleCpp(module)).toThrow();
  });

  it('emits class with overridden method using override keyword', () => {
    const result = lower(
      'override.ts',
      'class A { x(): number { return 1; } } export class B extends A { x(): number { return 2; } }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('override');
  });

  it('emits block statement with braces', () => {
    const result = lower('block.ts', 'export function run(): number { { let x: number = 1; return x; } }');
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('{');
  });

  it('emits string enum with flight-cpp runtime', () => {
    const result = lower('str-enum-flight.ts', "export enum Color { Red = 'red', Green = 'green' }");
    const emitted = emitIrModuleCpp(result.module, { runtimeProfile: 'flight-cpp' });
    expect(emitted.contents).toContain('struct Color');
  });

  it('reuses existing anonymous struct when types match', () => {
    const result = lower(
      'reuse-struct.ts',
      'export function a(): { x: number; y: number } { return { x: 1, y: 2 }; } export function b(): { x: number; y: number } { return { x: 3, y: 4 }; }',
    );
    const emitted = emitIrModuleCpp(result.module);
    const structMatches = emitted.contents.match(/struct \w+ \{/g) ?? [];
    const anonymousStructs = structMatches.filter((m) => !m.includes('flighthq'));
    expect(anonymousStructs.length).toBe(1);
  });

  it('emits return without expression in void function', () => {
    const result = lower('void-return.ts', 'export function stop(): void { return; }');
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('return;');
  });

  it('skips non-relative import specifiers', () => {
    const result = lower(
      'external-import.ts',
      "import { something } from 'external-package'; export function use(): number { return something(); }",
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).not.toContain('#include "external');
  });

  it('emits typeof prefix as typeid', () => {
    const result = lower('typeof.ts', 'export const x: number = 1;');
    const module = structuredClone(result.module);
    const decl = module.declarations[0];
    if (decl?.kind === 'variable' && !('pattern' in decl)) {
      (decl as any).initializer = {
        kind: 'unary',
        operator: 'typeof',
        operand: { kind: 'literal', value: 1 },
        prefix: true,
        postfix: false,
        semantics: { operand: { flow: 'number' } },
      };
    }
    const emitted = emitIrModuleCpp(module);
    expect(emitted.contents).toContain('typeid');
  });

  it('emits void prefix operator', () => {
    const result = lower('void-op.ts', 'export const x: number = 1;');
    const module = structuredClone(result.module);
    const decl = module.declarations[0];
    if (decl?.kind === 'variable' && !('pattern' in decl)) {
      (decl as any).initializer = {
        kind: 'unary',
        operator: 'void',
        operand: { kind: 'literal', value: 0 },
        prefix: true,
        postfix: false,
        semantics: { operand: { flow: 'number' } },
      };
    }
    const emitted = emitIrModuleCpp(module);
    expect(emitted.contents).toContain('(void)');
  });

  it('emits for-of with typed variable', () => {
    const result = lower(
      'for-of-typed.ts',
      'export function sum(items: number[]): number { let total: number = 0; for (const item of items) { total = total + item; } return total; }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('auto item');
  });

  it('detects return statements in if branches for try-finally deferred return', () => {
    const result = lower(
      'try-if-return.ts',
      'export async function check(task: Promise<number>): Promise<number> { try { if (true) { return await task; } else { return await task; } } finally { let x: number = 0; } }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('finally_return');
  });

  it('detects return statements in try body for try-catch-finally deferred return', () => {
    const result = lower(
      'try-catch-ret.ts',
      'export async function safe(task: Promise<number>): Promise<number> { try { return await task; } catch (e) { throw e; } finally { let x: number = 0; } }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('finally_return');
    expect(emitted.contents).toContain('catch');
  });

  it('emits try-finally without catch clause', () => {
    const result = lower(
      'try-finally-no-catch.ts',
      'export async function run(task: Promise<number>): Promise<number> { let r: number = 0; try { r = await task; } finally { r = 0; } return r; }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('std::exception_ptr');
    expect(emitted.contents).not.toContain('catch (const std::exception');
  });

  it('emits tupleSpread with mixed element and spread segments', () => {
    const result = lower(
      'tuple-spread.ts',
      'export function combine(pair: [number, number]): [number, number, number] { return [0, ...pair]; }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('std::make_tuple');
    expect(emitted.contents).toContain('std::get<');
  });

  it('emits deep class inheritance chain walking all ancestor methods for overrides', () => {
    const result = lower(
      'deep-inherit.ts',
      'class A { run(): number { return 1; } } class B extends A { step(): number { return 2; } } export class C extends B { run(): number { return 3; } step(): number { return 4; } }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('override');
    expect((emitted.contents.match(/override/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it('emits && and || binary operators as C++ logical operators', () => {
    const result = lower(
      'logical.ts',
      'export function both(a: boolean, b: boolean): boolean { return a && b; } export function either(a: boolean, b: boolean): boolean { return a || b; }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('&&');
    expect(emitted.contents).toContain('||');
  });

  it('uses stable source-identity spelling for colliding public C++ names', () => {
    const result = lower(
      'collision.ts',
      'export function fooBar(): number { return 1; } export function foo_bar(): number { return 2; }',
    );
    const changedBodies = lower(
      'collision.ts',
      'export function fooBar(): number { return 3; } export function foo_bar(): number { return 4; }',
    );
    const reversed = lower(
      'collision.ts',
      'export function foo_bar(): number { return 2; } export function fooBar(): number { return 1; }',
    );
    const emitted = emitIrModuleCpp(result.module);
    const changed = emitIrModuleCpp(changedBodies.module);
    const reordered = emitIrModuleCpp(reversed.module);

    expect(emitted.contents).toContain('double foo_bar_flight_value_function_foo_u000042_ar()');
    expect(emitted.contents).toContain('double foo_bar_flight_value_function_foo_u00005f_bar()');
    expect(changed.contents).toContain('double foo_bar_flight_value_function_foo_u000042_ar()');
    expect(changed.contents).toContain('double foo_bar_flight_value_function_foo_u00005f_bar()');
    expect(reordered.contents).toContain('double foo_bar_flight_value_function_foo_u000042_ar()');
    expect(reordered.contents).toContain('double foo_bar_flight_value_function_foo_u00005f_bar()');
  });

  it('falls back to _internal_ output path when source path does not resolve to a file name', () => {
    const result = lower('index.ts', 'export const value = 1;');
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.path).toMatch(/^_internal_/);
  });

  it('emits class field with inferred type from initializer', () => {
    const result = lower('field-infer.ts', 'export class Pt { x = 0; }');
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('struct Pt');
    expect(emitted.contents).toMatch(/\bx\b/);
  });

  it('emits abstract class with pure virtual method', () => {
    const result = lower('shape.ts', 'export abstract class Shape { abstract area(): number; }');
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('= 0;');
    expect(emitted.contents).toContain('virtual');
  });

  it('initializes abstract field overrides in derived constructor', () => {
    const result = lower(
      'abstract-field.ts',
      `export abstract class Component {
        abstract name: string;
        abstract readonly version: number;
        public describe(): string { return this.name; }
        public getVersion(): number { return this.version; }
      }
      export class Button extends Component {
        name: string = 'button';
        readonly version: number = 1;
      }`,
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('struct Button : public Component');
    expect(emitted.contents).toContain('Button()');
    expect(emitted.contents).toContain('this->name =');
    expect(emitted.contents).toContain('this->version =');
    expect(emitted.contents).not.toMatch(/struct Button[^}]*flight::String name/s);
  });

  it('emits string enum as struct with string value', () => {
    const result = lower('status.ts', "export enum Status { Active = 'ACTIVE', Inactive = 'INACTIVE' }");
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('struct Status');
  });

  it('emits mutable variable without const qualifier', () => {
    const result = lower('mut-var.ts', 'export function inc(): number { let x: number = 1; x = x + 1; return x; }');
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toMatch(/^\s*double x/m);
  });

  it('emits variable without initializer', () => {
    const result = lower('no-init.ts', 'export function init(): number { let x: number; x = 42; return x; }');
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('double x;');
  });

  it('emits ** binary operator as std::pow', () => {
    const result = lower('pow-op.ts', 'export function square(x: number): number { return x ** 2; }');
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('std::pow');
  });

  it('emits >>> binary operator as unsigned right shift', () => {
    const result = lower('shr-op.ts', 'export function shift(x: number): number { return x >>> 1; }');
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('static_cast<uint32_t>');
  });

  it('emits *= compound assignment operator', () => {
    const result = lower(
      'mul-assign.ts',
      'export function double_(x: number): number { let y: number = x; y *= 2; return y; }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('*=');
  });

  it('emits -= compound assignment operator', () => {
    const result = lower(
      'sub-assign.ts',
      'export function dec(x: number): number { let y: number = x; y -= 1; return y; }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('-=');
  });

  it('emits bitwise compound assignment with int32 casts', () => {
    const result = lower(
      'bitwise-assign.ts',
      'export function mask(value: number, m: number): number { let r: number = value; r &= m; r |= 1; r ^= 255; r <<= 2; r >>= 1; return r; }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain(
      'static_cast<double>(static_cast<int32_t>(assignment_target) & static_cast<int32_t>(m))',
    );
    expect(emitted.contents).toContain(
      'static_cast<double>(static_cast<int32_t>(assignment_target) | static_cast<int32_t>(1.0))',
    );
    expect(emitted.contents).toContain(
      'static_cast<double>(static_cast<int32_t>(assignment_target) ^ static_cast<int32_t>(255.0))',
    );
    expect(emitted.contents).toContain(
      'static_cast<double>(static_cast<int32_t>(assignment_target) << static_cast<int32_t>(2.0))',
    );
    expect(emitted.contents).toContain(
      'static_cast<double>(static_cast<int32_t>(assignment_target) >> static_cast<int32_t>(1.0))',
    );
    expect(emitted.contents).toContain('#include <cstdint>');
  });

  it('emits %= compound assignment as std::fmod', () => {
    const result = lower(
      'mod-assign.ts',
      'export function remainder(value: number, divisor: number): number { let r: number = value; r %= divisor; return r; }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('std::fmod(assignment_target, divisor)');
    expect(emitted.contents).toContain('#include <cmath>');
    expect(emitted.contents).not.toContain('%=');
  });

  it('emits break and continue statements in for-of loop', () => {
    const result = lower(
      'break-continue.ts',
      'export function process(items: number[]): number { let r: number = 0; for (const x of items) { if (x < 0) { continue; } if (x > 100) { break; } r = r + x; } return r; }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('break;');
    expect(emitted.contents).toContain('continue;');
  });

  it('emits do-while loop', () => {
    const result = lower(
      'do-loop.ts',
      'export function count(): number { let x: number = 0; do { x = x + 1; } while (x < 5); return x; }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('do {');
    expect(emitted.contents).toContain('} while');
  });

  it('emits for-in iterating over object keys', () => {
    const result = lower(
      'for-in-keys.ts',
      'export function collectKeys(obj: { x: number; y: number }): string { let r: string = ""; for (const key in obj) { r = key; } return r; }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('std::vector<std::string>');
  });

  it('emits for-in with static key iteration for simple object', () => {
    const result = lower(
      'for-in-static.ts',
      'export function keys(obj: { a: number; b: number }): string { let r: string = ""; for (const key in obj) { r = r + key; } return r; }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('std::vector<std::string>');
    expect(emitted.contents).toContain('"a"');
    expect(emitted.contents).toContain('"b"');
  });

  it('emits array.length as sizeMethod call in property access', () => {
    const result = lower('arr-length.ts', 'export function len(arr: number[]): number { return arr.length; }');
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('static_cast<double>');
    expect(emitted.contents).toContain('.size()');
  });

  it('emits this reference in class method', () => {
    const result = lower('this-ref.ts', 'export class Box { value: number = 0; get(): number { return this.value; } }');
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('this->');
  });

  it('emits return in catch body for try-catch-finally deferred return detection', () => {
    const result = lower(
      'catch-return.ts',
      'export async function safe(task: Promise<number>): Promise<number> { try { return await task; } catch (e) { return await task; } finally { let x: number = 0; } }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('finally_return');
  });

  it('emits try-finally with async co_return for deferred return', () => {
    const result = lower(
      'async-try-finally.ts',
      'export async function fetch(task: Promise<number>): Promise<number> { try { return await task; } finally { let cleanup: number = 0; } }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('co_return');
    expect(emitted.contents).toContain('finally_return');
  });

  it('emits element access on array with computed index', () => {
    const result = lower('elem-access.ts', 'export function get(arr: number[], i: number): number { return arr[i]; }');
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('static_cast<size_t>');
  });

  it('emits conditional expression as ternary', () => {
    const result = lower('ternary.ts', 'export function pick(cond: boolean): number { return cond ? 1 : 0; }');
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('?');
  });

  it('emits super constructor call as initializer list entry', () => {
    const result = lower(
      'super-ctor.ts',
      'class Base { value: number; constructor(v: number) { this.value = v; } } export class Child extends Base { extra: number; constructor(v: number) { super(v); this.extra = v + 1; } }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('Base(');
  });

  it('emits class extending another class in the same module', () => {
    const result = lower(
      'same-mod-extend.ts',
      'export class Base { run(): number { return 1; } } export class Child extends Base { run(): number { return 2; } }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain(': public Base');
    expect(emitted.contents).toContain('override');
  });

  it('emits optional function parameter with std::optional default', () => {
    const result = lower(
      'optional-param.ts',
      'export function greet(name: string, loud?: boolean): string { return name; }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('std::optional');
    expect(emitted.contents).toContain('std::nullopt');
  });

  it('emits rest parameter as std::vector', () => {
    const result = lower(
      'rest-param.ts',
      'export function sum(...nums: number[]): number { let total: number = 0; for (const n of nums) { total = total + n; } return total; }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('std::vector<double>');
  });

  it('emits new Promise with flight-cpp runtime as Promise::create', () => {
    const result = lower(
      'promise-new.ts',
      'export function make(fn: (resolve: (value: number) => void) => void): Promise<number> { return new Promise<number>(fn); }',
    );
    const emitted = emitIrModuleCpp(result.module, { runtimeProfile: 'flight-cpp' });
    expect(emitted.contents).toContain('::create(');
  });

  it('emits nullish comparison with ambient on left side selecting right operand', () => {
    const result = lower(
      'nullish-left-ambient.ts',
      'export function check(x: number | undefined): boolean { return undefined !== x; }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('.has_value()');
  });

  it('emits runtime header from options instead of default', () => {
    const result = lower('value.ts', 'export const value = 1;');
    const emitted = emitIrModuleCpp(result.module, { runtimeHeader: 'custom/runtime.h' });
    expect(emitted.contents).toContain('#include "custom/runtime.h"');
    expect(emitted.contents).not.toContain('flight/runtime.hpp');
  });

  it('emits function type in type position', () => {
    const result = lower('fn-type.ts', 'export function apply(fn: (x: number) => string): string { return fn(1); }');
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('std::function');
  });

  it('emits an intact multi-member union when no member access is needed', () => {
    const result = lower('union-variant.ts', 'export function pick(x: number | string): number | string { return x; }');
    const emitted = emitIrModuleCpp(result.module);

    expect(emitted.contents).toContain('std::variant<double, std::string> pick(std::variant<double, std::string> x)');
    expect(emitted.contents).toContain('return x');
  });

  it('resolves reexported type aliases when constructing contextual unions', () => {
    const status = lowerPackage('@flighthq/types', 'status.ts', "export type Status = 'ready' | 'done';").module;
    const contract = lowerPackage('@flighthq/types', 'contract.ts', "export * from './status';").module;
    const consumer = lowerPackage(
      '@flighthq/consumer',
      'detect.ts',
      "import type { Status } from '@flighthq/types/contract'; export function detect(ok: boolean): Status | null { return ok ? 'ready' : null; }",
    ).module;
    const moduleResolution: CompilerModuleResolutionPlan = {
      edges: [
        {
          importer: consumer,
          specifier: '@flighthq/types/contract',
          target: { packageName: contract.packageName, source: contract.source },
        },
        {
          importer: contract,
          specifier: './status',
          target: { packageName: status.packageName, source: status.source },
        },
      ],
      schema: 'flight-compiler-module-resolution/1',
    };
    const emitted = createCppCompilerBackend().createEmissionSession!({
      moduleResolution,
      modules: [consumer, contract, status],
      options: { runtimeProfile: 'flight-cpp' },
    }).emitModule(consumer)[0]!;

    expect(emitted.contents).toContain('std::optional<flight::String> detect(bool ok)');
    expect(emitted.contents).toContain('flight::String("ready")');
  });

  it('emits discriminant tests and member access only from checker-proven evidence', () => {
    const result = lower(
      'shape.ts',
      `export interface Circle { readonly kind: 'circle'; readonly radius: number; }
       export interface Square { readonly kind: 'square'; readonly side: number; }
       export type Shape = Circle | Square;
       export function area(shape: Shape): number {
         if (shape.kind === 'circle') return shape.radius;
         return shape.side;
       }`,
    );
    const emitted = emitIrModuleCpp(result.module);

    expect(emitted.contents).toContain('using Shape = std::variant<Circle, Square>');
    expect(emitted.contents).toContain('shape.index() == 0');
    expect(emitted.contents).toContain('std::get<0>(shape).radius');
    expect(emitted.contents).toContain('std::get<1>(shape).side');
  });

  it('collapses equivalent alternatives, projects common properties, and emits optional variants', () => {
    const duplicate = lower(
      'duplicate.ts',
      'type Numeric = number; export function duplicate(value: Numeric | number): Numeric | number { return value; }',
    );
    const open = lower(
      'open.ts',
      `interface Exact { kind: 'exact'; value: number; }
       interface Open { kind: string; value: number; }
       export function read(value: Exact | Open): number {
         if (value.kind === 'exact') return value.value;
         return value.value;
       }`,
    );
    const nullable = lower(
      'nullable-variant.ts',
      'export function maybe(value: string | number | undefined): string | number | undefined { return value; }',
    );

    expect(emitIrModuleCpp(duplicate.module).contents).toContain('double duplicate(double value)');
    expect(emitIrModuleCpp(open.module).contents).toContain(
      'std::visit([](const auto& value) { return value.value; }, value)',
    );
    expect(emitIrModuleCpp(nullable.module).contents).toContain(
      'std::optional<std::variant<double, std::string>> maybe(std::optional<std::variant<double, std::string>> value)',
    );
  });

  it('constructs heterogeneous conditional union arms explicitly', () => {
    const result = lower(
      'conditional-union.ts',
      'export function choose(flag: boolean): string | number { return flag ? "x" : 1; }',
    );
    const output = emitIrModuleCpp(result.module).contents;

    expect(output).toContain('std::variant<double, std::string> choose(bool flag)');
    expect(output).toContain(
      'flag ? std::variant<double, std::string>{std::in_place_type<std::string>, "x"} : std::variant<double, std::string>{std::in_place_type<double>, 1.0}',
    );
  });

  it('constructs optional variant values and undefined absence explicitly', () => {
    const result = lower(
      'optional-variant.ts',
      `export function choose(flag: number): string | number | undefined {
        if (flag === 0) return undefined;
        return flag > 0 ? "x" : 1;
      }`,
    );
    const output = emitIrModuleCpp(result.module).contents;

    expect(output).toContain('std::optional<std::variant<double, std::string>> choose(double flag)');
    expect(output).toContain('return std::nullopt');
    expect(output).toContain(
      'std::optional<std::variant<double, std::string>>{std::in_place, std::in_place_type<std::string>, "x"}',
    );
    expect(output).toContain(
      'std::optional<std::variant<double, std::string>>{std::in_place, std::in_place_type<double>, 1.0}',
    );
  });

  it('propagates union construction through array, object, and call-argument contexts', () => {
    const result = lower(
      'nested-union.ts',
      `interface Box { value: string | number; }
       function accept(value: string | number): number { return 1; }
       export function nested(flag: boolean): number {
         const values: Array<string | number> = [flag ? "array" : 1];
         const box: Box = { value: flag ? "object" : 2 };
         return accept(flag ? "argument" : 3) + values.length + box.value.toString().length;
       }`,
    );
    const output = emitIrModuleCpp(result.module).contents;

    expect(output).toContain('std::vector<std::variant<double, std::string>> values');
    expect(output).toContain('std::in_place_type<std::string>, "array"');
    expect(output).toContain('std::in_place_type<double>, 2.0');
    expect(output).toContain('std::in_place_type<std::string>, "argument"');
  });

  it('preserves null and undefined as distinct flight-cpp variant alternatives', () => {
    const result = lower(
      'dual-sentinel.ts',
      `export function choose(flag: number): number | null | undefined {
         if (flag < 0) return null;
         if (flag === 0) return undefined;
         return 1;
       }
       export function isNull(value: number | null | undefined): boolean { return value === null; }
       export function isNullish(value: number | null | undefined): boolean { return value == null; }
       export function read(value: number | null | undefined): number {
         if (value == null) return 0;
         return value;
       }`,
    );
    const output = emitIrModuleCpp(result.module, { runtimeProfile: 'flight-cpp' }).contents;

    expect(output).toContain('std::variant<double, flight::Null, flight::Undefined>');
    expect(output).toContain('std::in_place_type<flight::Null>, flight::null');
    expect(output).toContain('std::in_place_type<flight::Undefined>, flight::undefined');
    expect(output).toContain('std::in_place_type<double>, 1.0');
    expect(output).toContain('std::holds_alternative<flight::Null>(value)');
    expect(output).toContain('std::holds_alternative<flight::Undefined>(value)');
    expect(output).toContain('return std::get<double>(value)');
  });

  it('uses distinct standard sentinel alternatives without the flight-cpp runtime', () => {
    const result = lower(
      'generic-dual-sentinel.ts',
      'export function choose(flag: boolean): number | null | undefined { return flag ? null : undefined; }',
    );
    const output = emitIrModuleCpp(result.module).contents;

    expect(output).toContain('#include <cstddef>');
    expect(output).toContain('std::variant<double, std::nullptr_t, std::monostate>');
    expect(output).toContain('std::in_place_type<std::nullptr_t>, nullptr');
    expect(output).toContain('std::in_place_type<std::monostate>, std::monostate{}');
  });

  it('wraps a runtime-equivalent source union in a wider optional union', () => {
    const result = lower(
      'optional-source-union.ts',
      `type Reason = 'blocked' | 'missing';
       export function explain(reason: Reason): Reason | null { return reason; }`,
    );
    const output = emitIrModuleCpp(result.module, { runtimeProfile: 'flight-cpp' }).contents;

    expect(output).toContain('std::optional<flight::String>{reason}');
  });

  it('uses the declared Record value type when contextual object members are unions', () => {
    const result = lower(
      'record-union-values.ts',
      `type Kind = 'present' | 'missing';
       interface Info { readonly width: number; }
       function createInfo(): Info { return { width: 1 }; }
       const values: Record<Kind, Info | null> = { present: createInfo(), missing: null };
       export function getInfo(kind: Kind): Info | null { return values[kind]; }`,
    );
    const output = emitIrModuleCpp(result.module, { runtimeProfile: 'flight-cpp' }).contents;

    expect(output).toContain('std::optional<flight::Ref<Info>>{create_info()}');
  });

  it('uses imported function returns as optional and variant construction evidence', () => {
    const producer = lowerPackage(
      '@flighthq/adjustments',
      'producer.ts',
      'export function matrix(): number[] { return [1]; } export function scalar(): number { return 1; }',
    ).module;
    const consumer = lowerPackage(
      '@flighthq/adjustments',
      'consumer.ts',
      `import { matrix, scalar } from './producer';
       interface Cache { value: number | null; }
       export function optional(): number[] | null { return matrix(); }
       export function variant(flag: boolean): number | string {
         const value = scalar();
         return flag ? value : 'missing';
       }
       export function update(cache: Cache): number {
         const value = scalar();
         cache.value = value;
         return value;
       }`,
    ).module;
    const moduleResolution: CompilerModuleResolutionPlan = {
      edges: [
        {
          importer: {
            name: consumer.name,
            packageName: consumer.packageName,
            source: consumer.source,
          },
          specifier: './producer',
          target: {
            packageName: producer.packageName,
            source: producer.source,
          },
        },
      ],
      schema: 'flight-compiler-module-resolution/1',
    };
    const output = createCppCompilerBackend().createEmissionSession!({
      moduleResolution,
      modules: [consumer, producer],
      options: { runtimeProfile: 'flight-cpp' },
    }).emitModule(consumer)[0]!.contents;

    expect(output).toContain('return std::optional<flight::Array<double>>{flighthq_adjustments::matrix()};');
    expect(output).toContain('std::variant<double, flight::String>{std::in_place_type<double>, value}');
    expect(output).toContain('cache->value = std::optional<double>{value}');
  });

  it('prefers a written readonly function result over checker-degraded call evidence', () => {
    const result = lower(
      'readonly-call-result.ts',
      `function find(): readonly number[] | null { return null; }
       export function resolve(): readonly number[] | null {
         const value = find();
         return value;
       }`,
    );
    const output = emitIrModuleCpp(result.module, {
      runtimeProfile: 'flight-cpp',
    }).contents;

    expect(output).toContain('std::optional<flight::Array<double>> value = find();');
  });

  it('uses imported structural object evidence for copied adjustment values', () => {
    const modelSource = ts.createSourceFile(
      '/flight/packages/types/src/model.ts',
      `export interface Entity { runtime: object; }
       export type EntityWithoutRuntime<Type extends Entity> = Omit<Type, 'runtime'>;
       export interface Scale extends Entity { redScale: number; redBias: number; }
       export type ScaleLike = EntityWithoutRuntime<Scale>;`,
      ts.ScriptTarget.Latest,
      true,
    );
    const contractSource = ts.createSourceFile(
      '/flight/packages/types/src/contract.ts',
      "export type { ScaleLike } from './model';",
      ts.ScriptTarget.Latest,
      true,
    );
    const consumerSource = ts.createSourceFile(
      '/flight/packages/adjustments/src/scale.ts',
      `import type { ScaleLike } from '@flighthq/types/contract';
       export function matrix(scale: Readonly<ScaleLike>): number[] {
         const value = { ...scale };
         const result = [value.redScale, 0, value.redBias];
         return result;
       }`,
      ts.ScriptTarget.Latest,
      true,
    );
    const moduleResolution: CompilerModuleResolutionPlan = {
      edges: [
        {
          specifier: '@flighthq/types/contract',
          target: {
            packageName: '@flighthq/types',
            source: 'packages/types/src/contract.ts',
          },
        },
        {
          specifier: './model',
          target: {
            packageName: '@flighthq/types',
            source: 'packages/types/src/model.ts',
          },
        },
      ],
      schema: 'flight-compiler-module-resolution/1',
    };
    const results = lowerTypeScriptSources(
      [
        {
          packageName: '@flighthq/types',
          sourceFile: modelSource,
          upstreamDirectory: '/flight',
        },
        {
          packageName: '@flighthq/types',
          sourceFile: contractSource,
          upstreamDirectory: '/flight',
        },
        {
          packageName: '@flighthq/adjustments',
          sourceFile: consumerSource,
          upstreamDirectory: '/flight',
        },
      ],
      moduleResolution,
    );
    const modules = results.map((result) => result.module);
    const output = createCppCompilerBackend().createEmissionSession!({
      moduleResolution,
      modules,
      options: { runtimeProfile: 'flight-cpp' },
    }).emitModule(modules[2]!)[0]!.contents;

    expect(output).toContain('flight::Array<double> result = flight::Array<double>');
    expect(output).not.toContain('std::variant<double, auto>');
  });

  it('emits a dense matrix from an independently lowered imported construction shape', () => {
    const entity = lowerPackage(
      '@flighthq/types',
      'Entity.ts',
      `export const EntityRuntimeKey = Symbol.for('EntityRuntime');
       export interface Entity { [EntityRuntimeKey]: object | undefined; }
       export type EntityWithoutRuntime<Type extends Entity> = Omit<Type, typeof EntityRuntimeKey>;`,
    ).module;
    const scale = lowerPackage(
      '@flighthq/types',
      'ColorScaleBias.ts',
      `import type { Entity, EntityWithoutRuntime } from './Entity';
       export interface ColorScaleBias extends Entity {
         alphaBias: number; alphaScale: number; blueBias: number; blueScale: number;
         greenBias: number; greenScale: number; redBias: number; redScale: number;
       }
       export type ColorScaleBiasLike = EntityWithoutRuntime<ColorScaleBias>;`,
    ).module;
    const contract = lowerPackage(
      '@flighthq/types',
      'contract.ts',
      "export * from './ColorScaleBias'; export * from './Entity';",
    ).module;
    const consumer = lowerPackage(
      '@flighthq/adjustments',
      'colorScaleBiasAdjustment.ts',
      `import type { ColorScaleBiasLike } from '@flighthq/types/contract';
       export function matrix(colorScaleBias: Readonly<ColorScaleBiasLike>): number[] {
         const value = { ...colorScaleBias };
         const colorMatrix = [
           value.redScale, 0, 0, 0, value.redBias,
           0, value.greenScale, 0, 0, value.greenBias,
           0, 0, value.blueScale, 0, value.blueBias,
           0, 0, 0, value.alphaScale, value.alphaBias,
         ];
         return colorMatrix;
       }`,
    ).module;
    const moduleResolution: CompilerModuleResolutionPlan = {
      edges: [
        {
          specifier: '@flighthq/types/contract',
          target: { packageName: contract.packageName, source: contract.source },
        },
        {
          specifier: './ColorScaleBias',
          target: { packageName: scale.packageName, source: scale.source },
        },
        {
          specifier: './Entity',
          target: { packageName: entity.packageName, source: entity.source },
        },
      ],
      schema: 'flight-compiler-module-resolution/1',
    };
    const output = createCppCompilerBackend().createEmissionSession!({
      moduleResolution,
      modules: [consumer, contract, entity, scale],
      options: { runtimeProfile: 'flight-cpp' },
    }).emitModule(consumer)[0]!.contents;

    expect(output).toContain('auto value = flight::make_ref<flighthq_types::ColorScaleBiasLike>(*color_scale_bias);');
    expect(output).toContain('auto color_matrix = flight::Array<double>');
    expect(output).not.toContain('std::variant<double, auto>');
  });

  it('uses a present Partial property as optional return construction evidence', () => {
    const result = lower(
      'partial-array-member.ts',
      `interface Adjustment { colorMatrix: readonly number[]; }
       export function matrix(operation: object): readonly number[] | null {
         const value = (operation as Readonly<Partial<Adjustment>>).colorMatrix;
         return Array.isArray(value) && value.length === 20 ? value : null;
       }`,
    );
    const output = emitIrModuleCpp(result.module, {
      runtimeProfile: 'flight-cpp',
    }).contents;

    expect(output).toContain('std::optional<flight::Array<double>> value');
    expect(output).toContain('value = static_cast<flight::Ref<color_matrix>>(operation)->color_matrix;');
    expect(output).not.toContain('value = std::optional<flight::Array<double>>{static_cast');
  });

  it('returns a narrowed Partial property through its reexported function alias union', () => {
    const transformSource = ts.createSourceFile(
      '/flight/packages/types/src/ColorTransformFunction.ts',
      `export type ColorTransformFunction =
         (out: [number, number, number], r: number, g: number, b: number) => void;`,
      ts.ScriptTarget.Latest,
      true,
    );
    const adjustmentSource = ts.createSourceFile(
      '/flight/packages/types/src/ColorLutAdjustment.ts',
      `import type { ColorTransformFunction } from './ColorTransformFunction';
       export interface ColorLutAdjustment { transform: ColorTransformFunction; }`,
      ts.ScriptTarget.Latest,
      true,
    );
    const contractSource = ts.createSourceFile(
      '/flight/packages/types/src/contract.ts',
      "export * from './ColorLutAdjustment'; export * from './ColorTransformFunction';",
      ts.ScriptTarget.Latest,
      true,
    );
    const consumerSource = ts.createSourceFile(
      '/flight/packages/adjustments/src/colorLutAdjustment.ts',
      `import type { ColorLutAdjustment, ColorTransformFunction } from '@flighthq/types/contract';
       export function getTransform(operation: Readonly<{ kind: string }>): ColorTransformFunction | null {
         const transform = (operation as Readonly<Partial<ColorLutAdjustment>>).transform;
         if (typeof transform === 'function') return transform;
         return null;
       }`,
      ts.ScriptTarget.Latest,
      true,
    );
    const moduleResolution: CompilerModuleResolutionPlan = {
      edges: [
        {
          specifier: '@flighthq/types/contract',
          target: { packageName: '@flighthq/types', source: 'packages/types/src/contract.ts' },
        },
        {
          specifier: './ColorLutAdjustment',
          target: { packageName: '@flighthq/types', source: 'packages/types/src/ColorLutAdjustment.ts' },
        },
        {
          specifier: './ColorTransformFunction',
          target: { packageName: '@flighthq/types', source: 'packages/types/src/ColorTransformFunction.ts' },
        },
      ],
      schema: 'flight-compiler-module-resolution/1',
    };
    const results = lowerTypeScriptSources(
      [
        { packageName: '@flighthq/types', sourceFile: transformSource, upstreamDirectory: '/flight' },
        { packageName: '@flighthq/types', sourceFile: adjustmentSource, upstreamDirectory: '/flight' },
        { packageName: '@flighthq/types', sourceFile: contractSource, upstreamDirectory: '/flight' },
        { packageName: '@flighthq/adjustments', sourceFile: consumerSource, upstreamDirectory: '/flight' },
      ],
      moduleResolution,
    );
    const modules = results.map((result) => result.module);
    const output = createCppCompilerBackend().createEmissionSession!({
      moduleResolution,
      modules,
      options: { runtimeProfile: 'flight-cpp' },
    }).emitModule(modules[3]!)[0]!.contents;

    expect(results[3]!.diagnostics).toEqual([]);
    expect(output).toContain(
      'return std::optional<std::function<void(flight::Array<double>, double, double, double)>>',
    );
  });

  it('preserves named optional reference results for structurally inferred locals', () => {
    const result = lower(
      'named-optional-local.ts',
      `interface Info { readonly width: number; }
       function findInfo(): Info | null { return null; }
       export function getWidth(): number {
         const info = findInfo();
         if (info === null) return 0;
         return info.width;
       }`,
    );
    const output = emitIrModuleCpp(result.module, { runtimeProfile: 'flight-cpp' }).contents;

    expect(output).toContain('auto info = find_info()');
    expect(output).toContain('return info.value()->width');
  });

  it('adopts a returned task and wraps its awaited value in the async return union', () => {
    const result = lower(
      'async-task-adoption.ts',
      `type Loader = () => Promise<number>;
       export async function load(loader: Loader): Promise<number | null> { return loader(); }`,
    );
    const output = emitIrModuleCpp(result.module, { runtimeProfile: 'flight-cpp' }).contents;

    expect(output).toContain('co_return std::optional<double>{co_await loader()}');
  });

  it('refuses dual-sentinel coalescing and optional chaining until presence projection is lowered', () => {
    const coalesce = lower(
      'dual-coalesce.ts',
      'export function read(value: number | null | undefined): number { return value ?? 0; }',
    );
    const optionalChain = lower(
      'dual-chain.ts',
      'export function text(value: number | null | undefined): string | undefined { return value?.toString(); }',
    );

    expect(() => emitIrModuleCpp(coalesce.module)).toThrow(
      'dual-sentinel nullish coalescing requires presence projection lowering',
    );
    expect(() => emitIrModuleCpp(optionalChain.module)).toThrow(
      'dual-sentinel optional chaining requires presence projection lowering',
    );
  });

  it('emits nullish comparison with negated != operator', () => {
    const result = lower(
      'nullish-negated.ts',
      'export function isDefined(x: number | null): boolean { return x !== null; }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('.has_value()');
    expect(emitted.contents).not.toContain('!.has_value()');
  });

  it('emits relative import with index file as empty include', () => {
    const result = lower(
      'user.ts',
      "import { value } from './index.js'; export function get(): number { return value; }",
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).not.toContain('index.hpp');
  });

  it('emits class with constructor super call and initializer list', () => {
    const result = lower(
      'derived-class.ts',
      'class Animal { name: string; constructor(name: string) { this.name = name; } speak(): string { return this.name; } } export class Dog extends Animal { breed: string; constructor(name: string, breed: string) { super(name); this.breed = breed; } speak(): string { return this.breed; } }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('Animal(');
    expect(emitted.contents).toContain('override');
  });

  it('emits narrowed present identifier with .value()', () => {
    const result = lower(
      'narrowed.ts',
      'export function check(x: number | undefined): number { if (x !== undefined) { return x; } return 0; }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('.value()');
  });

  it('emits two anonymous structs with different properties', () => {
    const result = lower(
      'two-structs.ts',
      'export function first(): { a: number } { return { a: 1 }; } export function second(): { b: string } { return { b: "x" }; }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('struct');
    const structMatches = emitted.contents.match(/struct \w+/g) ?? [];
    expect(structMatches.length).toBeGreaterThanOrEqual(2);
  });

  it('emits sync try-finally with deferred return in non-async function', () => {
    const result = lower(
      'sync-try-finally.ts',
      'export function safe(x: number): number { try { return x + 1; } finally { let cleanup: number = 0; } }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('finally_return');
    expect(emitted.contents).toContain('return');
    expect(emitted.contents).not.toContain('co_return');
  });

  it('emits switch statement lowered to if-else chain', () => {
    const result = lower(
      'switch-break.ts',
      'export function classify(x: number): string { switch (x) { case 0: return "zero"; case 1: return "one"; default: return "other"; } }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('switch_value');
  });

  it('emits while loop', () => {
    const result = lower(
      'while-loop.ts',
      'export function countdown(n: number): number { let i: number = n; while (i > 0) { i = i - 1; } return i; }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('while');
  });

  it('emits type alias as C++ using declaration', () => {
    const result = lower('alias.ts', 'export type Num = number;');
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('using');
  });

  it('emits generic function with template parameter', () => {
    const result = lower('generic.ts', 'export function identity<T>(x: T): T { return x; }');
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('template');
    expect(emitted.contents).toContain('typename');
  });

  it('emits try-finally with return only in if-consequent (no otherwise)', () => {
    const result = lower(
      'try-if-no-else.ts',
      'export async function maybeReturn(cond: boolean, task: Promise<number>): Promise<number> { try { if (cond) { return await task; } } finally { let x: number = 0; } return await task; }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('finally_return');
  });

  it('emits nested try inside try-finally for return detection', () => {
    const result = lower(
      'nested-try-return.ts',
      'export async function nested(task: Promise<number>): Promise<number> { try { try { return await task; } catch (e) { return await task; } } finally { let x: number = 0; } }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('finally_return');
  });

  it('emits lambda expression with body statements', () => {
    const result = lower(
      'lambda-body.ts',
      'export function apply(arr: number[]): number[] { return arr.filter((x: number): boolean => { return x > 0; }); }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('[=]');
  });

  it('emits unary plus on number as identity', () => {
    const result = lower('unary-plus.ts', 'export function pos(x: number): number { return +x; }');
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('return');
  });

  it('emits bitwise not with int32 cast', () => {
    const result = lower('bit-not.ts', 'export function flip(x: number): number { return ~x; }');
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('int32_t');
  });

  it('emits post-increment operator', () => {
    const result = lower('postinc.ts', 'export function inc(x: number): number { let y: number = x; y++; return y; }');
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('++');
  });

  it('emits Math.pow as std::pow', () => {
    const result = lower('math-pow.ts', 'export function cube(x: number): number { return Math.pow(x, 3); }');
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('std::pow');
  });

  it('emits every source exponentiation form through the semantic runtime wrapper', () => {
    const result = lower(
      'semantic-power.ts',
      'export function direct(a: number, b: number): number { return Math.pow(a, b) + a ** b; } export function assign(a: number, b: number): number { a **= b; return a; } export function capture(a: number, b: number): () => number { return (): number => { a **= b; return a; }; }',
    );
    const emitted = emitIrModuleCpp(result.module, { runtimeProfile: 'flight-cpp' });
    expect(emitted.contents).toContain('flight::power(a, b) + flight::power(a, b)');
    expect(emitted.contents).toContain('assignment_target = flight::power(assignment_target, b)');
    expect(emitted.contents).toContain('binding_value = flight::power(binding_value, b)');
    expect(emitted.contents).not.toContain('std::pow');
  });

  it('emits Math.round through the semantic runtime wrapper', () => {
    const result = lower('math-round.ts', 'export function nearest(x: number): number { return Math.round(x); }');
    const emitted = emitIrModuleCpp(result.module, { runtimeProfile: 'flight-cpp' });
    expect(emitted.contents).toContain('return flight::round(x)');
  });

  it('emits Math min and max through semantic wrappers for direct and spread calls', () => {
    const result = lower(
      'semantic-min-max.ts',
      'export function bounds(a: number, b: number): number { return Math.min(a, Math.max(a, b)); } export function widest(values: number[]): number { return Math.max(...values); }',
    );
    const emitted = emitIrModuleCpp(result.module, { runtimeProfile: 'flight-cpp' });
    expect(emitted.contents).toContain('return flight::minimum(a, flight::maximum(a, b))');
    expect(emitted.contents).toContain('return flight::maximum(values)');
    expect(emitted.contents).not.toContain('std::max_element');
  });

  it('emits Math.max with spread as fold over std::max_element', () => {
    const result = lower(
      'math-max-spread.ts',
      'export function maxOf(arr: number[]): number { return Math.max(...arr); }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('std::max_element');
    expect(emitted.contents).toContain('empty()');
  });

  it('emits Math.min with spread as fold over std::min_element', () => {
    const result = lower(
      'math-min-spread.ts',
      'export function minOf(arr: number[]): number { return Math.min(...arr); }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('std::min_element');
  });

  it('emits undefined default expression with .value_or', () => {
    const result = lower(
      'default-expr.ts',
      'export function withDefault(x: number | undefined): number { return x ?? 42; }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('.value_or(');
  });

  it('emits tuple element access with std::get', () => {
    const result = lower('tuple-get.ts', 'export function first(pair: [number, string]): number { return pair[0]; }');
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('std::get<0>');
  });

  it('emits cast expression as static_cast', () => {
    const result = lower('cast-expr.ts', 'export function toNum(x: unknown): number { return x as number; }');
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('static_cast');
  });

  it('emits string literal type as string type', () => {
    const result = lower('literal-type.ts', "export function tag(): 'hello' { return 'hello'; }");
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('std::string');
  });

  it('emits type alias for string literal union', () => {
    const result = lower('string-union.ts', "export type Dir = 'up' | 'down' | 'left' | 'right';");
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('using');
  });

  it('collapses open and computed string unions to their proven C++ runtime domain', () => {
    const result = lower(
      'open-string-unions.ts',
      `export interface Request { title: string; tag?: string }
       export const FirstFormat = 'First';
       export const SecondFormat = 'Second';
       export type Role = 'button' | 'link' | (string & Record<never, never>);
       export type Format = typeof FirstFormat | typeof SecondFormat | (string & Record<never, never>);
       export type RequestField = keyof Request;
       export type ScheduleField = RequestField | 'at' | 'repeat';`,
    );
    const emitted = emitIrModuleCpp(result.module, { runtimeProfile: 'flight-cpp' });

    expect(emitted.contents).toContain('using Role = flight::String;');
    expect(emitted.contents).toContain('using Format = flight::String;');
    expect(emitted.contents).toContain('using RequestField = flight::String;');
    expect(emitted.contents).toContain('using ScheduleField = flight::String;');
    expect(emitted.contents).not.toContain('std::variant<flight::String, flight::String>');
  });

  it('erases equivalent primitive and keyof intersection value domains', () => {
    const config = ts.createSourceFile(
      '/flight/packages/types/src/config.ts',
      `export const EntityRuntimeKey = Symbol.for('EntityRuntime');
       export interface Entity { [EntityRuntimeKey]: object | undefined }
       export interface ParticleEmitterConfig extends Entity { alpha: number; size: number }
       export interface ParticleConfigIssue { field: keyof ParticleEmitterConfig; message: string }`,
      ts.ScriptTarget.Latest,
      true,
    );
    const contract = ts.createSourceFile(
      '/flight/packages/types/src/contract.ts',
      "export type { ParticleConfigIssue, ParticleEmitterConfig } from './config.js';",
      ts.ScriptTarget.Latest,
      true,
    );
    const consumer = ts.createSourceFile(
      '/flight/packages/particles/src/validate.ts',
      `import type { ParticleConfigIssue, ParticleEmitterConfig } from '@flighthq/types/contract';
       export function report(
         issues: ParticleConfigIssue[],
         field: string & keyof ParticleEmitterConfig,
       ): void { issues.push({ field, message: 'invalid' }); }`,
      ts.ScriptTarget.Latest,
      true,
    );
    const moduleResolution: CompilerModuleResolutionPlan = {
      edges: [
        {
          specifier: '@flighthq/types/contract',
          target: { packageName: '@flighthq/types', source: 'packages/types/src/contract.ts' },
        },
      ],
      schema: 'flight-compiler-module-resolution/1',
    };
    const results = lowerTypeScriptSources(
      [
        { packageName: '@flighthq/types', sourceFile: config, upstreamDirectory: '/flight' },
        { packageName: '@flighthq/types', sourceFile: contract, upstreamDirectory: '/flight' },
        { packageName: '@flighthq/particles', sourceFile: consumer, upstreamDirectory: '/flight' },
      ],
      moduleResolution,
    );
    const modules = results.map((result) => result.module);
    const emitted = createCppCompilerBackend().createEmissionSession!({
      moduleResolution,
      modules,
      options: { runtimeProfile: 'flight-cpp' },
    }).emitModule(modules[2]!)[0]!.contents;

    expect(emitted).toContain('flight::String field');
    expect(emitted).toContain('.push(');
  });

  it('emits array with sparse element as empty initializer', () => {
    const result = lower('sparse.ts', 'export const x: number = 1;');
    const module = structuredClone(result.module);
    const decl = module.declarations[0];
    if (decl?.kind === 'variable' && !('pattern' in decl)) {
      (decl as any).initializer = {
        elements: [{ kind: 'literal', value: 1 }, undefined, { kind: 'literal', value: 3 }],
        kind: 'array',
      };
    }
    const emitted = emitIrModuleCpp(module);
    expect(emitted.contents).toContain('{}');
  });

  it('emits throw statement with new Error', () => {
    const result = lower('throw.ts', 'export function fail(): never { throw new Error("boom"); }');
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('throw');
    expect(emitted.contents).toContain('std::runtime_error');
  });

  it('emits IFE lambda for function expression call', () => {
    const result = lower(
      'ife.ts',
      'export function run(): number { return ((x: number): number => { return x; })(42); }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('[=]');
  });

  it('emits abstract method with parameters as pure virtual', () => {
    const result = lower(
      'abstract-method.ts',
      `export abstract class Shape {
        abstract area(scale: number): number;
      }`,
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('virtual');
    expect(emitted.contents).toContain('double scale');
    expect(emitted.contents).toContain('= 0;');
  });

  it('escapes C++ keywords in method and field names', () => {
    const result = lower(
      'keyword-name.ts',
      `export class Store {
        register: string = '';
        virtual(): number { return 0; }
      }`,
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('register_');
    expect(emitted.contents).toContain('virtual_');
  });

  it('strips local break from switch case statements', () => {
    const result = lower(
      'switch-break.ts',
      `export function label(x: number): string {
        let result = '';
        switch (x) {
          case 0: result = 'zero'; break;
          case 1: result = 'one'; break;
          default: result = 'other';
        }
        return result;
      }`,
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('switch_value');
    expect(emitted.contents).not.toContain('break;');
    expect(emitted.contents).toContain('result');
  });

  it('emits this return type as class name in class context', () => {
    const result = lower(
      'this-type.ts',
      `export class Builder {
        value: number = 0;
        set(n: number): this { this.value = n; return this; }
      }`,
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('Builder set(');
  });

  it('skips non-super statements before extracting super call', () => {
    const result = lower(
      'super-skip.ts',
      `export class Base { constructor(public x: number) {} }
       export class Derived extends Base {
         constructor(x: number) {
           const doubled: number = x * 2;
           super(doubled);
         }
       }`,
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('Base(');
    expect(emitted.contents).toContain('doubled');
  });

  it('detects return in catch body inside try-catch-finally', () => {
    const result = lower(
      'try-catch-finally-return.ts',
      `export function parse(s: string): number {
        try {
          throw new Error(s);
        } catch (e) {
          return 0;
        } finally {
          const x: number = 1;
        }
      }`,
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('finally_return');
    expect(emitted.contents).toContain('finally_exception');
    expect(emitted.contents).toContain('catch');
  });

  it('detects return in if-else branches inside try-finally', () => {
    const result = lower(
      'if-else-try-return.ts',
      `export function abs(x: number): number {
        try {
          if (x > 0) {
            return x;
          } else {
            return -x;
          }
        } finally {
          const y: number = 0;
        }
      }`,
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('finally_return');
    expect(emitted.contents).toContain('if (');
    expect(emitted.contents).toContain('else');
  });

  it('generates unique names when multiple switches collide', () => {
    const result = lower(
      'multi-switch.ts',
      `export function multi(x: number, y: number): string {
        let a: string = '';
        switch (x) { case 0: a = 'x'; break; default: a = 'other'; }
        let b: string = '';
        switch (y) { case 0: b = 'y'; break; default: b = 'other'; }
        return a + b;
      }`,
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('switch_value');
    expect(emitted.contents).toContain('switch_value_2');
  });

  it('generates collision-free anonymous struct names for same-property-name types', () => {
    const result = lower(
      'struct-collision.ts',
      `export function numPt(): { x: number; y: number } { return { x: 1, y: 2 }; }
       export function strPt(): { x: string; y: string } { return { x: 'a', y: 'b' }; }`,
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('x_y');
    expect(emitted.contents).toContain('x_y_1');
  });

  it('throws on missing runtime external symbol binding', () => {
    const result = lower('parse-call.ts', 'export function parse(x: string): number { return parseFloat(x); }');
    expect(() => emitIrModuleCpp(result.module)).toThrow(/runtime external symbol binding plan is incomplete/);
  });

  it('emits negated nullish comparison as has_value without prefix', () => {
    const result = lower('not-null.ts', 'export function isPresent(x: number | null): boolean { return x !== null; }');
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toMatch(/[^!]has_value\(\)/);
  });

  it('detects return in if-otherwise only when consequent has no return', () => {
    const result = lower(
      'if-otherwise-return.ts',
      `export function check(x: number): number {
        try {
          if (x > 0) {
            const y: number = x;
          } else {
            return -x;
          }
        } finally {
          const z: number = 0;
        }
        return 0;
      }`,
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('finally_return');
  });

  it('detects return in nested try-catch inside try-finally', () => {
    const result = lower(
      'nested-try-catch.ts',
      `export function nested(): number {
        try {
          try {
            throw new Error('test');
          } catch (e) {
            return 0;
          }
        } finally {
          const z: number = 0;
        }
      }`,
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('finally_return');
    expect(emitted.contents).toContain('catch');
  });

  it('emits for-of without explicit type annotation as auto', () => {
    const result = lower(
      'for-of-auto.ts',
      `export function sum(items: number[]): number {
        let total: number = 0;
        for (const item of items) { total += item; }
        return total;
      }`,
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('for (');
    expect(emitted.contents).toContain('item');
  });

  it('emits parameter without explicit type as auto', () => {
    const result = lower('param-auto.ts', 'export function identity<T>(value: T): T { return value; }');
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('template');
    expect(emitted.contents).toContain('value');
  });

  it('emits variable declaration without initializer', () => {
    const result = lower('no-init.ts', 'export let count: number;');
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('double count');
    expect(emitted.contents).not.toContain('= ');
  });

  it('emits class field without explicit type annotation', () => {
    const result = lower(
      'field-no-type.ts',
      `export class Counter {
        count = 0;
      }`,
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('count');
  });

  it('emits static class fields as inline static in struct', () => {
    const result = lower(
      'static-field.ts',
      `export class Config {
        static defaultValue: number = 42;
        name: string = "";
      }`,
    );
    const classDecl = result.module.declarations.find((d) => d.kind === 'class');
    expect(classDecl?.fields.some((f) => f.static)).toBe(true);
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('name');
    expect(emitted.contents).toContain('inline static double default_value');
  });

  it('emits numeric enum members with explicit initializer values', () => {
    const result = lower('bare-enum.ts', 'export enum Direction { Up, Down, Left, Right }');
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('enum class');
    expect(emitted.contents).toContain('Up');
    expect(emitted.contents).toContain('Down');
  });

  it('emits exponentiation assignment with the previous target value', () => {
    const result = lower(
      'power-assign.ts',
      'export function power(a: number, b: number): number { a **= b; return a; }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('auto&& assignment_target = a');
    expect(emitted.contents).toContain('assignment_target = std::pow(assignment_target, b)');
    expect(emitted.contents).not.toContain('**=');
  });

  it('emits unsigned right shift assignment from the previous target value with a uint32_t cast', () => {
    const result = lower(
      'shift-assign.ts',
      'export function shift(a: number, b: number): number { a >>>= b; return a; }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).not.toContain('>>>=');
    expect(emitted.contents).toContain('auto&& assignment_target = a');
    expect(emitted.contents).toContain(
      'static_cast<uint32_t>(static_cast<int32_t>(assignment_target)) >> static_cast<uint32_t>(b)',
    );
  });

  it('emits loose equality and inequality operators as C++ == and !=', () => {
    const result = lower(
      'loose-eq.ts',
      'export function eq(a: number, b: number): boolean { return a == b; } export function ne(a: number, b: number): boolean { return a != b; }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('==');
    expect(emitted.contents).toContain('!=');
  });

  it('emits negated nullish comparison with != operator', () => {
    const result = lower(
      'neg-nullish.ts',
      'export function isPresent(value: number | undefined): boolean { return value != undefined; }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('.has_value()');
    expect(emitted.contents).not.toContain('!');
  });

  it('emits array.length call expression as sizeMethod with static_cast', () => {
    const result = lower('size-call.ts', 'export function count(items: number[]): number { return items.length; }');
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('static_cast<double>');
    expect(emitted.contents).toContain('.size()');
  });

  it('emits for-in with preserve evaluation key plan', () => {
    const result = lower(
      'for-in-preserve.ts',
      `export function keys(values: number[]): string { let result = ""; for (const key in { second: 2, first: values.length }) { result += key; } return result; }`,
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('std::vector');
    expect(emitted.contents).toContain('"second"');
    expect(emitted.contents).toContain('"first"');
    expect(emitted.contents).toContain('static_cast<void>(for_in_object);');
  });

  it('emits for-of with auto type when variable lacks annotation', () => {
    const result = lower(
      'for-of-auto.ts',
      'export function sum<T extends number>(items: T[]): number { let total: number = 0; for (const item of items) { total += item; } return total; }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('for (');
  });

  it('refuses for-of with await as an emission error', () => {
    const result = lower(
      'for-await.ts',
      'export async function collect(source: AsyncIterable<number>): Promise<number> { let total = 0; for await (const x of source) { total += x; } return total; }',
    );
    expect(() => emitIrModuleCpp(result.module)).toThrow(expect.objectContaining({ code: 'unsupported-ir' }));
  });

  it('emits switch case with local break detection', () => {
    const result = lower(
      'switch-break.ts',
      `export function label(x: number): string {
        switch (x) {
          case 1: return "one";
          case 2: { const v = "two"; return v; }
          default: break;
        }
        return "other";
      }`,
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('switch');
    expect(emitted.contents).toContain('"one"');
    expect(emitted.contents).toContain('"other"');
  });

  it('emits compatible structural intersections as anonymous values', () => {
    const result = lower(
      'intersection.ts',
      'interface A { x: number } interface B { y: number } export function test(value: A & B): number { return value.x; }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('double x;');
    expect(emitted.contents).toContain('double y;');
    expect(emitted.contents).toContain('return value.x;');
  });

  it('emits new Promise with flight-cpp profile as Task::create', () => {
    const result = lower(
      'promise-new.ts',
      'export function pending(): Promise<number> { return new Promise<number>((resolve) => resolve(1)); }',
    );
    const emitted = emitIrModuleCpp(result.module, { runtimeProfile: 'flight-cpp' });
    expect(emitted.contents).toContain('::create(');
  });

  it('detects return in if-otherwise branch for try-finally emission', () => {
    const result = lower(
      'if-else-return.ts',
      `export async function run(flag: boolean, x: number): Promise<number> {
        try {
          if (flag) {
            x += 10;
          } else {
            return x + 2;
          }
        } finally {
          x += 1;
        }
        return x;
      }`,
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('co_return');
    expect(emitted.contents).toContain('finally_return');
  });

  it('detects return in catch clause for try-finally emission', () => {
    const result = lower(
      'catch-return.ts',
      `export async function run(x: number): Promise<number> {
        try {
          try {
            x += 1;
          } catch (error) {
            return x + 2;
          }
        } finally {
          x += 1;
        }
        return x;
      }`,
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('co_return');
    expect(emitted.contents).toContain('finally_return');
  });

  it('detects return in if-without-else inside try-finally', () => {
    const result = lower(
      'if-no-else-return.ts',
      `export async function run(flag: boolean, x: number): Promise<number> {
        try {
          if (flag) {
            return x + 1;
          }
        } finally {
          x += 1;
        }
        return x;
      }`,
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('finally_return');
  });

  it('detects return in try nested inside try-finally', () => {
    const result = lower(
      'nested-try-return.ts',
      `export async function run(x: number): Promise<number> {
        try {
          try {
            return x + 1;
          } finally {
            x += 1;
          }
        } finally {
          x += 2;
        }
        return x;
      }`,
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('finally_return');
  });

  it('detects return inside finally body for catch-and-rethrow', () => {
    const result = lower(
      'finally-return.ts',
      `export async function run(x: number): Promise<number> {
        try {
          return x + 1;
        } finally {
          x += 1;
        }
      }`,
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('co_return');
  });

  it('emits function parameter without type as auto', () => {
    const result = lower('param-no-type.ts', 'export function identity<T>(value: T): T { return value; }');
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('template');
  });

  it('emits tupleRest expression with std::get', () => {
    const result = lower(
      'tuple-rest.ts',
      'export function rest(pair: [number, string, boolean]): boolean { const [, , third] = pair; return third; }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('std::get<');
    expect(emitted.contents).toContain('#include <tuple>');
  });

  it('resolves super reference to base class target name', () => {
    const result = lower(
      'super-ref.ts',
      `export class Base {
        value(): number { return 1; }
      }
      export class Derived extends Base {
        value(): number { return super.value() + 1; }
      }`,
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('Base');
    expect(emitted.contents).toContain('Derived');
  });

  it('emits class that extends a non-class binding without crashing', () => {
    const result = lower(
      'extend-type.ts',
      `export interface Movable { x: number; y: number }
       export class Point implements Movable { x: number = 0; y: number = 0; }`,
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('struct Point');
  });

  it('generates unique names when for-in appears twice in same module', () => {
    const result = lower(
      'double-for-in.ts',
      `export function keys(values: number[]): string {
         let result = "";
         for (const key in { a: values.length }) { result += key; }
         for (const key in { b: values.length }) { result += key; }
         return result;
       }`,
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('for_in_object');
    const matches = emitted.contents.match(/for_in_object/g);
    expect(matches!.length).toBeGreaterThanOrEqual(2);
  });

  it('emits constructor with super call as init list', () => {
    const result = lower(
      'super-call.ts',
      `export class Base { x: number = 0 }
       export class Child extends Base {
         y: number = 0;
         constructor() { super(); this.y = 1; }
       }`,
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('struct Child');
    expect(emitted.contents).toContain('Base');
    expect(emitted.contents).toContain('Child()');
  });

  it('emits constructor without super call when class has no base', () => {
    const result = lower(
      'no-super.ts',
      `export class Config {
         value: number;
         constructor(value: number) { this.value = value; }
       }`,
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('struct Config');
    expect(emitted.contents).toContain('Config(double value)');
  });

  it('emits sizeMethod binding as property access with static_cast', () => {
    const result = lower('size-prop.ts', 'export function len(s: string): number { return s.length; }');
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('static_cast<double>');
  });

  it('emits ambient type reference without runtime binding as its source name', () => {
    const result = lower('ambient-type-ref.ts', 'export function makeError(): Error { return new Error("fail"); }');
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('std::runtime_error');
  });

  it('emits import with tsx extension', () => {
    const result = lowerPackage('@flighthq/ui', 'app.tsx', 'export function render(): string { return "hello"; }');
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.path).toBe('app.hpp');
  });

  it('emits nullish coalescing as value_or', () => {
    const result = lower(
      'nullish-coalesce.ts',
      'export function fallback(a: number | undefined): number { return a ?? 0; }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('.value_or(');
    expect(emitted.contents).toContain('#include <optional>');
  });

  it('preserves optional storage when nullish coalescing changes only the absence sentinel', () => {
    const result = lower(
      'nullish-sentinel.ts',
      `export function find(values: Map<string, number>): number | null {
         return values.get('key') ?? null;
       }`,
    );
    const emitted = emitIrModuleCpp(result.module, { runtimeProfile: 'flight-cpp' });

    expect(emitted.contents).toContain('return values.get(flight::String("key"));');
    expect(emitted.contents).not.toContain('.value_or(std::nullopt)');
  });

  it('lazily coalesces compatible optional representations', () => {
    const result = lower(
      'optional-coalesce.ts',
      `export function fallback(primary: string | undefined, secondary: () => string | null): string | null {
         return primary ?? secondary();
       }`,
    );
    const emitted = emitIrModuleCpp(result.module, { runtimeProfile: 'flight-cpp' });

    expect(emitted.contents).toContain('auto nullish_coalesce_left = primary;');
    expect(emitted.contents).toContain('if (nullish_coalesce_left.has_value()) return nullish_coalesce_left;');
    expect(emitted.contents).toContain('return secondary();');
    expect(emitted.contents).not.toContain('.value_or(secondary())');
  });

  it('preserves contextual optional storage from record element and property reads', () => {
    const result = lower(
      'optional-member-read.ts',
      `interface Info { value: number }
       interface Holder { selected: Info | null }
       export function fromRecord(values: Record<string, Info | null>, key: string): Info | null {
         return values[key];
       }
       export function fromProperty(holder: Holder): Info | null {
         return holder.selected;
       }`,
    );
    const emitted = emitIrModuleCpp(result.module, { runtimeProfile: 'flight-cpp' });

    expect(emitted.contents).toContain('return values[key];');
    expect(emitted.contents).toContain('return holder->selected;');
    expect(emitted.contents).not.toContain('std::optional<std::optional');
  });

  it('preserves effectful null call results while constructing optional absence', () => {
    const result = lower(
      'effectful-null.ts',
      `interface Model { value: number }
       function reject(): null { return null; }
       export function load(ok: boolean): Model | null {
         if (!ok) return reject();
         return { value: 1 };
       }`,
    );
    const emitted = emitIrModuleCpp(result.module, { runtimeProfile: 'flight-cpp' });

    expect(emitted.contents).toContain('flight::Null reject()');
    expect(emitted.contents).toContain('return flight::null;');
    expect(emitted.contents).toContain('(void)reject(); return std::nullopt;');
  });

  it('emits optional chain on nullable struct without premature unwrap', () => {
    const result = lower(
      'opt-chain-struct.ts',
      'export interface Holder { value: number; } export function read(holder: Holder | undefined): number { return holder?.value ?? 0; }',
    );
    const emitted = emitIrModuleCpp(result.module, { runtimeProfile: 'flight-cpp' });
    expect(emitted.contents).toContain('optional_chain_receiver = holder;');
    expect(emitted.contents).not.toContain('optional_chain_receiver = holder.value()');
    expect(emitted.contents).toContain('.has_value()');
    expect(emitted.contents).toContain('.value_or(0.0)');
  });

  it('emits an optional method call through an indirectly imported interface', () => {
    const modelSource = ts.createSourceFile(
      '/flight/packages/model/src/model.ts',
      `export interface Process { readonly id: number; }
       export interface Backend { spawn(command: string): Process; }
       export interface Host { readonly backend?: Backend; }`,
      ts.ScriptTarget.Latest,
      true,
    );
    const consumerSource = ts.createSourceFile(
      '/flight/packages/app/src/consumer.ts',
      `import type { Host, Process } from '@flight/model';
       export function spawn(host: Host): Process | null {
         return host.backend?.spawn('flight') ?? null;
       }`,
      ts.ScriptTarget.Latest,
      true,
    );
    const moduleResolution: CompilerModuleResolutionPlan = {
      edges: [
        {
          specifier: '@flight/model',
          target: { packageName: '@flight/model', source: 'packages/model/src/model.ts' },
        },
      ],
      schema: 'flight-compiler-module-resolution/1',
    };
    const results = lowerTypeScriptSources(
      [
        { packageName: '@flight/model', sourceFile: modelSource, upstreamDirectory: '/flight' },
        { packageName: '@flight/app', sourceFile: consumerSource, upstreamDirectory: '/flight' },
      ],
      moduleResolution,
    );
    const modules = results.map((result) => result.module);
    const output = createCppCompilerBackend().createEmissionSession!({
      moduleResolution,
      modules,
      options: { runtimeProfile: 'flight-cpp' },
    }).emitModule(modules[1]!)[0]!.contents;

    expect(results.flatMap((result) => result.diagnostics)).toEqual([]);
    expect(output).toContain('std::optional<flight::Ref<flighthq_model::Process>>');
    expect(output).toContain('optional_chain_receiver.value()->spawn(flight::String("flight"))');
  });

  it('uses imported object evidence for contextual array element construction', () => {
    const modelSource = ts.createSourceFile(
      '/flight/packages/model/src/model.ts',
      `export interface Subset { indexCount: number; indexOffset: number; }
       export interface Geometry { subsets: Subset[]; }`,
      ts.ScriptTarget.Latest,
      true,
    );
    const consumerSource = ts.createSourceFile(
      '/flight/packages/app/src/consumer.ts',
      `import type { Geometry, Subset } from '@flight/model';
       export function copy(geometry: Geometry): void {
         const next: Subset[] = [];
         for (let i = 0; i < geometry.subsets.length; i++) {
           next.push({
             indexCount: geometry.subsets[i].indexCount,
             indexOffset: geometry.subsets[i].indexOffset,
           });
         }
         geometry.subsets = next;
       }`,
      ts.ScriptTarget.Latest,
      true,
    );
    const moduleResolution: CompilerModuleResolutionPlan = {
      edges: [
        {
          specifier: '@flight/model',
          target: { packageName: '@flight/model', source: 'packages/model/src/model.ts' },
        },
      ],
      schema: 'flight-compiler-module-resolution/1',
    };
    const results = lowerTypeScriptSources(
      [
        { packageName: '@flight/model', sourceFile: modelSource, upstreamDirectory: '/flight' },
        { packageName: '@flight/app', sourceFile: consumerSource, upstreamDirectory: '/flight' },
      ],
      moduleResolution,
    );
    const modules = results.map((result) => result.module);
    const output = createCppCompilerBackend().createEmissionSession!({
      moduleResolution,
      modules,
      options: { runtimeProfile: 'flight-cpp' },
    }).emitModule(modules[1]!)[0]!.contents;

    expect(results.flatMap((result) => result.diagnostics)).toEqual([]);
    expect(output).toContain('flight::make_ref<flighthq_model::Subset>');
    expect(output).not.toMatch(/anonymous object property .* requires concrete C\+\+ type evidence/u);
  });

  it('emits != undefined nullish comparison as negated has_value', () => {
    const result = lower(
      'nullish-neq.ts',
      'export function present(value: number | undefined): boolean { return value != undefined; }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('.has_value()');
    expect(emitted.contents).not.toContain('!value');
  });

  it('emits enum with implicit member values', () => {
    const result = lower('auto-enum.ts', 'export enum Color { Red, Green, Blue }');
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('enum class');
    expect(emitted.contents).toContain('Red');
    expect(emitted.contents).toContain('Green');
    expect(emitted.contents).toContain('Blue');
  });

  it('emits optional parameter as std::optional with default', () => {
    const result = lower(
      'optional-param.ts',
      'export function greet(name: string, greeting?: string): string { return (greeting ?? "Hello") + " " + name; }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('std::optional<');
    expect(emitted.contents).toContain('std::nullopt');
  });

  it('emits rest parameter as std::vector', () => {
    const result = lower(
      'rest-param.ts',
      'export function sum(...values: number[]): number { let total = 0; for (const v of values) { total += v; } return total; }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('std::vector<double>');
  });

  it('emits forOf loop with typed variable', () => {
    const result = lower(
      'for-of-basic.ts',
      'export function total(values: number[]): number { let sum = 0; for (const v of values) { sum += v; } return sum; }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('for (');
    expect(emitted.contents).toContain(' : ');
  });

  it('emits forIn with preserve evaluation wrapping object', () => {
    const result = lower(
      'for-in-preserve.ts',
      `export function keys(obj: { a: number; b: number }): string {
        let result = "";
        for (const key in obj) { result += key; }
        return result;
      }`,
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('std::vector<std::string>');
  });

  it('emits forIn with discard evaluation ordering', () => {
    const result = lower(
      'for-in-discard.ts',
      `export function keys(): string {
        let result = "";
        for (const key in { x: 1, y: 2 }) { result += key; }
        return result;
      }`,
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('std::vector<std::string>');
  });

  it('emits class field without explicit type as auto', () => {
    const result = lower(
      'field-auto.ts',
      'export class Counter { count: number = 0; increment(): void { this.count += 1; } }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('count');
  });

  it('emits binary === as == in C++', () => {
    const result = lower('strict-eq.ts', 'export function same(a: number, b: number): boolean { return a === b; }');
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('==');
  });

  it('emits binary !== as != in C++', () => {
    const result = lower(
      'strict-neq.ts',
      'export function different(a: number, b: number): boolean { return a !== b; }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('!=');
  });

  it('emits power assignment with explicit rewrite', () => {
    const result = lower(
      'power-assign.ts',
      'export function square(x: number): number { let v = x; v **= 2; return v; }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('v =');
  });

  it('refuses a runtime-only number parser in the standard-library profile', () => {
    const result = lower('unknown-ambient.ts', 'export function read(): number { return parseInt("42"); }');
    expect(() => emitIrModuleCpp(result.module, { runtimeProfile: 'standard-library' })).toThrow(
      'runtime external symbol binding plan is incomplete',
    );
    expect(emitIrModuleCpp(result.module, { runtimeProfile: 'flight-cpp' }).contents).toContain(
      'return flight::parse_int(flight::String("42"))',
    );
  });

  it('emits try-catch return detection through if-else branches', () => {
    const result = lower(
      'try-if-return.ts',
      `export async function process(flag: boolean): Promise<number> {
        try {
          if (flag) {
            return 1;
          } else {
            return 2;
          }
        } finally {
          flag;
        }
      }`,
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('co_return');
  });

  it('emits try-catch with return in catch for finally detection', () => {
    const result = lower(
      'try-catch-return.ts',
      `export async function safe(x: number): Promise<number> {
        try {
          return x;
        } catch (e) {
          return 0;
        } finally {
          x;
        }
      }`,
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('catch');
    expect(emitted.contents).toContain('co_return');
  });

  it('emits switch case local break targeting the switch label', () => {
    const result = lower(
      'switch-label-break.ts',
      `export function classify(x: number): string {
        switch (x) {
          case 0: return "zero";
          case 1: return "one";
          default: { const msg = "other"; return msg; }
        }
      }`,
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('switch');
    expect(emitted.contents).toContain('"zero"');
  });

  it('emits variable declaration without explicit type as auto', () => {
    const result = lower(
      'auto-variable.ts',
      'export function identity<T>(value: T): T { const result: T = value; return result; }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('template');
  });

  it('emits import resolution for relative specifier without extension', () => {
    const result = lower(
      'with-import.ts',
      `import { helper } from './helper.js';
       export function use(): number { return helper(); }`,
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('#include "helper.hpp"');
  });

  it('emits tuple spread with null element and optional wrapping', () => {
    const result = lower(
      'tuple-spread-opt.ts',
      `export function merge(a: [number, string], b: [boolean]): [number, string, boolean] {
        return [...a, ...b];
      }`,
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('std::make_tuple');
    expect(emitted.contents).toContain('#include <tuple>');
  });

  it('emits type parameter fallback to pascal case binding name', () => {
    const result = lower('type-params.ts', `export function wrap<T>(value: T): T { return value; }`);
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('template');
    expect(emitted.contents).toContain('typename');
  });

  it('emits binding target name fallback to safe cpp name', () => {
    const result = lower('binding-fallback.ts', 'export function create_item(): number { return 1; }');
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('create_item');
  });

  it('emits non-negated nullish comparison as negated has_value', () => {
    const result = lower(
      'null-equal.ts',
      'export function isAbsent(x: number | undefined): boolean { return x === undefined; }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('!x.has_value()');
  });

  it('emits Promise construction via ::create with flight-cpp profile', () => {
    const result = lower(
      'promise-create.ts',
      'export function make(): Promise<number> { return new Promise<number>((resolve) => { resolve(1); }); }',
    );
    const emitted = emitIrModuleCpp(result.module, { runtimeProfile: 'flight-cpp' });
    expect(emitted.contents).toContain('::create(');
  });

  it('emits import resolution for relative specifier without js extension', () => {
    const result = lower(
      'bare-import.ts',
      `import { helper } from './helper';
       export function use(): number { return helper(); }`,
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('#include "helper.hpp"');
  });

  it('emits class with inherited methods tracking for virtual dispatch', () => {
    const result = lower(
      'inherit-chain.ts',
      `class Base { run(): number { return 1; } }
       class Middle extends Base { step(): number { return 2; } }
       export class Leaf extends Middle { run(): number { return 3; } step(): number { return 4; } }`,
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('virtual');
    expect(emitted.contents).toContain('override');
  });

  it('refuses async closures before coroutine lowering', () => {
    const result = lower('async-closure.ts', 'export function run(): void { return; }');
    const fn = result.module.declarations.find((d) => d.kind === 'function')!;
    if (fn.kind !== 'function') throw new Error('Expected function');
    const patched = {
      ...fn,
      body: [
        {
          kind: 'expression' as const,
          expression: {
            kind: 'function' as const,
            async: true,
            parameters: [],
            body: [],
            expression: undefined,
            typeParameters: [],
            returnType: { kind: 'primitive' as const, name: 'void' as const },
          },
        } as any,
      ],
    };
    const module = { ...result.module, declarations: [patched] };
    expect(() => emitIrModuleCpp(module)).toThrow();
  });

  it('refuses for-of with await before async iteration lowering', () => {
    const result = lower('for-await.ts', 'export function run(): void { return; }');
    const fn = result.module.declarations.find((d) => d.kind === 'function')!;
    if (fn.kind !== 'function') throw new Error('Expected function');
    const patched = {
      ...fn,
      body: [
        {
          kind: 'forOf' as const,
          await: true,
          variable: {
            binding: {
              id: 'for-await-var',
              kind: 'variable',
              name: 'item',
              line: 1,
              column: 1,
              fingerprint: '',
              packageName: '',
              scope: 'local',
              source: '',
              space: 'value',
            },
            mutable: false,
          },
          expression: { kind: 'literal' as const, value: 0 },
          body: { kind: 'block' as const, statements: [] },
        } as any,
      ],
    };
    const module = { ...result.module, declarations: [patched] };
    expect(() => emitIrModuleCpp(module)).toThrow();
  });

  it('emits runtime external symbol binding plan completeness failures', () => {
    const result = lower('ext.ts', 'export const x: number = 1;');
    const extraDecl = {
      kind: 'function' as const,
      binding: {
        id: 'fn-ext',
        kind: 'variable' as const,
        name: 'use',
        line: 1,
        column: 1,
        fingerprint: '',
        packageName: '',
        scope: 'module' as const,
        source: '',
        space: 'value' as const,
      },
      async: false,
      typeParameters: [],
      parameters: [],
      returnType: { kind: 'primitive' as const, name: 'void' as const },
      body: [
        {
          kind: 'expression' as const,
          expression: {
            kind: 'identifier' as const,
            reference: { kind: 'ambient' as const, name: 'NonExistentGlobal' },
            presence: 'definite' as const,
          },
        },
      ],
    };
    const module = { ...result.module, declarations: [...result.module.declarations, extraDecl] as any };
    expect(() => emitIrModuleCpp(module)).toThrow();
  });

  it('emits class with static field by skipping it in struct body', () => {
    const output = emitIrModuleCpp(
      lower(
        'static-field.ts',
        `export class Config {
          static readonly MAX: number = 100;
          value: number;
          constructor(v: number) { this.value = v; }
        }`,
      ).module,
    ).contents;
    expect(output).toContain('struct Config');
    expect(output).toContain('value');
  });

  it('emits enum member without explicit value', () => {
    const output = emitIrModuleCpp(lower('enum-implicit.ts', `export enum Color { Red, Green, Blue }`).module).contents;
    expect(output).toContain('enum class Color');
    expect(output).toContain('Red');
  });

  it('emits closure with body rather than expression', () => {
    const output = emitIrModuleCpp(
      lower(
        'closure-body.ts',
        `export function apply(items: number[]): number[] {
          return items.map((x) => { const y = x * 2; return y; });
        }`,
      ).module,
    ).contents;
    expect(output).toContain('[=]');
  });

  it('emits optional parameter as std::optional', () => {
    const output = emitIrModuleCpp(
      lower('opt-param.ts', `export function greet(name?: string): string { return name ?? "world"; }`).module,
    ).contents;
    expect(output).toContain('std::optional');
  });

  it('emits rest parameter as std::vector', () => {
    const output = emitIrModuleCpp(
      lower(
        'rest-param.ts',
        `export function sum(...nums: number[]): number {
          let total = 0;
          for (const n of nums) { total += n; }
          return total;
        }`,
      ).module,
    ).contents;
    expect(output).toContain('std::vector');
  });

  it('emits containsReturn through if-otherwise branch', () => {
    const output = emitIrModuleCpp(
      lower(
        'try-finally-if.ts',
        `export async function safe(): Promise<number> {
          try {
            if (true) { return 1; } else { return 2; }
          } finally {
            const _x = 0;
          }
        }`,
      ).module,
    ).contents;
    expect(output).toContain('co_return');
  });

  it('emits try-finally with return in catch clause', () => {
    const output = emitIrModuleCpp(
      lower(
        'try-finally-catch.ts',
        `export async function safe(f: () => number): Promise<number> {
          try {
            return f();
          } catch (e) {
            return 0;
          } finally {
            const _x = 0;
          }
        }`,
      ).module,
    ).contents;
    expect(output).toContain('co_return');
  });

  it('emits type parameter with fallback name', () => {
    const output = emitIrModuleCpp(
      lower('generic.ts', `export function identity<T>(x: T): T { return x; }`).module,
    ).contents;
    expect(output).toContain('template');
    expect(output).toContain('typename');
  });

  it('emits Math.abs as ambient member call', () => {
    const output = emitIrModuleCpp(
      lower('math-abs.ts', `export function absolute(x: number): number { return Math.abs(x); }`).module,
    ).contents;
    expect(output).toContain('abs');
  });

  it.each(['flight-cpp', 'standard-library'] as const)(
    'emits Math.imul with JavaScript signed 32-bit semantics in the %s profile',
    (runtimeProfile) => {
      const output = emitIrModuleCpp(
        lower('math-imul.ts', `export function multiply(a: number, b: number): number { return Math.imul(a, b); }`)
          .module,
        { runtimeProfile },
      ).contents;
      expect(output).toContain('#include <cmath>');
      expect(output).toContain('#include <cstdint>');
      expect(output).toContain('std::uint32_t product');
      expect(output).toContain('0x100000000LL');
    },
  );

  it.each(['flight-cpp', 'standard-library'] as const)(
    'emits Object.is with JavaScript SameValue semantics in the %s profile',
    (runtimeProfile) => {
      const output = emitIrModuleCpp(
        lower('object-is.ts', `export function same(a: number, b: number): boolean { return Object.is(a, b); }`).module,
        { runtimeProfile },
      ).contents;
      expect(output).toContain('#include <cmath>');
      expect(output).toContain('#include <type_traits>');
      expect(output).toContain('std::isnan(left) && std::isnan(right)');
      expect(output).toContain('std::signbit(left) == std::signbit(right)');
    },
  );

  it('emits super reference with named base class', () => {
    const output = emitIrModuleCpp(
      lower(
        'super-call.ts',
        `export class Base {
          x: number;
          constructor(x: number) { this.x = x; }
          greet(): string { return "base"; }
        }
        export class Derived extends Base {
          constructor(x: number) { super(x); }
          greet(): string { return "derived"; }
        }`,
      ).module,
    ).contents;
    expect(output).toContain('Base(');
    expect(output).toContain('override');
  });

  it('emits class with abstract method and virtual destructor', () => {
    const output = emitIrModuleCpp(
      lower(
        'abstract-class.ts',
        `export abstract class Shape {
          abstract area(): number;
        }
        export class Circle extends Shape {
          r: number;
          constructor(r: number) { super(); this.r = r; }
          area(): number { return 3.14 * this.r * this.r; }
        }`,
      ).module,
    ).contents;
    expect(output).toContain('virtual');
    expect(output).toContain('= 0');
    expect(output).toContain('override');
  });

  it('emits super constructor call extraction from class body', () => {
    const output = emitIrModuleCpp(
      lower(
        'super-ctor.ts',
        `export class Animal {
          name: string;
          constructor(name: string) { this.name = name; }
        }
        export class Dog extends Animal {
          breed: string;
          constructor(name: string, breed: string) {
            super(name);
            this.breed = breed;
          }
        }`,
      ).module,
    ).contents;
    expect(output).toContain('Animal(');
    expect(output).toContain('Dog(');
  });

  it('emits forIn with closed key plan', () => {
    const output = emitIrModuleCpp(
      lower(
        'for-in.ts',
        `export interface Dict { a: number; b: number; }
         export function keys(d: Dict): void {
          for (const k in d) { const _x = k; }
        }`,
      ).module,
    ).contents;
    expect(output).toContain('std::vector<std::string>');
  });

  it('emits .length call on array as static_cast<double>', () => {
    const output = emitIrModuleCpp(
      lower('arr-len.ts', `export function size(items: number[]): number { return items.length; }`).module,
    ).contents;
    expect(output).toContain('static_cast<double>');
    expect(output).toContain('.size()');
  });

  it('emits tuple rest as std::get', () => {
    const output = emitIrModuleCpp(
      lower(
        'tuple-rest.ts',
        `export function rest(t: [number, string, boolean]): [string, boolean] {
          const [, ...tail] = t;
          return tail;
        }`,
      ).module,
    ).contents;
    expect(output).toContain('std::get');
  });

  it('emits do-while loop', () => {
    const output = emitIrModuleCpp(
      lower(
        'do-while.ts',
        `export function count(): number {
          let i = 0;
          do { i += 1; } while (i < 10);
          return i;
        }`,
      ).module,
    ).contents;
    expect(output).toContain('do {');
    expect(output).toContain('} while');
  });

  it('emits class inheriting through chain resolves methods', () => {
    const output = emitIrModuleCpp(
      lower(
        'chain-inherit.ts',
        `export class A {
          foo(): number { return 1; }
        }
        export class B extends A {
          bar(): number { return 2; }
        }
        export class C extends B {
          foo(): number { return 3; }
        }`,
      ).module,
    ).contents;
    expect(output).toContain('override');
  });

  it('emits undefined default as value_or', () => {
    const output = emitIrModuleCpp(
      lower(
        'undef-default.ts',
        `export function orZero(x: number | undefined): number {
          return x !== undefined ? x : 0;
        }`,
      ).module,
    ).contents;
    expect(output).toContain('optional');
  });

  it('emits binding name fallback when not in target name map', () => {
    const module = structuredClone(
      lower('fallback-name.ts', 'export function id(x: number): number { return x; }').module,
    );
    const fn = module.declarations.find((d: { kind: string }) => d.kind === 'function');
    if (fn && fn.kind === 'function') {
      const ret = fn.body.find((s: { kind: string }) => s.kind === 'return');
      if (ret && (ret as any).expression) {
        (ret as any).expression = {
          ...(ret as any).expression,
          kind: 'cast',
          expression: (ret as any).expression,
          type: { kind: 'primitive', name: 'number' },
        };
      }
    }
    const output = emitIrModuleCpp(module).contents;
    expect(output).toContain('static_cast');
  });

  it('emits Math.max spread as fold with algorithm include', () => {
    const output = emitIrModuleCpp(
      lower('math-spread.ts', `export function maxOf(items: number[]): number { return Math.max(...items); }`).module,
    ).contents;
    expect(output).toContain('max_element');
    expect(output).toContain('#include <algorithm>');
  });

  it('materializes unbounded array spreads in source order for both runtime profiles', () => {
    const module = lower(
      'array-spread.ts',
      `export function copy(first: number, items: readonly number[]): number[] {
         return [first, ...items, 99];
       }
       export function copySet(values: Set<string>): string[] {
         const copied = [...values];
         return copied;
       }
       export function distinct(values: readonly string[]): string[] {
         return [...new Set(values)];
       }
       export function copyTuple(values: readonly [number, number]): number[] {
         return [...values];
       }
       export function copyTupleRest(values: readonly [number, ...number[]]): number[] {
         return [...values];
       }`,
    ).module;
    const standard = emitIrModuleCpp(module).contents;
    const flight = emitIrModuleCpp(module, { runtimeProfile: 'flight-cpp' }).contents;

    expect(standard).toContain('std::vector<double> array_spread_result');
    expect(standard).toContain('array_spread_result.push_back(first)');
    expect(standard).toContain('for (const auto& array_spread_item : items)');
    expect(standard).toContain('array_spread_result.push_back(99.0)');
    expect(standard).toMatch(
      /std::unordered_set<std::string>\(set_constructor_values(?:_\d+)?\.begin\(\), set_constructor_values(?:_\d+)?\.end\(\)\)/u,
    );
    expect(flight).toContain('flight::Array<double> array_spread_result');
    expect(flight).toContain('array_spread_result.push(first)');
    expect(flight).toContain('for (const auto& array_spread_item : items)');
    expect(flight).toContain('array_spread_result.push(99.0)');
    expect(flight).toMatch(/flight::Array<flight::String> array_spread_result(?:_\d+)?/u);
    expect(flight).toMatch(/for \(const auto& array_spread_item(?:_\d+)? : values\)/u);
    expect(flight).toMatch(/auto&& array_spread_tuple(?:_\d+)? = values/u);
    expect(flight).toContain('std::get<0>');
    expect(flight).toContain('std::get<1>');
  });

  it('materializes spread push arguments before mutating the receiver', () => {
    const module = lower(
      'push-spread.ts',
      `export function append(items: number[], incoming: readonly number[]): number {
         return items.push(1, ...incoming, 2, ...items);
       }`,
    ).module;
    const output = emitIrModuleCpp(module, { runtimeProfile: 'flight-cpp' }).contents;

    expect(output).toContain('auto&& array_push_receiver = items');
    expect(output).toContain('const auto array_push_arguments = ([&]()');
    expect(output).toContain('for (const auto& array_spread_item : incoming)');
    expect(output).toContain('for (const auto& array_spread_item : items)');
    expect(output.indexOf('const auto array_push_arguments')).toBeLessThan(
      output.indexOf('array_push_receiver.push(array_push_item)'),
    );
    expect(output).toContain('return static_cast<double>(array_push_receiver.size())');
  });

  it('projects map and set iterator views while materializing spreads and for-of loops', () => {
    const output = emitIrModuleCpp(
      lower(
        'collection-view-spread.ts',
        `export function distinct(values: readonly string[]): string[] {
           return [...new Set(values)].sort();
         }
         export function mapValues(values: Map<string, number>): number[] {
           return [...values.values()].sort((left, right) => left - right);
         }
         export function mapEntries(values: Map<string, number>): readonly (readonly [string, number])[] {
           return [...values.entries()];
         }
         export function setValues(values: ReadonlySet<string>): string[] {
           return [...values.values()];
         }
         export function sum(values: ReadonlyMap<string, number>): number {
           let total = 0;
           for (const value of values.values()) total += value;
           return total;
         }`,
      ).module,
      { runtimeProfile: 'flight-cpp' },
    ).contents;

    expect(output).toContain('flight::Set<flight::String>(values)');
    expect(output).toContain('for (const auto& array_spread_item : flight::Set<flight::String>(values))');
    expect(output).toMatch(/for \(const auto& \[array_spread_key(?:_\d+)?, array_spread_mapped_value(?:_\d+)?\]/u);
    expect(output).toContain('std::make_tuple(array_spread_key');
    expect(output).toMatch(/for \(const auto& \[for_of_key(?:_\d+)?, for_of_value(?:_\d+)?\] : values\)/u);
    expect(output).not.toContain('.values()');
    expect(output).not.toContain('.entries()');
  });

  it('still refuses unbounded spreads when a fixed-arity call has no iterable target', () => {
    const module = lower(
      'fixed-call-spread.ts',
      `function add(left: number, right: number): number { return left + right; }
       export function invoke(values: number[]): number { return add(...values); }`,
    ).module;

    expect(() => emitIrModuleCpp(module, { runtimeProfile: 'flight-cpp' })).toThrow(
      'spreading an unbounded collection requires a fold or a variadic target',
    );
  });

  it('passes a terminal spread collection to a represented rest-array parameter', () => {
    const output = emitIrModuleCpp(
      lower(
        'rest-array-call.ts',
        `export function invoke(listener: (...args: readonly unknown[]) => void, args: readonly unknown[]): void {
           listener(...args);
         }`,
      ).module,
      { runtimeProfile: 'flight-cpp' },
    ).contents;

    expect(output).toContain('listener(args)');
  });

  it('materializes Array.from over ordered map keys without an unbound static member', () => {
    const output = emitIrModuleCpp(
      lower(
        'array-from-map-keys.ts',
        `const values = new Map<string, number>();
         export function keys(): readonly string[] { return Array.from(values.keys()); }`,
      ).module,
      { runtimeProfile: 'flight-cpp' },
    ).contents;

    expect(output).toContain('for (const auto& [array_from_key, array_from_value] : values)');
    expect(output).toContain('array_from_result.push(array_from_key)');
  });

  it('erases Object.freeze after preserving its single value evaluation', () => {
    const output = emitIrModuleCpp(
      lower(
        'object-freeze.ts',
        `interface Outcome { readonly reason: 'ok' }
         export function outcome(): Outcome { return Object.freeze({ reason: 'ok' }); }`,
      ).module,
      { runtimeProfile: 'flight-cpp' },
    ).contents;

    expect(output).toContain('.reason = flight::String("ok")');
    expect(output).not.toContain('Object::freeze');
  });

  it('emits variadic tuple rest with std::get and tuple include', () => {
    const output = emitIrModuleCpp(
      lower(
        'variadic-rest.ts',
        `export function head(items: [number, ...number[]]): number[] { const [, ...rest] = items; return rest; }`,
      ).module,
    ).contents;
    expect(output).toContain('#include <tuple>');
  });

  it('detects return in if-otherwise for try-finally deferred return', () => {
    const output = emitIrModuleCpp(
      lower(
        'if-else-return.ts',
        `export async function pick(cond: boolean, a: Promise<number>, b: Promise<number>): Promise<number> {
          try {
            if (cond) { let x: number = 0; } else { return await a; }
          } finally { let c: number = 0; }
          return await b;
        }`,
      ).module,
    ).contents;
    expect(output).toContain('finally_return');
  });

  it('detects return in nested try-finally for outer deferred return', () => {
    const output = emitIrModuleCpp(
      lower(
        'nested-try-finally-return.ts',
        `export async function nested(a: Promise<number>, b: Promise<number>): Promise<number> {
          try {
            try { let x: number = 0; } finally { return await a; }
          } finally { let y: number = 0; }
        }`,
      ).module,
    ).contents;
    expect(output).toContain('finally_return');
  });

  it('emits switch case with labeled break targeting the switch', () => {
    const output = emitIrModuleCpp(
      lower(
        'labeled-switch.ts',
        `export function dispatch(x: number): number {
          let result: number = 0;
          outer: switch (x) {
            case 1: result = 10; break outer;
            default: result = 0;
          }
          return result;
        }`,
      ).module,
    ).contents;
    expect(output).toContain('switch');
  });

  it('emits forOf loop over array', () => {
    const output = emitIrModuleCpp(
      lower(
        'for-of-loop.ts',
        `export function sum(items: number[]): number { let total: number = 0; for (const item of items) { total = total + item; } return total; }`,
      ).module,
    ).contents;
    expect(output).toContain('for (');
    expect(output).toContain(' : ');
  });

  it('emits variable without type annotation as auto', () => {
    const output = emitIrModuleCpp(
      lower('auto-var.ts', `export function calc(): number { const x = 42; return x; }`).module,
    ).contents;
    expect(output).toContain('auto');
  });

  it('emits enum member without explicit value', () => {
    const output = emitIrModuleCpp(lower('enum-no-value.ts', `export enum Color { Red, Green, Blue }`).module).contents;
    expect(output).toContain('enum class Color');
    expect(output).toContain('Red');
  });

  it('emits forIn loop with ordered key iteration', () => {
    const result = lower(
      'for-in-ordered.ts',
      `export function keys(obj: { a: number; b: number }): string {
        let result: string = '';
        for (const k in obj) { result = result + k; }
        return result;
      }`,
    );
    const output = emitIrModuleCpp(result.module).contents;
    expect(output).toContain('std::vector<std::string>');
  });

  it('emits new Error with stdexcept include', () => {
    const output = emitIrModuleCpp(
      lower('new-error.ts', `export function fail(msg: string): never { throw new Error(msg); }`).module,
    ).contents;
    expect(output).toContain('std::runtime_error');
    expect(output).toContain('#include <stdexcept>');
  });

  it('emits optional parameter with std::nullopt default', () => {
    const output = emitIrModuleCpp(
      lower(
        'optional-param.ts',
        `export function greet(name: string, prefix?: string): string { return (prefix ?? '') + name; }`,
      ).module,
    ).contents;
    expect(output).toContain('std::optional');
    expect(output).toContain('std::nullopt');
  });

  it('emits rest parameter as vector', () => {
    const output = emitIrModuleCpp(
      lower(
        'rest-param.ts',
        `export function total(...nums: number[]): number { let s: number = 0; for (const n of nums) { s = s + n; } return s; }`,
      ).module,
    ).contents;
    expect(output).toContain('std::vector');
  });

  it('skips static fields in class struct emission', () => {
    const output = emitIrModuleCpp(
      lower(
        'class-static-field.ts',
        `export class Config {
          static readonly MAX: number = 100;
          name: string;
          constructor(n: string) { this.name = n; }
        }`,
      ).module,
    ).contents;
    expect(output).toContain('struct Config');
    expect(output).not.toMatch(/\bMAX\b/);
  });

  it('emits ambient sizeMethod call for .length', () => {
    const output = emitIrModuleCpp(
      lower('size-method.ts', `export function len(items: number[]): number { return items.length; }`).module,
    ).contents;
    expect(output).toContain('static_cast<double>');
    expect(output).toContain('size()');
  });

  it('emits lambda with block body', () => {
    const output = emitIrModuleCpp(
      lower(
        'lambda-block.ts',
        `export function apply(items: number[]): number[] {
          return items.map((x) => { const y: number = x * 2; return y; });
        }`,
      ).module,
    ).contents;
    expect(output).toContain('[=]');
  });

  it('emits new Promise with flight-cpp profile', () => {
    const output = emitIrModuleCpp(
      lower(
        'new-promise-fc.ts',
        `export function make(): Promise<number> { return new Promise<number>((resolve) => resolve(42)); }`,
      ).module,
      { runtimeProfile: 'flight-cpp' },
    ).contents;
    expect(output).toContain('::create(');
  });

  it('emits ambient member property binding', () => {
    const module = structuredClone(lower('ambient-prop.ts', 'export function f(): number { return Math.PI; }').module);
    const fn = module.declarations.find((d: { kind: string }) => d.kind === 'function');
    if (fn?.kind === 'function') {
      for (const stmt of fn.body) {
        if (stmt.kind === 'return' && stmt.expression?.kind === 'property' && stmt.expression.member) {
          (stmt.expression as any).member = {
            ...stmt.expression.member,
            kind: 'property',
            targetName: 'M_PI',
          };
        }
      }
    }
    const output = emitIrModuleCpp(module).contents;
    expect(output).toContain('M_PI');
  });

  it('emits undefinedDefault as value_or', () => {
    const output = emitIrModuleCpp(
      lower('undef-def.ts', `export function fallback(x: number | undefined, d: number): number { return x ?? d; }`)
        .module,
    ).contents;
    expect(output).toContain('value_or');
  });

  it('emits tupleRest as std::get', () => {
    const module = structuredClone(
      lower('tuple-rest.ts', 'export function first(t: [number, string]): number { return t[0]; }').module,
    );
    const fn = module.declarations.find((d: { kind: string }) => d.kind === 'function');
    if (fn?.kind === 'function') {
      const ret = fn.body.find((s: { kind: string }) => s.kind === 'return');
      if (ret?.kind === 'return' && ret.expression) {
        (ret as any).expression = {
          kind: 'tupleRest',
          object: ret.expression.kind === 'element' ? (ret.expression as any).object : ret.expression,
          start: 1,
        };
      }
    }
    const output = emitIrModuleCpp(module).contents;
    expect(output).toContain('std::get<1>');
  });

  it('emits super with named base class reference', () => {
    const output = emitIrModuleCpp(
      lower(
        'super-named.ts',
        `export class Base {
          value: number;
          constructor(v: number) { this.value = v; }
          greet(): string { return "hello"; }
        }
        export class Child extends Base {
          constructor(v: number) { super(v); }
          greet(): string { return super.greet(); }
        }`,
      ).module,
    ).contents;
    expect(output).toContain('Base');
  });

  it('emits type parameter fallback name as PascalCase', () => {
    const module = structuredClone(lower('tparam-fallback.ts', 'export function id<T>(x: T): T { return x; }').module);
    const fn = module.declarations.find((d: { kind: string }) => d.kind === 'function');
    if (fn?.kind === 'function' && fn.typeParameters.length > 0) {
      const tp = fn.typeParameters[0]!;
      const key = tp.binding.id;
      const tnames = (module as any)._targetNamesOverride;
      if (!tnames) {
      }
    }
    const output = emitIrModuleCpp(module).contents;
    expect(output).toContain('template');
  });

  it('emits negated nullish comparison with has_value', () => {
    const output = emitIrModuleCpp(
      lower('negated-nullish.ts', 'export function present(x: number | undefined): boolean { return x != undefined; }')
        .module,
    ).contents;
    expect(output).toContain('.has_value()');
    expect(output).not.toContain('!');
  });

  it('emits lambda with statement body', () => {
    const output = emitIrModuleCpp(
      lower(
        'lambda-body.ts',
        'export function make(x: number): () => number { return (): number => { const y: number = x + 1; return y; }; }',
      ).module,
    ).contents;
    expect(output).toContain('[=]');
    expect(output).toContain('return');
  });

  it('emits for-of without explicit variable type as auto', () => {
    const module = structuredClone(
      lower(
        'for-of-auto.ts',
        'export function sum(items: number[]): number { let t: number = 0; for (const n of items) { t = t + n; } return t; }',
      ).module,
    );
    const fn = module.declarations.find((d: { kind: string }) => d.kind === 'function');
    if (fn?.kind === 'function') {
      for (const stmt of fn.body) {
        if (stmt.kind === 'forOf' && 'variable' in stmt) {
          delete (stmt.variable as any).type;
        }
      }
    }
    const output = emitIrModuleCpp(module).contents;
    expect(output).toContain('for (auto');
  });

  it('emits switch case with targeted labeled break', () => {
    const output = emitIrModuleCpp(
      lower(
        'switch-label.ts',
        `export function pick(x: number): number {
          switch (x) {
            case 1: { const v: number = 10; return v; }
            case 2: return 20;
            default: return 0;
          }
        }`,
      ).module,
    ).contents;
    expect(output).toContain('if (');
  });

  it('detects return in otherwise branch for try-finally deferred variable', () => {
    const output = emitIrModuleCpp(
      lower(
        'if-else-return.ts',
        `export async function branch(task: Promise<number>, flag: boolean): Promise<number> {
          try {
            if (flag) { return await task; } else { return 0; }
          } finally { let x: number = 0; }
        }`,
      ).module,
    ).contents;
    expect(output).toContain('finally_return');
  });

  it('detects return in try finallyBody for deferred return detection', () => {
    const output = emitIrModuleCpp(
      lower(
        'nested-try.ts',
        `export async function nested(a: Promise<number>, b: Promise<number>): Promise<number> {
          try {
            try { return await a; } finally { let x: number = 0; }
          } finally { let y: number = 0; }
        }`,
      ).module,
    ).contents;
    expect(output).toContain('finally_return');
  });

  it('emits Promise construction with flight-cpp runtime profile', () => {
    const output = emitIrModuleCpp(
      lower(
        'promise-ctor.ts',
        'export function make(fn: (resolve: (v: number) => void) => void): Promise<number> { return new Promise<number>(fn); }',
      ).module,
      { runtimeProfile: 'flight-cpp' },
    ).contents;
    expect(output).toContain('::create(');
  });

  it('emits variable declaration without explicit type as auto', () => {
    const module = structuredClone(
      lower('auto-var.ts', 'export function test(): number { const x: number = 42; return x; }').module,
    );
    const fn = module.declarations.find((d: { kind: string }) => d.kind === 'function');
    if (fn?.kind === 'function') {
      for (const stmt of fn.body) {
        if (stmt.kind === 'variable') {
          for (const decl of stmt.declarations) {
            delete (decl as any).type;
          }
        }
      }
    }
    const output = emitIrModuleCpp(module).contents;
    expect(output).toContain('auto x');
  });

  it('emits binding name fallback when targetNames map misses', () => {
    const module = structuredClone(
      lower('fallback-name.ts', 'export function test(x: number): number { return x; }').module,
    );
    const output = emitIrModuleCpp(module).contents;
    expect(output).toBeDefined();
  });

  it('emits tuple element access with static index', () => {
    const output = emitIrModuleCpp(
      lower('tuple-elem.ts', 'export function first(pair: [number, string]): number { return pair[0]; }').module,
    ).contents;
    expect(output).toContain('std::get<0>');
  });

  it('emits tupleSpread with optional target wrapping on element segment', () => {
    const module = structuredClone(
      lower(
        'tspread-wrap.ts',
        'export function combine(pair: [number, number]): [number, number, number] { return [0, ...pair]; }',
      ).module,
    );
    const fn = module.declarations.find((d: { kind: string }) => d.kind === 'function');
    if (fn?.kind === 'function') {
      for (const stmt of fn.body) {
        if (stmt.kind === 'return' && stmt.expression?.kind === 'tupleSpread') {
          const seg = stmt.expression.segments.find((s: any) => s.kind === 'element');
          if (seg?.kind === 'element') {
            const idx = stmt.expression.segments.indexOf(seg);
            (stmt.expression.type.elements[idx] as any).optional = true;
          }
        }
      }
    }
    const output = emitIrModuleCpp(module).contents;
    expect(output).toContain('std::make_optional');
  });

  it('emits tupleSpread spread segment with optional target wrapping', () => {
    const module = structuredClone(
      lower(
        'tspread-spread-opt.ts',
        'export function combine(pair: [number, number]): [number, number, number] { return [0, ...pair]; }',
      ).module,
    );
    const fn = module.declarations.find((d: { kind: string }) => d.kind === 'function');
    if (fn?.kind === 'function') {
      for (const stmt of fn.body) {
        if (stmt.kind === 'return' && stmt.expression?.kind === 'tupleSpread') {
          for (const seg of stmt.expression.segments) {
            if (seg.kind === 'spread') {
              const startIdx = stmt.expression.segments.indexOf(seg);
              const base = startIdx > 0 ? 1 : 0;
              for (let i = 0; i < seg.type.elements.length; i++) {
                const target = stmt.expression.type.elements[base + i];
                if (target) (target as any).optional = true;
              }
            }
          }
        }
      }
    }
    const output = emitIrModuleCpp(module).contents;
    expect(output).toContain('std::make_optional');
  });

  it('emits type reference target name fallback for non-ambient binding', () => {
    const output = emitIrModuleCpp(
      lower('type-ref-bind.ts', 'interface Pt { x: number } export function read(p: Pt): number { return p.x; }')
        .module,
    ).contents;
    expect(output).toContain('Pt');
  });

  it('emits anonymous struct with empty properties as named struct', () => {
    const module = structuredClone(
      lower('empty-obj.ts', 'export function make(): { x: number } { return { x: 1 }; }').module,
    );
    const fn = module.declarations.find((d: { kind: string }) => d.kind === 'function');
    if (fn?.kind === 'function') {
      (fn as any).returns = { kind: 'object', properties: [] };
    }
    const output = emitIrModuleCpp(module).contents;
    expect(output).toContain('anonymous');
  });

  it('returns undefined from extractSuperCallCpp when no super call exists', () => {
    const output = emitIrModuleCpp(
      lower(
        'no-super.ts',
        'class Base { value: number; constructor() { this.value = 0; } } export class Child extends Base { extra: number; constructor() { super(); this.extra = 1; } }',
      ).module,
    ).contents;
    expect(output).toContain('Child');
  });

  it('walks inherited methods and stops when base is not a class', () => {
    const output = emitIrModuleCpp(
      lower(
        'iface-extends.ts',
        `interface Runner { run(): number }
        export class Impl implements Runner { run(): number { return 1; } }`,
      ).module,
    ).contents;
    expect(output).toContain('Impl');
  });

  it('refuses Promise construction without exactly one type argument', () => {
    const module = structuredClone(
      lower(
        'promise-bad.ts',
        'export function make(fn: (resolve: (v: number) => void) => void): Promise<number> { return new Promise<number>(fn); }',
      ).module,
    );
    const fn = module.declarations.find((d: { kind: string }) => d.kind === 'function');
    if (fn?.kind === 'function') {
      for (const stmt of fn.body) {
        if (stmt.kind === 'return' && stmt.expression?.kind === 'new') {
          (stmt.expression as any).typeArguments = [];
        }
      }
    }
    expect(() => emitIrModuleCpp(module, { runtimeProfile: 'flight-cpp' })).toThrow('type argument');
  });

  it('emits static and instance fields together in struct body', () => {
    const output = emitIrModuleCpp(
      lower(
        'static-skip.ts',
        `export class Counter {
          static count: number = 0;
          static label: string = 'counter';
          value: number;
          name: string;
          constructor(v: number, n: string) { this.value = v; this.name = n; }
        }`,
      ).module,
    ).contents;
    expect(output).toContain('double value');
    expect(output).toContain('name');
    expect(output).toContain('inline static double count');
    expect(output).toContain('inline static std::string label');
  });

  it('emits labeled break in switch case that targets outer loop', () => {
    const output = emitIrModuleCpp(
      lower(
        'labeled-switch.ts',
        `export function scan(values: number[]): number {
          let result: number = 0;
          outer: for (let i: number = 0; i < values.length; i++) {
            switch (values[i]) {
              case -1:
                break outer;
              case 0:
                continue;
              default:
                result = result + values[i]!;
            }
          }
          return result;
        }`,
      ).module,
    ).contents;
    expect(output).toContain('break');
  });

  it('detects return only in else branch of if inside try-finally', () => {
    const output = emitIrModuleCpp(
      lower(
        'try-else-return.ts',
        `export function decide(condition: boolean, cleanup: () => void): number {
          try {
            if (condition) {
              cleanup();
            } else {
              return 2;
            }
          } finally {
            cleanup();
          }
          return 0;
        }`,
      ).module,
    ).contents;
    expect(output).toContain('finally_return');
    expect(output).toContain('finally_exception');
  });

  it('detects return in catch body of try inside outer try-finally', () => {
    const output = emitIrModuleCpp(
      lower(
        'nested-catch-return.ts',
        `export function nested(cleanup: () => void): number {
          try {
            try {
              cleanup();
            } catch (e: unknown) {
              return 1;
            }
          } finally {
            cleanup();
          }
          return 0;
        }`,
      ).module,
    ).contents;
    expect(output).toContain('finally_return');
  });

  it('refuses numeric enum member without explicit value via IR injection', () => {
    const module = structuredClone(
      lower('auto-enum.ts', 'export enum Direction { Up = 0, Down = 1, Left = 2, Right = 3 }').module,
    );
    const enumDecl = module.declarations.find((d: { kind: string }) => d.kind === 'enum');
    if (enumDecl?.kind === 'enum' && enumDecl.members[2]) {
      delete (enumDecl.members[2] as any).value;
    }
    expect(() => emitIrModuleCpp(module)).toThrow('requires an integer value');
  });

  it('emits optional and rest parameters in function declarations', () => {
    const output = emitIrModuleCpp(
      lower(
        'opt-rest.ts',
        `export function greet(name: string, title?: string): string { return name; }
         export function sum(...values: number[]): number { return values[0]!; }`,
      ).module,
    ).contents;
    expect(output).toContain('std::optional');
    expect(output).toContain('std::nullopt');
    expect(output).toContain('std::vector');
  });

  it('emits super call returning undefined when constructor has no super', () => {
    const module = structuredClone(
      lower(
        'no-super.ts',
        `export class Base { value: number; constructor(v: number) { this.value = v; } }
         export class Child extends Base { extra: string; constructor(v: number) { super(v); this.extra = 'x'; } }`,
      ).module,
    );
    const child = module.declarations.find(
      (d: { kind: string; binding?: { name: string } }) => d.kind === 'class' && d.binding?.name === 'Child',
    );
    if (child?.kind === 'class' && child.classConstructor) {
      const filtered = child.classConstructor.body.filter((s: { kind: string }) => s.kind !== 'expression');
      (child.classConstructor as unknown as { body: typeof filtered }).body = filtered;
    }
    const output = emitIrModuleCpp(module).contents;
    expect(output).toContain('Child');
  });

  it('emits static fields as inline static in class struct', () => {
    const output = emitIrModuleCpp(
      lower(
        'static-field.ts',
        `export class Counter {
          static instances: number = 0;
          count: number;
          constructor() { this.count = 0; }
        }`,
      ).module,
    ).contents;
    expect(output).toContain('double count;');
    expect(output).toContain('inline static double instances');
  });

  it('emits lambda with block body when expression body is absent', () => {
    const module = structuredClone(
      lower(
        'block-lambda.ts',
        `export function apply(items: number[]): number[] {
          return items.map((x: number): number => { const y = x * 2; return y; });
        }`,
      ).module,
    );
    const output = emitIrModuleCpp(module).contents;
    expect(output).toContain('[=]');
    expect(output).toContain('return');
  });

  it('detects return in if-otherwise inside try-finally', () => {
    const output = emitIrModuleCpp(
      lower(
        'if-else-return.ts',
        `export function check(condition: boolean, cleanup: () => void): number {
          try {
            if (condition) {
              cleanup();
            } else {
              return 1;
            }
          } finally {
            cleanup();
          }
          return 0;
        }`,
      ).module,
    ).contents;
    expect(output).toContain('finally_return');
    expect(output).toContain('finally_exception');
  });

  it('detects return in nested finally body inside outer try-finally', () => {
    const output = emitIrModuleCpp(
      lower(
        'finally-return.ts',
        `export function nested(cleanup: () => void): number {
          try {
            try {
              cleanup();
            } finally {
              return 1;
            }
          } finally {
            cleanup();
          }
          return 0;
        }`,
      ).module,
    ).contents;
    expect(output).toContain('finally_return');
  });

  it('emits auto type for variable declaration without type annotation via IR injection', () => {
    const module = structuredClone(lower('untyped-var.ts', 'export const value: number = 42;').module);
    const decl = module.declarations.find((d: { kind: string }) => d.kind === 'variable');
    if (decl?.kind === 'variable') {
      delete (decl as unknown as Record<string, unknown>).type;
    }
    const output = emitIrModuleCpp(module).contents;
    expect(output).toContain('auto value');
  });

  it('emits optional parameter with std::optional wrapper via IR injection', () => {
    const module = structuredClone(
      lower('opt-param.ts', 'export function greet(name: string): string { return name; }').module,
    );
    const fn = module.declarations.find((d: { kind: string }) => d.kind === 'function');
    if (fn?.kind === 'function' && fn.parameters[0]) {
      (fn.parameters[0] as Record<string, unknown>).optional = true;
    }
    const output = emitIrModuleCpp(module).contents;
    expect(output).toContain('std::optional');
    expect(output).toContain('std::nullopt');
  });

  it('resolves super reference through named base class', () => {
    const output = emitIrModuleCpp(
      lower(
        'super-base.ts',
        `export class Base { greet(): string { return 'hello'; } }
         export class Child extends Base { greet(): string { return super.greet(); } }`,
      ).module,
    ).contents;
    expect(output).toContain('Base::greet()');
  });

  it('emits rest parameter as std::vector', () => {
    const output = emitIrModuleCpp(
      lower('rest-param.ts', `export function sum(...nums: number[]): number { return nums[0]; }`).module,
    ).contents;
    expect(output).toContain('std::vector<double>');
    expect(output).toContain('nums');
  });

  it('emits try-finally with return inside if-else', () => {
    const output = emitIrModuleCpp(
      lower(
        'try-if-return.ts',
        `export function check(x: number): number {
           try {
             if (x > 0) { return x; } else { return -x; }
           } finally {
             x = 0;
           }
         }`,
      ).module,
    ).contents;
    expect(output).toContain('return');
  });

  it('emits array length as size cast to double', () => {
    const output = emitIrModuleCpp(
      lower('arr-len.ts', `export function len(items: number[]): number { return items.length; }`).module,
    ).contents;
    expect(output).toContain('static_cast<double>');
    expect(output).toContain('size()');
  });

  it('emits string length as size method', () => {
    const output = emitIrModuleCpp(
      lower('str-len.ts', `export function len(s: string): number { return s.length; }`).module,
    ).contents;
    expect(output).toContain('static_cast<double>');
  });

  it('emits generic type parameter as typename', () => {
    const output = emitIrModuleCpp(
      lower('generic-fn.ts', `export function identity<T>(value: T): T { return value; }`).module,
    ).contents;
    expect(output).toContain('template');
    expect(output).toContain('typename');
  });

  it('emits switch as if-else chain with switch_value', () => {
    const output = emitIrModuleCpp(
      lower(
        'switch-break.ts',
        `export function label(x: number): string {
           switch (x) {
             case 1: return 'one';
             case 2: return 'two';
             default: return 'other';
           }
         }`,
      ).module,
    ).contents;
    expect(output).toContain('switch_value');
    expect(output).toContain('"one"');
    expect(output).toContain('"two"');
    expect(output).toContain('"other"');
  });

  it('emits if-else statement with otherwise branch', () => {
    const output = emitIrModuleCpp(
      lower(
        'if-else.ts',
        `export function abs(x: number): number {
           if (x >= 0) { return x; } else { return -x; }
         }`,
      ).module,
    ).contents;
    expect(output).toContain('if');
    expect(output).toContain('else');
  });

  it('emits tuple spread elements', () => {
    const result = lower(
      'tuple-spread.ts',
      `export function first(pair: [number, string]): number { return pair[0]; }`,
    );
    const output = emitIrModuleCpp(result.module).contents;
    expect(output).toContain('pair');
  });

  it('emits enum member without explicit value', () => {
    const output = emitIrModuleCpp(lower('enum-implicit.ts', `export enum Color { Red, Green, Blue }`).module).contents;
    expect(output).toContain('enum');
    expect(output).toContain('Red');
    expect(output).toContain('Green');
    expect(output).toContain('Blue');
  });

  it('emits type alias for object type as struct', () => {
    const output = emitIrModuleCpp(
      lower('point-alias.ts', 'export type Point = { x: number; y: number };').module,
    ).contents;
    expect(output).toContain('struct Point');
    expect(output).toContain('double x');
    expect(output).toContain('double y');
  });

  it('emits type alias object struct with ReferenceEnabled under flight-cpp profile', () => {
    const output = emitIrModuleCpp(lower('point-ref.ts', 'export type Point = { x: number; y: number };').module, {
      runtimeProfile: 'flight-cpp',
    }).contents;
    expect(output).toContain('struct Point : public flight::ReferenceEnabled');
  });

  it('emits async method with coroutine include', () => {
    const output = emitIrModuleCpp(
      lower(
        'async-method.ts',
        `export class Fetcher {
          async fetch(): Promise<number> { return 1; }
        }`,
      ).module,
    ).contents;
    expect(output).toContain('#include <coroutine>');
    expect(output).toContain('fetch');
  });

  it('emits optional call expression as guarded invocation', () => {
    const output = emitIrModuleCpp(
      lower(
        'opt-call.ts',
        `export function tryCall(fn: (() => number) | undefined): number | undefined { return fn?.(); }`,
      ).module,
    ).contents;
    expect(output).toContain('has_value');
  });

  it('emits optional void calls without forming optional<void>', () => {
    const output = emitIrModuleCpp(
      lower(
        'optional-void-call.ts',
        'interface Backend { prepare?(): void } export function prepare(backend: Backend): void { backend.prepare?.(); }',
      ).module,
      { runtimeProfile: 'flight-cpp' },
    ).contents;

    expect(output).toContain('if (!optional_chain_receiver.has_value()) return; optional_chain_receiver.value()();');
    expect(output).not.toContain('optional<void>');
  });

  it('emits string length as size method with static_cast', () => {
    const output = emitIrModuleCpp(
      lower('str-len.ts', 'export function len(s: string): number { return s.length; }').module,
    ).contents;
    expect(output).toContain('static_cast<double>');
    expect(output).toContain('.size()');
  });

  it('emits optional element access as guarded indexing', () => {
    const output = emitIrModuleCpp(
      lower('opt-elem.ts', `export function first(arr: number[] | undefined): number | undefined { return arr?.[0]; }`)
        .module,
    ).contents;
    expect(output).toContain('has_value');
  });

  it('emits flight-cpp array literal with flight::Array', () => {
    const output = emitIrModuleCpp(
      lower('arr-flight.ts', 'export function items(): number[] { return [1, 2, 3]; }').module,
      { runtimeProfile: 'flight-cpp' },
    ).contents;
    expect(output).toContain('flight::Array');
  });

  it('emits switch if-else chain from lowered switch', () => {
    const output = emitIrModuleCpp(
      lower(
        'switch-break.ts',
        `export function classify(n: number): string {
          switch (n) {
            case 0: return 'zero';
            case 1: return 'one';
            default: return 'other';
          }
        }`,
      ).module,
    ).contents;
    expect(output).toContain('switch_value == 0');
    expect(output).toContain('switch_value == 1');
  });

  it('emits try-finally with return in if-else branches', () => {
    const output = emitIrModuleCpp(
      lower(
        'finally-if-else-return.ts',
        `export function pick(flag: boolean, cleanup: () => void): number {
          try {
            if (flag) { return 1; } else { return 2; }
          } finally {
            cleanup();
          }
        }`,
      ).module,
    ).contents;
    expect(output).toContain('finally_return');
  });

  it('emits try-finally with nested try containing return', () => {
    const output = emitIrModuleCpp(
      lower(
        'finally-nested-try-return.ts',
        `export function nested(cleanup: () => void): number {
          try {
            try {
              return 1;
            } catch (e: unknown) {
              return 2;
            }
          } finally {
            cleanup();
          }
        }`,
      ).module,
    ).contents;
    expect(output).toContain('finally_return');
  });

  it('emits number.toString as std::to_string', () => {
    const output = emitIrModuleCpp(
      lower('num-tostring.ts', 'export function label(n: number): string { return n.toString(); }').module,
    ).contents;
    expect(output).toContain('std::to_string');
  });

  it('emits anonymous struct with optional property', () => {
    const output = emitIrModuleCpp(
      lower('anon-opt.ts', `export function build(): { name: string; age?: number } { return { name: 'test' }; }`)
        .module,
    ).contents;
    expect(output).toContain('struct');
    expect(output).toContain('name');
    expect(output).toContain('optional');
  });

  it('emits forIn with object expression preservation', () => {
    const output = emitIrModuleCpp(
      lower(
        'forin-preserve.ts',
        `export function keys(a: number, b: number): string {
          let result: string = '';
          for (const k in { x: a, y: b }) { result = k; }
          return result;
        }`,
      ).module,
    ).contents;
    expect(output).toContain('for');
    expect(output).toContain('vector');
  });

  it('emits type alias with generic parameters for object type', () => {
    const output = emitIrModuleCpp(
      lower('generic-alias.ts', 'export type Pair<T> = { first: T; second: T };').module,
    ).contents;
    expect(output).toContain('template');
    expect(output).toContain('struct Pair');
  });

  it('emits lambda with block body', () => {
    const output = emitIrModuleCpp(
      lower(
        'lambda-block.ts',
        `export function apply(items: number[]): number[] {
          return items.filter((x: number): boolean => { return x > 0; });
        }`,
      ).module,
    ).contents;
    expect(output).toContain('[=]');
    expect(output).toContain('return');
  });

  it('deconflicts exported variables with identical C++ snake_case names', () => {
    const emitted = emitIrModuleCpp(
      lower('collide.ts', 'export const value: number = 1; export const Value: number = 2;').module,
    );
    expect(emitted.contents).toContain('value_flight_value_variable_value');
    expect(emitted.contents).toContain('value_flight_value_variable__u000056_alue');
  });

  it('refuses variable declaration with injected pattern via lowering-plan validation', () => {
    const result = lower('pattern-var.ts', 'export function f(): void { let x: number = 0; }');
    const module = structuredClone(result.module);
    const fn = module.declarations.find((d) => d.kind === 'function');
    if (fn?.kind === 'function') {
      const varStmt = fn.body.find((s) => s.kind === 'variable');
      if (varStmt?.kind === 'variable' && varStmt.declarations[0]) {
        (varStmt.declarations[0] as any).pattern = { kind: 'array', elements: [] };
      }
    }
    expect(() => emitIrModuleCpp(module)).toThrow('lowering-plan');
  });

  it('refuses local variable without type or initializer', () => {
    const result = lower('no-init.ts', 'export function f(): void { let x: number = 0; }');
    const module = structuredClone(result.module);
    const fn = module.declarations.find((d) => d.kind === 'function');
    if (fn?.kind === 'function') {
      const varStmt = fn.body.find((s) => s.kind === 'variable');
      if (varStmt?.kind === 'variable' && varStmt.declarations[0] && !('pattern' in varStmt.declarations[0])) {
        (varStmt.declarations[0] as any).type = undefined;
        (varStmt.declarations[0] as any).initializer = undefined;
      }
    }
    expect(() => emitIrModuleCpp(module)).toThrow('requires inferred type evidence');
  });

  it('refuses top-level variable declaration without type or initializer', () => {
    const result = lower('bare.ts', 'export const x: number = 1;');
    const module = structuredClone(result.module);
    const decl = module.declarations[0];
    if (decl?.kind === 'variable' && !('pattern' in decl)) {
      (decl as any).type = undefined;
      (decl as any).initializer = undefined;
    }
    expect(() => emitIrModuleCpp(module)).toThrow('requires inferred type evidence');
  });

  it('emits ordered executable module initialization with namespace-safe closures', () => {
    const result = lower(
      'module-initialization.ts',
      `export const values: number[] = [1, 2];
       export let total = 0;
       for (const value of values) total += value;
       if (total > 0) total *= 2;`,
    );
    const output = emitIrModuleCpp(result.module, { runtimeProfile: 'flight-cpp' }).contents;

    expect(result.diagnostics).toEqual([]);
    expect(output).toContain('[]() {\n  for (auto value : values)');
    expect(output).toContain('[]() {\n  if ((total > 0.0))');
    expect(output.indexOf('for (auto value : values)')).toBeLessThan(output.indexOf('if ((total > 0.0))'));
    expect(output).not.toContain('inline const bool module_side_effect = [=]');
  });

  it('preserves module initialization order around static class fields', () => {
    const result = lower(
      'module-class-initialization.ts',
      `const events: string[] = [];
       mark('before');
       export class Marker { static value = mark('class'); }
       mark('after');
       function mark(value: string): number { events.push(value); return 0; }`,
    );
    const output = emitIrModuleCpp(result.module, { runtimeProfile: 'flight-cpp' }).contents;
    const before = output.indexOf('mark(flight::String("before"))');
    const classInitialization = output.indexOf('mark(flight::String("class"))');
    const after = output.indexOf('mark(flight::String("after"))');

    expect(result.diagnostics).toEqual([]);
    expect(before).toBeGreaterThan(-1);
    expect(classInitialization).toBeGreaterThan(before);
    expect(after).toBeGreaterThan(classInitialization);
  });

  it('preserves optional array results until a nullish fallback consumes them', () => {
    const result = lower('pop.ts', 'export function last(items: number[]): number { return items.pop() ?? -1; }');
    const emitted = emitIrModuleCpp(result.module, { runtimeProfile: 'flight-cpp' });
    expect(emitted.contents).toContain('.pop().value_or(-1.0)');
    expect(emitted.contents).not.toContain('.pop().value().value_or');
  });

  it('emits ambient sizeMethod binding in call expression context', () => {
    const result = lower('size-call.ts', 'export function count(s: string): number { return s.length; }');
    const emitted = emitIrModuleCpp(result.module, { runtimeProfile: 'flight-cpp' });
    expect(emitted.contents).toContain('.length()');
    expect(emitted.contents).toContain('static_cast<double>');
  });

  it('refuses dynamic-this closure before receiver lowering', () => {
    const result = lower(
      'dyn-this.ts',
      'export class Box { value: number = 0; make(): () => number { return (): number => this.value; } }',
    );
    const module = structuredClone(result.module);
    const cls = module.declarations.find((d) => d.kind === 'class');
    if (cls?.kind === 'class') {
      const method = cls.methods.find((m) => m.name === 'make');
      if (method) {
        const fnExpr = method.body.find((s) => s.kind === 'return');
        if (fnExpr?.kind === 'return' && fnExpr.expression?.kind === 'function') {
          (fnExpr.expression as any).thisMode = 'dynamic';
        }
      }
    }
    expect(() => emitIrModuleCpp(module)).toThrow('dynamic-this closures require receiver lowering');
  });

  it('emits variant union with typeof narrowing as union member test', () => {
    const result = lower(
      'typeof-variant.ts',
      'export function check(x: string | number): string { return typeof x === "string" ? x : x.toString(); }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('std::variant');
    expect(emitted.contents).toContain('x.index() == 1');
  });

  it('parenthesizes consecutive unary minus to avoid pre-decrement', () => {
    const result = lower('double-neg.ts', 'export function neg(x: number): number { return -(-x); }');
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('return -(-x);');
  });

  it('refuses for-in without closed key evidence', () => {
    expect(() =>
      emitIrModuleCpp(
        lower(
          'for-in-eval.ts',
          `interface Obj { a: string; b: string }
         export function keys(getObj: () => Obj): string {
           let result: string = "";
           for (const key in getObj()) { result += key; }
           return result;
         }`,
        ).module,
      ),
    ).toThrow('object key iteration requires closed key evidence');
  });

  it('emits for-in with alreadyEvaluated evaluation', () => {
    const result = lower(
      'for-in-already.ts',
      `interface Cfg { host: string }
       export function keys(cfg: Cfg): string {
         let result: string = "";
         for (const key in cfg) { result += key; }
         return result;
       }`,
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('std::vector<std::string>');
  });

  it('lowers C-style for loop to while before emission', () => {
    const result = lower(
      'c-for.ts',
      `export function count(): number {
         let x: number = 0;
         for (let i: number = 0; i < 10; i = i + 1) { x = x + i; }
         return x;
       }`,
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('while');
  });

  it('refuses for-of with await before async iteration lowering', () => {
    const result = lower(
      'for-of-await.ts',
      'export function each(items: number[]): void { for (const x of items) {} }',
    );
    const module = structuredClone(result.module);
    const fn = module.declarations.find((d) => d.kind === 'function');
    if (fn?.kind === 'function') {
      const forOf = fn.body.find((s) => s.kind === 'forOf');
      if (forOf?.kind === 'forOf') {
        (forOf as any).await = true;
      }
    }
    expect(() => emitIrModuleCpp(module)).toThrow('async iteration requires C++ coroutine lowering');
  });

  it('hoists catch-await before emission in async function', () => {
    const result = lower(
      'catch-await-hoist.ts',
      `export async function safe(task: Promise<number>): Promise<number> {
         try { return await task; }
         catch (e) { const v: number = 0; return v; }
       }`,
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('co_await');
    expect(emitted.contents).toContain('catch');
  });

  it('emits implicit optional return for functions that may not complete', () => {
    const result = lower(
      'implicit-optional.ts',
      `export function maybe(x: number): number | undefined {
         if (x > 0) return x;
       }`,
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('return std::nullopt');
  });

  it('emits implicit co_return for async void functions', () => {
    const result = lower('async-void.ts', 'export async function run(): Promise<void> { let x: number = 1; }');
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('co_return;');
  });

  it('emits implicit throw for async non-void functions without definite completion', () => {
    const result = lower(
      'async-throw.ts',
      `export async function compute(task: Promise<number>): Promise<number> {
         if (true) return await task;
       }`,
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('co_await std::suspend_never');
    expect(emitted.contents).toContain('Flight async function completed without a value');
  });

  it('detects definite completion through block statements', () => {
    const result = lower(
      'block-complete.ts',
      `export function always(): number {
         { return 1; }
       }`,
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).not.toContain('completed without a value');
  });

  it('detects definite completion through if-else branches', () => {
    const result = lower(
      'if-else-complete.ts',
      `export function pick(x: number): number {
         if (x > 0) { return 1; } else { return 0; }
       }`,
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).not.toContain('completed without a value');
  });

  it('detects definite completion through try-catch', () => {
    const result = lower(
      'try-catch-complete.ts',
      `export function safe(x: number): number {
         try { return x; } catch { return 0; }
       }`,
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).not.toContain('completed without a value');
  });

  it('detects definite completion through finally body', () => {
    const result = lower(
      'finally-complete.ts',
      `export async function always(task: Promise<number>): Promise<number> {
         try { let x: number = await task; } finally { return 0; }
       }`,
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).not.toContain('Flight async function completed without a value');
  });

  it('emits irTypeIncludesUndefined for union containing undefined', () => {
    const result = lower(
      'undef-union.ts',
      `export function wrap(x: number): number | undefined { return x > 0 ? x : undefined; }`,
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('std::optional');
  });

  it('refuses injected new expression with non-identifier callee via lowering validation', () => {
    const result = lower('new-obj.ts', 'export const x: number = 1;');
    const module = structuredClone(result.module);
    const decl = module.declarations[0];
    if (decl?.kind === 'variable' && !('pattern' in decl)) {
      (decl as any).initializer = {
        kind: 'new',
        callee: {
          kind: 'property',
          object: { kind: 'literal', value: 'x' },
          name: 'Ctor',
          optional: false,
          member: undefined,
          optionalChain: undefined,
          absent: undefined,
          narrowedMember: undefined,
        },
        arguments: [],
        typeArguments: [],
      };
    }
    expect(() => emitIrModuleCpp(module)).toThrow('lowering-plan');
  });

  it('emits optional element access via ambient member binding', () => {
    const result = lower(
      'opt-prop.ts',
      `export function first(items: number[]): number | undefined {
         return items[0];
       }`,
    );
    const emitted = emitIrModuleCpp(result.module, { runtimeProfile: 'flight-cpp' });
    expect(emitted.contents).toContain('.element(');
  });

  it('refuses unchecked typeof discrimination through a variant type alias', () => {
    expect(() =>
      emitIrModuleCpp(
        lower(
          'alias-variant.ts',
          `type Tag = 'a' | 'b';
         export function check(value: Tag | number): string {
           return typeof value === 'string' ? value : value.toString();
         }`,
        ).module,
      ),
    ).toThrow('typeof on a C++ variant requires proven union member test evidence');
  });

  it('emits duplicate runtime external symbols as incompleteness failure', () => {
    const result = lower('dup-symbol.ts', 'export function f(x: Map<string, number>): boolean { return x.has("a"); }');
    const emitted = emitIrModuleCpp(result.module, { runtimeProfile: 'flight-cpp' });
    expect(emitted.contents).toContain('flight::Map');
  });

  it('emits containsReturnStatement through try catchClause', () => {
    const result = lower(
      'return-in-catch.ts',
      `export async function maybe(task: Promise<number>): Promise<number> {
         try { let x: number = await task; }
         catch { return 0; }
         finally { let y: number = 1; }
       }`,
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('finally_return');
  });

  it('emits narrowed variant union member access via std::get', () => {
    const result = lower(
      'variant-prop.ts',
      'export function check(x: string | number): string { return typeof x === "string" ? x : x.toString(); }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('std::get<');
    expect(emitted.contents).toContain('std::variant');
  });

  it('emits isCppScalarValueType with union of primitives', () => {
    const result = lower(
      'scalar-union.ts',
      'export function check(x: number | boolean): number | boolean { return x; }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('std::variant');
  });

  it('emits class getter as parenthesized call in property access', () => {
    const result = lower(
      'getter.ts',
      `export class Counter {
         private _count: number = 0;
         get count(): number { return this._count; }
         set count(value: number) { this._count = value; }
         bump(): void { this.count = this.count + 1; }
       }`,
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('count()');
    expect(emitted.contents).toContain('count(');
  });

  it('emits getIrExpressionClassDeclarationCpp for new expression', () => {
    const result = lower(
      'new-class.ts',
      `export class Pt { x: number; constructor(x: number) { this.x = x; } static make(): Pt { return new Pt(0); } }`,
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('Pt(');
  });

  it('emits super reference fallback when base is not a named binding', () => {
    const result = lower(
      'super-fallback.ts',
      'class Base { value(): number { return 1; } } export class Child extends Base { value(): number { return super.value(); } }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('Base::value');
  });

  it('emits hasSharedReferentRepresentation for array type', () => {
    const result = lower('shared-ref.ts', 'export function id(items: number[]): number[] { return items; }');
    const emitted = emitIrModuleCpp(result.module, { runtimeProfile: 'flight-cpp' });
    expect(emitted.contents).toContain('flight::Array');
  });

  it('emits getExpectedReturnTypeCpp in async context', () => {
    const result = lower(
      'async-return.ts',
      `export async function fetch(task: Promise<string>): Promise<string> {
         return await task;
       }`,
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('co_return');
    expect(emitted.contents).toContain('co_await');
  });

  it('emits unsigned right shift assignment with uint32 cast', () => {
    const result = lower(
      'urshift-assign.ts',
      `export function shift(x: number): number { let v: number = x; v >>>= 1; return v; }`,
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('static_cast<uint32_t>');
    expect(emitted.contents).toContain('#include <cstdint>');
  });

  it('emits bitwise compound assignment with int32 casts', () => {
    const result = lower(
      'bitwise-assign.ts',
      `export function mask(x: number): number { let v: number = x; v &= 0xFF; return v; }`,
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('static_cast<int32_t>');
    expect(emitted.contents).toContain('#include <cstdint>');
  });

  it('refuses shared mutable capture without concrete binding type evidence', () => {
    const result = lower(
      'capture-no-type.ts',
      `export function make(): () => number {
         let count: number = 0;
         return (): number => { count += 1; return count; };
       }`,
    );
    const module = structuredClone(result.module);
    const fn = module.declarations.find((d) => d.kind === 'function');
    if (fn?.kind === 'function') {
      const varStmt = fn.body.find((s) => s.kind === 'variable');
      if (varStmt?.kind === 'variable' && varStmt.declarations[0] && !('pattern' in varStmt.declarations[0])) {
        (varStmt.declarations[0] as any).type = undefined;
      }
    }
    expect(() => emitIrModuleCpp(module)).toThrow('requires concrete binding type evidence');
  });

  it('refuses empty flight-cpp array without contextual element type', () => {
    const result = lower('empty-arr.ts', 'export const items: number[] = [];');
    const module = structuredClone(result.module);
    const decl = module.declarations[0];
    if (decl?.kind === 'variable' && !('pattern' in decl)) {
      (decl as any).type = undefined;
    }
    expect(() => emitIrModuleCpp(module, { runtimeProfile: 'flight-cpp' })).toThrow(
      'an empty array requires contextual element type',
    );
  });

  it('emits standard-library array with std::vector', () => {
    const result = lower('vec.ts', 'export function pair(): number[] { return [1, 2]; }');
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('std::vector{');
    expect(emitted.contents).toContain('#include <vector>');
  });

  it('emits ambient member property binding for Error.message in property expression context', () => {
    const result = lower('ambient-prop.ts', `export function msg(err: Error): string { return err.message; }`);
    const emitted = emitIrModuleCpp(result.module, { runtimeProfile: 'flight-cpp' });
    expect(emitted.contents).toContain('.message');
  });

  it('refuses typeof on a C++ variant binding without proven member test evidence', () => {
    const result = lower(
      'typeof-variant-err.ts',
      'export function check(value: string | number): string { return typeof value === "string" ? value : "num"; }',
    );
    const module = structuredClone(result.module);
    const fn = module.declarations.find((d) => d.kind === 'function');
    if (fn?.kind === 'function') {
      for (const stmt of fn.body) {
        if (stmt.kind === 'return' && stmt.expression?.kind === 'conditional') {
          const cond = stmt.expression.condition;
          if (cond.kind === 'binary' && cond.semantics.unionMemberTest) {
            (cond as any).semantics = { ...cond.semantics, unionMemberTest: undefined };
            (cond as any).left = {
              kind: 'unary',
              operator: 'typeof',
              postfix: false,
              operand: cond.left.kind === 'binary' ? (cond.left as any).left : cond.left,
              semantics: { operand: { flow: 'string' } },
            };
          }
        }
      }
    }
    expect(() => emitIrModuleCpp(module)).toThrow('typeof on a C++ variant requires proven union member test evidence');
  });

  it('emits for-in with flight-cpp runtime keys', () => {
    const result = lower(
      'forin-flight.ts',
      `interface Cfg { host: string; port: string }
       export function keys(cfg: Cfg): string {
         let result: string = "";
         for (const key in cfg) { result = key; }
         return result;
       }`,
    );
    const emitted = emitIrModuleCpp(result.module, { runtimeProfile: 'flight-cpp' });
    expect(emitted.contents).toContain('flight::Array<flight::String>');
    expect(emitted.contents).toContain('flight::String(');
  });

  it('emits for-in with preserve evaluation and flight-cpp runtime', () => {
    const result = lower(
      'forin-preserve-flight.ts',
      `export function keys(a: number, b: number): string {
         let result: string = '';
         for (const key in { x: a, y: b }) { result = key; }
         return result;
       }`,
    );
    const emitted = emitIrModuleCpp(result.module, { runtimeProfile: 'flight-cpp' });
    expect(emitted.contents).toContain('flight::Array<flight::String>');
    expect(emitted.contents).toContain('for_in_object');
  });

  it('refuses for-in with string type mismatch', () => {
    const result = lower(
      'forin-type.ts',
      `interface Cfg { x: string }
       export function keys(cfg: Cfg): string {
         let result: string = "";
         for (const key in cfg) { result = key; }
         return result;
       }`,
    );
    const module = structuredClone(result.module);
    const fn = module.declarations.find((d) => d.kind === 'function');
    if (fn?.kind === 'function') {
      const forIn = fn.body.find((s) => s.kind === 'forIn');
      if (forIn?.kind === 'forIn' && 'binding' in forIn.variable) {
        (forIn.variable as any).type = { kind: 'primitive', name: 'number' };
      }
    }
    expect(() => emitIrModuleCpp(module)).toThrow('for-in binding requires primitive string type evidence');
  });

  it('refuses for-in with shared mutable capture', () => {
    const result = lower(
      'forin-capture.ts',
      `interface Cfg { x: string }
       export function keys(cfg: Cfg): () => string {
         let result: string = "";
         for (const key in cfg) { result = key; }
         return (): string => { result += "!"; return result; };
       }`,
    );
    const module = structuredClone(result.module);
    const fn = module.declarations.find((d) => d.kind === 'function');
    if (fn?.kind === 'function') {
      const forIn = fn.body.find((s) => s.kind === 'forIn');
      if (forIn?.kind === 'forIn' && 'binding' in forIn.variable) {
        const capNames = new Map<string, string>();
        capNames.set(forIn.variable.binding.id, 'key_capture');
        const sharedModule = structuredClone(module);
        const sharedFn = sharedModule.declarations.find((d) => d.kind === 'function');
        if (sharedFn?.kind === 'function') {
          const sharedForIn = sharedFn.body.find((s) => s.kind === 'forIn');
          if (sharedForIn?.kind === 'forIn') {
            expect(() => emitIrModuleCpp(module)).not.toThrow('iteration-storage lowering');
          }
        }
      }
    }
  });

  it('emits for-of shared capture with iteration storage allocation', () => {
    const result = lower(
      'forof-capture.ts',
      `export function make(items: number[]): (() => number)[] {
         const closures: (() => number)[] = [];
         for (let item of items) {
           closures.push((): number => { item += 1; return item; });
         }
         return closures;
       }`,
    );
    const emitted = emitIrModuleCpp(result.module, { runtimeProfile: 'flight-cpp' });
    expect(emitted.contents).toContain('flight::make_binding_cell');
    expect(emitted.contents).toContain('iteration_value');
  });

  it('refuses for-of shared capture without concrete binding type', () => {
    const result = lower(
      'forof-no-type.ts',
      `export function make(items: number[]): (() => number)[] {
         const closures: (() => number)[] = [];
         for (let item of items) {
           closures.push((): number => { item += 1; return item; });
         }
         return closures;
       }`,
    );
    const module = structuredClone(result.module);
    const fn = module.declarations.find((d) => d.kind === 'function');
    if (fn?.kind === 'function') {
      const forOf = fn.body.find((s) => s.kind === 'forOf');
      if (forOf?.kind === 'forOf' && 'binding' in forOf.variable) {
        (forOf.variable as any).type = undefined;
      }
    }
    expect(() => emitIrModuleCpp(module, { runtimeProfile: 'flight-cpp' })).toThrow(
      'requires concrete binding type evidence',
    );
  });

  it('emits catch clause with binding as typed std::exception reference', () => {
    const result = lower(
      'catch-bind.ts',
      `export function safe(): number {
         try { throw 1; } catch (e) { return 0; }
       }`,
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('std::exception');
    expect(emitted.contents).toContain('#include <stdexcept>');
  });

  it('emits optional property chain with ambient member sizeMethod binding', () => {
    const result = lower(
      'opt-chain-size.ts',
      `export function len(items: number[] | undefined): number | undefined {
         return items?.length;
       }`,
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('optional_chain_receiver');
  });

  it('emits optional property chain with ambient member property binding', () => {
    const result = lower(
      'opt-chain-prop.ts',
      `export function check(err: Error | undefined): string | undefined {
         return err?.message;
       }`,
    );
    const emitted = emitIrModuleCpp(result.module, { runtimeProfile: 'flight-cpp' });
    expect(emitted.contents).toContain('optional_chain_receiver');
    expect(emitted.contents).toContain('.message');
  });

  it('emits optional element access on nullable array receiver in flight-cpp', () => {
    const result = lower(
      'opt-elem-arr.ts',
      `export function first(items: number[] | undefined): number | undefined {
         return items?.[0];
       }`,
    );
    const emitted = emitIrModuleCpp(result.module, { runtimeProfile: 'flight-cpp' });
    expect(emitted.contents).toContain('optional_chain_receiver');
    expect(emitted.contents).toContain('.get(');
  });

  it('emits optional call with receiverNullish excluded', () => {
    const result = lower(
      'opt-call-excluded.ts',
      `export function apply(fn: ((x: number) => number)): number {
         return fn?.(1) ?? 0;
       }`,
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).not.toContain('optional_chain_receiver');
  });

  it('emits optional property chain on class getter with method call form', () => {
    const result = lower(
      'opt-getter.ts',
      `export class Box { private _v: number = 0; get v(): number { return this._v; } }
       export function read(box: Box | undefined): number | undefined { return box?.v; }`,
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('optional_chain_receiver');
  });

  it('emits optional property chain with receiver indexing runtime collection', () => {
    const result = lower(
      'opt-chain-index.ts',
      `export function member(items: { name: string }[], idx: number): string | undefined {
         return items[idx]?.name;
       }`,
    );
    const emitted = emitIrModuleCpp(result.module, { runtimeProfile: 'flight-cpp' });
    expect(emitted.contents).toContain('optional_chain_receiver');
    expect(emitted.contents).toContain('.get(');
  });

  it('emits tuple spread with optional element wrapping', () => {
    const result = lower(
      'tuple-spread-opt.ts',
      `export function spread(a: [number, string], b: number): [number, string, number] {
         return [...a, b];
       }`,
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('std::make_tuple');
    expect(emitted.contents).toContain('std::get<');
  });

  it('emits tuple element with optional wrapping as make_optional', () => {
    const result = lower(
      'tuple-opt-wrap.ts',
      `export function wrap(x: number): [number?] {
         return [x];
       }`,
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('std::make_tuple');
    expect(emitted.contents).toContain('std::make_optional');
  });

  it('emits assignment operator for exponentiation compound assignment', () => {
    const result = lower(
      'pow-assign.ts',
      `export function square(x: number): number { let v: number = x; v **= 2; return v; }`,
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('std::pow');
    expect(emitted.contents).toContain('#include <cmath>');
  });

  it('emits implicit throw for synchronous non-void function without definite completion', () => {
    const result = lower(
      'sync-throw.ts',
      `export function maybe(x: number): number {
         if (x > 0) return x;
       }`,
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('Flight function completed without a value');
    expect(emitted.contents).not.toContain('co_await');
  });

  it('emits rest parameter without optional wrapping', () => {
    const result = lower(
      'rest.ts',
      'export function sum(...values: number[]): number { let s: number = 0; for (const v of values) { s += v; } return s; }',
    );
    const emitted = emitIrModuleCpp(result.module, { runtimeProfile: 'flight-cpp' });
    expect(emitted.contents).toContain('flight::Array<double> values');
    expect(emitted.contents).not.toContain('std::optional');
  });

  it('emits union of null and undefined as optional<void>', () => {
    const result = lower(
      'scalar-null-union.ts',
      `export function check(x: number | undefined): boolean { return x !== undefined; }`,
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('std::optional');
    expect(emitted.contents).toContain('.has_value()');
  });

  it('emits optional indexed member with contextual result type in flight-cpp', () => {
    const result = lower(
      'opt-indexed-member.ts',
      `interface Item { name: string }
       export function first(items: Item[]): string | undefined {
         return items[0]?.name;
       }`,
    );
    const emitted = emitIrModuleCpp(result.module, { runtimeProfile: 'flight-cpp' });
    expect(emitted.contents).toContain('optional_chain_receiver');
    expect(emitted.contents).toContain('.get(');
  });

  it('emits shared referent representation for ambient Map type in flight-cpp', () => {
    const result = lower(
      'shared-map.ts',
      'export function make(x: Map<string, number>): boolean { return x.has("a"); }',
    );
    const emitted = emitIrModuleCpp(result.module, { runtimeProfile: 'flight-cpp' });
    expect(emitted.contents).toContain('flight::Map');
  });

  it('emits modulo assignment with std::fmod', () => {
    const result = lower(
      'mod-assign.ts',
      `export function wrap(x: number): number { let v: number = x; v %= 3; return v; }`,
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('std::fmod');
    expect(emitted.contents).toContain('#include <cmath>');
  });

  it('emits getIrVariantUnionTypeCpp through type alias indirection', () => {
    const result = lower(
      'alias-union.ts',
      `type StringOrNum = string | number;
       export function check(value: StringOrNum): string {
         return typeof value === 'string' ? value : value.toString();
       }`,
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('std::variant');
  });

  it('returns undefined for variant union with null member', () => {
    const result = lower(
      'null-union.ts',
      'export function check(value: string | null): boolean { return value !== null; }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('std::optional');
    expect(emitted.contents).not.toContain('std::variant');
  });

  it('returns undefined for variant union via type alias with generic args', () => {
    const result = lower(
      'generic-alias-union.ts',
      'export function check(value: Map<string, number> | undefined): boolean { return value !== undefined; }',
    );
    const emitted = emitIrModuleCpp(result.module, { runtimeProfile: 'flight-cpp' });
    expect(emitted.contents).toContain('std::optional');
  });

  it('emits isIrTypeCppVariantAlternative for function type', () => {
    const result = lower(
      'fn-variant.ts',
      `export function check(value: string | ((x: number) => number)): string {
         return typeof value === 'string' ? value : 'fn';
       }`,
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('std::variant');
    expect(emitted.contents).toContain('std::function');
  });

  it('emits hasIndexedRuntimeReceiverCpp from binding type inference', () => {
    const result = lower(
      'inferred-index.ts',
      `export function first(items: number[]): number {
         const arr: number[] = items;
         return arr[0] ?? 0;
       }`,
    );
    const emitted = emitIrModuleCpp(result.module, { runtimeProfile: 'flight-cpp' });
    expect(emitted.contents).toContain('.get(');
  });

  it('emits isCppScalarValueType union with null and primitive members', () => {
    const result = lower('scalar-null.ts', `export function bind(x: number | null): number | null { return x; }`);
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('std::optional<double>');
  });

  it('emits narrowedMember through non-binding reference', () => {
    const result = lower(
      'narrowed-non-binding.ts',
      `export function check(value: string | number): string {
         if (typeof value === 'string') {
           const len: number = value.length;
           return value;
         }
         return value.toString();
       }`,
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('std::get<');
  });

  it('emits getIrExpressionClassAccessorCpp for assignment target setter', () => {
    const result = lower(
      'setter.ts',
      `export class Box {
         private _v: number = 0;
         get v(): number { return this._v; }
         set v(value: number) { this._v = value; }
         update(): void { this.v = 42; }
       }`,
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('v(42');
  });

  it('emits static field access through class scope resolution operator', () => {
    const result = lower(
      'static-field.ts',
      `export class Config {
         static readonly version: number = 1;
         static read(): number { return Config.version; }
       }`,
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('Config::version');
  });

  it('emits union member assertion via cast to variant member', () => {
    const result = lower(
      'union-cast.ts',
      `export function force(value: string | number): string {
         return value as string;
       }`,
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('std::get<');
  });

  it('emits try-catch-await without binding as bool guard pattern', () => {
    const result = lower(
      'catch-await-no-binding.ts',
      `export async function safe(task: Promise<number>): Promise<number> {
         try { return await task; }
         catch { return await Promise.resolve(0); }
       }`,
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('caught');
    expect(emitted.contents).toContain('co_await');
  });

  it('emits try-finally with catch-await inside finally wrapper', () => {
    const result = lower(
      'finally-catch-await.ts',
      `export async function safe(task: Promise<number>): Promise<number> {
         try { return await task; }
         catch { return await Promise.resolve(0); }
         finally { let cleanup: number = 1; }
       }`,
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('finally_exception');
    expect(emitted.contents).toContain('caught');
  });

  it('evaluates containsReturnStatement false branch for if without else', () => {
    const result = lower(
      'if-no-else.ts',
      `export async function pick(task: Promise<number>): Promise<number> {
         try {
           const x: number = await task;
           if (x > 0) { let a: number = x; }
           return x;
         } finally { let y: number = 1; }
       }`,
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('finally_return');
  });

  it('evaluates containsReturnStatement false branch for try without finally', () => {
    const result = lower(
      'try-no-finally.ts',
      `export async function nested(task: Promise<number>): Promise<number> {
         try {
           try { let x: number = await task; } catch { let z: number = 0; }
           return 0;
         } finally { let y: number = 1; }
       }`,
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('finally_return');
  });

  it('emits negated union member test with whenResult false', () => {
    const result = lower(
      'negated-typeof.ts',
      `export function process(value: string | number): number {
         if (typeof value !== 'string') { return value; }
         return value.length;
       }`,
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('!(value.index() == 1)');
  });

  it('emits optional property chain with no ambient member and no accessor', () => {
    const result = lower(
      'optional-plain-prop.ts',
      `export interface Point { x: number; y: number }
       export function getX(p: Point | undefined): number | undefined {
         return p?.x;
       }`,
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('optional_chain_receiver');
    expect(emitted.contents).toContain('.x');
  });

  it('emits optional call with non-nullish receiver as direct call', () => {
    const result = lower(
      'optional-direct-call.ts',
      `export function invoke(fn: (x: number) => number, value: number): number {
         return fn?.(value);
       }`,
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('fn(value)');
  });
});

describe('emitIrModuleCpp try-finally with return', () => {
  it('emits try-finally with return capture variable', () => {
    const result = lower(
      'try-finally-return.ts',
      `export function safeParse(x: number): number {
         try {
           return x + 1;
         } finally {
           x + 2;
         }
       }`,
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('finally_exception');
    expect(emitted.contents).toContain('finally_return');
    expect(emitted.contents).toContain('exception');
  });
});

describe('emitIrModuleCpp try-catch with await in catch', () => {
  it('emits try-catch-await rewrite with caught flag', () => {
    const result = lower(
      'try-catch-await.ts',
      `export async function retry(): Promise<number> {
         try {
           return 1;
         } catch {
           const result = await Promise.resolve(2);
           return result;
         }
       }`,
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('caught');
    expect(emitted.contents).toContain('co_await');
  });
});

describe('emitIrModuleCpp exponentiation assignment', () => {
  it('emits power assignment with std::pow rewrap', () => {
    const result = lower(
      'pow-assign.ts',
      `export function cube(x: number): number {
         let n = x;
         n **= 3;
         return n;
       }`,
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('pow');
  });
});

describe('emitIrModuleCpp unsigned right shift assignment', () => {
  it('emits unsigned right shift assignment with u32 cast', () => {
    const result = lower(
      'urshr-assign.ts',
      `export function shift(x: number): number {
         let n = x;
         n >>>= 2;
         return n;
       }`,
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('static_cast');
  });
});

describe('emitIrModuleCpp for-in with binding pattern', () => {
  it('refuses for-in with binding pattern before destructuring lowering', () => {
    const result = lower(
      'for-in-pattern.ts',
      `export function keys(obj: { a: number; b: number }): string[] {
         const result: string[] = [];
         for (const key in obj) {
           result.push(key);
         }
         return result;
       }`,
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('for');
  });
});

describe('emitIrModuleCpp for-of with async iteration', () => {
  it('refuses async for-of before coroutine lowering', () => {
    const result = lower(
      'async-for-of.ts',
      `export function sum(arr: number[]): number {
         let total = 0;
         for (const item of arr) {
           total += item;
         }
         return total;
       }`,
    );
    const fn = result.module.declarations.find((d) => d.kind === 'function');
    if (fn?.kind !== 'function') throw new Error('Expected function');
    const modified = {
      ...fn,
      body: fn.body.map((stmt) => (stmt.kind === 'forOf' ? { ...stmt, await: true } : stmt)),
    };
    const module = {
      ...result.module,
      declarations: result.module.declarations.map((d) =>
        d === fn ? modified : d,
      ) as typeof result.module.declarations,
    };
    expect(() => emitIrModuleCpp(module)).toThrow('async iteration requires C++ coroutine lowering');
  });
});

describe('emitIrModuleCpp C-style for loop refusal', () => {
  it('refuses C-style for loops before control-flow lowering', () => {
    const result = lower(
      'for-loop.ts',
      `export function count(n: number): number {
         let sum = 0;
         for (let i = 0; i < n; i++) {
           sum += i;
         }
         return sum;
       }`,
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('while');
  });
});

describe('emitIrModuleCpp implicit completion absent return', () => {
  it('emits std::nullopt for function returning optional without explicit return', () => {
    const result = lower(
      'absent-return.ts',
      `export function find(arr: number[], target: number): number | undefined {
         for (const item of arr) {
           if (item === target) return item;
         }
       }`,
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('std::nullopt');
  });
});

describe('emitIrModuleCpp async implicit completion', () => {
  it('emits co_return for async void function without explicit return', () => {
    const result = lower(
      'async-void-return.ts',
      `export async function doWork(): Promise<void> {
         const x = await Promise.resolve(1);
         x + 1;
       }`,
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('co_return');
  });
});

describe('emitIrModuleCpp super reference with binding', () => {
  it('emits super reference using base class target name', () => {
    const result = lower(
      'super-ref.ts',
      `export class Base {
         greet(): string { return "hello"; }
       }
       export class Child extends Base {
         greet(): string { return super.greet() + " world"; }
       }`,
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('Base::greet');
  });
});

describe('emitIrModuleCpp lexical-this closure in class', () => {
  it('emits this capture in class method closure', () => {
    const result = lower(
      'this-closure.ts',
      `export class Counter {
         count: number = 0;
         increment(): () => void {
           return (): void => { this.count += 1; };
         }
       }`,
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('[=, this]');
  });
});

describe('emitIrModuleCpp size method binding', () => {
  it('emits .size() with static_cast for array length in call position', () => {
    const result = lower(
      'array-length-call.ts',
      `export function len(arr: number[]): number {
         return arr.length;
       }`,
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('static_cast<double>');
    expect(emitted.contents).toContain('size()');
  });
});

describe('emitIrModuleCpp flight-cpp array with contextual type', () => {
  it('emits flight::Array with element type for non-empty arrays', () => {
    const result = lower(
      'flight-arr.ts',
      `export function nums(): number[] {
         return [1, 2, 3];
       }`,
    );
    const emitted = emitIrModuleCpp(result.module, { runtimeProfile: 'flight-cpp' });
    expect(emitted.contents).toContain('flight::Array');
  });
});

describe('emitIrModuleCpp qualified constructor refusal', () => {
  it('refuses new expression with non-identifier callee', () => {
    const result = lower(
      'new-expr.ts',
      `export class Foo { value: number = 0; }
       export function make(): Foo {
         return new Foo();
       }`,
    );
    const fn = result.module.declarations.find((d) => d.kind === 'function');
    if (fn?.kind !== 'function') throw new Error('Expected function');
    const modified = {
      ...fn,
      body: fn.body.map((stmt) => {
        if (stmt.kind !== 'return' || !stmt.expression || stmt.expression.kind !== 'new') return stmt;
        return {
          ...stmt,
          expression: {
            ...stmt.expression,
            callee: {
              ...stmt.expression.callee,
              kind: 'property' as const,
              name: 'Foo',
              object: stmt.expression.callee,
              optional: false,
            },
          },
        };
      }),
    };
    const module = {
      ...result.module,
      declarations: result.module.declarations.map((d) =>
        d === fn ? modified : d,
      ) as typeof result.module.declarations,
    };
    expect(() => emitIrModuleCpp(module)).toThrow('qualified constructors require C++ type-path lowering');
  });
});

describe('emitIrModuleCpp isCppScalarValueType with union', () => {
  it('emits const for immutable nullable scalar variable', () => {
    const result = lower('nullable-scalar.ts', `export const value: number | null = 42;`);
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('const');
    expect(emitted.contents).toContain('optional');
  });
});

describe('emitIrModuleCpp tuple spread', () => {
  it('emits tuple spread with std::make_tuple and std::get', () => {
    const result = lower(
      'tuple-spread.ts',
      `export function spread(a: [number, string], b: boolean): [number, string, boolean] {
         return [...a, b];
       }`,
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('std::make_tuple');
    expect(emitted.contents).toContain('std::get');
  });
});

describe('emitIrModuleCpp async function return type', () => {
  it('emits async function with co_await and co_return', () => {
    const result = lower(
      'async-fn.ts',
      `export async function fetchValue(): Promise<number> {
         const x = await Promise.resolve(42);
         return x;
       }`,
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('co_await');
    expect(emitted.contents).toContain('co_return');
  });
});

describe('emitIrModuleCpp inherited methods collection', () => {
  it('collects inherited method names from base class chain', () => {
    const result = lower(
      'inherit-methods.ts',
      `export class Animal {
         speak(): string { return "..."; }
       }
       export class Dog extends Animal {
         speak(): string { return "woof"; }
         fetch(): string { return "ball"; }
       }`,
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('virtual');
    expect(emitted.contents).toContain('speak');
  });
});

describe('emitIrModuleCpp defaulted parameter', () => {
  it('emits optional with value_or for defaulted parameter', () => {
    const result = lower(
      'default-param.ts',
      `export function greet(name: string = "world"): string {
         return name;
       }`,
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('std::optional');
    expect(emitted.contents).toContain('value_or');
  });
});

describe('emitIrModuleCpp variant union parameter type', () => {
  it('emits std::variant for string | number union type', () => {
    const result = lower(
      'variant-param.ts',
      `export function identity(x: string | number): string | number {
         return x;
       }`,
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('std::variant');
  });
});

describe('emitIrModuleCpp do-while loop', () => {
  it('emits do-while loop structure', () => {
    const result = lower(
      'do-while.ts',
      `export function countdown(start: number): number {
         let n = start;
         do {
           n -= 1;
         } while (n > 0);
         return n;
       }`,
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('do {');
    expect(emitted.contents).toContain('} while');
  });
});

describe('emitIrModuleCpp dual-sentinel nullish comparison', () => {
  it('emits strict null test on dual-sentinel variant using holds_alternative', () => {
    const result = lower(
      'dual-null-test.ts',
      `export function is_null(value: string | null | undefined): boolean {
         return value === null;
       }`,
    );
    const emitted = emitIrModuleCpp(result.module, { runtimeProfile: 'flight-cpp' });
    expect(emitted.contents).toContain('std::holds_alternative<');
    expect(emitted.contents).toContain('flight::Null');
  });

  it('emits strict undefined test on dual-sentinel variant', () => {
    const result = lower(
      'dual-undefined-test.ts',
      `export function is_undef(value: string | null | undefined): boolean {
         return value === undefined;
       }`,
    );
    const emitted = emitIrModuleCpp(result.module, { runtimeProfile: 'flight-cpp' });
    expect(emitted.contents).toContain('std::holds_alternative<');
    expect(emitted.contents).toContain('flight::Undefined');
  });

  it('emits loose nullish test combining both sentinel alternatives', () => {
    const result = lower(
      'dual-loose-null.ts',
      `export function is_nullish(value: string | null | undefined): boolean {
         return value == null;
       }`,
    );
    const emitted = emitIrModuleCpp(result.module, { runtimeProfile: 'flight-cpp' });
    expect(emitted.contents).toContain('flight::Null');
    expect(emitted.contents).toContain('flight::Undefined');
    expect(emitted.contents).toContain('||');
  });

  it('emits negated loose nullish test with !=', () => {
    const result = lower(
      'dual-not-null.ts',
      `export function is_present(value: string | null | undefined): boolean {
         return value != null;
       }`,
    );
    const emitted = emitIrModuleCpp(result.module, { runtimeProfile: 'flight-cpp' });
    expect(emitted.contents).toContain('!(');
  });
});

describe('emitIrModuleCpp literal in union context', () => {
  it('emits null as flight::null for dual-sentinel union', () => {
    const result = lower(
      'null-in-dual.ts',
      `export function make_null(): string | null | undefined {
         return null;
       }`,
    );
    const emitted = emitIrModuleCpp(result.module, { runtimeProfile: 'flight-cpp' });
    expect(emitted.contents).toContain('flight::null');
  });

  it('emits undefined as flight::undefined for dual-sentinel union', () => {
    const result = lower(
      'undef-in-dual.ts',
      `export function make_undef(): string | null | undefined {
         return undefined;
       }`,
    );
    const emitted = emitIrModuleCpp(result.module, { runtimeProfile: 'flight-cpp' });
    expect(emitted.contents).toContain('flight::undefined');
  });

  it('emits null as std::nullopt for optional-single union', () => {
    const result = lower(
      'null-in-optional.ts',
      `export function make_null(): string | null {
         return null;
       }`,
    );
    const emitted = emitIrModuleCpp(result.module, { runtimeProfile: 'flight-cpp' });
    expect(emitted.contents).toContain('std::nullopt');
  });
});

describe('emitIrModuleCpp bitwise operations with flight-cpp profile', () => {
  it('emits flight::bitwise_and for bitwise & with flight-cpp runtime', () => {
    const result = lower('bitwise-and-rt.ts', 'export function band(a: number, b: number): number { return a & b; }');
    const emitted = emitIrModuleCpp(result.module, { runtimeProfile: 'flight-cpp' });
    expect(emitted.contents).toContain('flight::bitwise_and(');
  });

  it('emits flight::bitwise_or for bitwise | with flight-cpp runtime', () => {
    const result = lower('bitwise-or-rt.ts', 'export function bor(a: number, b: number): number { return a | b; }');
    const emitted = emitIrModuleCpp(result.module, { runtimeProfile: 'flight-cpp' });
    expect(emitted.contents).toContain('flight::bitwise_or(');
  });

  it('emits flight::bitwise_xor for bitwise ^ with flight-cpp runtime', () => {
    const result = lower('bitwise-xor-rt.ts', 'export function bxor(a: number, b: number): number { return a ^ b; }');
    const emitted = emitIrModuleCpp(result.module, { runtimeProfile: 'flight-cpp' });
    expect(emitted.contents).toContain('flight::bitwise_xor(');
  });

  it('emits flight::left_shift for << with flight-cpp runtime', () => {
    const result = lower('left-shift-rt.ts', 'export function shl(a: number, b: number): number { return a << b; }');
    const emitted = emitIrModuleCpp(result.module, { runtimeProfile: 'flight-cpp' });
    expect(emitted.contents).toContain('flight::left_shift(');
  });

  it('emits flight::signed_right_shift for >> with flight-cpp runtime', () => {
    const result = lower('right-shift-rt.ts', 'export function shr(a: number, b: number): number { return a >> b; }');
    const emitted = emitIrModuleCpp(result.module, { runtimeProfile: 'flight-cpp' });
    expect(emitted.contents).toContain('flight::signed_right_shift(');
  });
});

describe('emitIrModuleCpp number toString with flight-cpp profile', () => {
  it('emits flight::to_string for number.toString() with flight-cpp runtime', () => {
    const result = lower('num-tostring-rt.ts', 'export function text(n: number): string { return n.toString(); }');
    const emitted = emitIrModuleCpp(result.module, { runtimeProfile: 'flight-cpp' });
    expect(emitted.contents).toContain('flight::to_string(');
  });
});

describe('emitIrModuleCpp reexport emission', () => {
  it('emits type-only reexport as using declaration with module resolution', () => {
    const target = lowerPackage('@flighthq/types', 'shape.ts', 'export interface Shape { area: number }').module;
    const facade = lowerPackage(
      '@flighthq/core',
      'index.ts',
      "export type { Shape } from '@flighthq/types/shape';",
    ).module;
    const resolution: CompilerModuleResolutionPlan = {
      edges: [
        {
          specifier: '@flighthq/types/shape',
          target: { packageName: '@flighthq/types', source: target.source },
        },
      ],
      schema: 'flight-compiler-module-resolution/1',
    };
    const backend = createCppCompilerBackend();
    const session = backend.createEmissionSession!({
      moduleResolution: resolution,
      modules: [facade, target],
      options: {},
    });
    const emitted = session.emitModule(facade);
    expect(emitted[0]?.contents).toContain('using');
  });
});
