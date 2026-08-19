import type { IrStatement, IrType } from './compilerIntermediateRepresentation.js';
import type { SemanticPatch } from './compilerSemanticPatchContract.js';
import type { CompilerExportIdentity } from './compilerSourceIdentity.js';

describe('compiler semantic patch contracts', () => {
  it('represent every patch operation with shared target, expectation, reason, and scope identity', () => {
    const body: IrStatement[] = [{ expression: { kind: 'literal', value: 1 }, kind: 'return' }];
    const type: IrType = { kind: 'primitive', name: 'string' };
    const common = {
      expect: { fingerprint: 'sha256:value', kind: 'function' as const },
      reason: 'contract fixture',
      scope: { kind: 'neutral' as const },
      target: {
        exportName: 'readValue',
        packageName: '@flighthq/math',
        source: 'packages/math/src/value.ts',
      },
    };
    const patches: SemanticPatch[] = [
      { ...common, id: 'remove', operation: 'remove' },
      { ...common, id: 'rename', name: 'getValue', operation: 'rename' },
      { ...common, body, id: 'body', operation: 'replaceBody' },
      { ...common, expect: { ...common.expect, kind: 'type' }, id: 'type', operation: 'replaceType', type },
    ];

    expect(patches.map((patch) => patch.operation)).toEqual(['remove', 'rename', 'replaceBody', 'replaceType']);
    expect(patches.every((patch) => patch.target === common.target)).toBe(true);
    expectTypeOf<SemanticPatch['target']>().toEqualTypeOf<CompilerExportIdentity>();
  });
});
