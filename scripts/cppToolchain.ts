import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

export type CppCompilerFamily = 'gnu' | 'msvc';

export interface CppCompilerToolchain {
  readonly command: string;
  readonly family: CppCompilerFamily;
}

type CppCompilerProbe = (toolchain: Readonly<CppCompilerToolchain>) => boolean;

export function createCppCompilerToolchain(
  command: string,
  family: CppCompilerFamily = inferCppCompilerFamily(command),
): CppCompilerToolchain {
  return { command, family };
}

export function findCppCompilerToolchain(
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
  platform: NodeJS.Platform = process.platform,
  probe: CppCompilerProbe = canLaunchCppCompiler,
): CppCompilerToolchain | undefined {
  const configured = environment.FLIGHT_CPP_CXX?.trim();
  const configuredFamily = parseCppCompilerFamily(environment.FLIGHT_CPP_CXX_FAMILY);
  const candidates = configured
    ? [createCppCompilerToolchain(configured, configuredFamily ?? inferCppCompilerFamily(configured))]
    : platform === 'win32'
      ? [
          createCppCompilerToolchain('cl', 'msvc'),
          createCppCompilerToolchain('clang-cl', 'msvc'),
          createCppCompilerToolchain('c++', 'gnu'),
          createCppCompilerToolchain('g++', 'gnu'),
          createCppCompilerToolchain('clang++', 'gnu'),
        ]
      : [
          createCppCompilerToolchain('c++', 'gnu'),
          createCppCompilerToolchain('g++', 'gnu'),
          createCppCompilerToolchain('clang++', 'gnu'),
        ];
  const resolved = candidates.find(probe);
  if (!resolved && (configured || environment.FLIGHT_CPP_REQUIRE_CXX === '1')) {
    throw new Error(`required C++ compiler ${configured ?? '<auto>'} is not available`);
  }
  return resolved;
}

// The directories a C++ compile of emitted output needs from the runtime checkout.
//
// `include` holds the runtime itself. `generated/include` holds the SDK glue the runtime proves a
// structural widening through and binds a structural owner's members with: a specialization or a table
// only applies where its header is reachable, so an emission that leans on either names it. Both are
// reported when present, because a checkout that materialized one and not the other is a setup a
// compile can still be attempted on and diagnosed.
export function collectCppRuntimeIncludeDirectories(runtimeDirectory: string): readonly string[] {
  return [path.join(runtimeDirectory, 'include'), path.join(runtimeDirectory, 'generated', 'include')].filter(
    (directory) => existsSync(directory),
  );
}

export function createCppSyntaxOnlyArguments(
  toolchain: Readonly<CppCompilerToolchain>,
  source: string,
  includeDirectories: readonly string[],
): readonly string[] {
  if (toolchain.family === 'msvc') {
    return [
      '/nologo',
      '/std:c++20',
      '/permissive-',
      '/EHsc',
      '/Zs',
      '/TP',
      ...includeDirectories.map((directory) => `/I${directory}`),
      source,
    ];
  }
  return [
    '-std=c++20',
    '-fsyntax-only',
    '-pthread',
    ...includeDirectories.flatMap((directory) => ['-I', directory]),
    '-x',
    'c++-header',
    source,
  ];
}

export function createCppExecutableArguments(
  toolchain: Readonly<CppCompilerToolchain>,
  source: string,
  output: string,
  includeDirectories: readonly string[],
): readonly string[] {
  if (toolchain.family === 'msvc') {
    return [
      '/nologo',
      '/std:c++20',
      '/permissive-',
      '/EHsc',
      ...includeDirectories.map((directory) => `/I${directory}`),
      `/Fe:${output}`,
      source,
    ];
  }
  return [
    '-std=c++20',
    '-pthread',
    ...includeDirectories.flatMap((directory) => ['-I', directory]),
    '-o',
    output,
    source,
  ];
}

export function getCppExecutableName(toolchain: Readonly<CppCompilerToolchain>, basename: string): string {
  return toolchain.family === 'msvc' ? `${basename}.exe` : basename;
}

function inferCppCompilerFamily(command: string): CppCompilerFamily {
  const basename = path.win32.basename(command).toLowerCase();
  return basename === 'cl' || basename === 'cl.exe' || basename === 'clang-cl' || basename === 'clang-cl.exe'
    ? 'msvc'
    : 'gnu';
}

function parseCppCompilerFamily(value: string | undefined): CppCompilerFamily | undefined {
  if (!value) return undefined;
  if (value === 'gnu' || value === 'msvc') return value;
  throw new Error(`FLIGHT_CPP_CXX_FAMILY must be gnu or msvc, received ${value}`);
}

function canLaunchCppCompiler(toolchain: Readonly<CppCompilerToolchain>): boolean {
  const result = spawnSync(toolchain.command, toolchain.family === 'msvc' ? ['/?'] : ['--version'], {
    stdio: 'ignore',
  });
  return result.error === undefined;
}
