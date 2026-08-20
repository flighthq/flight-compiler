import type { IrBindingIdentity, IrIdentifierReference } from './compilerBindingIntermediateRepresentation.js';
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
      scope: 'local',
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
      'catch' | 'class' | 'enum' | 'function' | 'import' | 'interface' | 'parameter' | 'typeAlias' | 'variable'
    >();
    expectTypeOf<IrBindingIdentity['scope']>().toEqualTypeOf<'local' | 'module'>();
    expectTypeOf<Extract<IrIdentifierReference, { kind: 'binding' }>['binding']>().toEqualTypeOf<IrBindingIdentity>();
  });
});
