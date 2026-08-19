import { createBackendEmissionError, indentSource, isBackendEmissionError, normalizeEmittedFile } from './index.js';

describe('emission infrastructure', () => {
  it('normalizes contents and portable output paths', () => {
    expect(normalizeEmittedFile({ contents: 'line\r\n\r\n', path: 'generated\\Value.hx' })).toEqual({
      contents: 'line\n',
      path: 'generated/Value.hx',
    });
    expect(indentSource(['one', '', 'two'], 2)).toEqual(['    one', '', '    two']);
  });

  it('rejects unsafe output identities', () => {
    expect(() => normalizeEmittedFile({ contents: '', path: '../Value.hx' })).toThrow('unsafe file path');
    expect(() => normalizeEmittedFile({ contents: '', path: '/Value.hx' })).toThrow('unsafe file path');
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
