// A regex literal's value is a RegExp whatever its pattern and flags are, so the destination's one value
// slot is named by the syntax itself rather than by a recording the expression never carried. The literal
// is emitted as the runtime's own regexp carrier, constructed once.
export function pattern(): RegExp | undefined {
  return /\d+/gu;
}

export function patternIf(flag: boolean): RegExp | undefined {
  return flag ? /a/ : undefined;
}

// A property read through an erased receiver answers a dynamic value: the emitter reaches it through the
// runtime's own object view, so the read's result is an erased value rather than a value of no stated type.
// Naming that lets the destination take its checked selection -- each alternative tests the kind it needs
// and extracts it through the runtime's accessor, and a value of another kind answers absence here rather
// than becoming an alternative it is not.
export function size(value: any): number | undefined {
  return value.size;
}

export function label(value: any): string | undefined {
  return value.label;
}
