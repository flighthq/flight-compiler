import type ts from 'typescript';

export interface LowerTypeScriptSourceOptions {
  packageName: string;
  upstreamDirectory: string;
}

export interface RuntimeExportDecision {
  declaration?: ts.Declaration | ts.SourceFile | undefined;
  runtime: boolean;
}

export interface TypeScriptProject {
  checker: ts.TypeChecker;
  options: ts.CompilerOptions;
  program: ts.Program;
}
