export { analyzeIrModulesStaticFacts, combineCompilerStaticFactAudits } from './compilerIrStaticFacts.js';
export { analyzeTypeScriptSourcePortability } from './compilerSourcePortability.js';
export { getTypeScriptInvocationSignatureResolution } from './compilerTypeScriptInvocationSemantics.js';
export {
  createCompilerTypeScriptAnalysisIdentity,
  lowerTypeScriptSource,
  lowerTypeScriptSources,
} from './typeScriptSemanticLowering.js';
