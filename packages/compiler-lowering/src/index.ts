export { createCompilerLoweringPassArrayBindingPattern } from './compilerArrayBindingPatternLowering.js';
export { hasIrModuleArrayBindingPattern } from './compilerArrayBindingPatternPresence.js';
export { createCompilerLoweringPassCStyleFor } from './compilerCStyleForLowering.js';
export { getIrSwitchCaseCompletion } from './compilerSwitchClauseCompletion.js';
export { createCompilerLoweringPassSwitchFallthrough } from './compilerSwitchFallthroughLowering.js';
export { createCompilerLoweringPassVariableHoisting } from './compilerVariableHoistingLowering.js';
export {
  createCompilerLoweringFailure,
  isCompilerLoweringFailure,
  lowerIrModuleWithCompilerPasses,
} from './compilerLoweringPass.js';
