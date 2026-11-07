/** Identifiers of this system are UUIDs. The brand keeps an order id from being passed where a seller id is expected. */
export type Brand<T, B extends string> = T & { readonly __brand: B };

export type SellerId = Brand<string, "SellerId">;
export type OrderId = Brand<string, "OrderId">;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** The canonical (lower case) form of a UUID, or undefined for anything else, including non-strings. */
export function parseUuid(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length !== 36) return undefined;
  const lower = value.toLowerCase();
  return UUID.test(lower) ? lower : undefined;
}

export function parseId<T extends string>(value: unknown): Brand<string, T> | undefined {
  return parseUuid(value) as Brand<string, T> | undefined;
}

/** Marks a string that is already known to be an identifier (read from the database, produced by the generator). */
export function asId<T extends string>(value: string): Brand<string, T> {
  return value as Brand<string, T>;
}

/**
 * The object ids Stripe hands out: a short prefix, an underscore and an alphanumeric body. Anything else is refused, so an id
 * that reaches a query, a posting key or a log line has a known shape.
 */
const PREFIXES = ["acct", "ch", "re", "du", "po", "tr", "evt", "cs", "pi"] as const;
export type StripePrefix = (typeof PREFIXES)[number];

export function parseStripeId(prefix: StripePrefix, value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 80) return undefined;
  return new RegExp(`^${prefix}_[A-Za-z0-9]{8,64}$`).test(value) ? value : undefined;
}
