export function isLeapYear(year: number): boolean {
  if (year - 400 * Math.floor(year / 400) === 0) return true;
  if (year - 100 * Math.floor(year / 100) === 0) return false;
  if (year - 4 * Math.floor(year / 4) === 0) return true;
  return false;
}

export function isValidTriangle(a: number, b: number, c: number): boolean {
  if (a <= 0) return false;
  if (b <= 0) return false;
  if (c <= 0) return false;
  if (a + b <= c) return false;
  if (a + c <= b) return false;
  if (b + c <= a) return false;
  return true;
}

export function classifyBmi(weight: number, height: number): string {
  if (height <= 0) return 'invalid';
  if (weight <= 0) return 'invalid';
  const bmi: number = weight / (height * height);
  if (bmi < 18.5) return 'underweight';
  if (bmi < 25) return 'normal';
  if (bmi < 30) return 'overweight';
  return 'obese';
}

export function safeReciprocal(value: number): number {
  if (value === 0) return 0;
  return 1 / value;
}
