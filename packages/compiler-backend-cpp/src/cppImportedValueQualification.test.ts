import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { lowerTypeScriptSources } from '../../compiler-semantic/src/index.js';
import type { CompilerModuleResolutionPlan } from '../../compiler-types/src/index.js';
import { createCppCompilerBackend } from './cppCompilerBackend.js';

describe('C++ imported value qualification', () => {
  it('avoids local collisions and projects namespace imports inside lambdas', () => {
    const packageName = '@flighthq/math';
    const sources = [
      {
        packageName,
        sourceFile: ts.createSourceFile(
          '/flight/packages/math/src/constants.ts',
          'export const EPSILON = 0.000001; export function scale(value: number): number { return value * 2; }',
          ts.ScriptTarget.Latest,
          true,
        ),
        upstreamDirectory: '/flight',
      },
      {
        packageName,
        sourceFile: ts.createSourceFile(
          '/flight/packages/math/src/consumer.ts',
          "import { EPSILON } from './constants.js'; import * as constants from './constants.js'; export function close(value: number, epsilon: number = EPSILON): boolean { const scaled = (input: number): number => constants.scale(input); return scaled(value) <= EPSILON + epsilon; }",
          ts.ScriptTarget.Latest,
          true,
        ),
        upstreamDirectory: '/flight',
      },
    ];
    const moduleResolution: CompilerModuleResolutionPlan = {
      edges: [
        {
          specifier: './constants.js',
          target: { packageName, source: 'packages/math/src/constants.ts' },
        },
      ],
      schema: 'flight-compiler-module-resolution/1',
    };
    const results = lowerTypeScriptSources(sources, moduleResolution);
    expect(results.flatMap((result) => result.diagnostics)).toEqual([]);
    const modules = results.map((result) => result.module);
    const consumer = modules[1]!;
    const output = createCppCompilerBackend().createEmissionSession!({
      moduleResolution,
      modules,
      options: {
        packageTargets: {
          [packageName]: { includePrefix: 'flight/math', namespace: 'flight::math' },
        },
        runtimeProfile: 'flight-cpp',
      },
    }).emitModule(consumer)[0]!.contents;

    // The parameter is renamed to `epsilon_2`, and that is the naming rule rather than a regression:
    // the imported `EPSILON` and the parameter `epsilon` sanitize to the SAME C++ name, so one of them
    // has to change and the renamable one does. Every reference stays consistent -- the default reads the
    // imported value and the body adds the parameter -- and a parameter that does not collide keeps its
    // spelling, which the control below pins.
    expect(output).toContain('epsilon_2 = epsilon_2.value_or(flight::math::epsilon)');
    expect(output).toContain('flight::math::scale(input)');
    expect(output).toContain('flight::math::epsilon + epsilon_2.value()');
    expect(output).not.toContain('constants.scale');
  });

  it('renames a colliding local and leaves a non-colliding one alone', () => {
    // Collision-stable naming: a local whose C++ name would collide with an imported value's is renamed,
    // and one whose name does not collide keeps the spelling the source gave it. Both are deterministic,
    // and neither changes which value any reference reads.
    const constants = 'export const EPSILON = 0.000001;';
    const emitWithParameter = (parameter: string) => {
      const sources = [
        {
          packageName: '@flighthq/math',
          sourceFile: ts.createSourceFile(
            '/flight/packages/math/src/constants.ts',
            constants,
            ts.ScriptTarget.Latest,
            true,
          ),
          upstreamDirectory: '/flight',
        },
        {
          packageName: '@flighthq/math',
          sourceFile: ts.createSourceFile(
            '/flight/packages/math/src/consumer.ts',
            `import { EPSILON } from './constants.js'; export function close(value: number, ${parameter}): boolean { return value <= EPSILON + ${parameter.split(':')[0]}; }`,
            ts.ScriptTarget.Latest,
            true,
          ),
          upstreamDirectory: '/flight',
        },
      ];
      const moduleResolution: CompilerModuleResolutionPlan = {
        edges: [
          {
            specifier: './constants.js',
            target: { packageName: '@flighthq/math', source: 'packages/math/src/constants.ts' },
          },
        ],
        schema: 'flight-compiler-module-resolution/1',
      };
      const modules = lowerTypeScriptSources(sources, moduleResolution).map((result) => result.module);
      return createCppCompilerBackend().createEmissionSession!({
        moduleResolution,
        modules,
        options: {
          packageTargets: {
            '@flighthq/math': { includePrefix: 'flight/math', namespace: 'flight::math' },
          },
          runtimeProfile: 'flight-cpp',
        },
      })
        .emitModule(modules[1]!)
        .map((file) => file.contents)
        .join('\n');
    };

    // A defaulted parameter is stored optionally, so the spelling carries the optional wrapper too.
    const colliding = emitWithParameter('epsilon: number = EPSILON');
    expect(colliding).toContain('std::optional<double> epsilon_2');
    const distinct = emitWithParameter('eps: number = EPSILON');
    expect(distinct).toContain('std::optional<double> eps');
    expect(distinct).not.toContain('eps_2');
  });

  it('qualifies values resolved through a barrel without capturing a shadow', () => {
    const typesPackage = '@flighthq/types';
    const lightingPackage = '@flighthq/lighting';
    const sources = [
      {
        packageName: typesPackage,
        sourceFile: ts.createSourceFile(
          '/flight/packages/types/src/LightUnit.ts',
          `export type LightUnit = 'Lux' | 'Unitless';
           export const LuxLightUnit = 'Lux';
           export const UnitlessLightUnit = 'Unitless';`,
          ts.ScriptTarget.Latest,
          true,
        ),
        upstreamDirectory: '/flight',
      },
      {
        packageName: typesPackage,
        sourceFile: ts.createSourceFile(
          '/flight/packages/types/src/contract.ts',
          "export * from './LightUnit';",
          ts.ScriptTarget.Latest,
          true,
        ),
        upstreamDirectory: '/flight',
      },
      {
        packageName: lightingPackage,
        sourceFile: ts.createSourceFile(
          '/flight/packages/lighting/src/ambientLight.ts',
          `import type { LightUnit } from '@flighthq/types/contract';
           import { LuxLightUnit, UnitlessLightUnit } from '@flighthq/types/contract';
           export function getDefaultLightUnit(): LightUnit { return UnitlessLightUnit; }
           export function getLuxLightUnit(): LightUnit { return LuxLightUnit; }
           export function retainShadow(UnitlessLightUnit: string): string { return UnitlessLightUnit; }`,
          ts.ScriptTarget.Latest,
          true,
        ),
        upstreamDirectory: '/flight',
      },
    ];
    const modules = lowerTypeScriptSources(sources, {
      edges: [
        {
          specifier: './LightUnit',
          target: { packageName: typesPackage, source: 'packages/types/src/LightUnit.ts' },
        },
        {
          specifier: '@flighthq/types/contract',
          target: { packageName: typesPackage, source: 'packages/types/src/contract.ts' },
        },
      ],
      schema: 'flight-compiler-module-resolution/1',
    });
    expect(modules.flatMap((result) => result.diagnostics)).toEqual([]);
    const lowered = modules.map((result) => result.module);
    const output = createCppCompilerBackend().createEmissionSession!({
      moduleResolution: {
        edges: [
          {
            importer: lowered[1],
            specifier: './LightUnit',
            target: { packageName: typesPackage, source: 'packages/types/src/LightUnit.ts' },
          },
          {
            importer: lowered[2],
            specifier: '@flighthq/types/contract',
            target: { packageName: typesPackage, source: 'packages/types/src/contract.ts' },
          },
        ],
        schema: 'flight-compiler-module-resolution/1',
      },
      modules: lowered,
      options: {
        packageTargets: {
          [lightingPackage]: { includePrefix: 'flight/lighting', namespace: 'flight::lighting' },
          [typesPackage]: { includePrefix: 'flight/types', namespace: 'flight::types' },
        },
        runtimeProfile: 'flight-cpp',
      },
    }).emitModule(lowered[2]!)[0]!.contents;

    expect(output).toContain('return flight::types::unitless_light_unit;');
    expect(output).toContain('return flight::types::lux_light_unit;');
    expect(output).toContain('return unitless_light_unit;');
  });

  it('qualifies aliased type and value reexports by their distinct declaration owners', () => {
    const fixture = createCrossPackageQualificationFixture();
    const output = emitCrossPackageQualificationFixture(fixture, fixture.moduleResolution);

    expect(output).toContain('double imported(fixture::model::Point point)');
    expect(output).toContain('return (fixture::constants::origin + point.value);');
    expect(output).toContain('double local(LocalPoint point)');
    expect(output).toContain('return (local_value + point.value);');
    expect(output).not.toContain('fixture::facade::Shared');
    expect(output).not.toContain('fixture::consumer::LocalPoint');
    expect(output).not.toContain('fixture::consumer::local_value');
  });

  it('refuses ambiguous imported type ownership without selecting a module', () => {
    const fixture = createCrossPackageQualificationFixture();
    const modules = [...fixture.modules];
    modules[2] = {
      ...modules[2]!,
      exports: [
        ...modules[2]!.exports,
        {
          exported: 'SharedType',
          imported: 'Point',
          kind: 'reexport',
          specifier: '@fixture/alternate',
          typeOnly: true,
        },
      ],
    };
    const ambiguous: CompilerModuleResolutionPlan = {
      ...fixture.moduleResolution,
      edges: [
        ...fixture.moduleResolution.edges,
        {
          importer: modules[2],
          specifier: '@fixture/alternate',
          target: { packageName: '@fixture/alternate', source: 'packages/alternate/src/point.ts' },
        },
      ],
    };

    const failure = captureQualificationFailure(() =>
      emitCrossPackageQualificationFixture({ ...fixture, modules }, ambiguous),
    );

    expect(failure).toMatchObject({ rule: 'cpp-imported-binding-no-export-target' });
    expect(failure.message).toContain('imported type binding SharedType requires one exact exported declaration owner');
  });

  it('refuses unresolved imported value ownership instead of emitting a local spelling', () => {
    const fixture = createCrossPackageQualificationFixture();
    const unresolved: CompilerModuleResolutionPlan = {
      ...fixture.moduleResolution,
      edges: fixture.moduleResolution.edges.filter((edge) => edge.specifier !== '@fixture/constants'),
    };

    const failure = captureQualificationFailure(() => emitCrossPackageQualificationFixture(fixture, unresolved));

    expect(failure).toMatchObject({ rule: 'cpp-imported-binding-no-export-target' });
    expect(failure.message).toContain(
      'imported value binding SharedValue requires one exact exported declaration owner',
    );
  });
});

function captureQualificationFailure(action: () => string): Error & { rule?: string | undefined } {
  try {
    action();
  } catch (error) {
    if (error instanceof Error) return error;
    throw error;
  }
  throw new Error('Expected C++ qualification emission to fail');
}

function createCrossPackageQualificationFixture() {
  const source = (packageName: string, sourcePath: string, text: string) => ({
    packageName,
    sourceFile: ts.createSourceFile(`/flight/${sourcePath}`, text, ts.ScriptTarget.Latest, true),
    upstreamDirectory: '/flight',
  });
  const loweringResolution: CompilerModuleResolutionPlan = {
    edges: [
      {
        specifier: '@fixture/model',
        target: { packageName: '@fixture/model', source: 'packages/model/src/point.ts' },
      },
      {
        specifier: '@fixture/constants',
        target: { packageName: '@fixture/constants', source: 'packages/constants/src/origin.ts' },
      },
      {
        specifier: '@fixture/facade',
        target: { packageName: '@fixture/facade', source: 'packages/facade/src/contract.ts' },
      },
    ],
    schema: 'flight-compiler-module-resolution/1',
  };
  const results = lowerTypeScriptSources(
    [
      source('@fixture/model', 'packages/model/src/point.ts', 'export interface Point { value: number }'),
      source('@fixture/constants', 'packages/constants/src/origin.ts', 'export const ORIGIN = 1;'),
      source(
        '@fixture/facade',
        'packages/facade/src/contract.ts',
        `import type { Point as ModelPoint } from '@fixture/model';
         import { ORIGIN as originValue } from '@fixture/constants';
         export type { ModelPoint as SharedType };
         export { originValue as SharedValue };`,
      ),
      source(
        '@fixture/consumer',
        'packages/consumer/src/use.ts',
        `import { SharedValue as importedValue } from '@fixture/facade';
         import type { SharedType as ImportedType } from '@fixture/facade';
         interface LocalPoint { value: number }
         const localValue = 2;
         export function imported(point: ImportedType): number { return importedValue + point.value; }
         export function local(point: LocalPoint): number { return localValue + point.value; }`,
      ),
      source('@fixture/alternate', 'packages/alternate/src/point.ts', 'export interface Point { other: number }'),
    ],
    loweringResolution,
  );
  expect(results.flatMap((result) => result.diagnostics)).toEqual([]);
  const modules = results.map((result) => result.module);
  const moduleResolution: CompilerModuleResolutionPlan = {
    edges: [
      { importer: modules[2], ...loweringResolution.edges[0]! },
      { importer: modules[2], ...loweringResolution.edges[1]! },
      { importer: modules[3], ...loweringResolution.edges[2]! },
    ],
    schema: 'flight-compiler-module-resolution/1',
  };
  return { moduleResolution, modules };
}

function emitCrossPackageQualificationFixture(
  fixture: ReturnType<typeof createCrossPackageQualificationFixture>,
  moduleResolution: CompilerModuleResolutionPlan,
): string {
  return createCppCompilerBackend().createEmissionSession!({
    moduleResolution,
    modules: fixture.modules,
    options: {
      packageTargets: {
        '@fixture/alternate': { includePrefix: 'fixture/alternate', namespace: 'fixture::alternate' },
        '@fixture/constants': { includePrefix: 'fixture/constants', namespace: 'fixture::constants' },
        '@fixture/consumer': { includePrefix: 'fixture/consumer', namespace: 'fixture::consumer' },
        '@fixture/facade': { includePrefix: 'fixture/facade', namespace: 'fixture::facade' },
        '@fixture/model': { includePrefix: 'fixture/model', namespace: 'fixture::model' },
      },
    },
  }).emitModule(fixture.modules[3]!)[0]!.contents;
}
