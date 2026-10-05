/** Raised for any zone file parse or normalization failure. */
export class ZoneParseError extends Error {
  constructor(message: string, readonly line?: number) {
    super(line === undefined ? message : `line ${line}: ${message}`);
    this.name = "ZoneParseError";
  }
}
