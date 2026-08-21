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

/**
 * A portable route from the module root to an observed IR value.
 * Strings select object properties and numbers select array elements.
 */
export type CompilerIrTraversalPath = readonly (number | string)[];

export type CompilerIrTraversalCallback<Value> = (
  value: Readonly<Value>,
  path: CompilerIrTraversalPath,
) => CompilerIrTraversalObserverResult;

export interface CompilerIrTraversalObserver {
  readonly bindingPattern?: CompilerIrTraversalCallback<IrBindingPattern> | undefined;
  readonly declaration?: CompilerIrTraversalCallback<IrDeclaration> | undefined;
  readonly expression?: CompilerIrTraversalCallback<IrExpression> | undefined;
  readonly functionSignature?: CompilerIrTraversalCallback<IrFunctionSignature> | undefined;
  readonly module?: CompilerIrTraversalCallback<IrModule> | undefined;
  readonly objectMember?: CompilerIrTraversalCallback<IrObjectMember> | undefined;
  readonly optionalChain?: CompilerIrTraversalCallback<IrOptionalChainSemantics> | undefined;
  readonly parameter?: CompilerIrTraversalCallback<IrParameter> | undefined;
  readonly statement?: CompilerIrTraversalCallback<IrStatement> | undefined;
  readonly type?: CompilerIrTraversalCallback<IrType> | undefined;
  readonly typeParameter?: CompilerIrTraversalCallback<IrTypeParameter> | undefined;
  readonly variable?: CompilerIrTraversalCallback<IrVariable> | undefined;
}
