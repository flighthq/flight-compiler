import type { CompilerSourceFingerprint } from './compilerSourceFingerprint.js';
import type { CompilerSourceOrigin } from './compilerSourceIdentity.js';

describe('compiler source fingerprint contract', () => {
  it('requires the SHA-256 scheme prefix wherever source provenance is carried', () => {
    const fingerprint: CompilerSourceFingerprint = 'sha256:value';
    // @ts-expect-error Source fingerprints require their algorithm identity.
    const invalid: CompilerSourceFingerprint = 'value';

    expectTypeOf<CompilerSourceOrigin['fingerprint']>().toEqualTypeOf<CompilerSourceFingerprint>();
    expect(fingerprint).toBe('sha256:value');
    expect(invalid).toBe('value');
  });
});
