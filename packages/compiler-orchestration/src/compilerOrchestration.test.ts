import ts from 'typescript';

import {
  isCompilerEmittedSourceSyntaxFailure,
  isCompilerInvariantFailure,
  isCompilerTargetCompilationSmokeFailure,
} from '../../compiler-emission/src/index.js';
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
  it('uses backend emission session when provided instead of per-module entry point', () => {
    const module = createModule('Value');
    const calls: string[] = [];
    const backend: CompilerBackend = {
      createEmissionSession: ({ modules }) => {
        calls.push(`session:${modules.length}`);
        return {
          emitModule(subject) {
            calls.push(`emit:${subject.name}`);
            return [{ contents: subject.name, path: `${subject.name}.txt` }];
          },
        };
      },
      emitModule: () => {
        calls.push('compat');
        return [{ contents: '', path: 'compat.txt' }];
      },
      name: 'session-fixture',
    };

    const result = compileIrModules({ backend, backendOptions: {}, modules: [module] });

    expect(calls).toEqual(['session:1', 'emit:Value']);
    expect(result.compilation.files.map((file) => file.path)).toEqual(['Value.txt']);
  });

  it('orders modules and emitted files deterministically without mutating caller input', () => {
    const zeta = createModule('Zeta');
    const alpha = createModule('Alpha');
    const modules = [zeta, alpha];
    const sortingBackend: CompilerBackend = {
      emitModule: (module) => [
        { contents: '', path: `${module.name}-Zeta.txt` },
        { contents: '', path: `${module.name}-Alpha.txt` },
      ],
      name: 'sorting-fixture',
    };

    const result = compileIrModules({ backend: sortingBackend, backendOptions: {}, modules });

    expect(result.compilation.files.map((file) => file.path)).toEqual([
      'Alpha-Alpha.txt',
      'Alpha-Zeta.txt',
      'Zeta-Alpha.txt',
      'Zeta-Zeta.txt',
    ]);
    expect(result.report).toEqual({
      backend: 'sorting-fixture',
      emittedFiles: 4,
      modules: 2,
      schema: 'flight-compiler-report/1',
    });
    expect(modules).toEqual([zeta, alpha]);
  });

  it('forwards explicit module-resolution evidence to every backend module context', () => {
    const module = createModule('Value');
    const resolution = {
      edges: [
        {
          specifier: '@flighthq/types',
          target: { packageName: '@flighthq/types', source: 'packages/types/src/index.ts' },
        },
      ],
      schema: 'flight-compiler-module-resolution/1',
    } as const;
    const contexts: unknown[] = [];
    const backend: CompilerBackend = {
      emitModule: (subject, context) => {
        contexts.push(context);
        return [{ contents: '', path: `${subject.name}.txt` }];
      },
      name: 'resolution-fixture',
    };

    compileIrModules({ backend, backendOptions: {}, moduleResolution: resolution, modules: [module] });

    expect(contexts).toEqual([{ moduleResolution: resolution, modules: [module], options: {} }]);
  });

  it('orders module and emitted-path identities by code unit rather than host locale', () => {
    const modules = ['éclair', 'alpha', 'Zulu'].map((name) => ({
      ...createModule(name),
      source: 'packages/math/src/shared.ts',
    }));

    const result = compileIrModules({ backend: fixtureBackend, backendOptions: {}, modules });

    expect(result.compilation.files.map((file) => file.path)).toEqual(['Zulu.txt', 'alpha.txt', 'éclair.txt']);
    expect(modules.map((module) => module.name)).toEqual(['éclair', 'alpha', 'Zulu']);
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

  it('treats case and Unicode-equivalent portable paths as one emitted-file identity', () => {
    const cases = [
      {
        firstPath: 'generated/Value.txt',
        secondPath: 'generated/value.txt',
        subject: 'generated/value.txt',
      },
      {
        firstPath: 'generated/café.txt',
        secondPath: 'generated/cafe\u0301.txt',
        subject: 'generated/café.txt',
      },
    ];

    for (const fixture of cases) {
      const backend: CompilerBackend = {
        emitModule: (module) => [
          {
            contents: '',
            path: module.name === 'Alpha' ? fixture.firstPath : fixture.secondPath,
          },
        ],
        name: 'portable-path-fixture',
      };
      try {
        compileIrModules({
          backend,
          backendOptions: {},
          modules: [createModule('Alpha'), createModule('Beta')],
        });
        expect.unreachable('Expected portable path identities to collide');
      } catch (error) {
        expect(isCompilerInvariantFailure(error)).toBe(true);
        expect(error).toMatchObject({
          code: 'duplicate-emitted-path',
          kind: 'compiler-invariant',
          subject: fixture.subject,
        });
      }
    }
  });

  it('optionally rejects normalized backend output through an emitted-source parser', () => {
    const seen: string[] = [];
    const sourceParser = {
      name: 'fixture-language-parser',
      parseEmittedSource(file: Readonly<{ contents: string; path: string }>) {
        seen.push(`${file.path}:${file.contents}`);
        return [{ code: 'syntax', column: 2, line: 1, message: 'expected declaration' }];
      },
      supportsEmittedSource: (file: Readonly<{ path: string }>) => file.path.endsWith('.txt'),
    };

    try {
      compileIrModules({
        backend: fixtureBackend,
        backendOptions: {},
        modules: [createModule('Value')],
        sourceParser,
      });
      expect.unreachable('Expected parser syntax to reject emitted output');
    } catch (error) {
      expect(isCompilerEmittedSourceSyntaxFailure(error)).toBe(true);
      expect(error).toMatchObject({
        diagnostics: [{ code: 'syntax', path: 'Value.txt' }],
        kind: 'emitted-source-syntax',
        parser: 'fixture-language-parser',
      });
    }
    expect(seen).toEqual(['Value.txt:@flighthq/math:Value\n']);

    expect(() =>
      compileIrModules({
        backend: fixtureBackend,
        backendOptions: {},
        modules: [createModule('Value')],
        sourceParser: { ...sourceParser, supportsEmittedSource: () => false },
      }),
    ).toThrow(
      expect.objectContaining({
        code: 'insufficient-emitted-source-syntax-files',
        kind: 'compiler-invariant',
        subject: 'fixture-language-parser',
      }),
    );
    expect(
      compileIrModules({
        backend: fixtureBackend,
        backendOptions: {},
        modules: [],
        sourceParser: { ...sourceParser, supportsEmittedSource: () => false },
      }).compilation.files,
    ).toEqual([]);
  });

  it('distinguishes syntax parsing from one downstream target compilation smoke', () => {
    const events: string[] = [];
    const sourceParser = {
      name: 'fixture-parser',
      parseEmittedSource(file: Readonly<{ path: string }>) {
        events.push(`parse:${file.path}`);
        return [];
      },
      supportsEmittedSource: (file: Readonly<{ path: string }>) => file.path.endsWith('.txt'),
    };
    const targetCompilationSmoke = {
      compileEmittedSources(files: readonly Readonly<{ contents: string; path: string }>[]) {
        events.push(`compile:${files.map((file) => file.path).join(',')}`);
        return [{ code: 'type', column: 1, line: 1, message: 'unknown value', path: 'Value.txt' }];
      },
      name: 'fixture-compiler',
      supportsEmittedSource: (file: Readonly<{ path: string }>) => file.path.endsWith('.txt'),
    };

    try {
      compileIrModules({
        backend: fixtureBackend,
        backendOptions: {},
        modules: [createModule('Value')],
        sourceParser,
        targetCompilationSmoke,
      });
      expect.unreachable('Expected target compilation smoke to reject emitted output');
    } catch (error) {
      expect(isCompilerTargetCompilationSmokeFailure(error)).toBe(true);
      expect(error).toMatchObject({
        compiler: 'fixture-compiler',
        diagnostics: [{ code: 'type', path: 'Value.txt' }],
        kind: 'target-compilation-smoke',
      });
    }
    expect(events).toEqual(['parse:Value.txt', 'compile:Value.txt']);

    expect(() =>
      compileIrModules({
        backend: fixtureBackend,
        backendOptions: {},
        modules: [createModule('Value')],
        targetCompilationSmoke: { ...targetCompilationSmoke, supportsEmittedSource: () => false },
      }),
    ).toThrow(
      expect.objectContaining({
        code: 'insufficient-target-compilation-smoke-files',
        kind: 'compiler-invariant',
        subject: 'fixture-compiler',
      }),
    );
    expect(
      compileIrModules({
        backend: fixtureBackend,
        backendOptions: {},
        modules: [],
        targetCompilationSmoke: { ...targetCompilationSmoke, supportsEmittedSource: () => false },
      }).compilation.files,
    ).toEqual([]);
  });
});

describe('compileTypeScriptModules', () => {
  it('lowers TypeScript sources through the same deterministic backend path', () => {
    const parsedPaths: string[] = [];
    const compiledPaths: string[][] = [];
    const result = compileTypeScriptModules({
      backend: fixtureBackend,
      backendOptions: {},
      moduleResolution: { edges: [], schema: 'flight-compiler-module-resolution/1' },
      sourceParser: {
        name: 'fixture-language-parser',
        parseEmittedSource(file) {
          parsedPaths.push(file.path);
          return [];
        },
        supportsEmittedSource: () => true,
      },
      targetCompilationSmoke: {
        compileEmittedSources(files) {
          compiledPaths.push(files.map((file) => file.path));
          return [];
        },
        name: 'fixture-compiler',
        supportsEmittedSource: () => true,
      },
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
    expect(parsedPaths).toEqual(['Alpha.txt', 'Zeta.txt']);
    expect(compiledPaths).toEqual([['Alpha.txt', 'Zeta.txt']]);
  });

  it('forwards optional patches and omits absent optional fields without diagnostics', () => {
    const result = compileTypeScriptModules({
      backend: fixtureBackend,
      backendOptions: {},
      patches: [],
      sources: [
        {
          packageName: '@flighthq/math',
          sourceFile: parseTypeScriptSource('/flight/packages/math/src/value.ts', 'export const value = 1;'),
          upstreamDirectory: '/flight',
        },
      ],
    });

    expect(result.compilation.files).toHaveLength(1);
    expect(result.diagnostics).toEqual([]);
  });

  it('throws a tagged diagnostics failure instead of emitting partial output', () => {
    const sourceFile = parseTypeScriptSource(
      '/flight/packages/math/src/destructure.ts',
      'export function read(): void { let rest = {}; ({ ...rest } = { value: 1 }); }',
    );

    expect(() =>
      compileTypeScriptModules({
        backend: fixtureBackend,
        backendOptions: {},
        sources: [{ packageName: '@flighthq/math', sourceFile, upstreamDirectory: '/flight' }],
      }),
    ).toThrow(expect.objectContaining({ kind: 'compiler-diagnostics', name: 'CompilerDiagnosticsError' }));
  });

  it('emits modules whose only diagnostics are warning-severity type alias failures', () => {
    const sourceFile = parseTypeScriptSource(
      '/flight/packages/math/src/types.ts',
      'export type Mapped<T> = { [K in keyof T]: T[K] }; export const value = 1;',
    );

    const result = compileTypeScriptModules({
      backend: fixtureBackend,
      backendOptions: {},
      sources: [{ packageName: '@flighthq/math', sourceFile, upstreamDirectory: '/flight' }],
    });

    expect(result.compilation.files).toHaveLength(1);
    expect(result.diagnostics).toEqual([]);
  });
});

describe('createCompilerDiagnosticsFailure', () => {
  it('orders and clones globally identified diagnostics without retaining caller input', () => {
    const late = {
      code: 'unsupported-typescript' as const,
      column: 3,
      line: 2,
      message: 'late',
      packageName: '@flighthq/math',
      severity: 'error' as const,
      source: 'value.ts',
    };
    const early = {
      code: 'unsupported-typescript' as const,
      column: 1,
      line: 1,
      message: 'early',
      packageName: '@flighthq/core',
      severity: 'error' as const,
      source: 'index.ts',
    };
    const diagnostics: CompilerDiagnostic[] = [late, early];

    const failure = createCompilerDiagnosticsFailure(diagnostics);

    expect(failure).toBeInstanceOf(Error);
    expect(failure.diagnostics).not.toBe(diagnostics);
    expect(failure.diagnostics).toEqual([early, late]);
    expect(failure.message).toContain('@flighthq/core/index.ts:1:1 [unsupported-typescript] early');
    expect(failure).toMatchObject({ kind: 'compiler-diagnostics', name: 'CompilerDiagnosticsError' });

    diagnostics.reverse();
    late.message = 'changed';
    expect(failure.diagnostics).toEqual([early, { ...late, message: 'late' }]);
  });

  it('orders diagnostic identities by code unit rather than host locale', () => {
    const createDiagnostic = (packageName: string, message: string): CompilerDiagnostic => ({
      code: 'unsupported-typescript',
      column: 1,
      line: 1,
      message,
      packageName,
      severity: 'error',
      source: 'shared.ts',
    });
    const diagnostics = [
      createDiagnostic('@flighthq/éclair', 'éclair'),
      createDiagnostic('@flighthq/alpha', 'alpha'),
      createDiagnostic('@flighthq/Zulu', 'Zulu'),
    ];

    expect(
      createCompilerDiagnosticsFailure(diagnostics).diagnostics.map((diagnostic) => diagnostic.packageName),
    ).toEqual(['@flighthq/Zulu', '@flighthq/alpha', '@flighthq/éclair']);
    expect(
      createCompilerDiagnosticsFailure([
        createDiagnostic('@flighthq/shared', 'éclair'),
        createDiagnostic('@flighthq/shared', 'alpha'),
        createDiagnostic('@flighthq/shared', 'Zulu'),
      ]).diagnostics.map((diagnostic) => diagnostic.message),
    ).toEqual(['Zulu', 'alpha', 'éclair']);
  });
});

describe('isCompilerDiagnosticsFailure', () => {
  it('accepts complete produced failures and rejects malformed diagnostics', () => {
    const failure = createCompilerDiagnosticsFailure([]);
    const diagnostic = {
      code: 'unsupported-typescript',
      column: 1,
      line: 1,
      message: 'unsupported',
      packageName: '@flighthq/math',
      source: 'value.ts',
    };
    const unknownCode = Object.assign(new Error('forged'), {
      diagnostics: [{ ...diagnostic, code: 'future-code' }],
      kind: 'compiler-diagnostics',
    });
    const missingPackage = Object.assign(new Error('forged'), {
      diagnostics: [{ code: 'unsupported-typescript', column: 1, line: 1, message: 'unsupported', source: 'value.ts' }],
      kind: 'compiler-diagnostics',
    });
    const invalidLocation = Object.assign(new Error('forged'), {
      diagnostics: [{ ...diagnostic, line: 0 }],
      kind: 'compiler-diagnostics',
    });

    expect(isCompilerDiagnosticsFailure(failure)).toBe(true);
    expect(isCompilerDiagnosticsFailure({ kind: 'compiler-diagnostics' })).toBe(false);
    expect(isCompilerDiagnosticsFailure(new Error('plain'))).toBe(false);
    expect(isCompilerDiagnosticsFailure(unknownCode)).toBe(false);
    expect(isCompilerDiagnosticsFailure(missingPackage)).toBe(false);
    expect(isCompilerDiagnosticsFailure(invalidLocation)).toBe(false);

    const numericPackage = Object.assign(new Error('forged'), {
      diagnostics: [{ ...diagnostic, packageName: 42 }],
      kind: 'compiler-diagnostics',
    });
    const missingSource = Object.assign(new Error('forged'), {
      diagnostics: [
        { code: 'unsupported-typescript', column: 1, line: 1, message: 'unsupported', packageName: '@flighthq/math' },
      ],
      kind: 'compiler-diagnostics',
    });
    const numericSource = Object.assign(new Error('forged'), {
      diagnostics: [{ ...diagnostic, source: 42 }],
      kind: 'compiler-diagnostics',
    });
    expect(isCompilerDiagnosticsFailure(numericPackage)).toBe(false);
    expect(isCompilerDiagnosticsFailure(missingSource)).toBe(false);
    expect(isCompilerDiagnosticsFailure(numericSource)).toBe(false);
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
