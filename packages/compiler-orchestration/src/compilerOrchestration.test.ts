import ts from 'typescript';

import { isCompilerInvariantFailure } from '../../compiler-emission/src/index.js';
import type { CompilerBackend } from '../../compiler-types/src/index.js';
import {
  compileIrModules,
  compileTypeScriptModules,
  isCompilerDiagnosticsFailure,
  parseTypeScriptSource,
} from './index.js';

const fixtureBackend: CompilerBackend = {
  emitModule: (module) => [{ contents: `${module.packageName}:${module.name}`, path: `${module.name}.txt` }],
  name: 'fixture',
};

describe('compiler orchestration', () => {
  it('lowers, orders, and emits modules deterministically through a backend function record', () => {
    const result = compileTypeScriptModules({
      backend: fixtureBackend,
      backendOptions: {},
      sources: [
        {
          packageName: '@flighthq/math',
          sourceFile: parseTypeScriptSource('/flight/packages/math/src/zeta.ts', 'export const value = 1;'),
          upstreamDirectory: '/flight',
        },
        {
          packageName: '@flighthq/math',
          sourceFile: parseTypeScriptSource('/flight/packages/math/src/alpha.ts', 'export const value = 1;'),
          upstreamDirectory: '/flight',
        },
      ],
    });

    expect(result.compilation.files.map((file) => file.path)).toEqual(['Alpha.txt', 'Zeta.txt']);
    expect(result.report).toEqual({
      backend: 'fixture',
      emittedFiles: 2,
      modules: 2,
      schema: 'flight-compiler-report/1',
    });
  });

  it('returns inspectable lowering failures without a class hierarchy', () => {
    const sourceFile = parseTypeScriptSource(
      '/flight/packages/math/src/destructure.ts',
      'export function read({ value }: { value: number }): number { return value; }',
    );

    try {
      compileTypeScriptModules({
        backend: fixtureBackend,
        backendOptions: {},
        sources: [{ packageName: '@flighthq/math', sourceFile, upstreamDirectory: '/flight' }],
      });
      expect.unreachable('Expected semantic lowering to fail');
    } catch (error) {
      expect(isCompilerDiagnosticsFailure(error)).toBe(true);
      expect(error).toMatchObject({ kind: 'compiler-diagnostics', name: 'CompilerDiagnosticsError' });
    }
  });

  it('returns inspectable invariant failures for duplicate module and output identities', () => {
    const module = {
      declarations: [],
      exports: [],
      imports: [],
      name: 'Value',
      packageName: '@flighthq/math',
      source: 'packages/math/src/value.ts',
    };

    try {
      compileIrModules({ backend: fixtureBackend, backendOptions: {}, modules: [module, module] });
      expect.unreachable('Expected duplicate module identities to fail');
    } catch (error) {
      expect(isCompilerInvariantFailure(error)).toBe(true);
      expect(error).toMatchObject({
        code: 'duplicate-module-identity',
        kind: 'compiler-invariant',
        subject: '@flighthq/math/packages/math/src/value.ts#Value',
      });
    }

    const duplicatePathBackend: CompilerBackend = {
      emitModule: () => [{ contents: '', path: 'Value.txt' }],
      name: 'duplicate-path-fixture',
    };
    try {
      compileIrModules({
        backend: duplicatePathBackend,
        backendOptions: {},
        modules: [module, { ...module, name: 'Other' }],
      });
      expect.unreachable('Expected duplicate emitted paths to fail');
    } catch (error) {
      expect(isCompilerInvariantFailure(error)).toBe(true);
      expect(error).toMatchObject({
        code: 'duplicate-emitted-path',
        kind: 'compiler-invariant',
        subject: 'Value.txt',
      });
    }
  });

  it('selects TSX parsing from the source extension', () => {
    expect(parseTypeScriptSource('/flight/component.tsx', 'const view = <div />;').languageVariant).toBe(
      ts.LanguageVariant.JSX,
    );
  });
});
