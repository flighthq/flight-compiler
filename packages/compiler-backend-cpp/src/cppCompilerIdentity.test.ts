import {
  convertPackageNameToCppNamespace,
  convertSourcePathToCppFileName,
  isCppCompilerKeyword,
} from './cppCompilerIdentity.js';

describe('convertPackageNameToCppNamespace', () => {
  it('maps scoped and punctuated npm package identities deterministically', () => {
    expect(convertPackageNameToCppNamespace('@flighthq/render-gl')).toBe('flighthq_render_gl');
    expect(convertPackageNameToCppNamespace('render.gl_tools')).toBe('flighthq_render_gl_tools');
  });

  it('rejects empty and malformed package identities', () => {
    expect(() => convertPackageNameToCppNamespace('')).toThrow('Cannot map empty npm package name');
    expect(() => convertPackageNameToCppNamespace('@flighthq')).toThrow('Cannot map empty npm package name');
    expect(() => convertPackageNameToCppNamespace('@flighthq/')).toThrow('Cannot map empty npm package name');
    expect(() => convertPackageNameToCppNamespace('@flighthq/math/private')).toThrow(
      'Cannot map invalid npm package name',
    );
    expect(() => convertPackageNameToCppNamespace('@flighthq/---')).toThrow('Cannot map empty npm package name');
  });
});

describe('convertSourcePathToCppFileName', () => {
  it('maps POSIX and Windows TypeScript paths to the same file identity', () => {
    expect(convertSourcePathToCppFileName('packages/render-gl/src/glShader.ts')).toBe('gl_shader');
    expect(convertSourcePathToCppFileName('packages\\render-gl\\src\\glShader.ts')).toBe('gl_shader');
    expect(convertSourcePathToCppFileName('packages/render-gl/src/3dPoint.tsx')).toBe('_3d_point');
  });

  it('reserves routine source identities and rejects non-TypeScript paths', () => {
    expect(convertSourcePathToCppFileName('packages/signals/src/index.ts')).toBeUndefined();
    expect(convertSourcePathToCppFileName('packages/signals/src/internal.ts')).toBeUndefined();
    expect(convertSourcePathToCppFileName('packages/signals/src/value.test.ts')).toBeUndefined();
    expect(convertSourcePathToCppFileName('packages/signals/src/value.spec.tsx')).toBeUndefined();
    expect(convertSourcePathToCppFileName('packages/signals/src/valueTestHelper.ts')).toBeUndefined();
    expect(() => convertSourcePathToCppFileName('packages/signals/src/value.js')).toThrow(
      'Cannot map non-TypeScript source path',
    );
    expect(() => convertSourcePathToCppFileName('packages/signals/src/value.d.ts')).toThrow(
      'Cannot map non-runtime TypeScript source path',
    );
    expect(() => convertSourcePathToCppFileName('packages/signals/src/.ts')).toThrow(
      'Cannot map non-runtime TypeScript source path',
    );
    expect(() => convertSourcePathToCppFileName('packages/signals/src/---.ts')).toThrow(
      'Cannot map empty TypeScript source name',
    );
  });

  it('escapes C++ keyword file identities', () => {
    expect(convertSourcePathToCppFileName('packages/signals/src/class.ts')).toBe('class_');
  });
});

describe('isCppCompilerKeyword', () => {
  it('recognizes C++ keywords without folding case', () => {
    expect(isCppCompilerKeyword('class')).toBe(true);
    expect(isCppCompilerKeyword('int')).toBe(true);
    expect(isCppCompilerKeyword('auto')).toBe(true);
    expect(isCppCompilerKeyword('nullptr')).toBe(true);
    expect(isCppCompilerKeyword('Class')).toBe(false);
    expect(isCppCompilerKeyword('value')).toBe(false);
    expect(isCppCompilerKeyword('create')).toBe(false);
  });
});
