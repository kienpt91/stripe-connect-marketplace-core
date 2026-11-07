import { err, ok, type Result } from "./result.js";

/**
 * Where Stripe sends a person after onboarding or checkout. The origin is configuration; a request only names a path on it. A
 * path that could change the origin (`//host`, an absolute URL, a backslash that browsers treat as a slash) or that carries a
 * control character is refused, so a request cannot turn a checkout into a redirect to somebody else's site.
 */
export function returnUrl(origin: string, path: unknown): Result<string, "invalid_redirect"> {
  if (typeof path !== "string" || path.length < 1 || path.length > 500) return err("invalid_redirect");
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\")) return err("invalid_redirect");
  if (/[\u0000-\u001f\u007f\s]/.test(path)) return err("invalid_redirect");
  let url: URL;
  try {
    url = new URL(path, origin);
  } catch {
    return err("invalid_redirect");
  }
  return url.origin === new URL(origin).origin ? ok(url.toString()) : err("invalid_redirect");
}

/** An origin that is safe to send people to: https, or http only for a loopback host (development). No path, no credentials. */
export function parseOrigin(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) return undefined;
  if (url.username !== "" || url.password !== "" || (url.pathname !== "/" && url.pathname !== "") || url.search !== "" || url.hash !== "") return undefined;
  return url.origin;
}
