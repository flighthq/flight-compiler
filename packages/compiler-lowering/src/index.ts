export { createCompilerLoweringPassArrayBindingPattern } from './compilerArrayBindingPatternLowering.js';
export { createCompilerLoweringPassBindingPattern } from './compilerBindingPatternLowering.js';
export { hasIrModuleArrayBindingPattern } from './compilerArrayBindingPatternPresence.js';
export { createCompilerLoweringPassCStyleFor } from './compilerCStyleForLowering.js';
export { createCompilerLoweringPassExtraArgumentErasure } from './compilerExtraArgumentErasureLowering.js';
export { createCompilerLoweringPassInterfaceInheritance } from './compilerInterfaceInheritanceLowering.js';
export { createCompilerLoweringPassObjectBindingPattern } from './compilerObjectBindingPatternLowering.js';
export { getIrSwitchCaseCompletion } from './compilerSwitchClauseCompletion.js';
export { createCompilerLoweringPassSwitchFallthrough } from './compilerSwitchFallthroughLowering.js';
export { createCompilerLoweringPassVariableHoisting } from './compilerVariableHoistingLowering.js';
export {
  createCompilerLoweringFailure,
  isCompilerLoweringFailure,
  lowerIrModuleWithCompilerPasses,
} from './compilerLoweringPass.js';
