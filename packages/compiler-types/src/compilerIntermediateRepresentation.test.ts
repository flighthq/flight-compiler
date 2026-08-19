import type {
  IrDeclaration,
  IrExpression,
  IrModule,
  IrStatement,
  IrType,
} from './compilerIntermediateRepresentation.js';

describe('compiler intermediate representation contracts', () => {
  it('compose type, expression, statement, declaration, and module identities as plain data', () => {
    const type: IrType = { kind: 'union', types: [{ kind: 'primitive', name: 'number' }, { kind: 'null' }] };
    const expression: IrExpression = { kind: 'literal', value: 1 };
    const statement: IrStatement = { expression, kind: 'return' };
    const declaration: IrDeclaration = {
      async: false,
      body: [statement],
      exported: true,
      kind: 'function',
      name: 'readValue',
      origin: {
        column: 1,
        fingerprint: 'sha256:value',
        line: 1,
        packageName: '@flighthq/math',
        source: 'packages/math/src/value.ts',
      },
      overloads: [],
      parameters: [],
      returns: type,
      typeParameters: [],
    };
    const module: IrModule = {
      declarations: [declaration],
      exports: [],
      imports: [],
      name: 'Value',
      packageName: '@flighthq/math',
      source: 'packages/math/src/value.ts',
    };

    expect(module.declarations[0]).toBe(declaration);
    expect(module).toMatchObject({ name: 'Value', packageName: '@flighthq/math' });
  });
});
