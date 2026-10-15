import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { isBackendEmissionFailure } from '../../compiler-emission/src/index.js';
import { compileTypeScriptModules, compileTypeScriptPackageGraph } from '../../compiler-orchestration/src/index.js';
import type { CppCompilerExternalBinding } from '../../compiler-types/src/index.js';
import { createCppCompilerBackend } from './cppCompilerBackend.js';

function createBinding(sourceName: string, space: 'type' | 'value'): CppCompilerExternalBinding {
  return {
    headers: ['host/profile.hpp'],
    nullability: 'non-null',
    ownership: 'shared',
    sourceName,
    space,
    targetName: `host::${sourceName}`,
  };
}

function compile(source: string, bindings: readonly CppCompilerExternalBinding[]) {
  return compileTypeScriptModules({
    backend: createCppCompilerBackend(),
    backendOptions: {
      externalBindings: { bindings, schema: 'flight-cpp-external-bindings/1' },
      runtimeProfile: 'flight-cpp',
    },
    sources: [
      {
        packageName: '@flighthq/net',
        sourceFile: ts.createSourceFile('/flight/packages/net/src/read.ts', source, ts.ScriptTarget.Latest, true),
        upstreamDirectory: '/flight',
      },
    ],
  });
}

function compilePackage(source: string, bindings: readonly CppCompilerExternalBinding[]) {
  return compileTypeScriptPackageGraph({
    backend: createCppCompilerBackend(),
    backendOptions: {
      externalBindings: { bindings, schema: 'flight-cpp-external-bindings/1' },
      runtimeProfile: 'flight-cpp',
    },
    graph: {
      entries: [{ name: 'Read', packageName: '@flighthq/net', source: 'packages/net/src/read.ts' }],
      moduleDependencies: [],
      packages: [{ dependencies: [], name: '@flighthq/net', root: '/flight/packages/net' }],
      schema: 'flight-compiler-package-graph/1',
    },
    sources: [
      {
        packageName: '@flighthq/net',
        packageRoot: '/flight/packages/net',
        sourceFile: ts.createSourceFile('/flight/packages/net/src/read.ts', source, ts.ScriptTarget.Latest, true),
        upstreamDirectory: '/flight',
      },
    ],
  });
}

function captureBackendEmissionFailure(run: () => unknown) {
  try {
    run();
  } catch (error) {
    if (isBackendEmissionFailure(error)) return error;
    throw error;
  }
  throw new Error('expected C++ emission to refuse and it did not');
}

const response = (type: string) =>
  `export interface NetResponse { readonly body: string | ${type} | null }
   export function read(response: NetResponse): string | ${type} | null { return response.body; }`;

describe('C++ profile type-name evidence', () => {
  it('carries the exact profile type lane through the TypeScript compilation pipeline', () => {
    const bindings = [createBinding('Blob', 'value'), createBinding('Blob', 'type')];
    const first = compilePackage(response('Blob'), bindings).compilation.files[0]?.contents;
    const second = compilePackage(response('Blob'), [...bindings].reverse()).compilation.files[0]?.contents;

    expect(first).toBe(second);
    expect(first).toContain('#include <host/profile.hpp>');
    expect(first).toContain('std::optional<std::variant<host::Blob, flight::String>> body;');
    expect(first).toContain('return response->body;');
  });

  it('keeps absent, value-only, and non-profile identities on stable runtime-binding refusals', () => {
    const absent = captureBackendEmissionFailure(() => compile(response('Blob'), []));
    const valueOnly = captureBackendEmissionFailure(() => compile(response('Blob'), [createBinding('Blob', 'value')]));
    const nearNeighbor = captureBackendEmissionFailure(() =>
      compile(response('File'), [createBinding('Blob', 'type')]),
    );

    expect(absent).toMatchObject({
      rule: 'cpp-runtime-external-symbol-binding-incomplete',
    });
    expect(absent.message).toContain('missing: Blob[type]');
    expect(valueOnly.rule).toBe(absent.rule);
    expect(valueOnly.message).toContain('missing: Blob[type]');
    expect(nearNeighbor.rule).toBe(absent.rule);
    expect(nearNeighbor.message).toContain('missing: File[type]');
  });

  it('refuses a profile identity that conflicts with the runtime binding for the same type lane', () => {
    const failure = captureBackendEmissionFailure(() =>
      compile(response('ArrayBuffer'), [createBinding('ArrayBuffer', 'type')]),
    );

    expect(failure).toMatchObject({ rule: 'cpp-runtime-external-symbol-binding-incomplete' });
    expect(failure.message).toContain('duplicate: ArrayBuffer[type]');
  });
});
