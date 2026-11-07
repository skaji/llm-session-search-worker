import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";

let commit = null;
let dirty = false;
try {
  commit = execFileSync("git", ["rev-parse", "--verify", "HEAD"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
  dirty = !!execFileSync("git", ["status", "--porcelain"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
} catch {
  commit = null;
}

await mkdir("dist", { recursive: true });
await writeFile(
  "dist/build-info.ts",
  `export const buildInfo = ${JSON.stringify({ commit, dirty })} as { commit: string | null; dirty: boolean };\n`,
);

await build({
  entryPoints: ["client/markdown.js", "client/detail.js"],
  bundle: true,
  minify: true,
  platform: "browser",
  format: "iife",
  outdir: "dist",
  outExtension: { ".js": ".txt" },
});
