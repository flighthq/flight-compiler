import { convertPackageNameToRustCrateName, convertSourcePathToRustModuleName } from './index.js';

describe('Rust identity mapping', () => {
  it('maps npm and source identities deterministically', () => {
    expect(convertPackageNameToRustCrateName('@flighthq/render-gl')).toBe('flighthq-render-gl');
    expect(convertSourcePathToRustModuleName('packages/render-gl/src/glShader.ts')).toBe('gl_shader');
    expect(convertSourcePathToRustModuleName('packages/signals/src/internal.ts')).toBeUndefined();
  });
});
