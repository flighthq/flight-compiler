import type { CompilerLoweringPass, IrModule } from '../../compiler-types/src/index.js';
import { createCompilerLoweringPassArrayBindingPattern } from './compilerArrayBindingPatternLowering.js';
import { createCompilerLoweringFailure } from './compilerLoweringPass.js';
import { createCompilerLoweringPassObjectBindingPattern } from './compilerObjectBindingPatternLowering.js';

export function createCompilerLoweringPassBindingPattern(): CompilerLoweringPass {
  const array = createCompilerLoweringPassArrayBindingPattern();
  const object = createCompilerLoweringPassObjectBindingPattern();
  return {
    idempotent: true,
    lowerIrModule(module) {
      let lowered: IrModule = module;
      for (let iteration = 0; iteration < compilerBindingPatternLoweringIterationLimit; iteration += 1) {
        const before = JSON.stringify(lowered);
        lowered = array.lowerIrModule(object.lowerIrModule(lowered));
        if (JSON.stringify(lowered) === before) return lowered;
        if (array.verifyIrModule(lowered).kind === 'valid' && object.verifyIrModule(lowered).kind === 'valid') {
          return lowered;
        }
      }
      throw createCompilerLoweringFailure(
        'unsupported-ir',
        compilerLoweringPassNameBindingPattern,
        module,
        'recursive binding normalization did not reach a fixed point',
      );
    },
    name: compilerLoweringPassNameBindingPattern,
    runsAfter: [],
    verifyIrModule(module) {
      const arrayResult = array.verifyIrModule(module);
      if (arrayResult.kind === 'invalid') return arrayResult;
      return object.verifyIrModule(module);
    },
  };
}

const compilerBindingPatternLoweringIterationLimit = 64;
const compilerLoweringPassNameBindingPattern = 'array-binding-pattern';
