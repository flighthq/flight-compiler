import { execFileSync } from 'node:child_process';

export interface RustCompilerToolchain {
  readonly linker?: string | undefined;
  readonly rustc: string;
}

type RustToolProbe = (command: string) => boolean;

// Local source checks remain useful on machines without Rust, so absence is optional by default. A
// target-specific CI lane sets FLIGHT_RUST_REQUIRE_RUSTC and turns that same absence into a hard
// setup failure: a required validation must never report a successful skip.
export function findRustCompilerToolchain(
  options: Readonly<{ link: boolean }>,
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
  probe: RustToolProbe = canLaunchRustTool,
): RustCompilerToolchain | undefined {
  if (!probe('rustc')) {
    if (environment.FLIGHT_RUST_REQUIRE_RUSTC === '1') {
      throw new Error('required Rust compiler rustc is not available');
    }
    return undefined;
  }

  if (options.link && !probe('cc')) {
    if (environment.FLIGHT_RUST_REQUIRE_RUSTC === '1') {
      throw new Error('required Rust linker cc is not available');
    }
    return undefined;
  }

  return { ...(options.link ? { linker: 'cc' } : {}), rustc: 'rustc' };
}

function canLaunchRustTool(command: string): boolean {
  try {
    execFileSync(command, ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
