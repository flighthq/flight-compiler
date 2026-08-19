import { convertPackageNameToHaxePackageName, convertSourcePathToHaxeModuleName } from './index.js';

describe('Haxe identity mapping', () => {
  it('maps npm and source identities deterministically', () => {
    expect(convertPackageNameToHaxePackageName('@flighthq/render-gl')).toBe('flighthq.renderGl');
    expect(convertSourcePathToHaxeModuleName('packages/render-gl/src/glShader.ts')).toBe('GlShader');
    expect(convertSourcePathToHaxeModuleName('packages/signals/src/internal.ts')).toBeUndefined();
  });
});
