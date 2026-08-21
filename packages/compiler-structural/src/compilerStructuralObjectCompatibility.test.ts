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
import { analyzeIrModuleStructuralObjectCompatibility } from './compilerStructuralObjectCompatibility.js';

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

function createModule(declarations: IrModule['declarations'], expressions: readonly IrExpression[]): IrModule {
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
  kind: 'interface' | 'typeAlias' | 'typeParameter',
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
