#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { normalizePathPortable } from '../../compiler-canonical-form/src/index.js';
import { isCompilerInventoryFailure, readFlightPackageManifests } from '../../compiler-inventory/src/index.js';
import type {
  CompilerCommandLineSource,
  CompilerCommandLineWorkspacePackage,
  WorkspaceSource,
  WorkspaceSourceEntry,
} from '../../compiler-types/src/index.js';
import { validateCompilerCommandLineCheckRequest, compileCompilerCommandLineRequest } from './compilerCommandLine.js';

// The edge, and the only place in the compiler that reads a directory or writes a file on its own.
// Everything above it decides; this reads, writes, and reports an exit code. It is a function rather
// than work at import so that importing the package still does nothing, which is the rule everywhere
// else too.
export function compileCompilerCommandLineDirectory(argv: readonly string[]): number {
  return argv[0] === commandLineCheckCommand
    ? validateCompilerCommandLineCheckDirectory(argv.slice(1))
    : compileCompilerCommandLineRequest(
        { argv },
        {
          listSourceFiles: listTypeScriptSources,
          write: (text) => process.stdout.write(text),
          writeError: (text) => process.stderr.write(text),
          writeOutputFile: (directory, relativePath, contents) => {
            const target = path.join(directory, relativePath);
            mkdirSync(path.dirname(target), { recursive: true });
            writeFileSync(target, contents);
          },
        },
      ).exitCode;
}

// The check edge. It reads what a check needs to read and writes only what the caller asked for: the
// report file when `--report` names one. There is no output-directory capability here at all, so a check
// cannot write generated sources however it is invoked.
export function validateCompilerCommandLineCheckDirectory(argv: readonly string[]): number {
  return validateCompilerCommandLineCheckRequest(
    { argv },
    {
      listSourceFiles: listTypeScriptSources,
      listWorkspacePackages: listWorkspacePackages,
      readBaseline: (file) => (existsSync(file) ? readFileSync(file, 'utf8') : undefined),
      write: (text) => process.stdout.write(text),
      writeError: (text) => process.stderr.write(text),
      writeReportFile: (file, contents) => {
        mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
        writeFileSync(file, contents);
      },
    },
  ).exitCode;
}

// A directory that is not there reads as nothing to compile rather than as a stack trace: a mistyped path
// is an ordinary thing to do and the report already says what it found.
function listTypeScriptSources(directory: string): readonly CompilerCommandLineSource[] {
  return (existsSync(directory) ? readdirSync(directory, { recursive: true, withFileTypes: true }) : [])
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.endsWith('.ts') &&
        !entry.name.endsWith('.d.ts') &&
        !entry.name.endsWith('.test.ts'),
    )
    .map((entry) => {
      const sourcePath = path.join(entry.parentPath, entry.name);
      return {
        contents: readFileSync(sourcePath, 'utf8'),
        moduleName: normalizePathPortable(path.relative(directory, sourcePath)),
        sourcePath,
      };
    })
    .sort((left, right) => (left.moduleName < right.moduleName ? -1 : 1));
}

// Every package under `<workspace>/packages`, read with the inventory's own manifest reader so the
// declared `flight.environment` arrives in the vocabulary the eligibility lane uses. A workspace with no
// packages directory is one package -- what a scratch project and the consumer smoke are -- and nothing
// there declares an environment, so it is unmarked.
function listWorkspacePackages(workspaceDirectory: string): readonly CompilerCommandLineWorkspacePackage[] {
  const packagesDirectory = path.join(workspaceDirectory, 'packages');
  if (!existsSync(packagesDirectory)) {
    return [{ dependencies: [], name: path.basename(workspaceDirectory), root: workspaceDirectory }];
  }
  const scope = readWorkspacePackageScope(workspaceDirectory);
  let manifests: ReturnType<typeof readFlightPackageManifests>;
  try {
    manifests = readFlightPackageManifests(
      { upstreamDirectory: workspaceDirectory, ...(scope === undefined ? {} : { packageScope: scope }) },
      fileSystemWorkspaceSource(),
    );
  } catch (error) {
    if (!isCompilerInventoryFailure(error)) throw error;
    // The directory exists but holds no readable manifests; the workspace is still one package to the
    // caller, and saying so beats reporting that there was nothing to check.
    return [{ dependencies: [], name: path.basename(workspaceDirectory), root: workspaceDirectory }];
  }
  return manifests
    .map((manifest) => ({
      dependencies: [...manifest.dependencies],
      ...(manifest.environment === undefined ? {} : { environment: manifest.environment }),
      name: manifest.name,
      root: manifest.directory,
    }))
    .sort((left, right) => (left.name < right.name ? -1 : 1));
}

// The package scope a workspace keeps its packages under, taken from the workspace's own name: a
// repository named `@flighthq/flight` holds `@flighthq/*` packages. A workspace without a scoped name
// leaves the reader its default rather than inventing one.
function readWorkspacePackageScope(workspaceDirectory: string): string | undefined {
  const manifest = path.join(workspaceDirectory, 'package.json');
  if (!existsSync(manifest)) return undefined;
  const name = readPackageManifestName(manifest, '');
  const separator = name.indexOf('/');
  return separator > 0 && name.startsWith('@') ? name.slice(0, separator) : undefined;
}

// The inventory reads a workspace through a four-operation capability, and its own filesystem
// implementation is not exported from that package's barrel, so the edge that owns filesystem access in
// this package supplies the same four operations. It is the reader's shape, not a second reading of the
// workspace: which fields mean what stays in the inventory.
function fileSystemWorkspaceSource(): WorkspaceSource {
  return {
    isDirectory: (candidate) => existsSync(candidate) && statSync(candidate).isDirectory(),
    isFile: (candidate) => existsSync(candidate) && statSync(candidate).isFile(),
    listDirectory: (directory): readonly WorkspaceSourceEntry[] =>
      readdirSync(directory, { withFileTypes: true }).map((entry) => ({
        isDirectory: entry.isDirectory(),
        name: entry.name,
      })),
    readTextFile: (file) => readFileSync(file, 'utf8'),
  };
}

function readPackageManifestName(manifest: string, fallback: string): string {
  try {
    const parsed: unknown = JSON.parse(readFileSync(manifest, 'utf8'));
    const name = (parsed as { name?: unknown }).name;
    return typeof name === 'string' && name.length > 0 ? name : fallback;
  } catch {
    // A manifest that cannot be read names nothing; the directory still does.
    return fallback;
  }
}

const commandLineCheckCommand = 'check';

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  process.exitCode = compileCompilerCommandLineDirectory(process.argv.slice(2));
}
