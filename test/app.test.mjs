import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
let mf, denied, anonymous;
before(async () => {
  const bundle = await build({
    entryPoints: ["src/index.ts"],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
  });
  const options = {
    modules: true,
    script: bundle.outputFiles[0].text,
    compatibilityDate: "2026-09-26",
    bindings: { ALLOWED_EMAIL: "you@example.com" },
    d1Databases: ["DB"],
  };
  mf = new Miniflare(
    convertV4MiniflareOptions({
      workers: [
        {
          ...options,
          name: "app",
          access: { aud: "local", identity: { email: "you@example.com" } },
        },
      ],
    }),
  );
  denied = new Miniflare(
    convertV4MiniflareOptions({
      workers: [
        {
          ...options,
          name: "app",
          access: { aud: "local", identity: { email: "other@example.com" } },
        },
      ],
    }),
  );
  anonymous = new Miniflare(
    convertV4MiniflareOptions({ workers: [{ ...options, name: "app" }] }),
  );
  const db = await mf.getD1Database("DB");
  // D1 exec accepts one statement per line; keep trigger bodies intact.
  for (const file of (await readdir("migrations"))
    .filter((f) => f.endsWith(".sql"))
    .sort()) {
    const sql = await readFile(`migrations/${file}`, "utf8");
    const statements = sql.match(
      /CREATE TRIGGER[\s\S]*?END;|CREATE (?:TABLE|INDEX|VIRTUAL TABLE)[\s\S]*?;/g,
    );
    for (const statement of statements) await db.prepare(statement).run();
  }
});
after(async () => {
  await Promise.all([mf, denied, anonymous].map((m) => m?.dispose()));
});
const session = {
  device: "macbook",
  source: "codex",
  source_id: "session-a",
  title: "<script>alert(1)</script>",
  cwd: "/projects/demo",
  path: "/fixture/a.jsonl",
  archived: 0,
  updated_at_ms: 1000,
};
async function post(records, s = session) {
  return mf.dispatchFetch("https://example.com/api/v1/sync", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session: s, records }),
  });
}
async function get(path) {
  const response = await mf.dispatchFetch("https://example.com" + path);
  assert.equal(response.status, 200);
  return response.json();
}
test("Access identity is required; a forged email header is insufficient", async () => {
  for (const instance of [denied, anonymous]) {
    const r = await instance.dispatchFetch("https://example.com/", {
      headers: {
        "Cf-Access-Authenticated-User-Email": "you@example.com",
        Authorization: "Bearer old-probe-secret",
      },
    });
    assert.equal(r.status, 403);
  }
});
test("delta sync, FTS, isolation, pagination, and HTML escaping", async () => {
  const records = [
    {
      line: 1,
      role: "user",
      text: "Hello GitHub Actions 日本語検索 <img src=x>",
    },
    { line: 3, role: "assistant", text: "secondterm 日本語検索" },
  ];
  assert.equal((await post(records)).status, 200);
  assert.equal((await (await post(records)).json()).rows_written, 0);
  let results = await get("/api/v1/search?q=GitHub+secondterm&cwd=%2Fprojects");
  assert.equal(results.results.length, 1);
  assert.equal((await get("/api/v1/search?q=%22Hub+Act%22")).results.length, 1);
  assert.equal((await get("/api/v1/search?q=語検")).results.length, 1);
  assert.equal(
    (await get("/api/v1/search?q=GitHub&cwd=%2Fproject")).results.length,
    0,
  );
  await post(records, { ...session, device: "imac" });
  assert.equal((await get("/api/v1/search?q=GitHub")).results.length, 2);
  const id = results.results[0].id;
  let detail = await get(`/api/v1/sessions/${id}`);
  assert.equal(detail.records.length, 2);
  const html = await (
    await mf.dispatchFetch(`https://example.com/sessions/${id}`)
  ).text();
  assert.ok(html.includes("&lt;script&gt;"));
  assert.ok(html.includes("&lt;img"));
  assert.ok(!html.includes("<script>"));
  await post([{ line: 1, role: "user", text: "replacement" }]);
  assert.equal(
    (await get("/api/v1/search?q=GitHub&device=macbook")).results.length,
    0,
  );
  assert.equal((await get("/api/v1/search?q=replacement")).results.length, 1);
  await post([{ line: 1, role: "user", text: null }]);
  assert.equal((await get("/api/v1/search?q=replacement")).results.length, 0);
  await post(
    Array.from({ length: 40 }, (_, i) => ({
      line: 10 + i,
      role: "user",
      text: "pagination",
    })),
  );
  detail = await get(`/api/v1/sessions/${id}`);
  assert.equal(detail.records.length, 20);
  assert.ok(detail.next_after);
  const next = await get(`/api/v1/sessions/${id}?after=${detail.next_after}`);
  assert.ok(next.records[0].line > detail.records.at(-1).line);
  assert.equal(
    (
      await mf.dispatchFetch("https://example.com/api/v1/devices/imac", {
        method: "DELETE",
      })
    ).status,
    200,
  );
  assert.equal((await get("/api/v1/search?q=GitHub")).results.length, 0);
});
test("invalid input, large bodies, and cross-origin writes are rejected", async () => {
  assert.equal(
    (
      await post([
        { line: 1, role: "user", text: "x" },
        { line: 1, role: "user", text: "y" },
      ])
    ).status,
    400,
  );
  assert.equal(
    (
      await post(
        Array.from({ length: 41 }, (_, i) => ({
          line: i + 1,
          role: "user",
          text: "x",
        })),
      )
    ).status,
    400,
  );
  assert.equal(
    (await post([{ line: 1, role: "user", text: "x".repeat(128 * 1024) }]))
      .status,
    413,
  );
  assert.equal(
    (
      await mf.dispatchFetch("https://example.com/api/v1/devices/macbook", {
        method: "DELETE",
        headers: { Origin: "https://evil.example" },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await mf.dispatchFetch(
        "https://example.com/api/v1/search?q=" +
          encodeURIComponent("a b c d e f"),
      )
    ).status,
    400,
  );
  assert.equal(
    (await mf.dispatchFetch("https://example.com/api/v1/search?offset=-1"))
      .status,
    400,
  );
});

test("Go CLI sync and daemon work against the Worker", async () => {
  const {
    mkdtemp,
    writeFile,
    mkdir,
    rm,
    readFile: read,
  } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const exec = promisify(execFile);
  const dir = await mkdtemp(join(tmpdir(), "session-sync-test-"));
  const binary = join(dir, "sync");
  const home = join(dir, "codex");
  const configDir = join(dir, "config");
  await mkdir(join(home, "sessions"), { recursive: true });
  await mkdir(configDir);
  const url = (await mf.ready).origin;
  await writeFile(
    join(configDir, "config.json"),
    JSON.stringify({ url, device: "cli-test", token: "" }),
    { mode: 0o600 },
  );
  const source = join(home, "sessions", "cli.jsonl");
  const row = (text) =>
    JSON.stringify({
      type: "response_item",
      payload: { role: "user", content: [{ type: "input_text", text }] },
    }) + "\n";
  await writeFile(source, row("cliunique alpha"));
  await exec("go", ["build", "-o", binary, "./cmd/llm-session-sync"]);
  const options = [
    "-data-dir",
    configDir,
    "-codex-home",
    home,
    "-claude-home",
    "",
  ];
  const run = (...args) => exec(binary, args, { timeout: 15000 });
  try {
    let output = await run(...options);
    assert.equal(JSON.parse(output.stdout).Changed, 1);
    output = await run(...options);
    assert.equal(JSON.parse(output.stdout).Requests, 0);
    await writeFile(source, row("cliunique alpha") + row("cliunique beta"));
    output = await run(...options);
    assert.equal(JSON.parse(output.stdout).Records, 1);
    output = await run("search", "-data-dir", configDir, "cliunique");
    assert.equal(JSON.parse(output.stdout).results.length, 1);
    await writeFile(source, row("cliunique replacement"));
    await run(...options);
    assert.equal(
      (await get("/api/v1/search?q=beta&device=cli-test")).results.length,
      0,
    );
    await run("-daemon", "-interval", "100ms", ...options);
    output = await run("-daemon-status", "-data-dir", configDir);
    assert.match(output.stdout, /running/);
    assert.match(output.stdout, /development/);
    output = await run("-daemon", "-interval", "100ms", ...options);
    assert.match(output.stdout, /already running/);
    await writeFile(source, row("daemonunique"));
    for (let attempt = 0; attempt < 30; attempt++) {
      if ((await get("/api/v1/search?q=daemonunique")).results.length === 1)
        break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(
      (await get("/api/v1/search?q=daemonunique")).results.length,
      1,
    );
    await run("-daemon-stop", "-data-dir", configDir);
    output = await run("-daemon-status", "-data-dir", configDir);
    assert.match(output.stdout, /stopped/);
    const log = await read(join(configDir, "app.log"), "utf8");
    assert.match(log, /Daemon started/);
    assert.match(log, /Daemon stopped/);
    assert.doesNotMatch(log, /Sync complete/);
    await rm(source);
    output = await run("-prune", ...options);
    assert.equal(JSON.parse(output.stdout).Deleted, 1);
    assert.equal(
      (await get("/api/v1/search?q=daemonunique")).results.length,
      0,
    );
  } finally {
    await run("-daemon-stop", "-data-dir", configDir).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

test("search history is bounded, deduplicated, user-scoped, and explicitly submitted", async () => {
  const db = await mf.getD1Database("DB");
  const submit = (q, extra = {}) =>
    mf.dispatchFetch("https://example.com/search", {
      method: "POST",
      body: new URLSearchParams({ q, ...extra }),
      redirect: "manual",
    });
  const history = async () =>
    (
      await db
        .prepare(
          "SELECT query FROM search_history WHERE email=? ORDER BY id DESC",
        )
        .bind("you@example.com")
        .all()
    ).results.map((r) => r.query);
  await db
    .prepare("INSERT INTO search_history(email, query) VALUES (?, ?)")
    .bind("other@example.com", "private-other-query")
    .run();
  for (let i = 0; i < 22; i++)
    assert.equal((await submit(`query${i}`)).status, 303);
  assert.equal((await history()).length, 20);
  assert.equal((await history()).at(-1), "query2");
  const response = await submit(" query2 ", {
    cwd: "/projects",
    device: "imac2024",
    email: "other@example.com",
  });
  assert.equal(
    response.headers.get("Location"),
    "/?q=query2&cwd=%2Fprojects&device=imac2024",
  );
  assert.equal((await history())[0], "query2");
  assert.equal((await history()).length, 20);
  const snapshot = await history();
  await submit("  ");
  await submit('""');
  assert.equal((await submit("a b c d e f")).status, 400);
  await mf.dispatchFetch("https://example.com/?q=query10&offset=20");
  await mf.dispatchFetch("https://example.com/?q=query11");
  await get("/api/v1/search?q=api-query");
  assert.deepEqual(await history(), snapshot);
  await submit("<script>alert(1)</script>");
  const html = await (await mf.dispatchFetch("https://example.com/")).text();
  assert.ok(html.includes('aria-label="Recent searches"'));
  assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
  assert.ok(!html.includes("<script>"));
  assert.ok(!html.includes("private-other-query"));
  for (const path of ["/search", "/history/clear"]) {
    assert.equal(
      (
        await mf.dispatchFetch(`https://example.com${path}`, {
          method: "POST",
          headers: { Origin: "https://evil.example" },
          body: "q=evil",
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await anonymous.dispatchFetch(`https://example.com${path}`, {
          method: "POST",
          body: "q=evil",
        })
      ).status,
      403,
    );
  }
  const clear = await mf.dispatchFetch("https://example.com/history/clear", {
    method: "POST",
    redirect: "manual",
  });
  assert.equal(clear.status, 303);
  assert.deepEqual(await history(), []);
  assert.equal(
    (
      await db
        .prepare("SELECT COUNT(*) AS n FROM search_history WHERE email=?")
        .bind("other@example.com")
        .first()
    ).n,
    1,
  );
});

test("form submissions preserve Origin and still reject opaque or foreign origins", async () => {
  const page = await mf.dispatchFetch("https://example.com/");
  assert.equal(page.headers.get("Referrer-Policy"), "strict-origin");
  for (const [origin, status] of [
    ["https://example.com", 303],
    ["null", 403],
    ["https://evil.example", 403],
  ]) {
    const response = await mf.dispatchFetch("https://example.com/search", {
      method: "POST",
      headers: {
        Origin: origin,
        "Content-Type": "application/x-www-form-urlencoded",
        "Sec-Fetch-Site": "same-origin",
      },
      body: "q=",
      redirect: "manual",
    });
    assert.equal(response.status, status);
  }
});
