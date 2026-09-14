interface CompilerCallableSignatureAbiCpp {
  readonly bind: string;
  readonly contract: string;
  readonly trait: string;
}

export function getCompilerCallableSignatureAbiCpp(): CompilerCallableSignatureAbiCpp {
  return compilerCallableSignatureAbiCpp;
}

const compilerCallableSignatureAbiCpp = Object.freeze({
  bind: 'flight::bind_callable_v1',
  contract: 'flight-cpp-callable-signature-abi/1',
  trait: 'flight::callable_signature_v1',
});
