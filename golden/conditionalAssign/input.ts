export function sign(value: number): string {
  let label: string;
  if (value > 0) {
    label = 'positive';
  } else if (value < 0) {
    label = 'negative';
  } else {
    label = 'zero';
  }
  return label;
}

export function bounds(values: number[]): number {
  let min = values[0]!;
  let max = values[0]!;
  for (const v of values) {
    if (v < min) {
      min = v;
    }
    if (v > max) {
      max = v;
    }
  }
  return max - min;
}

export function grade(score: number): string {
  let letter: string;
  if (score >= 90) {
    letter = 'A';
  } else if (score >= 80) {
    letter = 'B';
  } else if (score >= 70) {
    letter = 'C';
  } else if (score >= 60) {
    letter = 'D';
  } else {
    letter = 'F';
  }
  return letter;
}
