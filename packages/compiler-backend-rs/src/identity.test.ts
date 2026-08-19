import { packageNameToRustCrate, sourcePathToRustModule } from './index.js';

describe('Rust identity mapping', () => {
  it('maps npm and source identities deterministically', () => {
    expect(packageNameToRustCrate('@flighthq/render-gl')).toBe('flighthq-render-gl');
    expect(sourcePathToRustModule('packages/render-gl/src/glShader.ts')).toBe('gl_shader');
    expect(sourcePathToRustModule('packages/signals/src/internal.ts')).toBeUndefined();
  });
});
