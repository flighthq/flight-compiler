export function dayType(day: number): string {
  switch (day) {
    case 0:
    case 6:
      return 'weekend';
    case 1:
    case 2:
    case 3:
    case 4:
    case 5:
      return 'weekday';
    default:
      return 'invalid';
  }
}

export function monthDays(month: number): number {
  switch (month) {
    case 2:
      return 28;
    case 4:
    case 6:
    case 9:
    case 11:
      return 30;
    default:
      return 31;
  }
}

export function gradePoints(grade: string): number {
  switch (grade) {
    case 'A':
      return 4;
    case 'B':
      return 3;
    case 'C':
      return 2;
    case 'D':
      return 1;
    default:
      return 0;
  }
}
