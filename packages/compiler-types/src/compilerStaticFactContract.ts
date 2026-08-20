import type {
  IrIndexedReceiver,
  IrTypedArrayElementWidth,
  IrTypedArrayReceiver,
} from './compilerAccessSemanticIntermediateRepresentation.js';
import type { IrOperatorValueDomain } from './compilerOperatorSemanticIntermediateRepresentation.js';

export type CompilerStaticTruthinessContext = 'condition' | 'logical' | 'negation';

export type CompilerStaticIndexedAccessMode = 'read' | 'readWrite' | 'write';

export type CompilerStaticFactCount =
  | Readonly<{
      count: number;
      domain: IrOperatorValueDomain;
      kind: 'truthiness';
      context: CompilerStaticTruthinessContext;
    }>
  | Readonly<{
      count: number;
      domain: 'bigint' | 'number';
      kind: 'numericRelation';
    }>
  | Readonly<{
      access: CompilerStaticIndexedAccessMode;
      count: number;
      kind: 'indexedAccess';
      receivers: readonly [IrIndexedReceiver, ...IrIndexedReceiver[]];
    }>
  | Readonly<{
      count: number;
      kind: 'typedArraySet';
      receivers: readonly [IrTypedArrayReceiver, ...IrTypedArrayReceiver[]];
    }>
  | Readonly<{
      count: number;
      kind: 'mixedWidthIndexedWrite';
      receivers: readonly [IrTypedArrayReceiver, IrTypedArrayReceiver, ...IrTypedArrayReceiver[]];
      widths: readonly [IrTypedArrayElementWidth, IrTypedArrayElementWidth, ...IrTypedArrayElementWidth[]];
    }>;

export interface CompilerStaticFactAudit {
  readonly facts: readonly CompilerStaticFactCount[];
  readonly modules: number;
  readonly schema: 'flight-compiler-static-facts/2';
}
