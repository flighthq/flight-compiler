export { createCppCompilerBackend, emitIrModuleCpp } from './cppCompilerBackend.js';
export { createIrModuleClosureCapturePlanCpp } from './cppClosureCapturePlan.js';
export {
  createIrTypeReferenceRepresentationPlanCpp,
  createIrTypeReferenceRepresentationPlannerCpp,
} from './cppReferenceRepresentationPlan.js';
export {
  convertPackageNameToCppNamespace,
  convertSourcePathToCppFileName,
  getCppCompilerPackageIncludePrefix,
  getCppCompilerPackageNamespace,
  isCppCompilerKeyword,
} from './cppCompilerIdentity.js';
export {
  createCompilerRuntimeExternalSymbolBindingPlanCpp,
  getCompilerRuntimeExternalSymbolTargetCpp,
} from './cppRuntimeExternalSymbolBinding.js';
