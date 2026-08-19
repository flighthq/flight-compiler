import {
  convertPackageNameToRustCrateName,
  convertSourcePathToRustModuleName,
  isRustCompilerKeyword,
} from './rustCompilerIdentity.js';

describe('convertPackageNameToRustCrateName', () => {
  it('maps scoped and punctuated npm package identities deterministically', () => {
    expect(convertPackageNameToRustCrateName('@flighthq/render-gl')).toBe('flighthq-render-gl');
    expect(convertPackageNameToRustCrateName('render.gl_tools')).toBe('flighthq-render-gl-tools');
  });

  it('rejects empty and malformed package identities', () => {
    expect(() => convertPackageNameToRustCrateName('')).toThrow('Cannot map empty npm package name');
    expect(() => convertPackageNameToRustCrateName('@flighthq')).toThrow('Cannot map empty npm package name');
    expect(() => convertPackageNameToRustCrateName('@flighthq/')).toThrow('Cannot map empty npm package name');
    expect(() => convertPackageNameToRustCrateName('@flighthq/math/private')).toThrow(
      'Cannot map invalid npm package name',
    );
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
  });

  it('escapes Rust keyword module identities', () => {
    expect(convertSourcePathToRustModuleName('packages/signals/src/type.ts')).toBe('type_');
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
