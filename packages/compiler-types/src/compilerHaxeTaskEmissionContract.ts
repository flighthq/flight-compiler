import type { IrBindingIdentity } from './compilerBindingIntermediateRepresentation.js';
import type { IrExpression, IrStatement } from './compilerExecutableIntermediateRepresentation.js';

export interface CompilerHaxeTaskEmissionCapabilities {
  readonly emitExpression: (expression: Readonly<IrExpression>) => string;
  readonly emitStatement: (statement: Readonly<IrStatement>) => readonly string[];
  readonly fail: (message: string) => never;
  readonly getBindingName: (binding: Readonly<IrBindingIdentity>) => string;
  readonly getGeneratedName: (preferredName: string) => string;
}
