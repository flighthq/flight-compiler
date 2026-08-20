import type { IrDeclaration } from './compilerDeclarationIntermediateRepresentation.js';
import type { IrModule } from './compilerModuleIntermediateRepresentation.js';
import type { CompilerModuleIdentity } from './compilerSourceIdentity.js';

describe('compiler module intermediate representation contracts', () => {
  it('composes declaration collections with globally identified modules', () => {
    const declaration: IrDeclaration = {
      async: false,
      binding: {
        column: 1,
        fingerprint: 'sha256:value',
        id: 'binding:["@flighthq/math","packages/math/src/value.ts",0]',
        kind: 'function',
        line: 1,
        name: 'readValue',
        packageName: '@flighthq/math',
        scope: 'module',
        space: 'value',
        source: 'packages/math/src/value.ts',
      },
      body: [{ expression: { kind: 'literal', value: 1 }, kind: 'return' }],
      exported: true,
      kind: 'function',
      origin: {
        column: 1,
        fingerprint: 'sha256:value',
        line: 1,
        packageName: '@flighthq/math',
        source: 'packages/math/src/value.ts',
      },
      overloads: [],
      parameters: [],
      returns: { kind: 'primitive', name: 'number' },
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
    expectTypeOf(module).toMatchTypeOf<CompilerModuleIdentity>();
    expectTypeOf(module.declarations).toEqualTypeOf<readonly IrDeclaration[]>();
  });
});
