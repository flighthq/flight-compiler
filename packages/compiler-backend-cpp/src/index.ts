export { createCppCompilerBackend, emitIrModuleCpp } from './cppCompilerBackend.js';
export {
  convertPackageNameToCppNamespace,
  convertSourcePathToCppFileName,
  isCppCompilerKeyword,
} from './cppCompilerIdentity.js';
export {
  createCompilerRuntimeExternalSymbolBindingPlanCpp,
  getCompilerRuntimeExternalSymbolTargetCpp,
} from './cppRuntimeExternalSymbolBinding.js';
