import type {
  CompilerTargetCompilationSmoke,
  CompilerTargetCompilationSmokeDiagnostic,
  EmittedFile,
} from '../../compiler-types/src/index.js';
import { isCompilerInvariantFailure } from './compilerSourceEmission.js';
import {
  isCompilerTargetCompilationSmokeFailure,
  validateCompilerTargetCompilationSmoke,
} from './compilerTargetCompilationSmoke.js';

describe('isCompilerTargetCompilationSmokeFailure', () => {
  it('accepts complete produced failures and rejects plain or malformed lookalikes', () => {
    const failure = captureFailure(
      [{ contents: 'invalid', path: 'Value.rs' }],
      createCompiler(() => [{ code: 'type', column: 2, line: 1, message: 'expected value', path: 'Value.rs' }]),
    );
    const malformed = Object.assign(new Error('forged'), {
      compiler: 'fixture-compiler',
      diagnostics: [{ code: 'type', column: 0, line: 1, message: 'bad', path: 'Value.rs' }],
      kind: 'target-compilation-smoke',
    });

    expect(isCompilerTargetCompilationSmokeFailure(failure)).toBe(true);
    expect(isCompilerTargetCompilationSmokeFailure(malformed)).toBe(false);
    expect(isCompilerTargetCompilationSmokeFailure(new Error('plain'))).toBe(false);
    expect(
      isCompilerTargetCompilationSmokeFailure({
        compiler: 'fixture-compiler',
        diagnostics: [],
        kind: 'target-compilation-smoke',
      }),
    ).toBe(false);
  });

  it('rejects a failure whose compiler name is an empty string', () => {
    const emptyCompiler = Object.assign(new Error('forged'), {
      compiler: '',
      diagnostics: [{ code: 'type', column: 1, line: 1, message: 'bad', path: 'Value.rs' }],
      kind: 'target-compilation-smoke',
    });

    expect(isCompilerTargetCompilationSmokeFailure(emptyCompiler)).toBe(false);
  });

  it('rejects a diagnostic with an empty code, message, or path', () => {
    const withEmpty = (override: Record<string, unknown>) =>
      Object.assign(new Error('forged'), {
        compiler: 'fixture-compiler',
        diagnostics: [{ code: 'type', column: 1, line: 1, message: 'ok', path: 'Value.rs', ...override }],
        kind: 'target-compilation-smoke',
      });

    expect(isCompilerTargetCompilationSmokeFailure(withEmpty({ code: '' }))).toBe(false);
    expect(isCompilerTargetCompilationSmokeFailure(withEmpty({ message: '' }))).toBe(false);
    expect(isCompilerTargetCompilationSmokeFailure(withEmpty({ path: '' }))).toBe(false);
  });
});

describe('validateCompilerTargetCompilationSmoke', () => {
  it('normalizes and freezes one complete supported file set without changing caller values', () => {
    const files = [
      { contents: 'class Value {}\r\n\r\n', path: 'generated\\Value.hx' },
      { contents: 'pub struct Value {}\r\n', path: 'generated\\value.rs' },
      { contents: 'metadata', path: 'generated/value.txt' },
    ];
    const snapshot = structuredClone(files);
    const compilations: Array<readonly Readonly<EmittedFile>[]> = [];
    const compiler = createCompiler((compiled) => {
      compilations.push(compiled);
      expect(Object.isFrozen(compiled)).toBe(true);
      expect(compiled.every(Object.isFrozen)).toBe(true);
      expect(() => Object.assign(compiled[0]!, { path: 'changed' })).toThrow(TypeError);
      return [];
    });

    expect(validateCompilerTargetCompilationSmoke(files, compiler)).toEqual({
      checkedFiles: 2,
      compiler: 'fixture-compiler',
      skippedFiles: ['generated/value.txt'],
    });
    expect(compilations).toEqual([
      [
        { contents: 'class Value {}\n', path: 'generated/Value.hx' },
        { contents: 'pub struct Value {}\n', path: 'generated/value.rs' },
      ],
    ]);
    expect(files).toEqual(snapshot);

    let calls = 0;
    const unsupported = createCompiler(() => {
      calls += 1;
      return [];
    });
    expect(validateCompilerTargetCompilationSmoke([{ contents: '', path: 'metadata.txt' }], unsupported)).toEqual({
      checkedFiles: 0,
      compiler: 'fixture-compiler',
      skippedFiles: ['metadata.txt'],
    });
    expect(calls).toBe(0);
  });

  it('orders, normalizes, captures, and reports compiler diagnostics deterministically', () => {
    const late = { code: 'zeta', column: 3, line: 2, message: 'late', path: 'Zulu.rs' };
    const compiler = createCompiler(() => [
      late,
      { code: 'e\u0301', column: 2, line: 1, message: 'decomposed e\u0301', path: 'Alpha.hx' },
      { code: 'alpha', column: 1, line: 1, message: 'early', path: 'Alpha.hx' },
      { code: 'same', column: 3, line: 1, message: 'Zulu', path: 'Alpha.hx' },
      { code: 'same', column: 3, line: 1, message: 'alpha', path: 'Alpha.hx' },
    ]);
    const failure = captureFailure(
      [
        { contents: 'late', path: 'Zulu.rs' },
        { contents: 'early', path: 'Alpha.hx' },
      ],
      compiler,
    );

    expect(failure).toMatchObject({
      compiler: 'fixture-compiler',
      kind: 'target-compilation-smoke',
      name: 'CompilerTargetCompilationSmokeError',
    });
    expect(failure.diagnostics).toEqual([
      { code: 'alpha', column: 1, line: 1, message: 'early', path: 'Alpha.hx' },
      { code: 'é', column: 2, line: 1, message: 'decomposed é', path: 'Alpha.hx' },
      { code: 'same', column: 3, line: 1, message: 'Zulu', path: 'Alpha.hx' },
      { code: 'same', column: 3, line: 1, message: 'alpha', path: 'Alpha.hx' },
      { code: 'zeta', column: 3, line: 2, message: 'late', path: 'Zulu.rs' },
    ]);
    expect(failure.message).toContain('Alpha.hx:1:1 [alpha] early');
    expect(Object.isFrozen(failure.diagnostics)).toBe(true);
    expect(Object.isFrozen(failure.diagnostics[0])).toBe(true);
    late.message = 'changed';
    expect(failure.diagnostics.at(-1)?.message).toBe('late');
  });

  it('sorts by message when code is equal regardless of input order', () => {
    const compiler = createCompiler(() => [
      { code: 'same', column: 1, line: 1, message: 'beta', path: 'Value.rs' },
      { code: 'same', column: 1, line: 1, message: 'Alpha', path: 'Value.rs' },
    ]);
    const failure = captureFailure([{ contents: 'value', path: 'Value.rs' }], compiler);

    expect(failure.diagnostics[0]?.message).toBe('Alpha');
    expect(failure.diagnostics[1]?.message).toBe('beta');
  });

  it('sorts by path before line when path and line orders disagree', () => {
    const compiler = createCompiler(() => [
      { code: 'err', column: 1, line: 5, message: 'late line', path: 'Alpha.rs' },
      { code: 'err', column: 1, line: 1, message: 'early line', path: 'Zulu.rs' },
    ]);
    const failure = captureFailure(
      [
        { contents: 'alpha', path: 'Alpha.rs' },
        { contents: 'zulu', path: 'Zulu.rs' },
      ],
      compiler,
    );

    expect(failure.diagnostics[0]?.path).toBe('Alpha.rs');
    expect(failure.diagnostics[0]?.line).toBe(5);
    expect(failure.diagnostics[1]?.path).toBe('Zulu.rs');
    expect(failure.diagnostics[1]?.line).toBe(1);
  });

  it('refuses malformed adapter identities, support decisions, results, and diagnostics as invariants', () => {
    const files = [{ contents: 'value', path: 'Value.rs' }];
    const invalidCompilers = [
      { ...createCompiler(() => []), name: '' },
      { ...createCompiler(() => []), name: ' padded ' },
      { ...createCompiler(() => []), name: 'multi\nline' },
      { ...createCompiler(() => []), name: 42 as unknown as string },
      { ...createCompiler(() => []), supportsEmittedSource: () => 'yes' as unknown as boolean },
      {
        ...createCompiler(() => []),
        compileEmittedSources: () => ({}) as readonly CompilerTargetCompilationSmokeDiagnostic[],
      },
    ];

    for (const compiler of invalidCompilers) {
      expect(() => validateCompilerTargetCompilationSmoke(files, compiler)).toThrow(
        expect.objectContaining({ code: 'invalid-target-compilation-smoke-adapter', kind: 'compiler-invariant' }),
      );
    }

    const nonStringName = invalidCompilers.find((c) => typeof c.name !== 'string')!;
    try {
      validateCompilerTargetCompilationSmoke(files, nonStringName);
      expect.unreachable('Expected non-string compiler name to fail');
    } catch (error) {
      expect(error).toMatchObject({ subject: '<non-string>' });
    }
    const emptyName = invalidCompilers.find((c) => c.name === '')!;
    try {
      validateCompilerTargetCompilationSmoke(files, emptyName);
      expect.unreachable('Expected empty compiler name to fail');
    } catch (error) {
      expect(error).toMatchObject({ subject: '' });
    }

    for (const diagnostic of [
      undefined,
      null,
      {},
      { path: 1 },
      { code: '', column: 1, line: 1, message: 'missing code', path: 'Value.rs' },
      { code: 'type', column: 0, line: 1, message: 'bad column', path: 'Value.rs' },
      { code: 'type', column: 1, line: Number.NaN, message: 'bad line', path: 'Value.rs' },
      { code: 'type', column: 1, line: 1, message: '', path: 'Value.rs' },
      { code: 'type', column: 1, line: 1, message: 'unknown file', path: 'Other.rs' },
      { code: 'type', column: 1, line: 1, message: 'unsafe file', path: '../Value.rs' },
    ]) {
      try {
        validateCompilerTargetCompilationSmoke(
          files,
          createCompiler(() => [diagnostic as CompilerTargetCompilationSmokeDiagnostic]),
        );
        expect.unreachable('Expected malformed compiler diagnostic to fail');
      } catch (error) {
        expect(isCompilerInvariantFailure(error)).toBe(true);
        expect(error).toMatchObject({
          code: 'invalid-target-compilation-smoke-diagnostic',
          kind: 'compiler-invariant',
          subject: 'fixture-compiler#0',
        });
      }
    }
  });
});

function captureFailure(files: readonly EmittedFile[], compiler: Readonly<CompilerTargetCompilationSmoke>) {
  try {
    validateCompilerTargetCompilationSmoke(files, compiler);
    throw new Error('Expected target compilation smoke to fail');
  } catch (error) {
    if (!isCompilerTargetCompilationSmokeFailure(error)) throw error;
    return error;
  }
}

function createCompiler(
  compileEmittedSources: CompilerTargetCompilationSmoke['compileEmittedSources'],
): CompilerTargetCompilationSmoke {
  return {
    compileEmittedSources,
    name: 'fixture-compiler',
    supportsEmittedSource: (file) => /\.(?:hx|rs)$/u.test(file.path),
  };
}
