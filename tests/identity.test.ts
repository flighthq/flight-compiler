import {
  fingerprintText,
  packageNameToHaxePackage,
  packageNameToRustCrate,
  sourcePathToHaxeModule,
  sourcePathToRustModule,
} from '../src/index.ts';

describe('target identity mapping', () => {
  it('maps the same npm and source identities deterministically per backend', () => {
    expect(packageNameToHaxePackage('@flighthq/render-gl')).toBe('flighthq.renderGl');
    expect(packageNameToRustCrate('@flighthq/render-gl')).toBe('flighthq-render-gl');
    expect(sourcePathToHaxeModule('packages/render-gl/src/glShader.ts')).toBe('GlShader');
    expect(sourcePathToRustModule('packages/render-gl/src/glShader.ts')).toBe('gl_shader');
    expect(sourcePathToHaxeModule('packages/signals/src/internal.ts')).toBeUndefined();
    expect(sourcePathToRustModule('packages/signals/src/internal.ts')).toBeUndefined();
  });

  it('uses an explicit normalized SHA-256 identity', () => {
    expect(fingerprintText('export const value = 1;')).toBe(
      'sha256:fcbcb7aece718d280178457c2c5a3bfb8e8743b8331374c29a50397f38d511e4',
    );
  });
});
