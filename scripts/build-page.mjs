// Bundle the upload page: src/page/main.ts → public/app.js. esbuild ships with wrangler
// (node_modules/esbuild); no separate dependency. The output is committed so a deploy
// from a clean checkout serves the current page.
import { build } from "esbuild";

await build({
  entryPoints: ["src/page/main.ts"],
  outfile: "public/app.js",
  bundle: true,
  format: "esm",
  target: "es2020",
  minify: false,
  sourcemap: false,
  legalComments: "none",
  logLevel: "info",
});
