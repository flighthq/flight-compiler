import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { lowerTypeScriptSource, lowerTypeScriptSources } from '../../compiler-semantic/src/index.js';
import type {
  CompilerCppReferenceRepresentationPlan,
  CompilerModuleResolutionPlan,
  IrDeclaration,
  IrModule,
  IrType,
} from '../../compiler-types/src/index.js';
import { createCppCompilerBackend } from './cppCompilerBackend.js';
import {
  createIrTypeReferenceRepresentationPlanCpp,
  createIrTypeReferenceRepresentationPlannerCpp,
} from './cppReferenceRepresentationPlan.js';

const numberType = { kind: 'primitive', name: 'number' } as const satisfies IrType;
const objectType = {
  kind: 'object',
  properties: [{ name: 'value', optional: false, readonly: false, type: numberType }],
} as const satisfies IrType;

describe('C++ reference planner object shapes', () => {
  it('resolves named aliases and object utility shapes without changing their neutral types', () => {
    const module = lower(
      'model.ts',
      'export interface Model { value: number; label?: string } export type Alias = Model; export type Maybe<Value> = Value | null;',
    );
    const alias = declarationType(module, 'Alias');
    const model = declarationType(module, 'Model');
    const resolver = createIrTypeReferenceRepresentationPlannerCpp([module]);

    expect(resolver.resolveAlias(alias, module)).toEqual(model);
    expect(
      resolver.resolveAlias(
        { ...declarationType(module, 'Maybe'), typeArguments: [{ kind: 'primitive', name: 'number' }] },
        module,
      ),
    ).toEqual({
      kind: 'union',
      types: [{ kind: 'primitive', name: 'number' }, { kind: 'null' }],
    });
    expect(resolver.resolveObjectShape(ambientType('Partial', [model]), module)).toEqual([
      { name: 'value', optional: true, readonly: false, type: numberType },
      { name: 'label', optional: true, readonly: false, type: { kind: 'primitive', name: 'string' } },
    ]);
  });

  it('projects nested utilities through aliases and inherited interfaces', () => {
    const module = lower(
      'inherited-model.ts',
      'interface Base { readonly id: number; } interface Model extends Base { value?: string; } export type Alias = Model;',
    );
    const alias = declarationType(module, 'Alias');
    const resolver = createIrTypeReferenceRepresentationPlannerCpp([module]);

    expect(resolver.resolveObjectShape(ambientType('Readonly', [ambientType('Partial', [alias])]), module)).toEqual([
      { name: 'id', optional: true, readonly: true, type: numberType },
      {
        name: 'value',
        optional: true,
        readonly: true,
        type: { kind: 'primitive', name: 'string' },
      },
    ]);
    expect(resolver.resolveObjectShape(ambientType('Required', [ambientType('Partial', [alias])]), module)).toEqual([
      { name: 'id', optional: false, readonly: true, type: numberType },
      {
        name: 'value',
        optional: false,
        readonly: false,
        type: { kind: 'primitive', name: 'string' },
      },
    ]);
  });

  it('rejects unresolved, conflicting, behavioral, and malformed object shapes', () => {
    const module = lower(
      'object-shape-refusals.ts',
      `
        interface Left { value: number; }
        interface Right { value: string; }
        interface Conflict extends Left, Right {}
        class Parent { base = 1; }
        class Data extends Parent { value = 1; static kind = 1; private hidden = 1; }
        class Behavior { value = 1; run(): void {} }
        type Cycle = Cycle;
      `,
    );
    const unresolved = lower(
      'unresolved-shape.ts',
      "import type { Missing } from '@missing'; export type Alias = Missing;",
    );
    const resolver = createIrTypeReferenceRepresentationPlannerCpp([module]);

    expect(resolver.resolveObjectShape(objectType, module)).toEqual(objectType.properties);
    expect(resolver.resolveObjectShape(numberType, module)).toBeUndefined();
    expect(resolver.resolveObjectShape(ambientType('Partial'), module)).toBeUndefined();
    expect(resolver.resolveObjectShape(ambientType('Pick', [objectType]), module)).toBeUndefined();
    expect(resolver.resolveObjectShape(declarationType(module, 'Conflict'), module)).toBeUndefined();
    expect(resolver.resolveObjectShape(declarationType(module, 'Data'), module)).toEqual([
      { name: 'base', optional: false, readonly: false, type: numberType },
      { name: 'value', optional: false, readonly: false, type: numberType },
    ]);
    expect(resolver.resolveObjectShape(declarationType(module, 'Behavior'), module)).toBeUndefined();
    expect(resolver.resolveObjectShape(declarationType(module, 'Cycle'), module)).toBeUndefined();
    expect(
      createIrTypeReferenceRepresentationPlannerCpp([unresolved]).resolveObjectShape(
        declarationType(unresolved, 'Alias'),
        unresolved,
      ),
    ).toBeUndefined();
    expect(() => resolver.resolveObjectShape(objectType, unresolved)).toThrow(
      'C++ object-shape subject must belong to the explicit module set',
    );
  });
});

describe('createIrTypeReferenceRepresentationPlanCpp', () => {
  it('separates inline values, reference handles, and their raw object storage', () => {
    const module = lower(
      'model.ts',
      'export class Model { value = 1; } export interface Shape { value: number } export type RecordShape = { value: number }; export enum Mode { Ready }',
    );

    expect(createIrTypeReferenceRepresentationPlanCpp(numberType, module)).toEqual({
      category: 'value',
      identity: { identity: 'value', reason: 'intrinsic-value', schema: 'flight-compiler-type-value-identity/1' },
      identityDomain: 'none',
      kind: 'represented',
      schema: 'flight-compiler-cpp-reference-representation/1',
      storageRepresentation: 'inlineValue',
      valueRepresentation: 'inlineValue',
    });
    expect(planDeclaration(module, 'Model')).toMatchObject({
      category: 'class',
      identityDomain: 'object',
      kind: 'represented',
      storageRepresentation: 'rawNamedObject',
      valueRepresentation: 'flightReference',
    });
    expect(planDeclaration(module, 'Shape')).toMatchObject({
      category: 'interface',
      identityDomain: 'object',
      kind: 'represented',
      storageRepresentation: 'rawNamedObject',
      valueRepresentation: 'flightReference',
    });
    expect(planDeclaration(module, 'RecordShape')).toMatchObject({
      category: 'objectAlias',
      identityDomain: 'object',
      kind: 'represented',
      storageRepresentation: 'rawNamedObject',
      valueRepresentation: 'flightReference',
    });
    expect(createIrTypeReferenceRepresentationPlanCpp(objectType, module)).toMatchObject({
      category: 'anonymousObject',
      identityDomain: 'object',
      kind: 'represented',
      storageRepresentation: 'rawAnonymousObject',
      valueRepresentation: 'flightReference',
    });
    expect(planDeclaration(module, 'Mode')).toMatchObject({
      category: 'value',
      identityDomain: 'none',
      kind: 'represented',
      storageRepresentation: 'inlineValue',
      valueRepresentation: 'inlineValue',
    });
  });

  it('keeps runtime handles and inline aggregate aliases direct instead of wrapping them in flight references', () => {
    const module = lower(
      'aliases.ts',
      'export type Values = number[]; export type Table = Map<string, number>; export type View = Uint8Array; export type Callback = () => void; export type Pair = [number, string];',
    );
    const cases = [
      [{ element: numberType, kind: 'array', readonly: false }, 'array', 'object'],
      [ambientType('Array', [numberType]), 'array', 'object'],
      [ambientType('ReadonlyArray', [numberType]), 'array', 'object'],
      [ambientType('Map', [numberType, numberType]), 'map', 'object'],
      [ambientType('ReadonlyMap', [numberType, numberType]), 'map', 'object'],
      [ambientType('Set', [numberType]), 'set', 'object'],
      [ambientType('ReadonlySet', [numberType]), 'set', 'object'],
      [ambientType('Promise', [numberType]), 'task', 'object'],
      [ambientType('PromiseLike', [numberType]), 'task', 'object'],
      [ambientType('Date'), 'date', 'object'],
      [ambientType('WeakMap', [objectType, numberType]), 'weakMap', 'object'],
      [ambientType('Uint8Array'), 'typedArray', 'view'],
    ] as const satisfies readonly (readonly [IrType, string, string])[];

    for (const [type, category, identityDomain] of cases) {
      expect(createIrTypeReferenceRepresentationPlanCpp(type, module)).toMatchObject({
        category,
        identityDomain,
        kind: 'represented',
        storageRepresentation: 'runtimeManaged',
        valueRepresentation: 'runtimeReference',
      });
    }
    expect(planDeclaration(module, 'Values')).toMatchObject({
      category: 'array',
      valueRepresentation: 'runtimeReference',
    });
    expect(planDeclaration(module, 'Table')).toMatchObject({
      category: 'map',
      valueRepresentation: 'runtimeReference',
    });
    expect(planDeclaration(module, 'View')).toMatchObject({
      category: 'typedArray',
      identityDomain: 'view',
      valueRepresentation: 'runtimeReference',
    });
    expect(planDeclaration(module, 'Callback')).toMatchObject({
      category: 'value',
      kind: 'represented',
      storageRepresentation: 'inlineValue',
      valueRepresentation: 'inlineValue',
    });
    expect(planDeclaration(module, 'Pair')).toMatchObject({
      category: 'value',
      kind: 'represented',
      storageRepresentation: 'inlineValue',
      valueRepresentation: 'inlineValue',
    });
  });

  it('preserves reference representation through generic aliases and ambient object utilities', () => {
    const module = lower('generic.ts', 'export type Box<T> = { value: T };');
    const box = declarationType(module, 'Box');
    if (box.kind !== 'named') throw new TypeError('expected named type');
    const applied = { ...box, typeArguments: [numberType] } as const satisfies IrType;
    const utilities = [
      ambientType('Readonly', [objectType]),
      ambientType('Required', [objectType]),
      ambientType('Partial', [objectType]),
      ambientType('Pick', [objectType, { kind: 'literal', value: 'value' }]),
      ambientType('Omit', [objectType, { kind: 'literal', value: 'other' }]),
    ];

    expect(createIrTypeReferenceRepresentationPlanCpp(applied, module)).toMatchObject({
      category: 'objectAlias',
      kind: 'represented',
      storageRepresentation: 'rawNamedObject',
      valueRepresentation: 'flightReference',
    });
    for (const type of utilities) {
      expect(createIrTypeReferenceRepresentationPlanCpp(type, module)).toMatchObject({
        category: 'anonymousObject',
        kind: 'represented',
        storageRepresentation: 'rawAnonymousObject',
        valueRepresentation: 'flightReference',
      });
    }
  });

  it('uses a type parameter reference constraint as representation proof', () => {
    const module = lower(
      'constraint.ts',
      'export interface Entity {} export type WithoutRuntime<Type extends Entity> = Omit<Type, "runtime">;',
    );
    const alias = module.declarations.find(
      (declaration) => declaration.kind === 'typeAlias' && declaration.binding.name === 'WithoutRuntime',
    );
    if (alias?.kind !== 'typeAlias' || alias.type.kind !== 'named') throw new TypeError('expected projected alias');
    const parameter = alias.type.typeArguments[0];
    if (!parameter) throw new TypeError('expected projected type parameter');

    expect(createIrTypeReferenceRepresentationPlanCpp(parameter, module)).toMatchObject({
      category: 'interface',
      identity: { identity: 'reference', reason: 'declared-reference' },
      identityDomain: 'object',
      kind: 'represented',
      storageRepresentation: 'rawNamedObject',
      valueRepresentation: 'flightReference',
    });
    expect(createIrTypeReferenceRepresentationPlanCpp(alias.type, module)).toMatchObject({
      category: 'interface',
      kind: 'represented',
      valueRepresentation: 'flightReference',
    });
  });

  it('returns explicit refusals where reference identity does not yet select one safe C++ representation', () => {
    const module = lower(
      'refusals.ts',
      'export type Open<T extends object> = T; export interface Generic<T extends { value: number }> {}',
    );
    const unresolvedImport = lower(
      'missing.ts',
      "import type { Missing } from '@missing'; export type Alias = Missing;",
    );
    const referenceUnion = { kind: 'union', types: [objectType, ambientType('Map')] } as const satisfies IrType;
    const referenceIntersection = {
      kind: 'intersection',
      types: [objectType, ambientType('Readonly', [objectType])],
    } as const satisfies IrType;
    const functionType = {
      kind: 'function',
      parameters: [],
      returns: numberType,
      typeParameters: [],
    } as const satisfies IrType;
    const tupleType = {
      elements: [{ optional: false, rest: false, type: numberType }],
      kind: 'tuple',
      readonly: false,
    } as const satisfies IrType;
    const typeOfArray = { kind: 'typeOf', reference: { kind: 'ambient', name: 'Array' } } as const satisfies IrType;
    const generic = module.declarations.find(
      (declaration) => declaration.kind === 'interface' && declaration.binding.name === 'Generic',
    );
    if (generic?.kind !== 'interface') throw new TypeError('expected Generic interface');
    const constrainedParameter = {
      kind: 'named',
      reference: { binding: generic.typeParameters[0]!.binding, kind: 'binding', path: [] },
      typeArguments: [],
    } as const satisfies IrType;

    expect(createIrTypeReferenceRepresentationPlanCpp(referenceUnion, module)).toMatchObject({
      category: 'value',
      identityDomain: 'none',
      kind: 'represented',
      storageRepresentation: 'inlineValue',
      valueRepresentation: 'inlineValue',
    });
    expect(createIrTypeReferenceRepresentationPlanCpp(referenceIntersection, module)).toMatchObject({
      category: 'anonymousObject',
      kind: 'represented',
      valueRepresentation: 'flightReference',
    });
    expect(createIrTypeReferenceRepresentationPlanCpp(functionType, module)).toMatchObject({
      category: 'value',
      kind: 'represented',
      storageRepresentation: 'inlineValue',
      valueRepresentation: 'inlineValue',
    });
    expect(createIrTypeReferenceRepresentationPlanCpp(tupleType, module)).toMatchObject({
      category: 'array',
      kind: 'represented',
      storageRepresentation: 'runtimeManaged',
      valueRepresentation: 'runtimeReference',
    });
    expect(
      createIrTypeReferenceRepresentationPlanCpp(
        {
          elements: [
            { optional: false, rest: false, type: numberType },
            { optional: false, rest: false, type: { kind: 'primitive', name: 'string' } },
          ],
          kind: 'tuple',
          readonly: false,
        },
        module,
      ),
    ).toMatchObject({
      category: 'value',
      kind: 'represented',
      storageRepresentation: 'inlineValue',
      valueRepresentation: 'inlineValue',
    });
    expect(createIrTypeReferenceRepresentationPlanCpp(typeOfArray, module)).toMatchObject({
      kind: 'refused',
      reason: 'unsupportedReferenceForm',
    });
    expect(createIrTypeReferenceRepresentationPlanCpp(constrainedParameter, module)).toMatchObject({
      category: 'interface',
      kind: 'represented',
      valueRepresentation: 'flightReference',
    });
    for (const type of [ambientType('WeakSet'), ambientType('BigInt64Array')]) {
      expect(createIrTypeReferenceRepresentationPlanCpp(type, module)).toMatchObject({
        kind: 'refused',
        reason: 'unsupportedAmbientReference',
      });
    }
    expect(planDeclaration(unresolvedImport, 'Alias')).toEqual({
      identity: {
        identity: 'indeterminate',
        reason: 'unresolved-reference',
        schema: 'flight-compiler-type-value-identity/1',
      },
      kind: 'refused',
      reason: 'indeterminateIdentity',
      schema: 'flight-compiler-cpp-reference-representation/1',
    });
    const importBinding = unresolvedImport.imports[0]?.bindings[0]?.binding;
    if (!importBinding || importBinding.space !== 'type') throw new TypeError('expected type import binding');
    const directImportType = {
      kind: 'named',
      reference: { binding: importBinding, kind: 'binding', path: [] },
      typeArguments: [],
    } as const satisfies IrType;
    expect(createIrTypeReferenceRepresentationPlanCpp(directImportType, unresolvedImport)).toMatchObject({
      category: 'interface',
      identity: { identity: 'indeterminate', reason: 'unresolved-reference' },
      identityDomain: 'object',
      kind: 'represented',
      storageRepresentation: 'rawNamedObject',
      valueRepresentation: 'flightReference',
    });
    expect(planDeclaration(module, 'Open')).toMatchObject({
      identity: { identity: 'indeterminate', reason: 'invalid-type-application' },
      kind: 'refused',
      reason: 'indeterminateIdentity',
    });
  });
});

describe('createIrTypeReferenceRepresentationPlannerCpp', () => {
  it('resolves direct imported declarations through explicit module resolution independent of module order', () => {
    const model = lower(
      'model.ts',
      'export class Model { value = 1; } export type Shape = { value: number }; export type Values = number[]; export type Callback = (value: number) => void; export type Pair = [number, string];',
      '@flighthq/models',
    );
    const consumer = lower(
      'consumer.ts',
      "import type { Callback, Model, Pair, Shape, Values } from '@flighthq/models'; export type PublicCallback = Callback; export type PublicModel = Model; export type PublicPair = Pair; export type PublicShape = Shape; export type PublicValues = Values;",
      '@flighthq/consumer',
    );
    const resolution: CompilerModuleResolutionPlan = {
      edges: [
        {
          specifier: '@flighthq/models',
          target: { packageName: model.packageName, source: model.source },
        },
        {
          importer: { name: consumer.name, packageName: consumer.packageName, source: consumer.source },
          specifier: '@flighthq/models',
          target: { packageName: model.packageName, source: model.source },
        },
      ],
      schema: 'flight-compiler-module-resolution/1',
    };
    const forward = createIrTypeReferenceRepresentationPlannerCpp([model, consumer], resolution);
    const reverse = createIrTypeReferenceRepresentationPlannerCpp([consumer, model], resolution);

    for (const planner of [forward, reverse]) {
      expect(planner.plan(declarationType(consumer, 'PublicModel'), consumer)).toMatchObject({
        category: 'class',
        kind: 'represented',
        valueRepresentation: 'flightReference',
      });
      expect(planner.plan(declarationType(consumer, 'PublicShape'), consumer)).toMatchObject({
        category: 'objectAlias',
        kind: 'represented',
        storageRepresentation: 'rawNamedObject',
      });
      expect(planner.plan(declarationType(consumer, 'PublicValues'), consumer)).toMatchObject({
        category: 'array',
        kind: 'represented',
        valueRepresentation: 'runtimeReference',
      });
      expect(planner.plan(declarationType(consumer, 'PublicCallback'), consumer)).toMatchObject({
        category: 'value',
        kind: 'represented',
        valueRepresentation: 'inlineValue',
      });
      expect(planner.plan(declarationType(consumer, 'PublicPair'), consumer)).toMatchObject({
        category: 'value',
        kind: 'represented',
        valueRepresentation: 'inlineValue',
      });
    }
    expect(forward.plan(declarationType(consumer, 'PublicModel'), consumer)).toEqual(
      reverse.plan(declarationType(consumer, 'PublicModel'), consumer),
    );
    const publicValues = forward.resolveAlias(declarationType(consumer, 'PublicValues'), consumer);
    expect(publicValues).toMatchObject({
      kind: 'named',
      reference: { binding: { kind: 'import', name: 'Values' }, kind: 'binding' },
    });
    if (!publicValues) throw new TypeError('expected local alias target');
    expect(forward.resolveAlias(publicValues, consumer)).toMatchObject({ kind: 'array' });
    expect(forward.resolveModule('@flighthq/models', consumer)).toEqual(model);
  });

  it('preserves caller-owned generic and concrete identity through an imported identity alias', () => {
    const resolution: CompilerModuleResolutionPlan = {
      edges: [
        {
          importedNames: ['Adjustment', 'AdjustmentKind', 'EntityConstruction'],
          specifier: '@flighthq/types/contract',
          target: { packageName: '@flighthq/types', source: 'packages/types/src/Entity.ts' },
        },
        {
          importedNames: ['BrightnessContrastAdjustment'],
          specifier: '@flighthq/types/contract',
          target: { packageName: '@flighthq/types', source: 'packages/types/src/BrightnessContrastAdjustment.ts' },
        },
      ],
      schema: 'flight-compiler-module-resolution/1',
    };
    const results = lowerTypeScriptSources(
      [
        {
          packageName: '@flighthq/types',
          sourceFile: ts.createSourceFile(
            '/flight/packages/types/src/Entity.ts',
            `export interface Entity {}
             export interface Adjustment extends Entity { kind: string }
             export type AdjustmentKind = string;
             export type EntityConstruction<Type extends Entity> = {
               -readonly [Key in keyof Type]: Type[Key]
             };`,
            ts.ScriptTarget.Latest,
            true,
          ),
          upstreamDirectory: '/flight',
        },
        {
          packageName: '@flighthq/types',
          sourceFile: ts.createSourceFile(
            '/flight/packages/types/src/BrightnessContrastAdjustment.ts',
            `import type { Adjustment } from './Entity';
             export interface BrightnessContrastAdjustment extends Adjustment { brightness?: number }`,
            ts.ScriptTarget.Latest,
            true,
          ),
          upstreamDirectory: '/flight',
        },
        {
          packageName: '@flighthq/adjustments',
          sourceFile: ts.createSourceFile(
            '/flight/packages/adjustments/src/adjustment.ts',
            `import type {
               Adjustment,
               AdjustmentKind,
               BrightnessContrastAdjustment,
               EntityConstruction,
             } from '@flighthq/types/contract';
             interface LocalAdjustment extends Adjustment { local?: number }
             export function initializeAdjustment<T extends Adjustment>(
               out: EntityConstruction<T>,
               kind: AdjustmentKind,
             ): void {
               out.kind = kind;
             }
             export function initializeBrightnessContrastAdjustment(
               out: EntityConstruction<BrightnessContrastAdjustment>,
             ): void {
               out.brightness = 0;
             }
             export function initializeLocalAdjustment(out: EntityConstruction<LocalAdjustment>): void {
               out.local = 0;
             }`,
            ts.ScriptTarget.Latest,
            true,
          ),
          upstreamDirectory: '/flight',
        },
      ],
      resolution,
    );
    expect(results.flatMap((result) => result.diagnostics)).toEqual([]);
    const modules = results.map((result) => result.module);
    const adjustments = modules.find((module) => module.packageName === '@flighthq/adjustments');
    if (!adjustments) throw new TypeError('expected adjustments module');
    const declarations = new Map(
      adjustments.declarations.flatMap((candidate) =>
        candidate.kind === 'function' ? [[candidate.binding.name, candidate] as const] : [],
      ),
    );
    const initializers = [
      declarations.get('initializeAdjustment'),
      declarations.get('initializeBrightnessContrastAdjustment'),
      declarations.get('initializeLocalAdjustment'),
    ];
    if (initializers.some((declaration) => declaration?.kind !== 'function')) {
      throw new TypeError('expected adjustment initializers');
    }

    const planner = createIrTypeReferenceRepresentationPlannerCpp(modules, resolution);
    const constructionTypes = initializers.map((declaration) => declaration!.parameters[0]!.type);
    const [genericConstruction, importedConstruction, localConstruction] = constructionTypes;
    if (!genericConstruction || !importedConstruction || !localConstruction) {
      throw new TypeError('expected construction types');
    }
    for (const constructionType of constructionTypes) {
      expect(planner.plan(constructionType, adjustments)).toMatchObject({
        category: 'interface',
        identity: { identity: 'reference', reason: 'declared-reference' },
        kind: 'represented',
        valueRepresentation: 'flightReference',
      });
    }
    const emitted = createCppCompilerBackend().createEmissionSession!({
      moduleResolution: resolution,
      modules,
      options: { runtimeProfile: 'flight-cpp' },
    }).emitModule(adjustments)[0]!.contents;
    expect(emitted).toContain('initialize_adjustment');
    expect(emitted).toContain('initialize_brightness_contrast_adjustment');
    expect(emitted).toContain('initialize_local_adjustment');

    if (constructionTypes.some((type) => type.kind !== 'named' || !type.typeArguments[0])) {
      throw new TypeError('expected applied construction alias');
    }
    const collision = {
      ...structuredClone(adjustments),
      name: 'collision',
      packageName: '@flighthq/collision',
      source: 'packages/collision/src/adjustment.ts',
    };
    const collidingPlanner = createIrTypeReferenceRepresentationPlannerCpp([...modules, collision], resolution);
    for (const constructionType of constructionTypes) {
      if (constructionType.kind !== 'named' || !constructionType.typeArguments[0]) continue;
      expect(collidingPlanner.plan(constructionType.typeArguments[0], adjustments)).toMatchObject({
        kind: 'represented',
      });
    }
    expect(collidingPlanner.plan(genericConstruction, adjustments)).toMatchObject({
      identity: { identity: 'indeterminate', reason: 'unconstrained-type-parameter' },
      kind: 'refused',
    });
    expect(collidingPlanner.plan(importedConstruction, adjustments)).toMatchObject({
      identity: { identity: 'indeterminate', reason: 'unresolved-reference' },
    });
    expect(collidingPlanner.plan(localConstruction, adjustments)).toMatchObject({
      identity: { identity: 'indeterminate', reason: 'unresolved-reference' },
    });
  });

  it('resolves relative JavaScript specifiers and local export aliases without changing caller data', () => {
    const model = lower('model.ts', 'interface Shape { value: number } export { Shape as PublicShape };');
    const consumer = lower(
      'consumer.ts',
      "import type { PublicShape } from './model.js'; export type Shape = PublicShape;",
    );
    const snapshot = structuredClone([model, consumer]);
    const planner = createIrTypeReferenceRepresentationPlannerCpp([consumer, model]);

    expect(planner.plan(declarationType(consumer, 'Shape'), consumer)).toMatchObject({
      category: 'interface',
      kind: 'represented',
      storageRepresentation: 'rawNamedObject',
      valueRepresentation: 'flightReference',
    });
    expect(Object.isFrozen(planner)).toBe(true);
    expect(Object.isFrozen(planner.plan(numberType, consumer))).toBe(true);
    expect(planner.resolveModule('./model.js', consumer)).toEqual(model);
    expect([model, consumer]).toEqual(snapshot);
  });

  it('resolves namespace imports, parent traversal, and extensionless index modules', () => {
    const model = lower('model.ts', 'export interface Shape { value: number } export const marker = 1;');
    const nestedConsumer = lower(
      'nested/consumer.ts',
      "import type * as Models from '../model.js'; export type Shape = Models.Shape;",
    );
    const index = lower('records/index.ts', 'export type RecordShape = { value: number };');
    const indexConsumer = lower(
      'index-consumer.ts',
      "import type { RecordShape } from './records'; export type Shape = RecordShape;",
    );
    const planner = createIrTypeReferenceRepresentationPlannerCpp([indexConsumer, nestedConsumer, index, model]);

    expect(planner.plan(declarationType(nestedConsumer, 'Shape'), nestedConsumer)).toMatchObject({
      category: 'interface',
      kind: 'represented',
    });
    expect(planner.plan(declarationType(indexConsumer, 'Shape'), indexConsumer)).toMatchObject({
      category: 'objectAlias',
      kind: 'represented',
    });
  });

  it('follows named reexports through resolved facade modules', () => {
    const model = lower('model.ts', 'export interface Shape { value: number }');
    const barrel = lower('barrel.ts', "export type { Shape } from './model.js';");
    const consumer = lower('consumer.ts', "import type { Shape } from './barrel.js'; export type Alias = Shape;");
    const planner = createIrTypeReferenceRepresentationPlannerCpp([consumer, barrel, model]);

    expect(planner.plan(declarationType(consumer, 'Alias'), consumer)).toMatchObject({
      category: 'interface',
      identity: { identity: 'reference', reason: 'declared-reference' },
      kind: 'represented',
      valueRepresentation: 'flightReference',
    });
  });

  it('snapshots its graph and rejects subjects outside that explicit graph', () => {
    const module = lower('snapshot.ts', 'export interface Shape { value: number } export type Alias = Shape;');
    const planner = createIrTypeReferenceRepresentationPlannerCpp([module]);
    const shape = declarationType(module, 'Shape');
    const alias = declarationType(module, 'Alias');
    (module.declarations as IrDeclaration[]).splice(0);

    expect(planner.plan(shape, module)).toMatchObject({
      category: 'interface',
      kind: 'represented',
    });
    expect(planner.resolveAlias(alias, module)).toMatchObject({
      kind: 'named',
      reference: { binding: { name: 'Shape' }, kind: 'binding' },
    });
    expect(planner.resolveAlias(alias, module)).toEqual(planner.resolveAlias(alias, module));
    expect(planner.resolveAlias(numberType, module)).toBeUndefined();
    expect(planner.resolveModule('./missing.js', module)).toBeUndefined();
    expect(() => planner.plan(numberType, lower('other.ts', 'export const value = 1;'))).toThrow(
      'C++ reference representation subject must belong to the explicit module set',
    );
    const other = lower('other.ts', 'export const value = 1;');
    expect(() => planner.resolveAlias(alias, other)).toThrow(
      'C++ type-alias subject must belong to the explicit module set',
    );
    expect(() => planner.resolveModule('./snapshot.js', other)).toThrow(
      'C++ module resolution subject must belong to the explicit module set',
    );
  });
});

function ambientType(name: string, typeArguments: readonly IrType[] = []): IrType {
  return { kind: 'named', reference: { kind: 'ambient', name }, typeArguments };
}

function declarationType(module: Readonly<IrModule>, name: string): IrType {
  for (const declaration of module.declarations) {
    if (
      (declaration.kind === 'class' ||
        declaration.kind === 'enum' ||
        declaration.kind === 'interface' ||
        declaration.kind === 'typeAlias') &&
      declaration.binding.name === name
    ) {
      return {
        kind: 'named',
        reference: { binding: declaration.binding, kind: 'binding', path: [] },
        typeArguments: [],
      };
    }
  }
  throw new TypeError(`missing declaration ${name}`);
}

function lower(file: string, source: string, packageName = '@flighthq/reference-plan'): IrModule {
  const sourceFile = ts.createSourceFile(
    `/flight/packages/reference-plan/src/${file}`,
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  return lowerTypeScriptSource(sourceFile, { packageName, upstreamDirectory: '/flight' }).module;
}

function planDeclaration(module: Readonly<IrModule>, name: string): CompilerCppReferenceRepresentationPlan {
  return createIrTypeReferenceRepresentationPlanCpp(declarationType(module, name), module);
}
