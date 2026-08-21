import type {
  IrBindingIdentity,
  IrIdentifierReference,
  IrTypeBindingIdentity,
  IrTypeNameReference,
  IrValueNameReference,
} from './compilerBindingIntermediateRepresentation.js';
import type { CompilerSourceOrigin } from './compilerSourceIdentity.js';

describe('compiler binding intermediate representation contracts', () => {
  it('links resolved references to globally sourced plain-data identities', () => {
    const binding: IrBindingIdentity = {
      column: 7,
      fingerprint: 'sha256:value',
      id: 'binding:["@flighthq/math","packages/math/src/value.ts",7]',
      kind: 'variable',
      line: 1,
      name: 'value',
      packageName: '@flighthq/math',
      scope: 'function',
      space: 'value',
      source: 'packages/math/src/value.ts',
    };
    const references: readonly IrIdentifierReference[] = [
      { binding, kind: 'binding' },
      { kind: 'ambient', name: 'Error' },
      { kind: 'this' },
    ];

    expect(references.map((reference) => reference.kind)).toEqual(['binding', 'ambient', 'this']);
    expectTypeOf(binding).toMatchTypeOf<CompilerSourceOrigin>();
    expectTypeOf<IrBindingIdentity['kind']>().toEqualTypeOf<
      'catch' | 'class' | 'enum' | 'function' | 'import' | 'parameter' | 'variable'
    >();
    expectTypeOf<IrBindingIdentity['scope']>().toEqualTypeOf<'block' | 'declaration' | 'function' | 'module'>();
    expectTypeOf<Extract<IrIdentifierReference, { kind: 'binding' }>['binding']>().toEqualTypeOf<IrBindingIdentity>();
  });

  it('separates type-only identities while permitting dual-space declarations in type references', () => {
    const typeBinding: IrTypeBindingIdentity = {
      column: 1,
      fingerprint: 'sha256:type',
      id: 'type-binding:["@flighthq/math","value.ts",0]',
      kind: 'typeParameter',
      line: 1,
      name: 'Value',
      packageName: '@flighthq/math',
      scope: 'declaration',
      source: 'value.ts',
      space: 'type',
    };
    const reference: IrTypeNameReference = { binding: typeBinding, kind: 'binding', path: [] };

    expect(reference).toMatchObject({ binding: { space: 'type' }, kind: 'binding', path: [] });
    expectTypeOf<IrTypeBindingIdentity['kind']>().toEqualTypeOf<
      'import' | 'interface' | 'typeAlias' | 'typeParameter'
    >();
    expectTypeOf<Extract<IrTypeNameReference, { kind: 'binding' }>['binding']>().toEqualTypeOf<
      IrBindingIdentity | IrTypeBindingIdentity
    >();
    expectTypeOf<Extract<IrValueNameReference, { kind: 'binding' }>['binding']>().toEqualTypeOf<IrBindingIdentity>();
  });
});
