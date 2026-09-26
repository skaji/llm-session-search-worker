import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  copyFile,
  writeFile,
  readFile,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

test("deployment settings generate the custom domain and both email bindings", async () => {
  const root = await mkdtemp(join(tmpdir(), "worker-settings-"));
  try {
    await mkdir(join(root, "scripts"));
    await mkdir(join(root, "node_modules/wrangler/bin"), { recursive: true });
    await copyFile("scripts/wrangler.mjs", join(root, "scripts/wrangler.mjs"));
    await copyFile("wrangler.jsonc", join(root, "wrangler.jsonc"));
    await writeFile(
      join(root, "node_modules/wrangler/bin/wrangler.js"),
      "console.log(JSON.stringify(process.argv.slice(2)))",
    );
    const run = () =>
      spawnSync(
        process.execPath,
        [join(root, "scripts/wrangler.mjs"), "deploy", "--dry-run"],
        { encoding: "utf8" },
      );
    assert.equal(run().status, 1);
    await writeFile(
      join(root, "settings.json"),
      JSON.stringify({
        url: "https://search.example.org",
        email: "owner@example.org",
      }),
    );
    const result = run();
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), [
      "deploy",
      "--dry-run",
      "--config",
      "wrangler.local.json",
    ]);
    const config = JSON.parse(
      await readFile(join(root, "wrangler.local.json"), "utf8"),
    );
    assert.deepEqual(config.routes, [
      { pattern: "search.example.org", custom_domain: true },
    ]);
    assert.equal(config.vars.ALLOWED_EMAIL, "owner@example.org");
    assert.equal(config.access.dev.identity.email, "owner@example.org");
    assert.equal(config.main, "src/index.ts");
    assert.equal(config.workers_dev, false);
    for (const url of [
      "http://search.example.org",
      "https://search.example.org/path",
      "https://user:pass@search.example.org",
    ]) {
      await writeFile(
        join(root, "settings.json"),
        JSON.stringify({ url, email: "owner@example.org" }),
      );
      assert.equal(run().status, 1);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
