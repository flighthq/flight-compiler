export async function pick(task: Promise<number>, mode: number): Promise<number> {
  let total: number = 0;
  switch (mode) {
    case 1:
      total = await task;
      break;
    case 2:
      total = 20;
      break;
    default:
      total = 30;
  }
  return total;
}
