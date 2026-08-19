import { fingerprintText } from './index.js';

describe('compiler provenance', () => {
  it('uses an explicit normalized SHA-256 identity', () => {
    expect(fingerprintText('export const value = 1;')).toBe(
      'sha256:fcbcb7aece718d280178457c2c5a3bfb8e8743b8331374c29a50397f38d511e4',
    );
  });
});
