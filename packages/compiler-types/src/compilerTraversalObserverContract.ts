import type { IrOptionalChainSemantics } from './compilerAccessSemanticIntermediateRepresentation.js';
import type { IrBindingPattern } from './compilerBindingPatternIntermediateRepresentation.js';
import type { IrDeclaration, IrFunctionSignature } from './compilerDeclarationIntermediateRepresentation.js';
import type {
  IrExpression,
  IrObjectMember,
  IrParameter,
  IrStatement,
  IrVariable,
} from './compilerExecutableIntermediateRepresentation.js';
import type { IrModule } from './compilerModuleIntermediateRepresentation.js';
import type { IrType, IrTypeParameter } from './compilerTypeIntermediateRepresentation.js';

/** Returning false from any observer stops the whole traversal immediately. */
export type CompilerIrTraversalObserverResult = boolean | void;

export interface CompilerIrTraversalObserver {
  readonly bindingPattern?: ((pattern: Readonly<IrBindingPattern>) => CompilerIrTraversalObserverResult) | undefined;
  readonly declaration?: ((declaration: Readonly<IrDeclaration>) => CompilerIrTraversalObserverResult) | undefined;
  readonly expression?: ((expression: Readonly<IrExpression>) => CompilerIrTraversalObserverResult) | undefined;
  readonly functionSignature?:
    | ((signature: Readonly<IrFunctionSignature>) => CompilerIrTraversalObserverResult)
    | undefined;
  readonly module?: ((module: Readonly<IrModule>) => CompilerIrTraversalObserverResult) | undefined;
  readonly objectMember?: ((member: Readonly<IrObjectMember>) => CompilerIrTraversalObserverResult) | undefined;
  readonly optionalChain?:
    | ((semantics: Readonly<IrOptionalChainSemantics>) => CompilerIrTraversalObserverResult)
    | undefined;
  readonly parameter?: ((parameter: Readonly<IrParameter>) => CompilerIrTraversalObserverResult) | undefined;
  readonly statement?: ((statement: Readonly<IrStatement>) => CompilerIrTraversalObserverResult) | undefined;
  readonly type?: ((type: Readonly<IrType>) => CompilerIrTraversalObserverResult) | undefined;
  readonly typeParameter?: ((parameter: Readonly<IrTypeParameter>) => CompilerIrTraversalObserverResult) | undefined;
  readonly variable?: ((variable: Readonly<IrVariable>) => CompilerIrTraversalObserverResult) | undefined;
}
