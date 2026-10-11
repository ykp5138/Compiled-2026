export function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
export function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}
