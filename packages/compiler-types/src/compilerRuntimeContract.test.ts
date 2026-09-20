import type { CompilerRuntimeExternalMemberBinding } from './compilerRuntimeContract.js';

describe('CompilerRuntimeExternalMemberBinding', () => {
  it('carries optional exact call-result evidence independently from its target spelling', () => {
    const binding = {
      callResultType: 'flight::Symbol',
      sourceMember: 'for',
      targetName: 'flight::Symbol::for_key',
    } satisfies CompilerRuntimeExternalMemberBinding;

    expect(binding).toEqual({
      callResultType: 'flight::Symbol',
      sourceMember: 'for',
      targetName: 'flight::Symbol::for_key',
    });
    expectTypeOf(binding).toMatchTypeOf<CompilerRuntimeExternalMemberBinding>();
  });
});
