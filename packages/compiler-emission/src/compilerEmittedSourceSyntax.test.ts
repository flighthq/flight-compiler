import type {
  CompilerEmittedSourceParser,
  CompilerEmittedSourceParserDiagnostic,
  EmittedFile,
} from '../../compiler-types/src/index.js';
import {
  isCompilerEmittedSourceSyntaxFailure,
  validateCompilerEmittedSourceSyntax,
} from './compilerEmittedSourceSyntax.js';
import { isCompilerInvariantFailure } from './compilerSourceEmission.js';

describe('isCompilerEmittedSourceSyntaxFailure', () => {
  it('accepts complete produced failures and rejects lookalikes with malformed diagnostics', () => {
    const failure = captureFailure(
      [{ contents: 'invalid', path: 'Value.rs' }],
      createParser(() => [{ code: 'syntax', column: 2, line: 1, message: 'expected expression' }]),
    );
    const malformed = Object.assign(new Error('forged'), {
      diagnostics: [{ code: 'syntax', column: 0, line: 1, message: 'bad', path: 'Value.rs' }],
      kind: 'emitted-source-syntax',
      parser: 'fixture-parser',
    });

    expect(isCompilerEmittedSourceSyntaxFailure(failure)).toBe(true);
    expect(isCompilerEmittedSourceSyntaxFailure(malformed)).toBe(false);
    expect(isCompilerEmittedSourceSyntaxFailure(new Error('plain'))).toBe(false);
    expect(
      isCompilerEmittedSourceSyntaxFailure({
        diagnostics: [],
        kind: 'emitted-source-syntax',
        parser: 'fixture-parser',
      }),
    ).toBe(false);
  });

  it('rejects a failure whose parser name is an empty string', () => {
    const emptyParser = Object.assign(new Error('forged'), {
      diagnostics: [{ code: 'syntax', column: 1, line: 1, message: 'bad', path: 'Value.rs' }],
      kind: 'emitted-source-syntax',
      parser: '',
    });

    expect(isCompilerEmittedSourceSyntaxFailure(emptyParser)).toBe(false);
  });

  it('rejects a diagnostic with an empty code, message, or path', () => {
    const withEmpty = (override: Record<string, unknown>) =>
      Object.assign(new Error('forged'), {
        diagnostics: [{ code: 'syntax', column: 1, line: 1, message: 'ok', path: 'Value.rs', ...override }],
        kind: 'emitted-source-syntax',
        parser: 'fixture-parser',
      });

    expect(isCompilerEmittedSourceSyntaxFailure(withEmpty({ code: '' }))).toBe(false);
    expect(isCompilerEmittedSourceSyntaxFailure(withEmpty({ message: '' }))).toBe(false);
    expect(isCompilerEmittedSourceSyntaxFailure(withEmpty({ path: '' }))).toBe(false);
  });
});

describe('validateCompilerEmittedSourceSyntax', () => {
  it('normalizes and freezes supported Haxe and Rust files while leaving caller values unchanged', () => {
    const files = [
      { contents: 'class Value {}\r\n\r\n', path: 'generated\\Value.hx' },
      { contents: 'pub struct Value {}\r\n', path: 'generated\\value.rs' },
      { contents: 'metadata', path: 'generated/value.txt' },
    ];
    const snapshot = structuredClone(files);
    const seen: EmittedFile[] = [];
    const parser = createParser((file) => {
      seen.push(file);
      expect(Object.isFrozen(file)).toBe(true);
      expect(() => Object.assign(file, { path: 'changed' })).toThrow(TypeError);
      return [];
    });

    expect(validateCompilerEmittedSourceSyntax(files, parser)).toEqual({
      checkedFiles: 2,
      parser: 'fixture-parser',
      skippedFiles: ['generated/value.txt'],
    });
    expect(seen).toEqual([
      { contents: 'class Value {}\n', path: 'generated/Value.hx' },
      { contents: 'pub struct Value {}\n', path: 'generated/value.rs' },
    ]);
    expect(files).toEqual(snapshot);
    expect(validateCompilerEmittedSourceSyntax([{ contents: '', path: 'metadata.txt' }], parser)).toEqual({
      checkedFiles: 0,
      parser: 'fixture-parser',
      skippedFiles: ['metadata.txt'],
    });
  });

  it('orders, normalizes, captures, and reports parser diagnostics deterministically', () => {
    const late = { code: 'zeta', column: 3, line: 2, message: 'late' };
    const parser = createParser((file) =>
      file.path === 'Zulu.rs'
        ? [late]
        : [
            { code: 'e\u0301', column: 2, line: 1, message: 'decomposed e\u0301' },
            { code: 'alpha', column: 1, line: 1, message: 'early' },
            { code: 'beta', column: 3, line: 1, message: 'different code' },
            { code: 'same', column: 3, line: 1, message: 'Zulu' },
            { code: 'same', column: 3, line: 1, message: 'alpha' },
          ],
    );
    const failure = captureFailure(
      [
        { contents: 'late', path: 'Zulu.rs' },
        { contents: 'early', path: 'Alpha.hx' },
      ],
      parser,
    );

    expect(failure).toBeInstanceOf(Error);
    expect(failure).toMatchObject({
      kind: 'emitted-source-syntax',
      name: 'CompilerEmittedSourceSyntaxError',
      parser: 'fixture-parser',
    });
    expect(failure.diagnostics).toEqual([
      { code: 'alpha', column: 1, line: 1, message: 'early', path: 'Alpha.hx' },
      { code: 'é', column: 2, line: 1, message: 'decomposed é', path: 'Alpha.hx' },
      { code: 'beta', column: 3, line: 1, message: 'different code', path: 'Alpha.hx' },
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

  it('sorts by path before line when path and line orders disagree', () => {
    const parser = createParser((file) =>
      file.path === 'Alpha.rs'
        ? [{ code: 'err', column: 1, line: 5, message: 'late line' }]
        : [{ code: 'err', column: 1, line: 1, message: 'early line' }],
    );
    const failure = captureFailure(
      [
        { contents: 'alpha', path: 'Alpha.rs' },
        { contents: 'zulu', path: 'Zulu.rs' },
      ],
      parser,
    );

    expect(failure.diagnostics[0]?.path).toBe('Alpha.rs');
    expect(failure.diagnostics[0]?.line).toBe(5);
    expect(failure.diagnostics[1]?.path).toBe('Zulu.rs');
    expect(failure.diagnostics[1]?.line).toBe(1);
  });

  it('refuses malformed parser identities, support decisions, results, and diagnostics as invariants', () => {
    const file = [{ contents: 'value', path: 'Value.rs' }];
    const invalidParsers = [
      { ...createParser(() => []), name: '' },
      { ...createParser(() => []), name: ' padded ' },
      { ...createParser(() => []), name: 'multi\nline' },
      { ...createParser(() => []), name: 42 as unknown as string },
      { ...createParser(() => []), supportsEmittedSource: () => 'yes' as unknown as boolean },
      { ...createParser(() => []), parseEmittedSource: () => ({}) as readonly CompilerEmittedSourceParserDiagnostic[] },
    ];

    for (const parser of invalidParsers) {
      expect(() => validateCompilerEmittedSourceSyntax(file, parser)).toThrow(
        expect.objectContaining({ code: 'invalid-emitted-source-parser', kind: 'compiler-invariant' }),
      );
    }

    const nonStringName = invalidParsers.find((p) => typeof p.name !== 'string')!;
    try {
      validateCompilerEmittedSourceSyntax(file, nonStringName);
      expect.unreachable('Expected non-string parser name to fail');
    } catch (error) {
      expect(error).toMatchObject({ subject: '<non-string>' });
    }
    const emptyName = invalidParsers.find((p) => p.name === '')!;
    try {
      validateCompilerEmittedSourceSyntax(file, emptyName);
      expect.unreachable('Expected empty parser name to fail');
    } catch (error) {
      expect(error).toMatchObject({ subject: '' });
    }

    for (const diagnostic of [
      { code: '', column: 1, line: 1, message: 'missing code' },
      { code: 'syntax', column: 0, line: 1, message: 'bad column' },
      { code: 'syntax', column: 1, line: Number.NaN, message: 'bad line' },
      { code: 'syntax', column: 1, line: 1, message: '' },
    ]) {
      try {
        validateCompilerEmittedSourceSyntax(
          file,
          createParser(() => [diagnostic]),
        );
        expect.unreachable('Expected malformed parser diagnostic to fail');
      } catch (error) {
        expect(isCompilerInvariantFailure(error)).toBe(true);
        expect(error).toMatchObject({
          code: 'invalid-emitted-source-syntax-diagnostic',
          kind: 'compiler-invariant',
          subject: 'fixture-parser/Value.rs#0',
        });
      }
    }
  });
});

function captureFailure(files: readonly EmittedFile[], parser: Readonly<CompilerEmittedSourceParser>) {
  try {
    validateCompilerEmittedSourceSyntax(files, parser);
    throw new Error('Expected emitted-source syntax to fail');
  } catch (error) {
    if (!isCompilerEmittedSourceSyntaxFailure(error)) throw error;
    return error;
  }
}

function createParser(
  parseEmittedSource: CompilerEmittedSourceParser['parseEmittedSource'],
): CompilerEmittedSourceParser {
  return {
    name: 'fixture-parser',
    parseEmittedSource,
    supportsEmittedSource: (file) => /\.(?:hx|rs)$/u.test(file.path),
  };
}
