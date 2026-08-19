import {
  createBackendEmissionFailure,
  createCompilerInvariantFailure,
  indentSourceLines,
  isBackendEmissionFailure,
  isCompilerInvariantFailure,
  normalizeEmittedFile,
} from './compilerSourceEmission.js';

describe('createBackendEmissionFailure', () => {
  it('creates an inspectable Error record with backend and source identity', () => {
    const failure = createBackendEmissionFailure('haxe', 'packages/math/src/value.ts', 'unsupported');

    expect(failure).toBeInstanceOf(Error);
    expect(failure.message).toBe('haxe emission failed for packages/math/src/value.ts: unsupported');
    expect(failure).toMatchObject({
      backend: 'haxe',
      kind: 'backend-emission',
      name: 'BackendEmissionError',
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
    const valid = createBackendEmissionFailure('rust', 'value.ts', 'unsupported');
    const missingBackend = Object.assign(new Error('forged'), {
      kind: 'backend-emission',
      source: 'value.ts',
    });
    const missingSource = Object.assign(new Error('forged'), {
      backend: 'rust',
      kind: 'backend-emission',
    });

    expect(isBackendEmissionFailure(valid)).toBe(true);
    expect(isBackendEmissionFailure(missingBackend)).toBe(false);
    expect(isBackendEmissionFailure(missingSource)).toBe(false);
    expect(isBackendEmissionFailure({ backend: 'rust', kind: 'backend-emission', source: 'value.ts' })).toBe(false);
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
  it('normalizes line endings, trailing whitespace, empty contents, and portable paths without mutating input', () => {
    const file = { contents: 'one\r\ntwo\rthree  \r\n\r\n', path: 'generated\\Value.hx' };

    expect(normalizeEmittedFile(file)).toEqual({
      contents: 'one\ntwo\nthree\n',
      path: 'generated/Value.hx',
    });
    expect(file).toEqual({ contents: 'one\r\ntwo\rthree  \r\n\r\n', path: 'generated\\Value.hx' });
    expect(normalizeEmittedFile({ contents: '', path: 'Empty.rs' })).toEqual({
      contents: '\n',
      path: 'Empty.rs',
    });
  });

  it('rejects nonportable output identities with a stable invariant failure', () => {
    for (const path of [
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
    ]) {
      try {
        normalizeEmittedFile({ contents: '', path });
        expect.unreachable('Expected an unsafe emitted path to fail');
      } catch (error) {
        expect(isCompilerInvariantFailure(error)).toBe(true);
        expect(error).toMatchObject({
          code: 'unsafe-emitted-path',
          kind: 'compiler-invariant',
          name: 'CompilerInvariantError',
          subject: path,
        });
      }
    }
  });
});
