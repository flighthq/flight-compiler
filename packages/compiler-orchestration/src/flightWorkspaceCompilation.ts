import { createFlightWorkspaceCompilationInput } from '../../compiler-inventory/src/index.js';
import type {
  CompileFlightWorkspaceOptions,
  FlightWorkspaceCompilationResult,
} from '../../compiler-types/src/index.js';
import { compileTypeScriptPackageGraph } from './compilerPackageCompilation.js';

export function compileFlightWorkspace<BackendOptions>(
  options: Readonly<CompileFlightWorkspaceOptions<BackendOptions>>,
): FlightWorkspaceCompilationResult {
  const { eligiblePackageNames, packageScope, packagesDirectory, source, upstreamDirectory, ...compilationOptions } =
    options;
  const input = createFlightWorkspaceCompilationInput({
    eligiblePackageNames,
    ...(packageScope === undefined ? {} : { packageScope }),
    ...(packagesDirectory === undefined ? {} : { packagesDirectory }),
    ...(source === undefined ? {} : { source }),
    upstreamDirectory,
  });
  return compileTypeScriptPackageGraph({ ...compilationOptions, ...input });
}
