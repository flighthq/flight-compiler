import ts from 'typescript';

import { createIrModuleTargetNameAllocation } from '../../compiler-emission/src/index.js';
import { lowerTypeScriptSource } from '../../compiler-semantic/src/index.js';
import type { IrBindingIdentity, IrModule, IrTypeBindingIdentity } from '../../compiler-types/src/index.js';
import {
  convertPackageNameToRustCrateName,
  convertSourcePathToRustModuleName,
  createRustBindingNameRules,
  createRustCompilerModuleLocator,
  getRustConstantBindingIds,
  getRustPreferredBindingName,
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

describe('createRustBindingNameRules', () => {
  const rules = createRustBindingNameRules();

  it('splits acronym boundaries and separates the two casing families', () => {
    expect(rules.snakeCase('HTTPServer')).toBe('http_server');
    expect(rules.snakeCase('widget')).toBe('widget');
    expect(rules.pascalCase('foo_bar')).toBe('FooBar');
    expect(rules.pascalCase('HTTPServer')).toBe('HTTPServer');
  });

  it('applies keyword suffixes, `this`, and dotted type paths', () => {
    expect(rules.safeRustValueName('this')).toBe('self');
    expect(rules.safeRustValueName('type')).toBe('type_');
    expect(rules.safeRustTypeName('foo.bar')).toBe('Foo::Bar');
    expect(rules.safeRustTypeName('Self')).toBe('Self_');
  });
});

describe('getRustConstantBindingIds', () => {
  it('selects only immutable, non-pattern variable bindings', () => {
    const module = {
      declarations: [
        { binding: { id: 'immutable' }, kind: 'variable', mutable: false },
        { binding: { id: 'mutable' }, kind: 'variable', mutable: true },
        { binding: { id: 'pattern' }, kind: 'variable', mutable: false, pattern: {} },
        { binding: { id: 'function' }, kind: 'function' },
      ],
    } as unknown as IrModule;

    expect([...getRustConstantBindingIds(module)]).toEqual(['immutable']);
  });
});

describe('getRustPreferredBindingName', () => {
  function binding(changes: Readonly<Record<string, unknown>>) {
    return {
      id: 'binding',
      kind: 'import',
      name: 'Widget',
      packageName: '@scope/pkg',
      scope: 'module',
      source: 'packages/pkg/src/consumer.ts',
      space: 'value',
      ...changes,
    } as unknown as IrBindingIdentity | IrTypeBindingIdentity;
  }

  it('type-shapes an uppercase import and value-shapes a lowercase one', () => {
    expect(getRustPreferredBindingName(binding({}), new Set())).toBe('Widget');
    expect(getRustPreferredBindingName(binding({ name: 'widget' }), new Set())).toBe('widget');
  });

  it('names declarations by their declared space and constants by screaming snake', () => {
    expect(getRustPreferredBindingName(binding({ kind: 'class', name: 'Store' }), new Set())).toBe('Store');
    expect(getRustPreferredBindingName(binding({ kind: 'interface', name: 'Value', space: 'type' }), new Set())).toBe(
      'Value',
    );
    expect(
      getRustPreferredBindingName(
        binding({ id: 'constant', kind: 'variable', name: 'maxValue' }),
        new Set(['constant']),
      ),
    ).toBe('MAX_VALUE');
    expect(getRustPreferredBindingName(binding({ name: 'type' }), new Set())).toBe('type_');
  });

  it('produces the emitter-exact map once collision suffixes are applied, imports included', () => {
    const sourceFile = ts.createSourceFile(
      '/flight/packages/pkg/src/consumer.ts',
      "import { Widget } from './provider.js';\nfunction widget(): Widget { return new Widget(); }\nexport { widget };\nexport const f0: number = 1;",
      ts.ScriptTarget.Latest,
      true,
    );
    const module = lowerTypeScriptSource(sourceFile, {
      packageName: '@probe/pkg',
      upstreamDirectory: '/flight',
    }).module;
    const constants = getRustConstantBindingIds(module);
    const names = new Map(
      createIrModuleTargetNameAllocation(module, (binding) => ({
        namespace: 'identifier',
        preferredName: getRustPreferredBindingName(binding, constants),
      })).map((allocation) => [allocation.name, allocation.identity]),
    );

    // The import keeps its type-shaped spelling and the indirect function keeps its base name: the two
    // spellings that diverged when the plan used its own value-shaped import preference.
    expect(names.has('Widget')).toBe(true);
    expect(names.has('widget')).toBe(true);
    expect(names.has('widget_2')).toBe(false);
    expect(names.has('F0')).toBe(true);
  });
});
