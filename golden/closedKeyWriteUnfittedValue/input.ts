interface Style {
  fontSize?: number;
  color?: string;
}

// The value has to fit every member the key set names, and this one fits only one of them -- an assignment
// the source language rejects as well, so it is the author who narrows the key and the value together.
export function set(style: Style, key: 'fontSize' | 'color', value: number | string): void {
  style[key] = value;
}
