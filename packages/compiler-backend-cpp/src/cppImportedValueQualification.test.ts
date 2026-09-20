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

    expect(output).toContain('epsilon = epsilon.value_or(flight::math::epsilon)');
    expect(output).toContain('flight::math::scale(input)');
    expect(output).toContain('flight::math::epsilon + epsilon.value()');
    expect(output).not.toContain('constants.scale');
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
});
