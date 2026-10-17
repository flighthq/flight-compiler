import { describe, expect, it } from 'vitest';

import { findRustCompilerToolchain } from './rustToolchain.js';

describe('Rust toolchain availability', () => {
  it('finds the compiler alone for metadata checks and the linker for executable checks', () => {
    const available = (command: string): boolean => command === 'rustc' || command === 'cc';

    expect(findRustCompilerToolchain({ link: false }, {}, available)).toEqual({ rustc: 'rustc' });
    expect(findRustCompilerToolchain({ link: true }, {}, available)).toEqual({ linker: 'cc', rustc: 'rustc' });
  });

  it('lets optional local validation skip an absent Rust toolchain', () => {
    expect(findRustCompilerToolchain({ link: false }, {}, () => false)).toBeUndefined();
    expect(findRustCompilerToolchain({ link: true }, {}, (command) => command === 'rustc')).toBeUndefined();
  });

  it('fails required validation when rustc or its executable linker is absent', () => {
    const required = { FLIGHT_RUST_REQUIRE_RUSTC: '1' };

    expect(() => findRustCompilerToolchain({ link: false }, required, () => false)).toThrow(
      'required Rust compiler rustc is not available',
    );
    expect(() => findRustCompilerToolchain({ link: true }, required, (command) => command === 'rustc')).toThrow(
      'required Rust linker cc is not available',
    );
  });
});
