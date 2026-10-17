import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { lowerTypeScriptSources } from '../../compiler-semantic/src/index.js';
import type { CompilerModuleResolutionPlan } from '../../compiler-types/src/index.js';
import { createCppCompilerBackend } from './cppCompilerBackend.js';
import { createCppTestModuleEvaluation } from './cppModuleEvaluationTestSupport.js';

describe('C++ imported variant owner qualification', () => {
  it('qualifies imported owners for variant narrowing and concrete value construction', () => {
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
        source(
          '@flighthq/types',
          'packages/types/src/contract.ts',
          `export interface Texture2D { readonly dimension: '2d'; version: number }
           export interface TextureCube { readonly dimension: 'cube'; version: number; sources: readonly number[] }
           export type Texture = Texture2D | TextureCube;
           export type TextureConsumer = (value: Texture) => void;`,
        ),
        source(
          '@flighthq/scene3d-gl',
          'packages/scene3d-gl/src/importedTexture.ts',
          `import type { Texture, Texture2D, TextureConsumer } from '@flighthq/types/contract';
           export function consumeOne(consume: TextureConsumer, value: Texture2D): void { consume(value); }
           export function cubeSize(value: Texture | null): number {
             if (value === null || value.dimension !== 'cube') return 0;
             return value.sources.length;
           }`,
        ),
      ],
      moduleResolution,
    );
    const consumer = results[1]!;
    const emitted = createCppCompilerBackend().createEmissionSession!({
      moduleEvaluation: createCppTestModuleEvaluation(
        results.map((result) => result.module),
        moduleResolution,
      ),
      moduleResolution,
      modules: results.map((result) => result.module),
      options: {
        packageTargets: {
          '@flighthq/scene3d-gl': { includePrefix: 'flight/scene3d_gl', namespace: 'flight::scene3d_gl' },
          '@flighthq/types': { includePrefix: 'flight/types', namespace: 'flight::types' },
        },
        runtimeProfile: 'flight-cpp',
      },
    }).emitModule(consumer.module)[0]!.contents;

    expect(results.flatMap((result) => result.diagnostics)).toEqual([]);
    expect(emitted).toContain('std::in_place_type<flight::Ref<flight::types::Texture2D>>');
    expect(emitted).toContain('->sources.size()');
  });

  it('resolves renamed variant owners through a re-export facade', () => {
    const moduleResolution: CompilerModuleResolutionPlan = {
      edges: [
        {
          specifier: './textures',
          target: { packageName: '@flighthq/types', source: 'packages/types/src/textures.ts' },
        },
        {
          specifier: '../../types/src/textures.js',
          target: { packageName: '@flighthq/types', source: 'packages/types/src/textures.ts' },
        },
        {
          specifier: '@flighthq/types/contract',
          target: { packageName: '@flighthq/types', source: 'packages/types/src/contract.ts' },
        },
      ],
      schema: 'flight-compiler-module-resolution/1',
    };
    const results = lowerTypeScriptSources(
      [
        source(
          '@flighthq/types',
          'packages/types/src/textures.ts',
          `export interface Texture2D { readonly dimension: '2d'; version: number }
           export interface TextureCube { readonly dimension: 'cube'; version: number; sources: readonly number[] }
           export type Texture = Texture2D | TextureCube;
           export type TextureConsumer = (value: Texture) => void;`,
        ),
        source(
          '@flighthq/types',
          'packages/types/src/contract.ts',
          `export type {
             Texture as ImageTexture,
             Texture2D as ImageTexture2D,
             TextureConsumer as ImageTextureConsumer,
           } from './textures';`,
        ),
        source(
          '@flighthq/scene3d-gl',
          'packages/scene3d-gl/src/reexportedTexture.ts',
          `import type {
             ImageTexture as Texture,
             ImageTexture2D as Texture2D,
             ImageTextureConsumer as TextureConsumer,
           } from '@flighthq/types/contract';
           export function consumeOne(consume: TextureConsumer, value: Texture2D): void { consume(value); }
           export function cubeSize(value: Texture | null): number {
             if (value === null || value.dimension !== 'cube') return 0;
             return value.sources.length;
           }`,
        ),
      ],
      moduleResolution,
    );
    const emitted = emitConsumer(results, moduleResolution, 2);

    expect(results.flatMap((result) => result.diagnostics)).toEqual([]);
    expect(emitted).toContain('std::in_place_type<flight::Ref<flight::types::Texture2D>>');
    expect(emitted).toContain('->sources.size()');
    expect(emitted).not.toContain('flight::types::ImageTexture2D');
  });

  it('projects every present owner through direct imports and re-export facades', () => {
    const moduleResolution: CompilerModuleResolutionPlan = {
      edges: [
        {
          specifier: './textures',
          target: { packageName: '@flighthq/types', source: 'packages/types/src/textures.ts' },
        },
        {
          specifier: '@flighthq/types/contract',
          target: { packageName: '@flighthq/types', source: 'packages/types/src/contract.ts' },
        },
        {
          specifier: '@flighthq/types/textures',
          target: { packageName: '@flighthq/types', source: 'packages/types/src/textures.ts' },
        },
      ],
      schema: 'flight-compiler-module-resolution/1',
    };
    const results = lowerTypeScriptSources(
      [
        source(
          '@flighthq/types',
          'packages/types/src/textures.ts',
          `export interface ImageSource { readonly kind: 'image'; readonly width: number }
           export interface VoxelSource { readonly depth: number; readonly kind: 'voxel'; readonly width: number }
           export type Source = ImageSource | VoxelSource;`,
        ),
        source(
          '@flighthq/types',
          'packages/types/src/contract.ts',
          "export type { ImageSource, Source as ReexportedSource, VoxelSource } from './textures';",
        ),
        source(
          '@flighthq/scene3d-gl',
          'packages/scene3d-gl/src/directSource.ts',
          `import type { Source } from '@flighthq/types/textures';
           export function sourceWidth(source: Source | null | undefined): number {
             if (source === null) return -1;
             if (source === undefined) return -1;
             return source.width;
           }`,
        ),
        source(
          '@flighthq/scene3d-gl',
          'packages/scene3d-gl/src/reexportedSource.ts',
          `import type { ReexportedSource as Source } from '@flighthq/types/contract';
           export function sourceWidth(source: Source | null | undefined): number {
             if (source === null) return -1;
             if (source === undefined) return -1;
             return source.width;
           }`,
        ),
      ],
      moduleResolution,
    );

    expect(results.flatMap((result) => result.diagnostics)).toEqual([]);
    for (const index of [2, 3]) {
      const emitted = emitConsumer(results, moduleResolution, index);
      expect(emitted).toContain('std::holds_alternative<flight::Null>(source)');
      expect(emitted).toContain('std::holds_alternative<flight::Undefined>(source)');
      expect(emitted).toContain('const auto& present_union_source = source;');
      expect(emitted).toContain('std::get_if<flight::Ref<flight::types::ImageSource>>');
      expect(emitted).toContain('std::get_if<flight::Ref<flight::types::VoxelSource>>');
      expect(emitted).toContain('std::in_place_type<flight::Ref<flight::types::ImageSource>>');
      expect(emitted).toContain('std::in_place_type<flight::Ref<flight::types::VoxelSource>>');
      expect(emitted).toContain('return value->width;');
      expect(emitted).not.toContain('flight::scene3d_gl::ImageSource');
      expect(emitted).not.toContain('flight::scene3d_gl::VoxelSource');
    }
  });

  it('keeps local variant owners local', () => {
    const results = lowerTypeScriptSources([
      source(
        '@flighthq/scene3d-gl',
        'packages/scene3d-gl/src/localTexture.ts',
        `interface Texture2D { readonly dimension: '2d'; version: number }
         interface TextureCube { readonly dimension: 'cube'; version: number; sources: readonly number[] }
         type Texture = Texture2D | TextureCube;
         type TextureConsumer = (value: Texture) => void;
         export function consumeOne(consume: TextureConsumer, value: Texture2D): void { consume(value); }
         export function cubeSize(value: Texture | null): number {
           if (value === null || value.dimension !== 'cube') return 0;
           return value.sources.length;
         }`,
      ),
    ]);
    const emitted = emitConsumer(results, undefined, 0);

    expect(results.flatMap((result) => result.diagnostics)).toEqual([]);
    expect(emitted).toContain('std::in_place_type<flight::Ref<Texture2D>>');
    expect(emitted).toContain('->sources.size()');
    expect(emitted).not.toContain('flight::scene3d_gl::Texture2D');
  });

  it('keeps type and value declaration ownership separate for one imported spelling', () => {
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
        source(
          '@flighthq/types',
          'packages/types/src/contract.ts',
          `export interface Texture2D { readonly dimension: '2d'; version: number }
           export const Texture2D = 7;
           export interface TextureCube { readonly dimension: 'cube'; version: number; sources: readonly number[] }
           export type Texture = Texture2D | TextureCube;
           export type TextureConsumer = (value: Texture) => void;`,
        ),
        source(
          '@flighthq/scene3d-gl',
          'packages/scene3d-gl/src/namespacedTexture.ts',
          `import { Texture2D } from '@flighthq/types/contract';
           import type { Texture, TextureConsumer } from '@flighthq/types/contract';
           export function consumeOne(consume: TextureConsumer, value: Texture2D): void { consume(value); }
           export function marker(): number { return Texture2D; }`,
        ),
      ],
      moduleResolution,
    );
    const emitted = emitConsumer(results, moduleResolution, 1);

    expect(results.flatMap((result) => result.diagnostics)).toEqual([]);
    expect(emitted).toContain('std::in_place_type<flight::Ref<flight::types::Texture2D>>');
    expect(emitted).toMatch(/return flight::types::texture_?2_?d;/u);
  });

  it('refuses ambiguous and unresolved imported variant owners', () => {
    const resolved: CompilerModuleResolutionPlan = {
      edges: [
        {
          specifier: '@flighthq/types-a',
          target: { packageName: '@flighthq/types-a', source: 'packages/types-a/src/contract.ts' },
        },
        {
          specifier: '@flighthq/types/contract',
          target: { packageName: '@flighthq/types', source: 'packages/types/src/contract.ts' },
        },
      ],
      schema: 'flight-compiler-module-resolution/1',
    };
    const results = lowerTypeScriptSources(
      [
        source(
          '@flighthq/types-a',
          'packages/types-a/src/contract.ts',
          `export interface Texture2D { readonly dimension: '2d'; version: number }
           export interface TextureCube { readonly dimension: 'cube'; version: number }
           export type Texture = Texture2D | TextureCube;
           export type TextureConsumer = (value: Texture) => void;`,
        ),
        source(
          '@flighthq/types',
          'packages/types/src/contract.ts',
          "export type { Texture2D, TextureConsumer } from '@flighthq/types-a';",
        ),
        source(
          '@flighthq/scene3d-gl',
          'packages/scene3d-gl/src/ambiguousTexture.ts',
          `import type { Texture2D, TextureConsumer } from '@flighthq/types/contract';
           export function consumeOne(consume: TextureConsumer, value: Texture2D): void { consume(value); }`,
        ),
      ],
      resolved,
    );
    const alternate = lowerTypeScriptSources([
      source(
        '@flighthq/types-b',
        'packages/types-b/src/contract.ts',
        `export interface Texture2D { readonly dimension: '2d'; version: number }
         export interface TextureCube { readonly dimension: 'cube'; version: number }
         export type Texture = Texture2D | TextureCube;
         export type TextureConsumer = (value: Texture) => void;`,
      ),
    ])[0]!;
    const facade = results[1]!.module;
    const ambiguousResults = [...results];
    ambiguousResults[1] = {
      ...results[1]!,
      module: {
        ...facade,
        exports: [
          ...facade.exports,
          {
            exported: 'TextureConsumer',
            imported: 'TextureConsumer',
            kind: 'reexport',
            specifier: '@flighthq/types-b',
            typeOnly: true,
          },
        ],
      },
    };
    const ambiguous: CompilerModuleResolutionPlan = {
      ...resolved,
      edges: [
        ...resolved.edges,
        {
          specifier: '@flighthq/types-b',
          target: { packageName: '@flighthq/types-b', source: 'packages/types-b/src/contract.ts' },
        },
      ],
    };

    const ambiguousFailure = captureFailure(() => emitConsumer([...ambiguousResults, alternate], ambiguous, 2));
    const unresolvedFailure = captureFailure(() =>
      emitConsumer(results, { edges: [], schema: 'flight-compiler-module-resolution/1' }, 2),
    );

    expect(results.flatMap((result) => result.diagnostics)).toEqual([]);
    expect(ambiguousFailure).toMatchObject({ rule: 'cpp-imported-binding-no-export-target' });
    expect(ambiguousFailure.message).toContain(
      'imported type binding TextureConsumer requires one exact exported declaration owner',
    );
    expect(unresolvedFailure).toMatchObject({ rule: 'cpp-imported-binding-no-export-target' });
    expect(unresolvedFailure.message).toContain(
      'imported type binding TextureConsumer requires one exact exported declaration owner',
    );
  });
});

function source(packageName: string, sourcePath: string, text: string) {
  return {
    packageName,
    sourceFile: ts.createSourceFile(`/flight/${sourcePath}`, text, ts.ScriptTarget.Latest, true),
    upstreamDirectory: '/flight',
  };
}

function emitConsumer(
  results: ReturnType<typeof lowerTypeScriptSources>,
  moduleResolution: CompilerModuleResolutionPlan | undefined,
  consumerIndex: number,
): string {
  return createCppCompilerBackend().createEmissionSession!({
    moduleEvaluation: createCppTestModuleEvaluation(results.map((result) => result.module)),
    ...(moduleResolution ? { moduleResolution } : {}),
    modules: results.map((result) => result.module),
    options: {
      packageTargets: {
        '@flighthq/scene3d-gl': { includePrefix: 'flight/scene3d_gl', namespace: 'flight::scene3d_gl' },
        '@flighthq/types': { includePrefix: 'flight/types', namespace: 'flight::types' },
        '@flighthq/types-a': { includePrefix: 'flight/types_a', namespace: 'flight::types_a' },
        '@flighthq/types-b': { includePrefix: 'flight/types_b', namespace: 'flight::types_b' },
      },
      runtimeProfile: 'flight-cpp',
    },
  }).emitModule(results[consumerIndex]!.module)[0]!.contents;
}

function captureFailure(action: () => string): Error & { rule?: string | undefined } {
  try {
    action();
  } catch (error) {
    if (error instanceof Error) return error;
    throw error;
  }
  throw new Error('Expected C++ imported owner qualification to fail');
}
