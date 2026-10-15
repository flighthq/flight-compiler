import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { lowerTypeScriptSources } from '../../compiler-semantic/src/index.js';
import type { CompilerModuleResolutionPlan, IrModule } from '../../compiler-types/src/index.js';
import { createCppCompilerBackend } from './cppCompilerBackend.js';

describe('C++ refusal placeholder qualification', () => {
  const options = {
    packageTargets: {
      '@fixture/consumer': { includePrefix: 'fixture/consumer', namespace: 'fixture::consumer' },
      '@fixture/facade': { includePrefix: 'fixture/facade', namespace: 'fixture::facade' },
      '@fixture/model': { includePrefix: 'fixture/model', namespace: 'fixture::model' },
      '@fixture/model-b': { includePrefix: 'fixture/model_b', namespace: 'fixture::model_b' },
      '@fixture/unrelated': { includePrefix: 'fixture/unrelated', namespace: 'fixture::unrelated' },
    },
    runtimeProfile: 'flight-cpp' as const,
  };
  const refusedBody = '(target as unknown as Record<PropertyKey, unknown>)[prop] = value;';

  it('qualifies and includes cross-package type and value references retained by salvage', () => {
    const fixture = lowerDirectFixture(
      `import { BASE } from '@fixture/model';
       import type { Reader } from '@fixture/model';
       export function readPos(reader: Reader): number { return reader.pos + BASE; }
       export function bad(target: object, prop: string, value: unknown): void { ${refusedBody} }`,
    );
    const contents = placeholder(fixture);
    const fullFixture = lowerDirectFixture(
      `import { BASE } from '@fixture/model';
       import type { Reader } from '@fixture/model';
       export function readPos(reader: Reader): number { return reader.pos + BASE; }`,
    );
    const full = createCppCompilerBackend().createEmissionSession!({
      moduleResolution: fullFixture.moduleResolution,
      modules: fullFixture.modules,
      options,
    }).emitModule(fullFixture.consumer)[0]!.contents;
    const signature = /inline double read_pos\([^)]*\)/u;

    expect(contents).toContain('PARTIAL:');
    expect(contents).toContain('NOT GENERATED: function bad');
    expect(contents).toContain('double read_pos(flight::Ref<fixture::model::Reader> reader)');
    expect(contents).toContain('return (reader->pos + fixture::model::base);');
    expect(contents).toContain('#include <fixture/model/model.hpp>');
    expect(contents).not.toContain('flight::Ref<Reader>');
    expect(contents.match(signature)?.[0]).toBe(full.match(signature)?.[0]);
  });

  it('resolves retained references through aliased facade reexports', () => {
    const moduleResolution: CompilerModuleResolutionPlan = {
      edges: [
        {
          specifier: '@fixture/model',
          target: { packageName: '@fixture/model', source: 'packages/model/src/model.ts' },
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
        source(
          '@fixture/model',
          'packages/model/src/model.ts',
          'export interface Reader { pos: number } export const BASE = 4;',
        ),
        source(
          '@fixture/facade',
          'packages/facade/src/contract.ts',
          `export type { Reader as SharedReader } from '@fixture/model';
           export { BASE as sharedBase } from '@fixture/model';`,
        ),
        source(
          '@fixture/consumer',
          'packages/consumer/src/handler.ts',
          `import { sharedBase as base } from '@fixture/facade';
           import type { SharedReader as Reader } from '@fixture/facade';
           export function readPos(reader: Reader): number { return reader.pos + base; }
           export function bad(target: object, prop: string, value: unknown): void { ${refusedBody} }`,
        ),
      ],
      moduleResolution,
    );
    const contents = placeholder({
      consumer: results[2]!.module,
      moduleResolution,
      modules: results.map((result) => result.module),
    });

    expect(results.flatMap((result) => result.diagnostics)).toEqual([]);
    expect(contents).toContain('flight::Ref<fixture::model::Reader> reader');
    expect(contents).toContain('fixture::model::base');
    expect(contents).toContain('#include <fixture/facade/contract.hpp>');
    expect(contents).not.toContain('fixture::facade::SharedReader');
  });

  it('rolls back headers used only by a refused declaration', () => {
    const fixture = lowerDirectFixture(
      `import type { Reader } from '@fixture/model';
       import type { Unrelated } from '@fixture/unrelated';
       export function readPos(reader: Reader): number { return reader.pos; }
       export function bad(
         target: object,
         prop: string,
         value: unknown,
         unused: Unrelated,
       ): { onlyRefusedMarker: number } {
         ${refusedBody}
         return { onlyRefusedMarker: 1 };
       }`,
    );
    const contents = placeholder(fixture);

    expect(contents).toContain('#include <fixture/model/model.hpp>');
    expect(contents).not.toContain('fixture/unrelated/unrelated.hpp');
    expect(contents).not.toContain('Unrelated>');
    expect(contents).not.toContain('only_refused_marker');
  });

  it('marks retained declarations with missing or ambiguous owners instead of guessing', () => {
    const missing = lowerDirectFixture(
      `import type { Reader } from '@fixture/model';
       export function readPos(reader: Reader): number { return reader.pos; }
       export function bad(target: object, prop: string, value: unknown): void { ${refusedBody} }`,
    );
    const missingContents = placeholder({
      ...missing,
      moduleResolution: { edges: [], schema: 'flight-compiler-module-resolution/1' },
    });

    const facadeResolution: CompilerModuleResolutionPlan = {
      edges: [
        {
          specifier: '@fixture/model-a',
          target: { packageName: '@fixture/model', source: 'packages/model/src/model.ts' },
        },
        {
          specifier: '@fixture/facade',
          target: { packageName: '@fixture/facade', source: 'packages/facade/src/contract.ts' },
        },
      ],
      schema: 'flight-compiler-module-resolution/1',
    };
    const ambiguousResults = lowerTypeScriptSources(
      [
        source('@fixture/model', 'packages/model/src/model.ts', 'export interface Reader { pos: number }'),
        source('@fixture/facade', 'packages/facade/src/contract.ts', "export type { Reader } from '@fixture/model-a';"),
        source(
          '@fixture/consumer',
          'packages/consumer/src/handler.ts',
          `import type { Reader } from '@fixture/facade';
           export function readPos(reader: Reader): number { return reader.pos; }
           export function bad(target: object, prop: string, value: unknown): void { ${refusedBody} }`,
        ),
      ],
      facadeResolution,
    );
    const alternate = lowerTypeScriptSources([
      source('@fixture/model-b', 'packages/model-b/src/model.ts', 'export interface Reader { pos: number }'),
    ])[0]!;
    const facade = ambiguousResults[1]!.module;
    const mutatedAmbiguousResults = [...ambiguousResults];
    mutatedAmbiguousResults[1] = {
      ...ambiguousResults[1]!,
      module: {
        ...facade,
        exports: [
          ...facade.exports,
          {
            exported: 'Reader',
            imported: 'Reader',
            kind: 'reexport',
            specifier: '@fixture/model-b',
            typeOnly: true,
          },
        ],
      },
    };
    const ambiguousResolution: CompilerModuleResolutionPlan = {
      edges: [
        ...facadeResolution.edges,
        {
          specifier: '@fixture/model-b',
          target: { packageName: '@fixture/model-b', source: 'packages/model-b/src/model.ts' },
        },
      ],
      schema: 'flight-compiler-module-resolution/1',
    };
    const ambiguousContents = placeholder({
      consumer: ambiguousResults[2]!.module,
      moduleResolution: ambiguousResolution,
      modules: [...mutatedAmbiguousResults.map((result) => result.module), alternate.module],
    });

    for (const contents of [missingContents, ambiguousContents]) {
      expect(contents).toContain('NOT GENERATED: function readPos');
      expect(contents).toContain('refusal: cpp-imported-binding-no-export-target');
      expect(contents).not.toContain('flight::Ref<Reader> reader');
    }
  });

  function lowerDirectFixture(consumerSource: string): {
    consumer: IrModule;
    moduleResolution: CompilerModuleResolutionPlan;
    modules: IrModule[];
  } {
    const moduleResolution: CompilerModuleResolutionPlan = {
      edges: [
        {
          specifier: '@fixture/model',
          target: { packageName: '@fixture/model', source: 'packages/model/src/model.ts' },
        },
        {
          specifier: '@fixture/unrelated',
          target: { packageName: '@fixture/unrelated', source: 'packages/unrelated/src/unrelated.ts' },
        },
      ],
      schema: 'flight-compiler-module-resolution/1',
    };
    const results = lowerTypeScriptSources(
      [
        source(
          '@fixture/model',
          'packages/model/src/model.ts',
          'export interface Reader { pos: number } export const BASE = 4;',
        ),
        source(
          '@fixture/unrelated',
          'packages/unrelated/src/unrelated.ts',
          'export interface Unrelated { extent: number }',
        ),
        source('@fixture/consumer', 'packages/consumer/src/handler.ts', consumerSource),
      ],
      moduleResolution,
    );
    expect(results.flatMap((result) => result.diagnostics)).toEqual([]);
    const modules = results.map((result) => result.module);
    return { consumer: modules[2]!, moduleResolution, modules };
  }

  function placeholder(fixture: {
    consumer: IrModule;
    moduleResolution: CompilerModuleResolutionPlan;
    modules: IrModule[];
  }): string {
    const session = createCppCompilerBackend().createEmissionSession!({
      moduleResolution: fixture.moduleResolution,
      modules: fixture.modules,
      options,
    });
    expect(session.emitRefusalPlaceholder).toBeDefined();
    return session.emitRefusalPlaceholder!(fixture.consumer, {
      classification: 'source-portability',
      message: 'an erased assertion hides the represented source carrier',
      rule: 'cpp-erased-record-assertion-unrepresented',
    })!.contents;
  }
});

function source(packageName: string, sourcePath: string, text: string) {
  return {
    packageName,
    sourceFile: ts.createSourceFile(`/flight/${sourcePath}`, text, ts.ScriptTarget.Latest, true),
    upstreamDirectory: '/flight',
  };
}
