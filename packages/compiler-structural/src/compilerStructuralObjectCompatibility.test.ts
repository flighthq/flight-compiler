import type {
  IrBindingIdentity,
  IrExpression,
  IrInterfaceDeclaration,
  IrModule,
  IrObjectMember,
  IrObjectTypeProperty,
  IrType,
  IrTypeAliasDeclaration,
  IrTypeBindingIdentity,
  IrTypeParameter,
} from '../../compiler-types/src/index.js';
import {
  analyzeIrModuleStructuralObjectCompatibility,
  analyzeIrModuleStructuralObjectCompatibilityAcrossModules,
} from './compilerStructuralObjectCompatibility.js';

const numberType = { kind: 'primitive', name: 'number' } as const satisfies IrType;
const stringType = { kind: 'primitive', name: 'string' } as const satisfies IrType;

describe('analyzeIrModuleStructuralObjectCompatibility', () => {
  it('resolves generic aliases, sequential defaults, and optional properties without changing input', () => {
    const value = typeBinding('type-parameter:value', 'Value', 'typeParameter');
    const box = interfaceDeclaration(
      'type:box',
      'Box',
      [property('value', typeReference(value)), property('note', stringType, true)],
      [{ binding: value, default: numberType }],
    );
    const envelopeValue = typeBinding('type-parameter:envelope-value', 'EnvelopeValue', 'typeParameter');
    const envelope = aliasDeclaration(
      'type:envelope',
      'Envelope',
      typeReference(box.binding, [typeReference(envelopeValue)]),
      [{ binding: envelopeValue, default: numberType }],
    );
    const expression = objectExpression(typeReference(envelope.binding), [
      { kind: 'property', name: 'value', value: { kind: 'literal', value: 1 } },
    ]);
    const module = createModule([box, envelope], [expression]);
    const snapshot = structuredClone(module);

    const report = analyzeIrModuleStructuralObjectCompatibility(module);

    expect(report).toEqual({
      diagnostics: [],
      module: {
        name: 'compatibility',
        packageName: '@flighthq/structural',
        source: 'packages/structural/src/compatibility.ts',
      },
      schema: 'flight-compiler-structural-object-compatibility/1',
      status: 'compatible',
    });
    expect(Object.isFrozen(report)).toBe(true);
    expect(Object.isFrozen(report.diagnostics)).toBe(true);
    expect(Object.isFrozen(report.module)).toBe(true);
    expect(module).toEqual(snapshot);
  });

  it('reports every incompatibility, indeterminate target, and required lowering through stable paths', () => {
    const value = typeBinding('type-parameter:value', 'Value', 'typeParameter');
    const box = interfaceDeclaration('type:box', 'Box', [property('value', numberType)], [{ binding: value }]);
    const numeric = aliasDeclaration('type:numeric', 'Numeric', numberType);
    const cycleA = aliasDeclaration('type:cycle-a', 'CycleA', numberType);
    const cycleB = aliasDeclaration('type:cycle-b', 'CycleB', typeReference(cycleA.binding));
    cycleA.type = typeReference(cycleB.binding);
    const closed = { kind: 'object', properties: [property('value', numberType)] } as const satisfies IrType;
    const expressions = [
      objectExpression(closed, [
        { key: { kind: 'literal', value: 'value' }, kind: 'computedProperty', value: { kind: 'literal', value: 1 } },
      ]),
      objectExpression(closed, [
        { expression: { kind: 'identifier', reference: { kind: 'ambient', name: 'value' } }, kind: 'spread' },
      ]),
      objectExpression(closed, [
        { kind: 'property', name: 'value', value: { kind: 'literal', value: 1 } },
        { kind: 'property', name: 'value', value: { kind: 'literal', value: 2 } },
      ]),
      objectExpression(closed, []),
      objectExpression({ kind: 'object', properties: [] }, [
        { kind: 'property', name: 'extra', value: { kind: 'literal', value: 1 } },
      ]),
      objectExpression({ kind: 'unknown', source: 'object' }, []),
      objectExpression(typeReference(numeric.binding), []),
      objectExpression(typeReference(box.binding), []),
      objectExpression({ kind: 'named', reference: { kind: 'ambient', name: 'External' }, typeArguments: [] }, []),
      objectExpression(typeReference(typeBinding('type:missing', 'Missing', 'interface')), []),
      objectExpression(typeReference(cycleA.binding), []),
    ];
    const module = createModule([box, numeric, cycleA, cycleB], expressions);

    const report = analyzeIrModuleStructuralObjectCompatibility(module);

    expect(report.status).toBe('incompatible');
    expect(
      report.diagnostics.map(({ code, disposition, path, property }) => ({
        code,
        disposition,
        path,
        ...(property === undefined ? {} : { property }),
      })),
    ).toEqual([
      {
        code: 'computed-property-indeterminate',
        disposition: 'requires-lowering',
        path: ['exports', 0, 'expression', 'members', 0],
      },
      {
        code: 'spread-membership-indeterminate',
        disposition: 'requires-lowering',
        path: ['exports', 1, 'expression', 'members', 0],
      },
      {
        code: 'duplicate-property-requires-normalization',
        disposition: 'requires-lowering',
        path: ['exports', 2, 'expression', 'members', 1],
        property: 'value',
      },
      {
        code: 'missing-required-property',
        disposition: 'incompatible',
        path: ['exports', 3, 'expression'],
        property: 'value',
      },
      {
        code: 'unknown-property',
        disposition: 'incompatible',
        path: ['exports', 4, 'expression', 'members', 0],
        property: 'extra',
      },
      {
        code: 'open-construction-target',
        disposition: 'indeterminate',
        path: ['exports', 5, 'expression'],
      },
      {
        code: 'non-structural-construction-target',
        disposition: 'incompatible',
        path: ['exports', 6, 'expression'],
      },
      {
        code: 'invalid-type-application',
        disposition: 'incompatible',
        path: ['exports', 7, 'expression'],
      },
      {
        code: 'unresolved-named-construction-target',
        disposition: 'indeterminate',
        path: ['exports', 8, 'expression'],
      },
      {
        code: 'unresolved-named-construction-target',
        disposition: 'indeterminate',
        path: ['exports', 9, 'expression'],
      },
      {
        code: 'cyclic-construction-target',
        disposition: 'incompatible',
        path: ['exports', 10, 'expression'],
      },
    ]);
    expect(report.diagnostics.every(Object.isFrozen)).toBe(true);
    expect(report.diagnostics.every((diagnostic) => Object.isFrozen(diagnostic.path))).toBe(true);
  });

  it('distinguishes an indeterminate report from empty compatible input', () => {
    const indeterminate = analyzeIrModuleStructuralObjectCompatibility(
      createModule([], [objectExpression({ kind: 'unknown', source: 'object' }, [])]),
    );
    const empty = analyzeIrModuleStructuralObjectCompatibility(createModule([], []));

    expect(indeterminate.status).toBe('indeterminate');
    expect(indeterminate.diagnostics).toHaveLength(1);
    expect(empty.status).toBe('compatible');
    expect(empty.diagnostics).toEqual([]);
  });

  it('does not disguise an unexpected malformed declaration failure as a compatibility diagnostic', () => {
    const box = interfaceDeclaration('type:box', 'Box', [], [{ binding: null as unknown as IrTypeBindingIdentity }]);
    const module = createModule([box], [objectExpression(typeReference(box.binding), [])]);

    expect(() => analyzeIrModuleStructuralObjectCompatibility(module)).toThrow(TypeError);
  });
});

describe('analyzeIrModuleStructuralObjectCompatibilityAcrossModules', () => {
  it('resolves imported generic structural targets from an explicit immutable module set', () => {
    const value = typeBinding('type-parameter:value', 'Value', 'typeParameter');
    const box = {
      ...interfaceDeclaration('type:box', 'Box', [property('value', typeReference(value))], [{ binding: value }]),
      exported: true,
    };
    const model = createModule([box], [], { name: 'model', source: 'packages/structural/src/model.ts' });
    const imported = typeBinding('type:imported-box', 'Box', 'import');
    const expression = objectExpression(typeReference(imported, [numberType]), [
      { kind: 'property', name: 'value', value: { kind: 'literal', value: 1 } },
    ]);
    const subject = createModule([], [expression], {
      imports: [{ bindings: [{ binding: imported, imported: 'Box', typeOnly: true }], specifier: './model.js' }],
      name: 'use-model',
      source: 'packages/structural/src/use-model.ts',
    });
    const modules = [model, subject];
    const snapshot = structuredClone(modules);

    const report = analyzeIrModuleStructuralObjectCompatibilityAcrossModules(subject, modules);

    expect(report.status).toBe('compatible');
    expect(report.diagnostics).toEqual([]);
    expect(analyzeIrModuleStructuralObjectCompatibilityAcrossModules(subject, [...modules].reverse())).toEqual(report);
    expect(modules).toEqual(snapshot);
  });

  it('follows local, named, star, and namespace export routes without filesystem access', () => {
    const box = interfaceDeclaration('type:box', 'Box', []);
    const model = createModule([box], [], {
      exports: [{ binding: box.binding, exported: 'Box', kind: 'local', typeOnly: true }],
      name: 'model',
      source: 'packages/structural/src/model.ts',
    });
    const namedBarrel = createModule([], [], {
      exports: [
        { exported: 'Box', imported: 'Box', kind: 'reexport', specifier: './model.js', typeOnly: true },
        { exported: 'Models', kind: 'namespace', specifier: './model.js', typeOnly: true },
        { expression: { kind: 'literal', value: 1 }, kind: 'default' },
      ],
      name: 'named',
      source: 'packages/structural/src/named.ts',
    });
    const starBarrel = createModule([], [], {
      exports: [{ kind: 'all', specifier: './named.js', typeOnly: true }],
      name: 'star',
      source: 'packages/structural/src/star.ts',
    });
    const namedImport = typeBinding('type:named-import', 'NamedBox', 'import');
    const namespaceImport = typeBinding('type:namespace-import', 'Models', 'import');
    const subject = createModule(
      [],
      [
        objectExpression(typeReference(namedImport), []),
        objectExpression(
          { kind: 'named', reference: { binding: namespaceImport, kind: 'binding', path: ['Box'] }, typeArguments: [] },
          [],
        ),
      ],
      {
        imports: [
          { bindings: [{ binding: namedImport, imported: 'Box', typeOnly: true }], specifier: './star.js' },
          { bindings: [{ binding: namespaceImport, imported: '*', typeOnly: true }], specifier: './model.js' },
        ],
        name: 'routes',
        source: 'packages/structural/src/routes.ts',
      },
    );

    const report = analyzeIrModuleStructuralObjectCompatibilityAcrossModules(subject, [
      starBarrel,
      subject,
      model,
      namedBarrel,
    ]);

    expect(report.status).toBe('compatible');
    expect(report.diagnostics).toEqual([]);
  });

  it('resolves parent-relative and extensionless index specifiers portably', () => {
    const parentBox = { ...interfaceDeclaration('type:parent-box', 'ParentBox', []), exported: true };
    const indexBox = { ...interfaceDeclaration('type:index-box', 'IndexBox', []), exported: true };
    const parent = createModule([parentBox], [], {
      name: 'parent-model',
      source: 'packages/structural/src/parent-model.ts',
    });
    const index = createModule([indexBox], [], {
      name: 'directory-index',
      source: 'packages/structural/src/directory/index.ts',
    });
    const parentImport = typeBinding('type:parent-import', 'ParentBox', 'import');
    const indexImport = typeBinding('type:index-import', 'IndexBox', 'import');
    const subject = createModule(
      [],
      [objectExpression(typeReference(parentImport), []), objectExpression(typeReference(indexImport), [])],
      {
        imports: [
          {
            bindings: [{ binding: parentImport, imported: 'ParentBox', typeOnly: true }],
            specifier: '../parent-model.js',
          },
          { bindings: [{ binding: indexImport, imported: 'IndexBox', typeOnly: true }], specifier: '../directory' },
        ],
        name: 'portable-use',
        source: 'packages/structural/src/nested/portable-use.ts',
      },
    );

    expect(analyzeIrModuleStructuralObjectCompatibilityAcrossModules(subject, [index, subject, parent])).toMatchObject({
      diagnostics: [],
      status: 'compatible',
    });
  });

  it('reports deterministic ambiguity across competing star exports', () => {
    const firstBox = { ...interfaceDeclaration('type:first-box', 'Box', []), exported: true };
    const secondBox = { ...interfaceDeclaration('type:second-box', 'Box', []), exported: true };
    const first = createModule([firstBox], [], {
      name: 'first',
      source: 'packages/structural/src/first.ts',
    });
    const second = createModule([secondBox], [], {
      name: 'second',
      source: 'packages/structural/src/second.ts',
    });
    const barrel = createModule([], [], {
      exports: [
        { kind: 'all', specifier: './first.js', typeOnly: true },
        { kind: 'all', specifier: './second.js', typeOnly: true },
      ],
      name: 'ambiguous',
      source: 'packages/structural/src/ambiguous.ts',
    });
    const imported = typeBinding('type:ambiguous-import', 'Box', 'import');
    const subject = createModule([], [objectExpression(typeReference(imported), [])], {
      imports: [{ bindings: [{ binding: imported, imported: 'Box', typeOnly: true }], specifier: './ambiguous.js' }],
      name: 'ambiguity-use',
      source: 'packages/structural/src/ambiguity-use.ts',
    });

    const report = analyzeIrModuleStructuralObjectCompatibilityAcrossModules(subject, [subject, second, barrel, first]);

    expect(report.status).toBe('indeterminate');
    expect(report.diagnostics).toMatchObject([
      {
        code: 'ambiguous-named-construction-target',
        disposition: 'indeterminate',
        path: ['exports', 0, 'expression'],
      },
    ]);
    expect(
      analyzeIrModuleStructuralObjectCompatibilityAcrossModules(subject, [first, barrel, second, subject]),
    ).toEqual(report);
  });

  it('distinguishes cyclic re-export routes from unavailable modules', () => {
    const first = createModule([], [], {
      exports: [{ exported: 'Box', imported: 'Box', kind: 'reexport', specifier: './second.js', typeOnly: true }],
      name: 'first-cycle',
      source: 'packages/structural/src/first-cycle.ts',
    });
    const second = createModule([], [], {
      exports: [{ exported: 'Box', imported: 'Box', kind: 'reexport', specifier: './first-cycle.js', typeOnly: true }],
      name: 'second',
      source: 'packages/structural/src/second.ts',
    });
    const cyclicImport = typeBinding('type:cyclic-import', 'Box', 'import');
    const missingImport = typeBinding('type:missing-import', 'Missing', 'import');
    const subject = createModule(
      [],
      [objectExpression(typeReference(cyclicImport), []), objectExpression(typeReference(missingImport), [])],
      {
        imports: [
          { bindings: [{ binding: cyclicImport, imported: 'Box', typeOnly: true }], specifier: './first-cycle.js' },
          {
            bindings: [{ binding: missingImport, imported: 'Missing', typeOnly: true }],
            specifier: '@flighthq/missing',
          },
        ],
        name: 'cycle-use',
        source: 'packages/structural/src/cycle-use.ts',
      },
    );

    const report = analyzeIrModuleStructuralObjectCompatibilityAcrossModules(subject, [subject, first, second]);

    expect(report.status).toBe('incompatible');
    expect(report.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      'cyclic-construction-target',
      'unresolved-named-construction-target',
    ]);
  });

  it('keeps unsupported qualified and root-escaping routes explicitly unresolved', () => {
    const local = interfaceDeclaration('type:local', 'Local', []);
    const namespaceImport = typeBinding('type:namespace-self', 'Models', 'import');
    const escapeImport = typeBinding('type:escape', 'Escape', 'import');
    const subject = createModule(
      [local],
      [
        objectExpression(
          {
            kind: 'named',
            reference: { binding: local.binding, kind: 'binding', path: ['Nested'] },
            typeArguments: [],
          },
          [],
        ),
        objectExpression(typeReference(namespaceImport), []),
        objectExpression(typeReference(escapeImport), []),
      ],
      {
        imports: [
          { bindings: [{ binding: namespaceImport, imported: '*', typeOnly: true }], specifier: './models.js' },
          {
            bindings: [{ binding: escapeImport, imported: 'Escape', typeOnly: true }],
            specifier: '../../../../outside.js',
          },
        ],
        name: 'unresolved-routes',
        source: 'packages/structural/src/unresolved-routes.ts',
      },
    );

    const report = analyzeIrModuleStructuralObjectCompatibilityAcrossModules(subject, [subject]);

    expect(report.status).toBe('indeterminate');
    expect(report.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      'unresolved-named-construction-target',
      'unresolved-named-construction-target',
      'unresolved-named-construction-target',
    ]);
  });

  it('resolves bare package exports only through explicit inventory-owned edges', () => {
    const box = { ...interfaceDeclaration('type:package-box', 'Box', []), exported: true };
    const target = createModule([box], [], {
      name: 'types-public',
      packageName: '@flighthq/types',
      source: 'packages/types/src/public.ts',
    });
    const imported = typeBinding('type:package-import', 'Box', 'import');
    const subject = createModule([], [objectExpression(typeReference(imported), [])], {
      imports: [
        {
          bindings: [{ binding: imported, imported: 'Box', typeOnly: true }],
          specifier: '@flighthq/types/public',
        },
      ],
      name: 'package-use',
      packageName: '@flighthq/core',
      source: 'packages/core/src/use.ts',
    });
    const resolution = {
      edges: [
        {
          specifier: '@flighthq/types/public',
          target: { packageName: '@flighthq/types', source: 'packages/types/src/public.ts' },
        },
      ],
      schema: 'flight-compiler-module-resolution/1',
    } as const;
    const snapshot = structuredClone([subject, target, resolution]);

    expect(analyzeIrModuleStructuralObjectCompatibilityAcrossModules(subject, [subject, target])).toMatchObject({
      diagnostics: [{ code: 'unresolved-named-construction-target' }],
      status: 'indeterminate',
    });
    expect(
      analyzeIrModuleStructuralObjectCompatibilityAcrossModules(subject, [subject, target], resolution),
    ).toMatchObject({ diagnostics: [], status: 'compatible' });
    expect([subject, target, resolution]).toEqual(snapshot);
  });

  it('rejects a non-array explicit module set instead of consulting ambient state', () => {
    const subject = createModule([], []);

    expect(() => analyzeIrModuleStructuralObjectCompatibilityAcrossModules(subject, null as never)).toThrow(TypeError);
    expect(() => analyzeIrModuleStructuralObjectCompatibilityAcrossModules(subject, [])).toThrow(TypeError);
    expect(() => analyzeIrModuleStructuralObjectCompatibilityAcrossModules(subject, [subject, { ...subject }])).toThrow(
      TypeError,
    );
    const duplicate = interfaceDeclaration('type:duplicate', 'Duplicate', []);
    const malformed = createModule([duplicate, { ...duplicate }], []);
    expect(() => analyzeIrModuleStructuralObjectCompatibilityAcrossModules(malformed, [malformed])).toThrow(TypeError);
    const invalidResolutions = [
      null,
      { edges: [], schema: 'invalid' },
      { edges: null, schema: 'flight-compiler-module-resolution/1' },
      { edges: [null], schema: 'flight-compiler-module-resolution/1' },
      {
        edges: [{ specifier: '', target: { packageName: '@flighthq/types', source: 'index.ts' } }],
        schema: 'flight-compiler-module-resolution/1',
      },
      {
        edges: [{ specifier: '@flighthq/types', target: null }],
        schema: 'flight-compiler-module-resolution/1',
      },
      {
        edges: [{ specifier: '@flighthq/types', target: { packageName: '', source: 'index.ts' } }],
        schema: 'flight-compiler-module-resolution/1',
      },
      {
        edges: [{ specifier: '@flighthq/types', target: { packageName: '@flighthq/types', source: '' } }],
        schema: 'flight-compiler-module-resolution/1',
      },
      {
        edges: [
          { specifier: '@flighthq/types', target: { packageName: '@flighthq/types', source: 'index.ts' } },
          { specifier: '@flighthq/types', target: { packageName: '@flighthq/types', source: 'other.ts' } },
        ],
        schema: 'flight-compiler-module-resolution/1',
      },
    ];
    for (const resolution of invalidResolutions) {
      expect(() =>
        analyzeIrModuleStructuralObjectCompatibilityAcrossModules(subject, [subject], resolution as never),
      ).toThrow(TypeError);
    }
  });
});

function aliasDeclaration(
  id: string,
  name: string,
  type: IrType,
  typeParameters: IrTypeParameter[] = [],
): IrTypeAliasDeclaration & { type: IrType } {
  return {
    binding: typeBinding(id, name, 'typeAlias'),
    exported: false,
    kind: 'typeAlias',
    origin: sourceOrigin(),
    type,
    typeParameters,
  };
}

function createModule(
  declarations: IrModule['declarations'],
  expressions: readonly IrExpression[],
  changes: Partial<IrModule> = {},
): IrModule {
  return {
    declarations: [
      ...declarations,
      {
        binding: valueBinding('binding:mode', 'Mode'),
        exported: false,
        kind: 'enum',
        members: [],
        origin: sourceOrigin(),
      },
    ],
    exports: expressions.map((expression) => ({ expression, exported: 'default', kind: 'default' })),
    imports: [],
    name: 'compatibility',
    packageName: '@flighthq/structural',
    source: 'packages/structural/src/compatibility.ts',
    ...changes,
  };
}

function valueBinding(id: string, name: string): IrBindingIdentity {
  return {
    ...sourceOrigin(),
    id,
    kind: 'enum',
    name,
    scope: 'module',
    space: 'value',
  };
}

function interfaceDeclaration(
  id: string,
  name: string,
  properties: IrObjectTypeProperty[],
  typeParameters: IrTypeParameter[] = [],
): IrInterfaceDeclaration {
  return {
    binding: typeBinding(id, name, 'interface'),
    exported: false,
    extends: [],
    kind: 'interface',
    origin: sourceOrigin(),
    properties,
    typeParameters,
  };
}

function objectExpression(type: IrType, members: readonly IrObjectMember[]): IrExpression {
  return { kind: 'object', members, type };
}

function property(name: string, type: IrType, optional = false): IrObjectTypeProperty {
  return { name, optional, readonly: false, type };
}

function sourceOrigin() {
  return {
    column: 1,
    fingerprint: `sha256:${'0'.repeat(64)}` as const,
    line: 1,
    packageName: '@flighthq/structural',
    source: 'packages/structural/src/compatibility.ts',
  };
}

function typeBinding(
  id: string,
  name: string,
  kind: 'import' | 'interface' | 'typeAlias' | 'typeParameter',
): IrTypeBindingIdentity {
  return {
    ...sourceOrigin(),
    id,
    kind,
    name,
    scope: kind === 'typeParameter' ? 'declaration' : 'module',
    space: 'type',
  };
}

function typeReference(binding: IrTypeBindingIdentity, typeArguments: readonly IrType[] = []): IrType {
  return { kind: 'named', reference: { binding, kind: 'binding', path: [] }, typeArguments };
}
