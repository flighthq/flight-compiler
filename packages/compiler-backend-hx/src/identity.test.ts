import { packageNameToHaxePackage, sourcePathToHaxeModule } from './index.js';

describe('Haxe identity mapping', () => {
  it('maps npm and source identities deterministically', () => {
    expect(packageNameToHaxePackage('@flighthq/render-gl')).toBe('flighthq.renderGl');
    expect(sourcePathToHaxeModule('packages/render-gl/src/glShader.ts')).toBe('GlShader');
    expect(sourcePathToHaxeModule('packages/signals/src/internal.ts')).toBeUndefined();
  });
});
