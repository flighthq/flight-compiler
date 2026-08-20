import type {
  IrClassDeclaration,
  IrDeclaration,
  IrTypeAliasDeclaration,
} from './compilerDeclarationIntermediateRepresentation.js';
import type { CompilerSourceOrigin } from './compilerSourceIdentity.js';
import type { IrTypeReference } from './compilerTypeIntermediateRepresentation.js';

describe('compiler declaration intermediate representation contracts', () => {
  it('distinguishes type aliases and explicit class constructors as plain data', () => {
    const origin: CompilerSourceOrigin = {
      column: 1,
      fingerprint: 'sha256:value',
      line: 1,
      packageName: '@flighthq/math',
      source: 'packages/math/src/value.ts',
    };
    const alias: IrTypeAliasDeclaration = {
      exported: true,
      kind: 'typeAlias',
      name: 'Value',
      origin,
      type: { kind: 'primitive', name: 'number' },
      typeParameters: [],
    };
    const classDeclaration: IrClassDeclaration = {
      abstract: false,
      binding: {
        ...origin,
        id: 'binding:["@flighthq/math","packages/math/src/value.ts",0]',
        kind: 'class',
        name: 'Container',
        scope: 'module',
      },
      classConstructor: { body: [], parameters: [] },
      exported: true,
      fields: [],
      implements: [],
      kind: 'class',
      methods: [],
      origin,
      typeParameters: [],
    };
    const declarations: readonly IrDeclaration[] = [alias, classDeclaration];

    expect(declarations.map((declaration) => declaration.kind)).toEqual(['typeAlias', 'class']);
    expect(classDeclaration.classConstructor).toEqual({ body: [], parameters: [] });
    expectTypeOf<IrClassDeclaration['extends']>().toEqualTypeOf<IrTypeReference | undefined>();
  });
});
