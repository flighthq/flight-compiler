import type ts from 'typescript';

import type { FlightPackageManifest } from './compilerInventoryContract.js';
import type { CompilerSourceLocation } from './compilerSourceIdentity.js';
import type { TypeScriptProject } from './compilerTypeScriptContract.js';

export type CompilerHostEndpointOperation = 'call' | 'construct' | 'read' | 'readWrite' | 'write';

export interface CompilerHostEndpointRecord {
  readonly endpoint: string;
  readonly operation: CompilerHostEndpointOperation;
  readonly receiver: string;
  readonly sites: readonly CompilerSourceLocation[];
}

export interface CompilerHostEndpointInventory {
  readonly endpoints: readonly CompilerHostEndpointRecord[];
  readonly schema: 'flight-compiler-host-endpoints/1';
  readonly summary: {
    readonly endpoints: number;
    readonly uses: number;
  };
}

export type TypeScriptHostEndpointReceiverResolver = (type: ts.Type, checker: ts.TypeChecker) => string | undefined;

export interface AnalyzeTypeScriptHostEndpointsOptions {
  readonly manifests: readonly Readonly<FlightPackageManifest>[];
  readonly project: Readonly<TypeScriptProject>;
  readonly resolveReceiver: TypeScriptHostEndpointReceiverResolver;
  readonly upstreamDirectory: string;
}
