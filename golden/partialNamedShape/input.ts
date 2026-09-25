import type { Info, InfoAlias, NestedAlias } from './provider';

// An alias or an import names the shape the Partial makes optional, so all three spell one C++ shape and
// the members stay writable through it.
export function readDirect(values: Partial<Info>): number | undefined {
  return values.value;
}

export function readAliased(values: Partial<InfoAlias>): number | undefined {
  return values.value;
}

export function readNested(values: Partial<NestedAlias>): number | undefined {
  return values.value;
}

export function write(values: Partial<Info>): void {
  values.value = 1;
}
