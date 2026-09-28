// The positive control: the same read on a receiver whose DECLARATION carries the sentinel. The storage
// exists (`std::optional<flight::String>`), the guard is the whole proof, and the read lowers through it
// with no cast, copy, or materialized row.
export function isAbsent(text: string | undefined): boolean {
  return text === undefined;
}

export function measure(text: string | undefined): number {
  if (text === undefined) return 0;
  return text.length;
}

// The rewrite the refusal names, on a local that has the storage rather than the parameter that does not.
export function measureNarrowed(text: string | undefined): number {
  const value = text ?? '';
  return value.length;
}
