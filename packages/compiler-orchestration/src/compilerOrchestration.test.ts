import ts from 'typescript';

import { isCompilerInvariantFailure } from '../../compiler-emission/src/index.js';
import type { CompilerBackend, CompilerDiagnostic, IrModule } from '../../compiler-types/src/index.js';
import {
  compileIrModules,
  compileTypeScriptModules,
  createCompilerDiagnosticsFailure,
  isCompilerDiagnosticsFailure,
  parseTypeScriptSource,
} from './compilerOrchestration.js';

const fixtureBackend: CompilerBackend = {
  emitModule: (module) => [{ contents: `${module.packageName}:${module.name}`, path: `${module.name}.txt` }],
  name: 'fixture',
};

describe('compileIrModules', () => {
  it('orders modules and emitted files deterministically without mutating caller input', () => {
    const zeta = createModule('Zeta');
    const alpha = createModule('Alpha');
    const modules = [zeta, alpha];

    const result = compileIrModules({ backend: fixtureBackend, backendOptions: {}, modules });

    expect(result.compilation.files.map((file) => file.path)).toEqual(['Alpha.txt', 'Zeta.txt']);
    expect(result.report).toEqual({
      backend: 'fixture',
      emittedFiles: 2,
      modules: 2,
      schema: 'flight-compiler-report/1',
    });
    expect(modules).toEqual([zeta, alpha]);
  });

  it('returns inspectable invariant failures for duplicate module and output identities', () => {
    const module = createModule('Value');

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
});

describe('compileTypeScriptModules', () => {
  it('lowers TypeScript sources through the same deterministic backend path', () => {
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
    expect(result.diagnostics).toEqual([]);
  });

  it('throws a tagged diagnostics failure instead of emitting partial output', () => {
    const sourceFile = parseTypeScriptSource(
      '/flight/packages/math/src/destructure.ts',
      'export function read({ value }: { value: number }): number { return value; }',
    );

    expect(() =>
      compileTypeScriptModules({
        backend: fixtureBackend,
        backendOptions: {},
        sources: [{ packageName: '@flighthq/math', sourceFile, upstreamDirectory: '/flight' }],
      }),
    ).toThrow(expect.objectContaining({ kind: 'compiler-diagnostics', name: 'CompilerDiagnosticsError' }));
  });
});

describe('createCompilerDiagnosticsFailure', () => {
  it('creates a deterministic inspectable failure for ordered diagnostics', () => {
    const diagnostics: CompilerDiagnostic[] = [
      { code: 'TS0001', column: 3, line: 2, message: 'unsupported', source: 'value.ts' },
    ];

    const failure = createCompilerDiagnosticsFailure(diagnostics);

    expect(failure).toBeInstanceOf(Error);
    expect(failure.diagnostics).toBe(diagnostics);
    expect(failure.message).toContain('value.ts:2:3 [TS0001] unsupported');
    expect(failure).toMatchObject({ kind: 'compiler-diagnostics', name: 'CompilerDiagnosticsError' });
  });
});

describe('isCompilerDiagnosticsFailure', () => {
  it('accepts produced failures and rejects tagged non-Error lookalikes', () => {
    const failure = createCompilerDiagnosticsFailure([]);

    expect(isCompilerDiagnosticsFailure(failure)).toBe(true);
    expect(isCompilerDiagnosticsFailure({ kind: 'compiler-diagnostics' })).toBe(false);
    expect(isCompilerDiagnosticsFailure(new Error('plain'))).toBe(false);
  });
});

describe('parseTypeScriptSource', () => {
  it('selects TS and TSX parsing from the source extension', () => {
    expect(parseTypeScriptSource('/flight/value.ts', 'const value = 1;').languageVariant).toBe(
      ts.LanguageVariant.Standard,
    );
    expect(parseTypeScriptSource('/flight/component.tsx', 'const view = <div />;').languageVariant).toBe(
      ts.LanguageVariant.JSX,
    );
  });
});

function createModule(name: string): IrModule {
  return {
    declarations: [],
    exports: [],
    imports: [],
    name,
    packageName: '@flighthq/math',
    source: `packages/math/src/${name.toLowerCase()}.ts`,
  };
}
