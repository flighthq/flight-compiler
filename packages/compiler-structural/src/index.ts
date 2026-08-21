export { createIrObjectCopySemantics } from './compilerStructuralObjectCopySemantics.js';
export { analyzeIrModuleStructuralObjectCompatibility } from './compilerStructuralObjectCompatibility.js';
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
