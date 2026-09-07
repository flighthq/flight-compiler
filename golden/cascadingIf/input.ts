export function dayType(day: number): string {
  if (day === 0 || day === 6) {
    return 'weekend';
  } else if (day >= 1 && day <= 5) {
    return 'weekday';
  } else {
    return 'invalid';
  }
}

export function range(value: number): string {
  if (value < 0) {
    return 'negative';
  } else if (value === 0) {
    return 'zero';
  } else if (value < 10) {
    return 'small';
  } else if (value < 100) {
    return 'medium';
  } else {
    return 'large';
  }
}

export function season(month: number): string {
  if (month >= 3 && month <= 5) {
    return 'spring';
  } else if (month >= 6 && month <= 8) {
    return 'summer';
  } else if (month >= 9 && month <= 11) {
    return 'autumn';
  } else {
    return 'winter';
  }
}
