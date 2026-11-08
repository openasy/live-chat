import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createAuth, oidcFromEnv, readSecretsKey } from "@openasy/auth";
import { createApp, createMetricsHandler } from "./app.ts";
import { parseConfig, watchConfig } from "./config.ts";
import { openDb } from "./db.ts";
import { createLiveChat } from "./livechat.ts";
import { log } from "./log.ts";
import { parseProducts } from "./products.ts";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
const port = Number(process.env.PORT ?? 8080);
const dbPath = process.env.LIVE_CHAT_DB ?? "/data/live-chat.db";
const configPath = process.env.LIVE_CHAT_CONFIG?.trim() || "/config/live-chat.yaml";
const webDir = new URL("../dist/web", import.meta.url).pathname;
const docsDir = new URL("../dist/docs", import.meta.url).pathname;
const widgetFile = new URL("../dist/widget/w.js", import.meta.url).pathname;
const openapi = JSON.parse(readFileSync(new URL("../openapi.json", import.meta.url), "utf8")) as Record<string, unknown>;
const headless = process.env.LIVE_CHAT_HEADLESS === "true";
// Set it to keep /metrics off the port that is published or behind an ingress (ADR 0026).
const metricsPort = process.env.LIVE_CHAT_METRICS_PORT ? Number(process.env.LIVE_CHAT_METRICS_PORT) : undefined;

const db = openDb(dbPath);
// The address people open Live Chat at, behind the TLS proxy (ADR 0026). Cookies, passkeys, OIDC redirects and the
// window's script use it.
const publicUrl = (process.env.LIVE_CHAT_PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/$/, "");
const secretsKeyFile = process.env.LIVE_CHAT_SECRETS_KEY_FILE ?? "/run/secrets/openasy-kek";
let file: ReturnType<typeof watchConfig> | undefined;
const lc = createLiveChat(db, { publicUrl, fileState: () => file?.state ?? null, log });
const auth = createAuth({
  db,
  product: "live-chat",
  productName: "OpenAsy Live Chat",
  origin: publicUrl,
  // Locally the same product is often opened as 127.0.0.1 too.
  trustedOrigins: publicUrl.startsWith("http://localhost:") ? [publicUrl.replace("localhost", "127.0.0.1")] : [],
  passwords: process.env.LIVE_CHAT_PASSWORD_SIGN_IN !== "false",
  oidc: oidcFromEnv(process.env),
  secretsKey: readSecretsKey(secretsKeyFile),
  // The groups Identity sends at sign-in say which teams a member answers for (teams.<id>.group).
  onOidcSignIn: ({ userId, groups }) => lc.setGroups(userId, groups),
  // Audit log (ADR 0013): every sign-in, failure and change to members and tokens.
  onEvent: (event) => log(event.type === "sign-in-failed" ? "warn" : "info", "auth", { event }),
});
// The settings come from the file and only from it; a file with a mistake keeps the last good one in place.
file = watchConfig(configPath, (config, text) => lc.setConfig(config, text), {
  onChange: (state) =>
    state.error
      ? log("warn", "settings file not applied: the last good version stays until it is fixed", { file: state.path, error: state.error })
      : log("info", "settings file applied", { file: state.path, warnings: state.warnings }),
});
// Without a file, Live Chat starts with one team and no sites, so a first look needs nothing written.
if (!lc.config()) {
  lc.setConfig(parseConfig(""), "");
  log("warn", "no settings file applied: using the defaults until it can be read", { file: configPath });
}
const products = parseProducts(process.env.OPENASY_PRODUCTS);
if (products.invalid.length) log("warn", "OPENASY_PRODUCTS: left out entries that are not id=https://address", { entries: products.invalid });
const app = createApp({
  db,
  lc,
  version,
  publicUrl,
  auth,
  webDir: !headless && existsSync(webDir) ? webDir : undefined,
  docsDir: existsSync(docsDir) ? docsDir : undefined,
  widgetFile,
  openapi,
  serveMetrics: metricsPort === undefined,
  products: products.products,
  trustProxy: process.env.LIVE_CHAT_TRUST_PROXY === "true",
});
const server = createServer(app);
// Event streams stay open; only the request's own headers are timed.
server.requestTimeout = 0;
const metricsServer = metricsPort !== undefined ? createServer(createMetricsHandler(lc, version)) : undefined;
metricsServer?.listen(metricsPort, () => log("info", "metrics on their own port", { port: metricsPort }));

server.listen(port, () => log("info", "live chat started", { version, port, db: dbPath, config: configPath, headless }));
if (!publicUrl.startsWith("https://") && !/^http:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(publicUrl)) {
  log(
    "warn",
    "LIVE_CHAT_PUBLIC_URL is not https: browsers will not keep secure cookies or allow passkeys, and sites on https cannot load the window. Put it behind TLS (ADR 0026)",
    { url: publicUrl },
  );
}
if (auth.secretsInClear)
  log("warn", "no secrets key: TOTP secrets are stored unencrypted. Mount a 32-byte key (openssl rand -hex 32)", { file: secretsKeyFile });
const setup = auth.setupLink();
// No default password (ADR 0013): the first person to open this link becomes the owner.
if (setup) log("info", "no owner yet: open this link once to create the owner account", { url: setup });

const background = (name: string, work: () => Promise<void>) => () =>
  void work().catch((err: unknown) => log("error", `${name} failed`, { error: String(err) }));
lc.purge();
const timers: NodeJS.Timeout[] = [
  setInterval(() => auth.purge(), 5 * 60_000),
  setInterval(() => lc.purge(), 3_600_000),
  // Unanswered and idle chats, and tickets waiting for Helpdesk, every 15 seconds.
  setInterval(
    background("chat round", () => lc.tick()),
    15_000,
  ),
];
background("chat round", () => lc.tick())();

function shutdown(signal: string) {
  log("info", "shutting down", { signal });
  for (const t of timers) clearInterval(t);
  file?.stop();
  // Open streams end; the team's screens and the windows reconnect and resume from their last event.
  app.closeStreams();
  metricsServer?.close();
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
