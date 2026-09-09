import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { lowerTypeScriptSource } from '../../compiler-semantic/src/index.js';
import type {
  CompilerCppReferenceRepresentationPlan,
  CompilerModuleResolutionPlan,
  IrDeclaration,
  IrModule,
  IrType,
} from '../../compiler-types/src/index.js';
import {
  createIrTypeReferenceRepresentationPlanCpp,
  createIrTypeReferenceRepresentationPlannerCpp,
} from './cppReferenceRepresentationPlan.js';

const numberType = { kind: 'primitive', name: 'number' } as const satisfies IrType;
const objectType = {
  kind: 'object',
  properties: [{ name: 'value', optional: false, readonly: false, type: numberType }],
} as const satisfies IrType;

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

  it('keeps runtime identity handles direct instead of wrapping them in flight references', () => {
    const module = lower(
      'aliases.ts',
      'export type Values = number[]; export type Table = Map<string, number>; export type View = Uint8Array; export type Callback = () => void;',
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
      kind: 'refused',
      reason: 'unsupportedReferenceForm',
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
      kind: 'refused',
      reason: 'compoundReference',
    });
    expect(createIrTypeReferenceRepresentationPlanCpp(referenceIntersection, module)).toMatchObject({
      kind: 'refused',
      reason: 'compoundReference',
    });
    for (const type of [functionType, tupleType, typeOfArray, constrainedParameter]) {
      expect(createIrTypeReferenceRepresentationPlanCpp(type, module)).toMatchObject({
        kind: 'refused',
        reason: 'unsupportedReferenceForm',
      });
    }
    for (const type of [ambientType('Date'), ambientType('WeakSet'), ambientType('BigInt64Array')]) {
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
      'export class Model { value = 1; } export type Shape = { value: number }; export type Values = number[];',
      '@flighthq/models',
    );
    const consumer = lower(
      'consumer.ts',
      "import type { Model, Shape, Values } from '@flighthq/models'; export type PublicModel = Model; export type PublicShape = Shape; export type PublicValues = Values;",
      '@flighthq/consumer',
    );
    const resolution: CompilerModuleResolutionPlan = {
      edges: [
        {
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
    }
    expect(forward.plan(declarationType(consumer, 'PublicModel'), consumer)).toEqual(
      reverse.plan(declarationType(consumer, 'PublicModel'), consumer),
    );
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
    const module = lower('snapshot.ts', 'export interface Shape { value: number }');
    const planner = createIrTypeReferenceRepresentationPlannerCpp([module]);
    const shape = declarationType(module, 'Shape');
    (module.declarations as IrDeclaration[]).splice(0);

    expect(planner.plan(shape, module)).toMatchObject({
      category: 'interface',
      kind: 'represented',
    });
    expect(() => planner.plan(numberType, lower('other.ts', 'export const value = 1;'))).toThrow(
      'C++ reference representation subject must belong to the explicit module set',
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
