export { createIrObjectCopySemantics } from './compilerStructuralObjectCopySemantics.js';
export {
  analyzeIrModuleStructuralObjectCompatibility,
  analyzeIrModuleStructuralObjectCompatibilityAcrossModules,
} from './compilerStructuralObjectCompatibility.js';
export {
  analyzeIrTypeStructuralAssignability,
  isCompilerStructuralTypeAssignabilityFailure,
} from './compilerStructuralTypeAssignability.js';
export {
  createIrObjectTypeShapeIdentity,
  isCompilerStructuralTypeShapeFailure,
} from './compilerStructuralTypeShapeIdentity.js';
export { collectIrModulesStructuralTypeShapes } from './compilerStructuralTypeShapeInventory.js';
export {
  createIrTypeParameterSubstitutionPlan,
  isCompilerStructuralTypeSubstitutionFailure,
  resolveIrTypeStructuralSubstitution,
} from './compilerStructuralTypeSubstitution.js';
export { analyzeIrTypeValueIdentity, createIrTypeValueIdentityAnalyzer } from './compilerTypeValueIdentityAnalysis.js';
