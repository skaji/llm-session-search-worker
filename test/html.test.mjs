import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

const bundle = await build({
  entryPoints: ["src/html.ts"],
  bundle: true,
  write: false,
  format: "esm",
  platform: "browser",
});
const { searchPage, detailPage } = await import(
  "data:text/javascript;base64," +
    Buffer.from(bundle.outputFiles[0].text).toString("base64")
);

test("search timestamps use relative units while session details keep JST", (t) => {
  const now = Date.parse("2026-09-26T12:00:00Z");
  t.mock.method(Date, "now", () => now);
  const session = {
    id: 1,
    device: "imac2024",
    source: "codex",
    source_id: "time-test",
    title: "Timestamp test",
    cwd: "/test",
    path: "/test/session.jsonl",
    archived: 0,
    updated_at_ms: now - 86400_000,
    line: 1,
    snippet: "",
  };
  for (const [seconds, label] of [
    [-60, "just now"],
    [0, "just now"],
    [59, "just now"],
    [60, "1 minute ago"],
    [3599, "59 minutes ago"],
    [3600, "1 hour ago"],
    [86400, "1 day ago"],
    [7 * 86400, "1 week ago"],
    [14 * 86400, "2 weeks ago"],
    [30 * 86400, "1 month ago"],
    [365 * 86400, "1 year ago"],
  ]) {
    const updated_at_ms = now - seconds * 1000;
    const html = searchPage(
      new URL("https://example.com/"),
      { results: [{ ...session, updated_at_ms }], next_offset: null },
      "user@example.com",
    );
    assert.ok(
      html.includes(
        `<time datetime="${new Date(updated_at_ms).toISOString()}">${label}</time>`,
      ),
      label,
    );
  }
  const detail = detailPage(
    { session, records: [], next_after: null },
    "user@example.com",
  );
  assert.ok(
    detail.includes(
      '<time datetime="2026-09-25T12:00:00.000Z">2026/09/25 21:00:00 JST</time>',
    ),
  );
});

test("missing message timestamps are shown as unknown", () => {
  const session = {
    id: 1,
    device: "imac2024",
    source: "codex",
    source_id: "missing-time",
    title: "Missing timestamp",
    cwd: "/test",
    path: "/test/session.jsonl",
    archived: 0,
    updated_at_ms: 0,
    line: 1,
    snippet: "",
  };
  const pages = [
    searchPage(
      new URL("https://example.com/"),
      { results: [session], next_offset: null },
      "user@example.com",
    ),
    detailPage({ session, records: [], next_after: null }, "user@example.com"),
  ];
  for (const html of pages) {
    assert.ok(html.includes("Unknown update time"));
    assert.ok(!html.includes("<time"));
  }
});
