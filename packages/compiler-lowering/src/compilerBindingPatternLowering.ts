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
      let residual = countIrModuleBindingPatternResidual(lowered);
      while (residual > 0) {
        lowered = array.lowerIrModule(object.lowerIrModule(lowered));
        const nextResidual = countIrModuleBindingPatternResidual(lowered);
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

function countIrModuleBindingPatternResidual(module: Readonly<IrModule>): number {
  let residual = 0;
  const visit = (value: unknown, property?: string): void => {
    if (!value || typeof value !== 'object') return;
    if (
      property === 'pattern' &&
      'kind' in value &&
      (value.kind === 'array' || value.kind === 'binding' || value.kind === 'object')
    ) {
      residual += 1;
    }
    if (Array.isArray(value)) {
      value.forEach((item) => visit(item));
      return;
    }
    Object.entries(value).forEach(([key, item]) => visit(item, key));
  };
  visit(module);
  return residual;
}

const compilerLoweringPassNameBindingPattern = 'array-binding-pattern';
