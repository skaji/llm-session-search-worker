import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";
import { parseHTML } from "linkedom";

const bundle = await build({
  entryPoints: ["src/html.ts"],
  bundle: true,
  write: false,
  format: "esm",
  platform: "browser",
});
const { detailPage } = await import(
  "data:text/javascript;base64," +
    Buffer.from(bundle.outputFiles[0].text).toString("base64")
);
const script = await readFile("dist/markdown.txt", "utf8");
const result = {
  session: {
    id: 1,
    device: "imac2024",
    source: "codex",
    source_id: "test",
    title: "Test",
    cwd: "/test",
    path: "/test/a.jsonl",
    archived: 0,
    updated_at_ms: 0,
  },
  records: [
    {
      line: 4,
      role: "user",
      text: "# Question\n\n**Hello** 日本語\n\n<script>alert(1)</script>\n\n[bad](javascript:alert%281%29)",
    },
    {
      line: 8,
      role: "assistant",
      text: '| A | B |\n| - | - |\n| x | y |\n\n```go\nfmt.Println("<hello>")\n```\n\nText[^1]\n\n[^1]: Note',
    },
    { line: 10, role: "assistant", text: "Other[^1]\n\n[^1]: Another note" },
  ],
  next_after: 10,
};
const page = (query) =>
  parseHTML(
    detailPage(
      result,
      "you@example.com",
      new URL("https://example.com/sessions/1" + query),
    ),
  ).document;

test("plain text is the default and layout keeps search anchors without visible labels", () => {
  for (const query of ["", "?markdown=0", "?markdown=other"]) {
    const document = page(query);
    assert.equal(document.querySelector("script"), null);
    assert.equal(document.querySelectorAll(".message-source").length, 3);
    assert.equal(document.querySelectorAll(".message-user").length, 1);
    assert.equal(
      document.getElementById("line-4").textContent,
      result.records[0].text,
    );
    assert.equal(document.querySelector(".role-badge"), null);
    assert.equal(
      document
        .querySelector(".message-controls a:last-child")
        .getAttribute("href"),
      "/sessions/1?markdown=1",
    );
  }
});

test("Markdown controls preserve pagination and explicitly disabled rendering", () => {
  for (const value of ["0", "1"]) {
    const document = page(`?after=3&markdown=${value}`);
    const links = [
      ...document.querySelectorAll(".message-controls a, nav a"),
    ].map((a) => a.getAttribute("href"));
    assert.deepEqual(links, [
      `/sessions/1?markdown=${value}`,
      `/sessions/1?after=3&markdown=${value === "1" ? "0" : "1"}`,
      `/sessions/1?after=10&markdown=${value}`,
    ]);
    assert.equal(
      document.querySelector("script")?.getAttribute("src") ?? null,
      value === "1" ? "/assets/markdown.js" : null,
    );
  }
});

test("browser Markdown renders GFM safely and restores the search anchor", () => {
  const document = page("?markdown=1");
  let scrolled = false;
  document.getElementById("line-8").scrollIntoView = () => {
    scrolled = true;
  };
  runInNewContext(script, { document, location: { hash: "#line-8" } });
  assert.equal(scrolled, true);
  assert.equal(document.querySelectorAll(".markdown").length, 3);
  assert.equal(document.querySelectorAll(".message-source").length, 0);
  assert.equal(document.querySelector(".markdown h1").textContent, "Question");
  assert.equal(document.querySelector(".markdown strong").textContent, "Hello");
  assert.equal(document.querySelector(".markdown script"), null);
  assert.ok(
    document
      .querySelector(".markdown")
      .textContent.includes("<script>alert(1)</script>"),
  );
  assert.equal(document.querySelector('a[href^="javascript:"]'), null);
  assert.equal(
    document.querySelector(".table-scroll table td").textContent,
    "x",
  );
  assert.equal(
    document.querySelector("code.language-go").textContent,
    'fmt.Println("<hello>")\n',
  );
  const ids = [...document.querySelectorAll("[id]")].map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length);
});
