import type http from "node:http";
import { retryDeferred } from "../application/ingest.js";
import { compose, webhookServer } from "./compose.js";
import type { ServeConfig } from "./config.js";

export interface Running {
  readonly server: http.Server;
  stop(): Promise<void>;
}

/** Starts the webhook server and the one background job: applying the events that were waiting for a charge that has since arrived. */
export async function startServer(config: ServeConfig, write: (line: string) => void): Promise<Running> {
  const { deps, close } = compose({
    databaseUrl: config.databaseUrl, fees: config.fees, appOrigin: config.appOrigin, stripe: { secretKey: config.stripeSecretKey, apiVersion: config.stripeApiVersion }, write,
  });
  const server = webhookServer(deps, { secrets: config.webhookSecrets, maxBodyBytes: config.maxBodyBytes, toleranceMs: config.toleranceMs, trustedProxyHops: config.trustedProxyHops });
  const timer = setInterval(() => void retryDeferred(deps).catch((error: unknown) => deps.logger.error("job.failed", { job: "retry-deferred", error: error instanceof Error ? error.name : "unknown" })), 60_000).unref();
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  server.once("error", reject);
  server.listen(config.port, config.host, resolve);
  await promise;
  deps.logger.info("server.listening", { host: config.host, port: config.port });
  return {
    server,
    async stop() {
      clearInterval(timer);
      await new Promise<void>((done) => server.close(() => done()));
      await close();
    },
  };
}
