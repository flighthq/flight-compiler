import type { IrBindingIdentity, IrType } from '../../compiler-types/src/index.js';
import { emitIrTypeHaxe } from './haxeTypeEmission.js';

describe('emitIrTypeHaxe', () => {
  it('uses explicit binding, external, member, and failure capabilities', () => {
    const binding: IrBindingIdentity = {
      column: 1,
      fingerprint: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      id: 'binding',
      kind: 'class',
      line: 1,
      name: 'model',
      packageName: '@flighthq/types',
      scope: 'module',
      source: 'model.ts',
      space: 'value',
    };
    const context = {
      fail(message: string): never {
        throw new Error(message);
      },
      getBindingName: () => 'Model',
      getExternalTypeName: (name: string) => (name === 'Promise' ? 'Task' : undefined),
      getMemberName: (name: string) => `${name}_field`,
      getTypeName: (name: string) => `${name.slice(0, 1).toUpperCase()}${name.slice(1)}Type`,
      resolveNamedType: (type: Readonly<Extract<IrType, { kind: 'named' }>>) =>
        type.reference.kind === 'binding' && type.reference.binding.id === 'alias' ? 'String' : undefined,
    };
    const named: IrType = {
      kind: 'named',
      reference: { binding, kind: 'binding', path: ['value'] },
      typeArguments: [{ kind: 'primitive', name: 'number' }],
    };
    const external: IrType = {
      kind: 'named',
      reference: { kind: 'ambient', name: 'Promise' },
      typeArguments: [{ kind: 'primitive', name: 'string' }],
    };
    const record: IrType = {
      kind: 'named',
      reference: { kind: 'ambient', name: 'Record' },
      typeArguments: [
        { kind: 'primitive', name: 'string' },
        { kind: 'primitive', name: 'number' },
      ],
    };

    expect(emitIrTypeHaxe(named, context)).toBe('Model.ValueType<Float>');
    expect(emitIrTypeHaxe(external, context)).toBe('Task<String>');
    expect(
      emitIrTypeHaxe(record, {
        ...context,
        getExternalTypeName: (name: string) => (name === 'Record' ? 'haxe.DynamicAccess' : undefined),
      }),
    ).toBe('haxe.DynamicAccess<Float>');
    expect(
      emitIrTypeHaxe(
        {
          kind: 'object',
          properties: [
            { name: 'value', optional: true, readonly: false, type: { kind: 'primitive', name: 'boolean' } },
          ],
        },
        context,
      ),
    ).toBe('{ ?value_field:Bool }');
    expect(() =>
      emitIrTypeHaxe({ kind: 'named', reference: { kind: 'ambient', name: 'Missing' }, typeArguments: [] }, context),
    ).toThrow('external type Missing has no Haxe binding');
    expect(() =>
      emitIrTypeHaxe(
        { kind: 'union', types: [{ kind: 'primitive', name: 'string' }, { kind: 'null' }, { kind: 'undefined' }] },
        context,
      ),
    ).toThrow('types containing both null and undefined require distinct Haxe sentinels');
    expect(
      emitIrTypeHaxe(
        {
          kind: 'named',
          reference: { binding: { ...binding, id: 'alias', kind: 'class' }, kind: 'binding', path: [] },
          typeArguments: [],
        },
        context,
      ),
    ).toBe('String');
  });
});
