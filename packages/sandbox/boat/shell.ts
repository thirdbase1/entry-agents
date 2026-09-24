/** POSIX single-quote escaping for arguments interpolated into a command. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function shellQuoteArgs(args: readonly string[]): string {
  return args.map(shellQuote).join(" ");
}
