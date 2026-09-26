import { build } from "esbuild";

await build({
  entryPoints: ["client/markdown.js", "client/detail.js"],
  bundle: true,
  minify: true,
  platform: "browser",
  format: "iife",
  outdir: "dist",
  outExtension: { ".js": ".txt" },
});
