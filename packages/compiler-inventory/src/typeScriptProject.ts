import path from 'node:path';

import ts from 'typescript';

import type { TypeScriptProject } from '../../compiler-types/src/index.js';

export function createTypeScriptProject(tsconfigPath: string): TypeScriptProject {
  const absoluteConfigPath = path.resolve(tsconfigPath);
  const parsed = ts.getParsedCommandLineOfConfigFile(
    absoluteConfigPath,
    {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
        throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
      },
    },
  );
  if (!parsed) throw new Error(`Unable to parse TypeScript configuration: ${absoluteConfigPath}`);

  const program = ts.createProgram({
    options: parsed.options,
    rootNames: parsed.fileNames,
    ...(parsed.projectReferences ? { projectReferences: parsed.projectReferences } : {}),
  });
  return { checker: program.getTypeChecker(), options: parsed.options, program };
}
