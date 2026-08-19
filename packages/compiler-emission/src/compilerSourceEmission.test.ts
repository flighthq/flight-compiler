import {
  createBackendEmissionFailure,
  createCompilerInvariantFailure,
  indentSourceLines,
  isBackendEmissionFailure,
  isCompilerInvariantFailure,
  normalizeEmittedFile,
} from './index.js';

describe('emission infrastructure', () => {
  it('creates inspectable tagged failures without a class hierarchy', () => {
    const backend = createBackendEmissionFailure('haxe', 'packages/math/src/value.ts', 'unsupported');
    const invariant = createCompilerInvariantFailure('duplicate-emitted-path', 'Value.hx', 'duplicate');

    expect(isBackendEmissionFailure(backend)).toBe(true);
    expect(backend).toMatchObject({
      backend: 'haxe',
      kind: 'backend-emission',
      name: 'BackendEmissionError',
      source: 'packages/math/src/value.ts',
    });
    expect(isCompilerInvariantFailure(invariant)).toBe(true);
    expect(invariant).toMatchObject({
      code: 'duplicate-emitted-path',
      kind: 'compiler-invariant',
      name: 'CompilerInvariantError',
      subject: 'Value.hx',
    });
  });

  it('indents nonempty lines without changing blank lines', () => {
    expect(indentSourceLines(['one', '', 'two'], 2)).toEqual(['    one', '', '    two']);
    expect(indentSourceLines(['one', ''], 0)).toEqual(['one', '']);
    expect(indentSourceLines([])).toEqual([]);
  });

  it('normalizes line endings, trailing whitespace, empty contents, and portable paths', () => {
    expect(normalizeEmittedFile({ contents: 'one\r\ntwo\rthree  \r\n\r\n', path: 'generated\\Value.hx' })).toEqual({
      contents: 'one\ntwo\nthree\n',
      path: 'generated/Value.hx',
    });
    expect(normalizeEmittedFile({ contents: '', path: 'Empty.rs' })).toEqual({
      contents: '\n',
      path: 'Empty.rs',
    });
  });

  it('rejects nonportable output identities', () => {
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

  it('rejects malformed tagged failures', () => {
    const unknownInvariant = Object.assign(new Error('forged invariant'), {
      code: 'future-code',
      kind: 'compiler-invariant',
      subject: 'fixture',
    });
    const incompleteBackend = Object.assign(new Error('forged backend failure'), {
      kind: 'backend-emission',
      source: 'fixture.ts',
    });

    expect(isBackendEmissionFailure(incompleteBackend)).toBe(false);
    expect(isCompilerInvariantFailure(unknownInvariant)).toBe(false);
  });
});
