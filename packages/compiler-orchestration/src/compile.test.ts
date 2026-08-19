import ts from 'typescript';

import type { CompilerBackend } from '../../compiler-types/src/index.js';
import { compileTypeScriptModules, isCompilerDiagnosticsError, parseTypeScriptSource } from './index.js';

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
      expect(isCompilerDiagnosticsError(error)).toBe(true);
      expect(error).toMatchObject({ kind: 'compiler-diagnostics', name: 'CompilerDiagnosticsError' });
    }
  });

  it('selects TSX parsing from the source extension', () => {
    expect(parseTypeScriptSource('/flight/component.tsx', 'const view = <div />;').languageVariant).toBe(
      ts.LanguageVariant.JSX,
    );
  });
});
