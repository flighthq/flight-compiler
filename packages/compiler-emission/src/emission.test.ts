import {
  createBackendEmissionError,
  indentSource,
  isBackendEmissionError,
  isCompilerInvariantError,
  normalizeEmittedFile,
} from './index.js';

describe('emission infrastructure', () => {
  it('normalizes contents and portable output paths', () => {
    expect(normalizeEmittedFile({ contents: 'line\r\n\r\n', path: 'generated\\Value.hx' })).toEqual({
      contents: 'line\n',
      path: 'generated/Value.hx',
    });
    expect(indentSource(['one', '', 'two'], 2)).toEqual(['    one', '', '    two']);
  });

  it('rejects unsafe output identities', () => {
    for (const path of ['../Value.hx', '/Value.hx']) {
      try {
        normalizeEmittedFile({ contents: '', path });
        expect.unreachable('Expected an unsafe emitted path to fail');
      } catch (error) {
        expect(isCompilerInvariantError(error)).toBe(true);
        expect(error).toMatchObject({
          code: 'unsafe-emitted-path',
          kind: 'compiler-invariant',
          name: 'CompilerInvariantError',
          subject: path,
        });
      }
    }
  });

  it('creates inspectable tagged failures without a class hierarchy', () => {
    const failure = createBackendEmissionError('haxe', 'packages/math/src/value.ts', 'unsupported');

    expect(isBackendEmissionError(failure)).toBe(true);
    expect(failure).toMatchObject({
      backend: 'haxe',
      kind: 'backend-emission',
      name: 'BackendEmissionError',
      source: 'packages/math/src/value.ts',
    });
  });
});
