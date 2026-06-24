export function formatGrams(n: number): string {
  return String(Math.round(n * 10) / 10);
}
