import {
  convertPackageNameToRustCrateName,
  convertSourcePathToRustModuleName,
  createRustCompilerModuleLocator,
  isRustCompilerKeyword,
} from './rustCompilerIdentity.js';

describe('convertPackageNameToRustCrateName', () => {
  it('maps scoped and punctuated npm package identities deterministically', () => {
    expect(convertPackageNameToRustCrateName('@flighthq/render-gl')).toBe('flighthq-render-gl');
    expect(convertPackageNameToRustCrateName('@alternate/render-gl')).toBe('alternate-render-gl');
    expect(convertPackageNameToRustCrateName('render.gl_tools')).toBe('flighthq-render-gl-tools');
  });

  it('rejects empty and malformed package identities', () => {
    expect(() => convertPackageNameToRustCrateName('')).toThrow('Cannot map empty npm package name');
    expect(() => convertPackageNameToRustCrateName('@flighthq')).toThrow('Cannot map empty npm package name');
    expect(() => convertPackageNameToRustCrateName('@flighthq/')).toThrow('Cannot map empty npm package name');
    expect(() => convertPackageNameToRustCrateName('@flighthq/math/private')).toThrow(
      'Cannot map invalid npm package name',
    );
    expect(() => convertPackageNameToRustCrateName('@flighthq/---')).toThrow('Cannot map empty npm package name');
  });
});

describe('convertSourcePathToRustModuleName', () => {
  it('maps POSIX and Windows TypeScript paths to the same module identity', () => {
    expect(convertSourcePathToRustModuleName('packages/render-gl/src/glShader.ts')).toBe('gl_shader');
    expect(convertSourcePathToRustModuleName('packages\\render-gl\\src\\glShader.ts')).toBe('gl_shader');
    expect(convertSourcePathToRustModuleName('packages/render-gl/src/3dPoint.tsx')).toBe('_3d_point');
  });

  it('reserves routine source identities and rejects non-TypeScript paths', () => {
    expect(convertSourcePathToRustModuleName('packages/signals/src/index.ts')).toBeUndefined();
    expect(convertSourcePathToRustModuleName('packages/signals/src/internal.ts')).toBeUndefined();
    expect(convertSourcePathToRustModuleName('packages/signals/src/value.test.ts')).toBeUndefined();
    expect(convertSourcePathToRustModuleName('packages/signals/src/value.spec.tsx')).toBeUndefined();
    expect(convertSourcePathToRustModuleName('packages/signals/src/valueTestHelper.ts')).toBeUndefined();
    expect(() => convertSourcePathToRustModuleName('packages/signals/src/value.js')).toThrow(
      'Cannot map non-TypeScript source path',
    );
    expect(() => convertSourcePathToRustModuleName('packages/signals/src/value.d.ts')).toThrow(
      'Cannot map non-runtime TypeScript source path',
    );
    expect(() => convertSourcePathToRustModuleName('packages/signals/src/.ts')).toThrow(
      'Cannot map non-runtime TypeScript source path',
    );
    expect(() => convertSourcePathToRustModuleName('packages/signals/src/---.ts')).toThrow(
      'Cannot map empty TypeScript source name',
    );
  });

  it('escapes Rust keyword module identities', () => {
    expect(convertSourcePathToRustModuleName('packages/signals/src/type.ts')).toBe('type_');
  });
});

describe('createRustCompilerModuleLocator', () => {
  it('locates root indexes, nested indexes, and nested modules without a package directory', () => {
    expect(
      createRustCompilerModuleLocator(
        { packageName: '@scope/math', source: 'packages/math/src/index.ts' },
        { multiPackage: false },
      ),
    ).toEqual({
      filePath: 'lib.rs',
      modulePath: [],
      source: 'packages/math/src/index.ts',
    });
    expect(
      createRustCompilerModuleLocator(
        {
          packageName: '@scope/math',
          source: 'packages/math/src/geometry/index.ts',
        },
        { multiPackage: false },
      ),
    ).toEqual({
      filePath: 'geometry/mod.rs',
      modulePath: ['geometry'],
      source: 'packages/math/src/geometry/index.ts',
    });
    const portable = createRustCompilerModuleLocator(
      { packageName: '@scope/math', source: 'packages/math/src/geometry/lineSegment.tsx' },
      { multiPackage: false },
    );
    const windows = createRustCompilerModuleLocator(
      { packageName: '@scope/math', source: 'packages\\math\\src\\geometry\\lineSegment.tsx' },
      { multiPackage: false },
    );
    expect(windows).toEqual(portable);
    expect(portable).toEqual({
      filePath: 'geometry/line_segment.rs',
      modulePath: ['geometry', 'line_segment'],
      source: 'packages/math/src/geometry/lineSegment.tsx',
    });
  });

  it('prefixes scoped crate source directories only for multi-package output', () => {
    const identity = {
      packageName: '@scope/math-tools',
      source: 'packages/math-tools/src/type/3dPoint.ts',
    };

    expect(createRustCompilerModuleLocator(identity, { multiPackage: false })).toEqual({
      filePath: 'type_/_3d_point.rs',
      modulePath: ['type_', '_3d_point'],
      source: identity.source,
    });
    expect(createRustCompilerModuleLocator(identity, { multiPackage: true })).toEqual({
      filePath: 'scope-math-tools/src/type_/_3d_point.rs',
      modulePath: ['type_', '_3d_point'],
      source: identity.source,
    });
    expect(
      createRustCompilerModuleLocator(
        {
          packageName: '@scope/math-tools',
          source: 'packages/math-tools/src/index.ts',
        },
        { multiPackage: true },
      ).filePath,
    ).toBe('scope-math-tools/src/lib.rs');
    expect(
      createRustCompilerModuleLocator(
        {
          packageName: '@scope/math-tools',
          source: 'packages/math-tools/src/geometry/index.ts',
        },
        { multiPackage: true },
      ).filePath,
    ).toBe('scope-math-tools/src/geometry/mod.rs');
  });

  it('rejects declaration-only, non-TypeScript, and empty normalized source segments', () => {
    for (const source of ['packages/math/src/value.d.ts', 'packages/math/src/value.js']) {
      expect(() =>
        createRustCompilerModuleLocator({ packageName: '@scope/math', source }, { multiPackage: false }),
      ).toThrow('Rust module locator requires a runtime TypeScript source');
    }
    expect(() =>
      createRustCompilerModuleLocator(
        {
          packageName: '@scope/math',
          source: 'packages/math/src/---/value.ts',
        },
        { multiPackage: false },
      ),
    ).toThrow('Rust module path segment is empty after normalization');
  });
});

describe('isRustCompilerKeyword', () => {
  it('recognizes current, reserved, and weak Rust keywords without folding case', () => {
    expect(isRustCompilerKeyword('type')).toBe(true);
    expect(isRustCompilerKeyword('gen')).toBe(true);
    expect(isRustCompilerKeyword('Self')).toBe(true);
    expect(isRustCompilerKeyword('raw')).toBe(true);
    expect(isRustCompilerKeyword('safe')).toBe(true);
    expect(isRustCompilerKeyword('_')).toBe(true);
    expect(isRustCompilerKeyword('Type')).toBe(false);
    expect(isRustCompilerKeyword('value')).toBe(false);
  });
});
