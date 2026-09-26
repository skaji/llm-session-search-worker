import { build } from "esbuild";

await build({
  entryPoints: ["client/markdown.js"],
  bundle: true,
  minify: true,
  platform: "browser",
  format: "iife",
  outfile: "dist/markdown.txt",
});
