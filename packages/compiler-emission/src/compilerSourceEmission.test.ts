import {
  createBackendEmissionFailure,
  createCompilerInvariantFailure,
  convertEmittedFileContentsToUtf8,
  indentSourceLines,
  isBackendEmissionFailure,
  isCompilerInvariantFailure,
  normalizeEmittedFile,
  normalizeEmittedFileContents,
  normalizeEmittedFilePath,
  normalizeSourceTextGrouping,
} from './compilerSourceEmission.js';

describe('createBackendEmissionFailure', () => {
  it('creates an inspectable Error record with backend, code, and global source identity', () => {
    const failure = createBackendEmissionFailure(
      'haxe',
      { packageName: '@flighthq/math', source: 'packages/math/src/value.ts' },
      'unsupported',
    );

    expect(failure).toBeInstanceOf(Error);
    expect(failure.message).toBe('haxe emission failed for @flighthq/math/packages/math/src/value.ts: unsupported');
    expect(failure).toMatchObject({
      backend: 'haxe',
      code: 'unsupported-ir',
      kind: 'backend-emission',
      name: 'BackendEmissionError',
      packageName: '@flighthq/math',
      source: 'packages/math/src/value.ts',
    });
  });
});

describe('createCompilerInvariantFailure', () => {
  it('creates an inspectable Error record with stable code and subject identity', () => {
    const failure = createCompilerInvariantFailure('duplicate-emitted-path', 'Value.hx', 'duplicate');

    expect(failure).toBeInstanceOf(Error);
    expect(failure).toMatchObject({
      code: 'duplicate-emitted-path',
      kind: 'compiler-invariant',
      message: 'duplicate',
      name: 'CompilerInvariantError',
      subject: 'Value.hx',
    });
  });
});

describe('convertEmittedFileContentsToUtf8', () => {
  it('encodes normalized non-ASCII source as BOM-free UTF-8 bytes', () => {
    expect([...convertEmittedFileContentsToUtf8('const café = "😀";\r\n\r\n')]).toEqual([
      ...new TextEncoder().encode('const café = "😀";\n'),
    ]);
  });
});

describe('indentSourceLines', () => {
  it('indents nonempty lines without changing blank lines or caller input', () => {
    const lines = ['one', '', 'two'];

    expect(indentSourceLines(lines, 2)).toEqual(['    one', '', '    two']);
    expect(lines).toEqual(['one', '', 'two']);
    expect(indentSourceLines(['one', ''], 0)).toEqual(['one', '']);
    expect(indentSourceLines([])).toEqual([]);
  });

  it('fails loudly for an invalid negative indentation depth', () => {
    expect(() => indentSourceLines(['value'], -1)).toThrow(RangeError);
  });
});

describe('isBackendEmissionFailure', () => {
  it('accepts complete backend failures and rejects lookalikes', () => {
    const valid = createBackendEmissionFailure(
      'rust',
      { packageName: '@flighthq/math', source: 'value.ts' },
      'unsupported',
    );
    const missingBackend = Object.assign(new Error('forged'), {
      code: 'unsupported-ir',
      kind: 'backend-emission',
      packageName: '@flighthq/math',
      source: 'value.ts',
    });
    const missingSource = Object.assign(new Error('forged'), {
      backend: 'rust',
      code: 'unsupported-ir',
      kind: 'backend-emission',
      packageName: '@flighthq/math',
    });
    const unknownCode = Object.assign(new Error('forged'), {
      backend: 'rust',
      code: 'future-code',
      kind: 'backend-emission',
      packageName: '@flighthq/math',
      source: 'value.ts',
    });

    expect(isBackendEmissionFailure(valid)).toBe(true);
    expect(isBackendEmissionFailure(missingBackend)).toBe(false);
    expect(isBackendEmissionFailure(missingSource)).toBe(false);
    expect(isBackendEmissionFailure(unknownCode)).toBe(false);
    expect(
      isBackendEmissionFailure({
        backend: 'rust',
        code: 'unsupported-ir',
        kind: 'backend-emission',
        packageName: '@flighthq/math',
        source: 'value.ts',
      }),
    ).toBe(false);
  });
});

describe('isCompilerInvariantFailure', () => {
  it('accepts known invariant failures and rejects unknown or incomplete records', () => {
    const valid = createCompilerInvariantFailure('unsafe-emitted-path', '../value.rs', 'unsafe');
    const unknownCode = Object.assign(new Error('forged'), {
      code: 'future-code',
      kind: 'compiler-invariant',
      subject: 'fixture',
    });
    const missingSubject = Object.assign(new Error('forged'), {
      code: 'unsafe-emitted-path',
      kind: 'compiler-invariant',
    });

    expect(isCompilerInvariantFailure(valid)).toBe(true);
    expect(isCompilerInvariantFailure(unknownCode)).toBe(false);
    expect(isCompilerInvariantFailure(missingSubject)).toBe(false);
  });
});

describe('normalizeEmittedFile', () => {
  it('composes content and path normalization without mutating caller input', () => {
    const file = {
      contents: 'one\r\ntwo  \r\n\r\n',
      dependencies: ['flight\\types.hpp', 'algorithm', 'algorithm'],
      path: 'generated\\cafe\u0301.hx',
    };

    expect(normalizeEmittedFile(file)).toEqual({
      contents: 'one\ntwo  \n',
      dependencies: ['algorithm', 'flight/types.hpp'],
      path: 'generated/café.hx',
    });
    expect(file).toEqual({
      contents: 'one\r\ntwo  \r\n\r\n',
      dependencies: ['flight\\types.hpp', 'algorithm', 'algorithm'],
      path: 'generated\\cafe\u0301.hx',
    });
    expect(() => normalizeEmittedFile({ contents: '', dependencies: ['../private.hpp'], path: 'value.hpp' })).toThrow(
      expect.objectContaining({ code: 'unsafe-emitted-path' }),
    );
    expect(() => normalizeEmittedFile({ contents: 'value', dependencies: [''], path: 'value.hpp' })).toThrow(
      expect.objectContaining({ code: 'unsafe-emitted-path' }),
    );
    expect(() =>
      normalizeEmittedFile({ contents: 'value', dependencies: ['path/<bad>.hpp'], path: 'value.hpp' }),
    ).toThrow(expect.objectContaining({ code: 'unsafe-emitted-path' }));
  });
});

describe('normalizeEmittedFileContents', () => {
  it('canonicalizes line endings and the final newline without erasing source text', () => {
    expect(normalizeEmittedFileContents('one\r\ntwo\rthree  \r\n\r\n')).toBe('one\ntwo\nthree  \n');
    expect(normalizeEmittedFileContents('one  \ntwo')).toBe('one  \ntwo\n');
    expect(normalizeEmittedFileContents('one\t\n\ttwo\t\n\n')).toBe('one\t\n\ttwo\t\n');
    expect(normalizeEmittedFileContents('x'.repeat(10_000))).toBe(`${'x'.repeat(10_000)}\n`);
    expect(normalizeEmittedFileContents('')).toBe('\n');
    expect(normalizeEmittedFileContents('\n')).toBe('\n');
    expect(normalizeEmittedFileContents(normalizeEmittedFileContents('value\r\n'))).toBe('value\n');
  });

  it('accepts Unicode scalar values and refuses text that UTF-8 encoding would replace or reinterpret', () => {
    expect(normalizeEmittedFileContents('const edges = "\uD7FF\uE000😀";')).toBe('const edges = "\uD7FF\uE000😀";\n');
    expect(normalizeEmittedFileContents('const interior = "one\uFEFFtwo";')).toBe('const interior = "one\uFEFFtwo";\n');

    for (const [contents, subject] of [
      ['\uFEFFconst value = 1;', 'byte-order-mark'],
      ['const value = "\ud800";', 'unicode-code-unit:15'],
      ['const value = "\udc00";', 'unicode-code-unit:15'],
    ] as const) {
      try {
        normalizeEmittedFileContents(contents);
        expect.unreachable('Expected unsafe emitted contents to fail');
      } catch (error) {
        expect(isCompilerInvariantFailure(error)).toBe(true);
        expect(error).toMatchObject({
          code: 'unsafe-emitted-contents',
          kind: 'compiler-invariant',
          name: 'CompilerInvariantError',
          subject,
        });
      }
    }

    for (const surrogate of ['\uD800', '\uDBFF', '\uDC00', '\uDFFF']) {
      expect(() => normalizeEmittedFileContents(`x${surrogate}`)).toThrow(
        expect.objectContaining({ code: 'unsafe-emitted-contents', subject: 'unicode-code-unit:1' }),
      );
    }
  });
});

describe('normalizeEmittedFilePath', () => {
  it('canonicalizes separators and Unicode composition idempotently', () => {
    expect(normalizeEmittedFilePath('generated\\cafe\u0301.hx')).toBe('generated/café.hx');
    expect(normalizeEmittedFilePath('generated/café.hx')).toBe('generated/café.hx');
    expect(normalizeEmittedFilePath(normalizeEmittedFilePath('generated\\Value.hx'))).toBe('generated/Value.hx');
    expect(normalizeEmittedFilePath('generated/COM0.hx')).toBe('generated/COM0.hx');
    expect(normalizeEmittedFilePath('generated/LPT10.rs')).toBe('generated/LPT10.rs');
    expect(normalizeEmittedFilePath('generated/value name.hx')).toBe('generated/value name.hx');
  });

  it('rejects each class of nonportable identity with a stable invariant failure', () => {
    for (const value of [
      '',
      '.',
      '../Value.hx',
      '/Value.hx',
      'C:\\Value.hx',
      'C:Value.hx',
      '\\Value.hx',
      '\\\\server\\Value.hx',
      'generated//Value.hx',
      'generated/./Value.hx',
      'generated/../Value.hx',
      'generated/CON.hx',
      'generated/value.',
      'generated/value ',
      'generated/value?.hx',
      'generated\0Value.hx',
      'generated/value\u001f.hx',
    ]) {
      try {
        normalizeEmittedFilePath(value);
        expect.unreachable('Expected an unsafe emitted path to fail');
      } catch (error) {
        expect(isCompilerInvariantFailure(error)).toBe(true);
        expect(error).toMatchObject({
          code: 'unsafe-emitted-path',
          kind: 'compiler-invariant',
          name: 'CompilerInvariantError',
          subject: value,
        });
      }
    }
  });
});

describe('normalizeSourceTextGrouping', () => {
  it('drops a grouping the surrounding syntax already provides', () => {
    expect(normalizeSourceTextGrouping('(a + b)')).toBe('a + b');
    expect(normalizeSourceTextGrouping('((a + b) * c)')).toBe('(a + b) * c');
  });

  it('keeps a string that is not one group, so two groups are not spliced into one', () => {
    expect(normalizeSourceTextGrouping('(a) + (b)')).toBe('(a) + (b)');
    expect(normalizeSourceTextGrouping('a + b')).toBe('a + b');
    expect(normalizeSourceTextGrouping('(unbalanced')).toBe('(unbalanced');
  });

  it('keeps a parenthesised list, which is a tuple or an argument list rather than a grouping', () => {
    expect(normalizeSourceTextGrouping('(a, b)')).toBe('(a, b)');
    // The unit value groups nothing, so removing its parentheses would remove the value.
    expect(normalizeSourceTextGrouping('()')).toBe('()');
    // A comma inside a string literal is text, not a separator.
    expect(normalizeSourceTextGrouping('("a,b".to_owned())')).toBe('"a,b".to_owned()');
  });

  it('preserves escaped characters inside quoted strings and keeps unbalanced-depth groups', () => {
    expect(normalizeSourceTextGrouping('("a\\"b")')).toBe('"a\\"b"');
    expect(normalizeSourceTextGrouping('((a)')).toBe('((a)');
  });
});
