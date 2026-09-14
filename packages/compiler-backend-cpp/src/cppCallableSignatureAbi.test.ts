import { getCompilerCallableSignatureAbiCpp } from './cppCallableSignatureAbi.js';

describe('getCompilerCallableSignatureAbiCpp', () => {
  it('publishes the frozen callable trait and binding spellings under one ABI revision', () => {
    const abi = getCompilerCallableSignatureAbiCpp();

    expect(abi).toEqual({
      bind: 'flight::bind_callable_v1',
      contract: 'flight-cpp-callable-signature-abi/1',
      trait: 'flight::callable_signature_v1',
    });
    expect(Object.isFrozen(abi)).toBe(true);
    expect(getCompilerCallableSignatureAbiCpp()).toBe(abi);
  });
});
