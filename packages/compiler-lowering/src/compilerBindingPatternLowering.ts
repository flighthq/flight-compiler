import { analyzeIrModuleTraversal } from '../../compiler-ir-traversal/src/index.js';
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
      let residual = getIrModuleBindingPatternResidualCount(lowered);
      while (residual > 0) {
        lowered = array.lowerIrModule(object.lowerIrModule(lowered));
        const nextResidual = getIrModuleBindingPatternResidualCount(lowered);
        if (nextResidual >= residual) {
          throw createCompilerLoweringFailure(
            'unsupported-ir',
            compilerLoweringPassNameBindingPattern,
            module,
            `recursive binding normalization did not decrease its structural residual from ${String(residual)}`,
          );
        }
        residual = nextResidual;
      }
      return lowered;
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

export function getIrModuleBindingPatternResidualCount(module: Readonly<IrModule>): number {
  let residual = 0;
  analyzeIrModuleTraversal(module, {
    bindingPattern() {
      residual += 1;
    },
  });
  return residual;
}

const compilerLoweringPassNameBindingPattern = 'binding-pattern';
