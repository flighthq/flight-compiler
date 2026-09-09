import { describe, expect, it } from 'vitest';

import type {
  CompilerModuleResolutionPlan,
  CompilerSourceOrigin,
  IrBindingIdentity,
  IrClassDeclaration,
  IrClassMethod,
  IrEnumDeclaration,
  IrFunctionDeclaration,
  IrInterfaceDeclaration,
  IrModule,
  IrType,
  IrTypeAliasDeclaration,
  IrTypeBindingIdentity,
  IrTypeParameter,
  IrVariableDeclaration,
} from '../../compiler-types/src/index.js';
import { analyzeIrTypeValueIdentity, createIrTypeValueIdentityAnalyzer } from './compilerTypeValueIdentityAnalysis.js';

const numberType = { kind: 'primitive', name: 'number' } as const satisfies IrType;
const objectType = { kind: 'object', properties: [] } as const satisfies IrType;

describe('analyzeIrTypeValueIdentity', () => {
  it('distinguishes intrinsic value and reference types from indeterminate evidence', () => {
    const module = createModule([]);
    const valueTypes = [
      numberType,
      { kind: 'literal', value: 'ready' },
      { kind: 'never' },
      { kind: 'null' },
      { kind: 'undefined' },
      { kind: 'keyof', type: objectType },
    ] as const satisfies readonly IrType[];
    const referenceTypes = [
      objectType,
      { element: numberType, kind: 'array', readonly: false },
      { elements: [{ optional: false, rest: false, type: numberType }], kind: 'tuple', readonly: true },
      { kind: 'function', parameters: [], returns: numberType, typeParameters: [] },
      ambientType('Map'),
      ambientType('WeakMap'),
      ambientType('Uint8Array'),
    ] as const satisfies readonly IrType[];

    for (const type of valueTypes) {
      expect(analyzeIrTypeValueIdentity(type, module).identity).toBe('value');
    }
    for (const type of referenceTypes) {
      expect(analyzeIrTypeValueIdentity(type, module).identity).toBe('reference');
    }
    expect(analyzeIrTypeValueIdentity({ kind: 'unknown', source: 'object' }, module)).toMatchObject({
      identity: 'indeterminate',
      reason: 'unknown-type',
    });
    expect(analyzeIrTypeValueIdentity(ambientType('External'), module)).toMatchObject({
      identity: 'indeterminate',
      reason: 'unresolved-reference',
    });
    expect(
      analyzeIrTypeValueIdentity({ index: numberType, kind: 'indexedAccess', object: objectType }, module),
    ).toMatchObject({ identity: 'indeterminate', reason: 'type-operator' });
  });

  it('makes transitive and generic aliases observationally equivalent to their resolved types', () => {
    const parameter = typeBinding('type:parameter', 'Value', 'typeParameter');
    const identity = aliasDeclaration('type:identity', 'Identity', typeReference(parameter), [
      { binding: parameter, default: numberType },
    ]);
    const first = aliasDeclaration('type:first', 'First', typeReference(identity.binding));
    const second = aliasDeclaration('type:second', 'Second', typeReference(first.binding));
    const module = createModule([identity, first, second]);
    const snapshot = structuredClone(module);

    const direct = analyzeIrTypeValueIdentity(numberType, module);
    const aliased = analyzeIrTypeValueIdentity(typeReference(second.binding), module);

    expect(aliased).toEqual(direct);
    expect(Object.isFrozen(aliased)).toBe(true);
    expect(module).toEqual(snapshot);
  });

  it('classifies declarations by runtime identity rather than structural spelling', () => {
    const class_ = classDeclaration('value:class', 'Model');
    const interface_ = interfaceDeclaration('type:interface', 'ModelShape');
    const enum_ = enumDeclaration('value:enum', 'Mode');
    const classAlias = aliasDeclaration('type:class-alias', 'ModelAlias', typeReference(class_.binding));
    const enumAlias = aliasDeclaration('type:enum-alias', 'ModeAlias', typeReference(enum_.binding));
    const module = createModule([class_, interface_, enum_, classAlias, enumAlias]);

    expect(analyzeIrTypeValueIdentity(typeReference(class_.binding), module)).toMatchObject({
      identity: 'reference',
      reason: 'declared-reference',
    });
    expect(analyzeIrTypeValueIdentity(typeReference(interface_.binding), module)).toMatchObject({
      identity: 'reference',
      reason: 'declared-reference',
    });
    expect(analyzeIrTypeValueIdentity(typeReference(classAlias.binding), module).identity).toBe('reference');
    expect(analyzeIrTypeValueIdentity(typeReference(enum_.binding), module)).toMatchObject({
      identity: 'value',
      reason: 'declared-value',
    });
    expect(analyzeIrTypeValueIdentity(typeReference(enumAlias.binding), module).identity).toBe('value');
  });

  it('uses constraints while leaving unconstrained type parameters indeterminate', () => {
    const value = typeBinding('type:value', 'Value', 'typeParameter');
    const reference = typeBinding('type:reference', 'Reference', 'typeParameter');
    const open = typeBinding('type:open', 'Open', 'typeParameter');
    const declaration = interfaceDeclaration('type:generic', 'Generic', [
      { binding: value, constraint: numberType },
      { binding: reference, constraint: objectType },
      { binding: open },
    ]);
    const module = createModule([declaration]);

    expect(analyzeIrTypeValueIdentity(typeReference(value), module).identity).toBe('value');
    expect(analyzeIrTypeValueIdentity(typeReference(reference), module).identity).toBe('reference');
    expect(analyzeIrTypeValueIdentity(typeReference(open), module)).toMatchObject({
      identity: 'indeterminate',
      reason: 'unconstrained-type-parameter',
    });
  });

  it('combines only types with one proven identity category', () => {
    const module = createModule([]);
    const values = { kind: 'union', types: [numberType, { kind: 'literal', value: 1 }] } as const satisfies IrType;
    const references = {
      kind: 'intersection',
      types: [objectType, ambientType('Map')],
    } as const satisfies IrType;
    const mixed = { kind: 'union', types: [numberType, objectType] } as const satisfies IrType;

    expect(analyzeIrTypeValueIdentity(values, module)).toMatchObject({
      identity: 'value',
      reason: 'homogeneous-compound',
    });
    expect(analyzeIrTypeValueIdentity(references, module)).toMatchObject({
      identity: 'reference',
      reason: 'homogeneous-compound',
    });
    expect(analyzeIrTypeValueIdentity(mixed, module)).toMatchObject({
      identity: 'indeterminate',
      reason: 'ambiguous-compound',
    });
  });

  it('applies explicit identity and arity policy to ambient utility types', () => {
    const module = createModule([]);
    const aliases = ['Readonly', 'Required', 'Partial'] as const;
    const projections = ['Pick', 'Omit'] as const;
    for (const utility of aliases) {
      expect(analyzeIrTypeValueIdentity(ambientType(utility, [numberType]), module)).toEqual(
        analyzeIrTypeValueIdentity(numberType, module),
      );
      expect(analyzeIrTypeValueIdentity(ambientType(utility, [objectType]), module)).toEqual(
        analyzeIrTypeValueIdentity(objectType, module),
      );
    }
    for (const utility of projections) {
      expect(
        analyzeIrTypeValueIdentity(ambientType(utility, [objectType, { kind: 'literal', value: 'id' }]), module),
      ).toEqual(analyzeIrTypeValueIdentity(objectType, module));
    }
    expect(analyzeIrTypeValueIdentity(ambientType('Record', [numberType, objectType]), module)).toMatchObject({
      identity: 'reference',
      reason: 'known-ambient-reference',
    });
    expect(analyzeIrTypeValueIdentity(ambientType('Readonly'), module)).toMatchObject({
      identity: 'indeterminate',
      reason: 'invalid-type-application',
    });
    expect(analyzeIrTypeValueIdentity(ambientType('Record', [numberType]), module)).toMatchObject({
      identity: 'indeterminate',
      reason: 'invalid-type-application',
    });
    expect(analyzeIrTypeValueIdentity(ambientType('Exclude', [numberType, objectType]), module)).toMatchObject({
      identity: 'indeterminate',
      reason: 'unsupported-ambient-utility',
    });
  });

  it('classifies value-side type queries without confusing values and their result types', () => {
    const class_ = classDeclaration('value:type-of-class', 'Model');
    const enum_ = enumDeclaration('value:type-of-enum', 'Mode');
    const function_ = functionDeclaration('value:type-of-function', 'create');
    const numeric = variableDeclaration('value:type-of-number', 'count', numberType);
    const object = variableDeclaration('value:type-of-object', 'state', objectType);
    const unknown = variableDeclaration('value:type-of-unknown', 'external');
    const missing = valueBinding('value:type-of-missing', 'missing', 'variable');
    const module = createModule([class_, enum_, function_, numeric, object, unknown]);

    for (const declaration of [class_, enum_, function_]) {
      expect(analyzeIrTypeValueIdentity(typeOf(declaration.binding), module)).toMatchObject({
        identity: 'reference',
        reason: 'declared-reference',
      });
    }
    expect(analyzeIrTypeValueIdentity(typeOf(numeric.binding), module)).toEqual(
      analyzeIrTypeValueIdentity(numberType, module),
    );
    expect(analyzeIrTypeValueIdentity(typeOf(object.binding), module)).toEqual(
      analyzeIrTypeValueIdentity(objectType, module),
    );
    expect(analyzeIrTypeValueIdentity(typeOf(unknown.binding), module)).toMatchObject({
      identity: 'indeterminate',
      reason: 'unknown-type',
    });
    for (const type of [typeOf(missing), typeOf(class_.binding, ['prototype']), typeOfAmbient('Missing')]) {
      expect(analyzeIrTypeValueIdentity(type, module)).toMatchObject({
        identity: 'indeterminate',
        reason: 'unresolved-reference',
      });
    }
    expect(analyzeIrTypeValueIdentity(typeOfAmbient('Date'), module)).toMatchObject({
      identity: 'reference',
      reason: 'known-ambient-reference',
    });
  });

  it('resolves imported aliases through deterministic re-export evidence without changing it', () => {
    const model = aliasDeclaration('type:model', 'Model', objectType, [], true);
    const source = createModule([model], {
      name: 'model',
      source: 'packages/model.ts',
    });
    const barrel = createModule([], {
      exports: [
        { exported: 'PublicModel', imported: 'Model', kind: 'reexport', specifier: './model.js', typeOnly: true },
      ],
      name: 'barrel',
      source: 'packages/barrel.ts',
    });
    const imported = typeBinding('type:import', 'PublicModel', 'import');
    const subject = createModule([], {
      imports: [
        {
          bindings: [{ binding: imported, imported: 'PublicModel', typeOnly: true }],
          specifier: './barrel.js',
          typeOnly: true,
        },
      ],
      name: 'subject',
      source: 'packages/subject.ts',
    });
    const snapshot = structuredClone([source, barrel, subject]);

    const forward = analyzeIrTypeValueIdentity(typeReference(imported), subject, [source, barrel, subject]);
    const reverse = analyzeIrTypeValueIdentity(typeReference(imported), subject, [subject, barrel, source]);

    expect(forward).toEqual(analyzeIrTypeValueIdentity(objectType, subject));
    expect(reverse).toEqual(forward);
    expect([source, barrel, subject]).toEqual(snapshot);
  });

  it('preserves indeterminate reason when compound members share one, disambiguates otherwise', () => {
    const module = createModule([]);
    const sameReason = {
      kind: 'union',
      types: [
        { kind: 'unknown', source: 'object' },
        { kind: 'unknown', source: 'any' },
      ],
    } as const satisfies IrType;
    const result = analyzeIrTypeValueIdentity(sameReason, module);
    expect(result).toMatchObject({ identity: 'indeterminate', reason: 'unknown-type' });

    const differentReasons = {
      kind: 'union',
      types: [
        { kind: 'unknown', source: 'object' },
        { index: numberType, kind: 'indexedAccess', object: objectType },
      ],
    } as const satisfies IrType;
    expect(analyzeIrTypeValueIdentity(differentReasons, module)).toMatchObject({
      identity: 'indeterminate',
      reason: 'ambiguous-compound',
    });
  });

  it('returns indeterminate for type parameters with qualified path or type arguments', () => {
    const param = typeBinding('type:param', 'T', 'typeParameter');
    const declaration = interfaceDeclaration('type:owner', 'Owner', [{ binding: param }]);
    const module = createModule([declaration]);
    const withPath: IrType = {
      kind: 'named',
      reference: { binding: param, kind: 'binding', path: ['nested'] },
      typeArguments: [],
    };
    expect(analyzeIrTypeValueIdentity(withPath, module)).toMatchObject({
      identity: 'indeterminate',
      reason: 'unresolved-reference',
    });
    const withArgs: IrType = {
      kind: 'named',
      reference: { binding: param, kind: 'binding', path: [] },
      typeArguments: [numberType],
    };
    expect(analyzeIrTypeValueIdentity(withArgs, module)).toMatchObject({
      identity: 'indeterminate',
      reason: 'unresolved-reference',
    });
  });

  it('returns indeterminate for typeof on interface and typeAlias declarations', () => {
    const iface = interfaceDeclaration('type:iface', 'Shape');
    const alias = aliasDeclaration('type:alias', 'Alias', numberType);
    const module = createModule([iface, alias]);

    const ifaceValueRef = valueBinding('type:iface', 'Shape', 'variable');
    const aliasValueRef = valueBinding('type:alias', 'Alias', 'variable');
    expect(analyzeIrTypeValueIdentity(typeOf(ifaceValueRef), module)).toMatchObject({
      identity: 'indeterminate',
      reason: 'unresolved-reference',
    });
    expect(analyzeIrTypeValueIdentity(typeOf(aliasValueRef), module)).toMatchObject({
      identity: 'indeterminate',
      reason: 'unresolved-reference',
    });
  });

  it('detects cyclic type parameter constraints', () => {
    const paramA = typeBinding('type:param-a', 'A', 'typeParameter');
    const paramB = typeBinding('type:param-b', 'B', 'typeParameter');
    const declaration = interfaceDeclaration('type:cyclic-constraint', 'Cyclic', [
      {
        binding: paramA,
        constraint: { kind: 'named', reference: { binding: paramB, kind: 'binding', path: [] }, typeArguments: [] },
      },
      {
        binding: paramB,
        constraint: { kind: 'named', reference: { binding: paramA, kind: 'binding', path: [] }, typeArguments: [] },
      },
    ]);
    const module = createModule([declaration]);
    expect(analyzeIrTypeValueIdentity(typeReference(paramA), module)).toMatchObject({
      identity: 'indeterminate',
      reason: 'cyclic-reference',
    });
  });

  it('returns indeterminate for named type with non-binding reference kind', () => {
    const module = createModule([]);
    const nonBinding: IrType = {
      kind: 'named',
      reference: { kind: 'ambient', name: 'NonExistent' },
      typeArguments: [],
    };
    expect(analyzeIrTypeValueIdentity(nonBinding, module)).toMatchObject({
      identity: 'indeterminate',
      reason: 'unresolved-reference',
    });
  });

  it('returns indeterminate for local binding with qualified path or missing declaration', () => {
    const class_ = classDeclaration('value:local', 'Model');
    const module = createModule([class_]);
    const withPath: IrType = {
      kind: 'named',
      reference: { binding: class_.binding, kind: 'binding', path: ['nested'] },
      typeArguments: [],
    };
    expect(analyzeIrTypeValueIdentity(withPath, module)).toMatchObject({
      identity: 'indeterminate',
      reason: 'unresolved-reference',
    });
    const missingBinding = valueBinding('value:missing', 'Missing', 'variable');
    const missingRef: IrType = {
      kind: 'named',
      reference: { binding: missingBinding, kind: 'binding', path: [] },
      typeArguments: [],
    };
    expect(analyzeIrTypeValueIdentity(missingRef, module)).toMatchObject({
      identity: 'indeterminate',
      reason: 'unresolved-reference',
    });
  });

  it('resolves namespace import star with qualified member path', () => {
    const model = classDeclaration('value:ns-model', 'Model');
    const exported: IrModule['declarations'][number] = { ...model, exported: true };
    const source = createModule([exported], { name: 'types', source: 'packages/types.ts' });
    const ns = typeBinding('type:ns', 'Types', 'import');
    const subject = createModule([], {
      imports: [
        { bindings: [{ binding: ns, imported: '*', typeOnly: true }], specifier: './types.js', typeOnly: true },
      ],
      name: 'consumer',
      source: 'packages/consumer.ts',
    });
    const nsAccess: IrType = {
      kind: 'named',
      reference: { binding: ns, kind: 'binding', path: ['Model'] },
      typeArguments: [],
    };
    expect(analyzeIrTypeValueIdentity(nsAccess, subject, [source, subject])).toMatchObject({
      identity: 'reference',
      reason: 'declared-reference',
    });
  });

  it('resolves local exports and named re-exports through module export records', () => {
    const iface = interfaceDeclaration('type:local-exported', 'Schema');
    const localSource = createModule([iface], {
      exports: [{ binding: iface.binding, exported: 'Schema', kind: 'local', typeOnly: true }],
      name: 'schema',
      source: 'packages/schema.ts',
    });
    const reexportBarrel = createModule([], {
      exports: [{ exported: 'Schema', imported: 'Schema', kind: 'reexport', specifier: './schema.js', typeOnly: true }],
      name: 'reexport-barrel',
      source: 'packages/reexport-barrel.ts',
    });
    const imported = typeBinding('type:reexported', 'Schema', 'import');
    const subject = createModule([], {
      imports: [
        {
          bindings: [{ binding: imported, imported: 'Schema', typeOnly: true }],
          specifier: './reexport-barrel.js',
          typeOnly: true,
        },
      ],
      name: 'consumer',
      source: 'packages/consumer.ts',
    });
    expect(
      analyzeIrTypeValueIdentity(typeReference(imported), subject, [localSource, reexportBarrel, subject]),
    ).toMatchObject({
      identity: 'reference',
      reason: 'declared-reference',
    });
  });

  it('detects cyclic cross-module re-export chains', () => {
    const alpha = createModule([], {
      exports: [{ exported: 'Model', imported: 'Model', kind: 'reexport', specifier: './beta.js', typeOnly: true }],
      name: 'alpha',
      source: 'packages/alpha.ts',
    });
    const beta = createModule([], {
      exports: [{ exported: 'Model', imported: 'Model', kind: 'reexport', specifier: './alpha.js', typeOnly: true }],
      name: 'beta',
      source: 'packages/beta.ts',
    });
    const imported = typeBinding('type:cyclic-import', 'Model', 'import');
    const subject = createModule([], {
      imports: [
        {
          bindings: [{ binding: imported, imported: 'Model', typeOnly: true }],
          specifier: './alpha.js',
          typeOnly: true,
        },
      ],
      name: 'cycle-consumer',
      source: 'packages/cycle-consumer.ts',
    });
    expect(analyzeIrTypeValueIdentity(typeReference(imported), subject, [alpha, beta, subject])).toMatchObject({
      identity: 'indeterminate',
    });
  });

  it('resolves through resolution plan edges for bare package specifiers', () => {
    const model = classDeclaration('value:ext-model', 'ExtModel');
    const exported: IrModule['declarations'][number] = { ...model, exported: true };
    const target = createModule([exported], {
      name: 'ext-model',
      packageName: '@flighthq/model',
      source: 'src/model.ts',
    });
    const imported = typeBinding('type:ext-import', 'ExtModel', 'import');
    const subject = createModule([], {
      imports: [
        {
          bindings: [{ binding: imported, imported: 'ExtModel', typeOnly: true }],
          specifier: '@flighthq/model',
          typeOnly: true,
        },
      ],
      name: 'ext-consumer',
      source: 'packages/ext-consumer.ts',
    });
    const resolution: CompilerModuleResolutionPlan = {
      edges: [{ specifier: '@flighthq/model', target: { packageName: '@flighthq/model', source: 'src/model.ts' } }],
      schema: 'flight-compiler-module-resolution/1',
    };
    expect(analyzeIrTypeValueIdentity(typeReference(imported), subject, [target, subject], resolution)).toMatchObject({
      identity: 'reference',
      reason: 'declared-reference',
    });
  });

  it('scopes repeated resolution specifiers to their explicit importer identity', () => {
    const valueTarget = createModule([aliasDeclaration('type:value-model', 'Model', numberType, [], true)], {
      name: 'value-model',
      packageName: '@workspace/value-model',
      source: 'value/model.ts',
    });
    const referenceTarget = createModule([{ ...classDeclaration('type:reference-model', 'Model'), exported: true }], {
      name: 'reference-model',
      packageName: '@workspace/reference-model',
      source: 'reference/model.ts',
    });
    const valueImport = typeBinding('type:value-import', 'Model', 'import');
    const referenceImport = typeBinding('type:reference-import', 'Model', 'import');
    const valueConsumer = createModule([], {
      imports: [
        {
          bindings: [{ binding: valueImport, imported: 'Model', typeOnly: true }],
          specifier: '@model',
          typeOnly: true,
        },
      ],
      name: 'value-consumer',
      source: 'consumer/value.ts',
    });
    const referenceConsumer = createModule([], {
      imports: [
        {
          bindings: [{ binding: referenceImport, imported: 'Model', typeOnly: true }],
          specifier: '@model',
          typeOnly: true,
        },
      ],
      name: 'reference-consumer',
      source: 'consumer/reference.ts',
    });
    const resolution: CompilerModuleResolutionPlan = {
      edges: [
        {
          importer: valueConsumer,
          specifier: '@model',
          target: { packageName: valueTarget.packageName, source: valueTarget.source },
        },
        {
          importer: referenceConsumer,
          specifier: '@model',
          target: { packageName: referenceTarget.packageName, source: referenceTarget.source },
        },
      ],
      schema: 'flight-compiler-module-resolution/1',
    };
    const modules = [valueTarget, referenceTarget, valueConsumer, referenceConsumer];

    expect(analyzeIrTypeValueIdentity(typeReference(valueImport), valueConsumer, modules, resolution)).toMatchObject({
      identity: 'value',
    });
    expect(
      analyzeIrTypeValueIdentity(typeReference(referenceImport), referenceConsumer, modules, resolution),
    ).toMatchObject({ identity: 'reference' });
  });

  it('resolves parent directory traversal and extensionless specifiers', () => {
    const model = classDeclaration('value:deep-model', 'DeepModel');
    const exported: IrModule['declarations'][number] = { ...model, exported: true };
    const deep = createModule([exported], { name: 'deep', source: 'packages/models/deep.ts' });
    const imported = typeBinding('type:deep-import', 'DeepModel', 'import');
    const subject = createModule([], {
      imports: [
        {
          bindings: [{ binding: imported, imported: 'DeepModel', typeOnly: true }],
          specifier: '../models/deep.js',
          typeOnly: true,
        },
      ],
      name: 'sibling-consumer',
      source: 'packages/sibling/consumer.ts',
    });
    expect(analyzeIrTypeValueIdentity(typeReference(imported), subject, [deep, subject])).toMatchObject({
      identity: 'reference',
      reason: 'declared-reference',
    });

    const indexModule = createModule([exported], { name: 'index-model', source: 'packages/shared/index.ts' });
    const indexImported = typeBinding('type:index-import', 'DeepModel', 'import');
    const indexConsumer = createModule([], {
      imports: [
        {
          bindings: [{ binding: indexImported, imported: 'DeepModel', typeOnly: true }],
          specifier: './shared',
          typeOnly: true,
        },
      ],
      name: 'index-consumer',
      source: 'packages/index-consumer.ts',
    });
    expect(
      analyzeIrTypeValueIdentity(typeReference(indexImported), indexConsumer, [indexModule, indexConsumer]),
    ).toMatchObject({ identity: 'reference', reason: 'declared-reference' });
  });

  it('returns empty candidates when parent traversal goes above root', () => {
    const model = classDeclaration('value:root-model', 'RootModel');
    const exported: IrModule['declarations'][number] = { ...model, exported: true };
    const target = createModule([exported], { name: 'root-target', source: 'root.ts' });
    const imported = typeBinding('type:root-import', 'RootModel', 'import');
    const subject = createModule([], {
      imports: [
        {
          bindings: [{ binding: imported, imported: 'RootModel', typeOnly: true }],
          specifier: '../../above-root.js',
          typeOnly: true,
        },
      ],
      name: 'root-consumer',
      source: 'consumer.ts',
    });
    expect(analyzeIrTypeValueIdentity(typeReference(imported), subject, [target, subject])).toMatchObject({
      identity: 'indeterminate',
      reason: 'unresolved-reference',
    });
  });

  it('collects type parameters from function and class method declarations', () => {
    const fnParam = typeBinding('type:fn-param', 'T', 'typeParameter');
    const fn = functionDeclaration('value:generic-fn', 'transform');
    (fn as unknown as { typeParameters: IrTypeParameter[] }).typeParameters = [
      { binding: fnParam, constraint: objectType },
    ];

    const methodParam = typeBinding('type:method-param', 'U', 'typeParameter');
    const class_ = classDeclaration('value:generic-class', 'Container');
    (class_ as unknown as { methods: IrClassMethod[] }).methods = [
      {
        async: false,
        body: [],
        name: 'map',
        overloads: [],
        parameters: [],
        returns: numberType,
        static: false,
        typeParameters: [{ binding: methodParam, constraint: numberType }],
        visibility: 'public',
      },
    ];
    const module = createModule([fn, class_]);
    expect(analyzeIrTypeValueIdentity(typeReference(fnParam), module)).toMatchObject({
      identity: 'reference',
      reason: 'intrinsic-reference',
    });
    expect(analyzeIrTypeValueIdentity(typeReference(methodParam), module)).toMatchObject({
      identity: 'value',
      reason: 'intrinsic-value',
    });
  });

  it('refuses ambiguous export-star identity and never forwards a default through a star', () => {
    const left = createModule([aliasDeclaration('type:left-model', 'Model', objectType, [], true)], {
      name: 'left',
      source: 'packages/left.ts',
    });
    const right = createModule([aliasDeclaration('type:right-model', 'Model', objectType, [], true)], {
      name: 'right',
      source: 'packages/right.ts',
    });
    const barrel = createModule([], {
      exports: [
        { kind: 'all', specifier: './left.js', typeOnly: true },
        { kind: 'all', specifier: './right.js', typeOnly: true },
        { exported: 'Models', kind: 'namespace', specifier: './left.js', typeOnly: true },
        { expression: { kind: 'literal', value: 1 }, kind: 'default' },
      ],
      name: 'barrel',
      source: 'packages/barrel.ts',
    });
    const model = typeBinding('type:ambiguous-model', 'Model', 'import');
    const default_ = typeBinding('type:star-default', 'DefaultModel', 'import');
    const subject = createModule([], {
      imports: [
        {
          bindings: [
            { binding: model, imported: 'Model', typeOnly: true },
            { binding: default_, imported: 'default', typeOnly: true },
          ],
          specifier: './barrel.js',
          typeOnly: true,
        },
      ],
      name: 'star-subject',
      source: 'packages/star-subject.ts',
    });
    const modules = [subject, barrel, right, left];

    for (const imported of [model, default_]) {
      expect(analyzeIrTypeValueIdentity(typeReference(imported), subject, modules)).toMatchObject({
        identity: 'indeterminate',
        reason: 'unresolved-reference',
      });
    }
  });

  it('distinguishes unresolved imports, invalid applications, and cycles deterministically', () => {
    const cycleA = typeBinding('type:cycle-a', 'CycleA', 'typeAlias');
    const cycleB = typeBinding('type:cycle-b', 'CycleB', 'typeAlias');
    const required = typeBinding('type:required', 'Value', 'typeParameter');
    const imported = typeBinding('type:missing-import', 'Missing', 'import');
    const module = createModule(
      [
        aliasDeclarationWithBinding(cycleA, typeReference(cycleB)),
        aliasDeclarationWithBinding(cycleB, typeReference(cycleA)),
        aliasDeclaration('type:generic', 'Generic', typeReference(required), [{ binding: required }]),
      ],
      {
        imports: [
          {
            bindings: [{ binding: imported, imported: 'Missing', typeOnly: true }],
            specifier: './missing.js',
            typeOnly: true,
          },
        ],
      },
    );

    expect(analyzeIrTypeValueIdentity(typeReference(cycleA), module)).toMatchObject({
      identity: 'indeterminate',
      reason: 'cyclic-reference',
    });
    expect(analyzeIrTypeValueIdentity(typeReference(cycleB), module)).toEqual(
      analyzeIrTypeValueIdentity(typeReference(cycleA), module),
    );
    expect(analyzeIrTypeValueIdentity(typeReference(imported), module)).toMatchObject({
      identity: 'indeterminate',
      reason: 'unresolved-reference',
    });
    const generic = module.declarations.find(
      (declaration): declaration is IrTypeAliasDeclaration =>
        declaration.kind === 'typeAlias' && declaration.binding.name === 'Generic',
    )!;
    expect(analyzeIrTypeValueIdentity(typeReference(generic.binding), module)).toMatchObject({
      identity: 'indeterminate',
      reason: 'invalid-type-application',
    });
  });
});

describe('createIrTypeValueIdentityAnalyzer', () => {
  it('reuses one immutable module graph with results equivalent to the single-shot analysis', () => {
    const alias = aliasDeclaration('type:alias', 'Alias', objectType);
    const module = createModule([alias]);
    const valueAlias = aliasDeclaration('type:value-alias', 'ValueAlias', numberType);
    const other = createModule([valueAlias], { name: 'other', source: 'packages/other.ts' });
    const modules = [module, other];
    const snapshot = structuredClone(modules);

    const analyzer = createIrTypeValueIdentityAnalyzer(modules);

    expect(Object.isFrozen(analyzer)).toBe(true);
    expect(analyzer.schema).toBe('flight-compiler-type-value-identity-analyzer/1');
    expect(analyzer.analyze(numberType, module)).toEqual(analyzeIrTypeValueIdentity(numberType, module, modules));
    expect(analyzer.analyze(typeReference(alias.binding), module)).toEqual(
      analyzeIrTypeValueIdentity(typeReference(alias.binding), module, modules),
    );
    expect(analyzer.analyze(typeReference(alias.binding), module)).toEqual(
      analyzer.analyze(typeReference(alias.binding), module),
    );
    expect(analyzer.analyze(typeReference(valueAlias.binding), other)).toEqual(
      analyzeIrTypeValueIdentity(typeReference(valueAlias.binding), other, modules),
    );
    expect(modules).toEqual(snapshot);
  });

  it('rejects malformed graphs and resolution plans before identity analysis', () => {
    const module = createModule([]);
    expect(() => createIrTypeValueIdentityAnalyzer({} as unknown as readonly IrModule[])).toThrow(
      'Type value identity module set must be an array',
    );
    for (const resolution of [
      null,
      {},
      { edges: [], schema: 'other' },
      { edges: {}, schema: 'flight-compiler-module-resolution/1' },
    ]) {
      expect(() =>
        createIrTypeValueIdentityAnalyzer([module], resolution as unknown as CompilerModuleResolutionPlan),
      ).toThrow('Type value identity module resolution plan is invalid');
    }

    const invalidEdges = [
      null,
      { specifier: '', target: { packageName: '@flighthq/model', source: 'model.ts' } },
      { specifier: '@flighthq/model' },
      { specifier: '@flighthq/model', target: { packageName: '', source: 'model.ts' } },
      { specifier: '@flighthq/model', target: { packageName: '@flighthq/model', source: '' } },
    ];
    for (const edge of invalidEdges) {
      expect(() =>
        createIrTypeValueIdentityAnalyzer([module], {
          edges: [edge] as unknown as CompilerModuleResolutionPlan['edges'],
          schema: 'flight-compiler-module-resolution/1',
        }),
      ).toThrow('Type value identity module resolution plan contains an invalid or duplicate edge');
    }

    const edge = {
      specifier: '@flighthq/model',
      target: { packageName: '@flighthq/model', source: 'model.ts' },
    } as const;
    expect(() =>
      createIrTypeValueIdentityAnalyzer([module], {
        edges: [edge, edge],
        schema: 'flight-compiler-module-resolution/1',
      }),
    ).toThrow('Type value identity module resolution plan contains an invalid or duplicate edge');
    expect(() => createIrTypeValueIdentityAnalyzer([module, structuredClone(module)])).toThrow(
      'Type value identity module set contains a duplicate module identity',
    );

    const duplicate = classDeclaration('value:duplicate', 'Duplicate');
    expect(() => createIrTypeValueIdentityAnalyzer([createModule([duplicate, duplicate])])).toThrow(
      'Type value identity module contains a duplicate declaration identity',
    );
    const parameter = { binding: typeBinding('type:duplicate', 'T', 'typeParameter') };
    expect(() =>
      createIrTypeValueIdentityAnalyzer([
        createModule([
          interfaceDeclaration('type:first-owner', 'First', [parameter]),
          interfaceDeclaration('type:second-owner', 'Second', [parameter]),
        ]),
      ]),
    ).toThrow('Type value identity module contains a duplicate type parameter identity');

    const analyzer = createIrTypeValueIdentityAnalyzer([module]);
    expect(() => analyzer.analyze(numberType, createModule([], { name: 'outside' }))).toThrow(
      'Type value identity subject must belong to the explicit module set',
    );
  });
});

function aliasDeclaration(
  id: string,
  name: string,
  type: IrType,
  typeParameters: IrTypeParameter[] = [],
  exported = false,
): IrTypeAliasDeclaration {
  return aliasDeclarationWithBinding(typeBinding(id, name, 'typeAlias'), type, typeParameters, exported);
}

function aliasDeclarationWithBinding(
  binding: IrTypeBindingIdentity,
  type: IrType,
  typeParameters: IrTypeParameter[] = [],
  exported = false,
): IrTypeAliasDeclaration {
  return { binding, exported, kind: 'typeAlias', origin: sourceOrigin(), type, typeParameters };
}

function ambientType(name: string, typeArguments: readonly IrType[] = []): IrType {
  return { kind: 'named', reference: { kind: 'ambient', name }, typeArguments };
}

function classDeclaration(id: string, name: string): IrClassDeclaration {
  return {
    abstract: false,
    binding: valueBinding(id, name, 'class'),
    exported: false,
    fields: [],
    implements: [],
    kind: 'class',
    methods: [],
    origin: sourceOrigin(),
    typeParameters: [],
  };
}

function createModule(declarations: IrModule['declarations'], changes: Partial<IrModule> = {}): IrModule {
  return {
    declarations,
    exports: [],
    imports: [],
    name: 'identity',
    packageName: '@flighthq/structural',
    source: 'packages/identity.ts',
    ...changes,
  };
}

function enumDeclaration(id: string, name: string): IrEnumDeclaration {
  return {
    binding: valueBinding(id, name, 'enum'),
    exported: false,
    kind: 'enum',
    members: [{ name: 'Ready', value: 1 }],
    origin: sourceOrigin(),
  };
}

function functionDeclaration(id: string, name: string): IrFunctionDeclaration {
  return {
    async: false,
    binding: valueBinding(id, name, 'function'),
    body: [],
    exported: false,
    kind: 'function',
    origin: sourceOrigin(),
    overloads: [],
    parameters: [],
    returns: numberType,
    typeParameters: [],
  };
}

function interfaceDeclaration(
  id: string,
  name: string,
  typeParameters: IrTypeParameter[] = [],
): IrInterfaceDeclaration {
  return {
    binding: typeBinding(id, name, 'interface'),
    exported: false,
    extends: [],
    kind: 'interface',
    origin: sourceOrigin(),
    properties: [],
    typeParameters,
  };
}

function sourceOrigin(): CompilerSourceOrigin {
  return {
    column: 1,
    fingerprint: `sha256:${'0'.repeat(64)}`,
    line: 1,
    packageName: '@flighthq/structural',
    source: 'packages/identity.ts',
  };
}

function typeBinding(id: string, name: string, kind: IrTypeBindingIdentity['kind']): IrTypeBindingIdentity {
  return {
    ...sourceOrigin(),
    id,
    kind,
    name,
    scope: kind === 'typeParameter' ? 'declaration' : 'module',
    space: 'type',
  };
}

function typeReference(
  binding: IrBindingIdentity | IrTypeBindingIdentity,
  typeArguments: readonly IrType[] = [],
): IrType {
  return { kind: 'named', reference: { binding, kind: 'binding', path: [] }, typeArguments };
}

function typeOf(binding: IrBindingIdentity, path: readonly string[] = []): IrType {
  return { kind: 'typeOf', reference: { binding, kind: 'binding', path } };
}

function typeOfAmbient(name: string): IrType {
  return { kind: 'typeOf', reference: { kind: 'ambient', name } };
}

function variableDeclaration(
  id: string,
  name: string,
  type?: IrType,
): IrVariableDeclaration & Readonly<{ binding: IrBindingIdentity }> {
  return {
    binding: valueBinding(id, name, 'variable'),
    declarationKind: 'const',
    exported: false,
    kind: 'variable',
    mutable: false,
    origin: sourceOrigin(),
    type,
  };
}

function valueBinding(
  id: string,
  name: string,
  kind: Extract<IrBindingIdentity['kind'], 'class' | 'enum' | 'function' | 'variable'>,
): IrBindingIdentity {
  return { ...sourceOrigin(), id, kind, name, scope: 'module', space: 'value' };
}
