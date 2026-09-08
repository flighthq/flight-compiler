import { convertPackageNameToHaxePackageName, convertSourcePathToHaxeModuleName } from './haxeCompilerIdentity.js';

describe('convertPackageNameToHaxePackageName', () => {
  it('maps scoped, punctuated, and custom-root package identities deterministically', () => {
    expect(convertPackageNameToHaxePackageName('@flighthq/render-gl')).toBe('flighthq.renderGl');
    expect(convertPackageNameToHaxePackageName('render.gl')).toBe('flighthq.renderGl');
    expect(convertPackageNameToHaxePackageName('@flighthq/render_gl', 'org.flight')).toBe('org.flight.renderGl');
    expect(convertPackageNameToHaxePackageName('@flighthq/3d')).toBe('flighthq._3d');
  });

  it('rejects empty or malformed npm and Haxe package identities', () => {
    expect(() => convertPackageNameToHaxePackageName('')).toThrow('Cannot map empty npm package name');
    expect(() => convertPackageNameToHaxePackageName('@flighthq')).toThrow('Cannot map empty npm package name');
    expect(() => convertPackageNameToHaxePackageName('@flighthq/')).toThrow('Cannot map empty npm package name');
    expect(() => convertPackageNameToHaxePackageName('@flighthq/math/private')).toThrow(
      'Cannot map invalid npm package name',
    );
    expect(() => convertPackageNameToHaxePackageName('@flighthq/math', '')).toThrow(
      'Cannot map invalid Haxe root package',
    );
    expect(() => convertPackageNameToHaxePackageName('@flighthq/math', 'Flight')).toThrow(
      'Cannot map invalid Haxe root package',
    );
  });
});

describe('convertSourcePathToHaxeModuleName', () => {
  it('maps POSIX and Windows TypeScript paths to the same module identity', () => {
    expect(convertSourcePathToHaxeModuleName('packages/render-gl/src/glShader.ts')).toBe('GlShader');
    expect(convertSourcePathToHaxeModuleName('packages\\render-gl\\src\\glShader.ts')).toBe('GlShader');
    expect(convertSourcePathToHaxeModuleName('packages/render-gl/src/3dPoint.tsx')).toBe('_3dPoint');
    expect(convertSourcePathToHaxeModuleName('packages/render-gl/src/---.ts')).toBe('_Generated');
  });

  it('reserves routine source identities and rejects non-TypeScript paths', () => {
    expect(convertSourcePathToHaxeModuleName('packages/signals/src/index.ts')).toBeUndefined();
    expect(convertSourcePathToHaxeModuleName('packages/signals/src/internal.ts')).toBeUndefined();
    expect(convertSourcePathToHaxeModuleName('packages/signals/src/value.test.ts')).toBeUndefined();
    expect(convertSourcePathToHaxeModuleName('packages/signals/src/value.spec.tsx')).toBeUndefined();
    expect(convertSourcePathToHaxeModuleName('packages/signals/src/valueTestHelper.ts')).toBeUndefined();
    expect(() => convertSourcePathToHaxeModuleName('packages/signals/src/value.js')).toThrow(
      'Cannot map non-TypeScript source path',
    );
    expect(() => convertSourcePathToHaxeModuleName('packages/signals/src/value.d.ts')).toThrow(
      'Cannot map non-runtime TypeScript source path',
    );
    expect(() => convertSourcePathToHaxeModuleName('packages/signals/src/.ts')).toThrow(
      'Cannot map non-runtime TypeScript source path',
    );
  });
});
