import { describe, expect, it } from 'vitest';

import type {
  CompilerSourceOrigin,
  IrBindingIdentity,
  IrClassDeclaration,
  IrEnumDeclaration,
  IrInterfaceDeclaration,
  IrModule,
  IrType,
  IrTypeAliasDeclaration,
  IrTypeBindingIdentity,
  IrTypeParameter,
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

function valueBinding(
  id: string,
  name: string,
  kind: Extract<IrBindingIdentity['kind'], 'class' | 'enum'>,
): IrBindingIdentity {
  return { ...sourceOrigin(), id, kind, name, scope: 'module', space: 'value' };
}
