/** The SQLSTATE of a database error, narrowed at runtime instead of cast. */
export function sqlState(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : undefined;
}

/** The name of the constraint a database error names, if any. */
export function constraintName(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "constraint" in error && typeof error.constraint === "string" ? error.constraint : undefined;
}
