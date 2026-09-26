import { readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
process.chdir(root);
try {
  const settings = JSON.parse(await readFile("settings.json", "utf8"));
  const url = new URL(settings.url);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    typeof settings.email !== "string" ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(settings.email)
  )
    throw new Error(
      "settings.json requires an HTTPS origin URL and an email address",
    );

  const config = JSON.parse(await readFile("wrangler.jsonc", "utf8"));
  config.vars.ALLOWED_EMAIL = settings.email;
  config.access.dev.identity.email = settings.email;
  config.routes = [{ pattern: url.hostname, custom_domain: true }];
  await writeFile(
    "wrangler.local.json",
    JSON.stringify(config, null, 2) + "\n",
  );
  const result = spawnSync(
    process.execPath,
    [
      "node_modules/wrangler/bin/wrangler.js",
      ...process.argv.slice(2),
      "--config",
      "wrangler.local.json",
    ],
    { stdio: "inherit" },
  );
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} catch (error) {
  console.error(
    error.code === "ENOENT"
      ? "Missing configuration. Copy settings.example.json to settings.json and edit it; run npm ci if needed."
      : error.message,
  );
  process.exitCode = 1;
}
