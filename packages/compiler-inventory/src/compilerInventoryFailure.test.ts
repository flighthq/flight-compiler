import { createCompilerInventoryFailure, isCompilerInventoryFailure } from './compilerInventoryFailure.js';

describe('createCompilerInventoryFailure', () => {
  it('creates an inspectable error without depending on message text', () => {
    const cause = new Error('disk');
    const failure = createCompilerInventoryFailure(
      'invalid-package-manifest',
      'packages/math/package.json',
      'Invalid manifest',
      cause,
    );

    expect(failure).toBeInstanceOf(Error);
    expect(failure).toMatchObject({
      cause,
      code: 'invalid-package-manifest',
      kind: 'compiler-inventory',
      name: 'CompilerInventoryError',
      subject: 'packages/math/package.json',
    });
  });
});

describe('isCompilerInventoryFailure', () => {
  it('accepts every failure code and rejects lookalikes, unknown codes, and plain objects', () => {
    const codes = [
      'duplicate-package-name',
      'invalid-package-directory',
      'invalid-package-manifest',
      'invalid-package-scope',
      'missing-packages-directory',
      'unsupported-dynamic-import',
    ] as const;

    expect(
      codes.every((code) => isCompilerInventoryFailure(createCompilerInventoryFailure(code, 'subject', code))),
    ).toBe(true);
    expect(isCompilerInventoryFailure(Object.assign(new Error('lookalike'), { kind: 'compiler-inventory' }))).toBe(
      false,
    );
    expect(
      isCompilerInventoryFailure(
        Object.assign(new Error('unknown'), {
          code: 'unknown',
          kind: 'compiler-inventory',
          subject: 'subject',
        }),
      ),
    ).toBe(false);
    expect(
      isCompilerInventoryFailure({
        code: 'invalid-package-manifest',
        kind: 'compiler-inventory',
        subject: 'subject',
      }),
    ).toBe(false);
  });
});
