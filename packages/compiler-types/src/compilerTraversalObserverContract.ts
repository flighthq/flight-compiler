import type { IrBindingPattern } from './compilerBindingPatternIntermediateRepresentation.js';
import type { IrDeclaration } from './compilerDeclarationIntermediateRepresentation.js';
import type {
  IrExpression,
  IrParameter,
  IrStatement,
  IrVariable,
} from './compilerExecutableIntermediateRepresentation.js';
import type { IrModule } from './compilerModuleIntermediateRepresentation.js';
import type { IrType } from './compilerTypeIntermediateRepresentation.js';

export interface CompilerIrTraversalObserver {
  readonly bindingPattern?: ((pattern: Readonly<IrBindingPattern>) => void) | undefined;
  readonly declaration?: ((declaration: Readonly<IrDeclaration>) => void) | undefined;
  readonly expression?: ((expression: Readonly<IrExpression>) => void) | undefined;
  readonly module?: ((module: Readonly<IrModule>) => void) | undefined;
  readonly parameter?: ((parameter: Readonly<IrParameter>) => void) | undefined;
  readonly statement?: ((statement: Readonly<IrStatement>) => void) | undefined;
  readonly type?: ((type: Readonly<IrType>) => void) | undefined;
  readonly variable?: ((variable: Readonly<IrVariable>) => void) | undefined;
}
