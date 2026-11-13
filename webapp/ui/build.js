// Builds the dashboard front end into ../static/app.js (one file, no framework files to serve).
// Run once:  npm install   then   npm run build   (or npm run watch while editing).
const esbuild = require("esbuild");
const watch = process.argv.includes("--watch");
const opts = {
  entryPoints: ["src/main.jsx"], bundle: true, outfile: "../static/app.js", minify: !watch, sourcemap: watch ? "inline" : false,
  loader: { ".jsx": "jsx", ".js": "jsx" }, jsx: "automatic", target: ["chrome110", "edge110", "firefox115", "safari16"],
  define: { "process.env.NODE_ENV": watch ? '"development"' : '"production"' }, logLevel: "info",
};
if (watch) esbuild.context(opts).then(c => c.watch()); else esbuild.build(opts).catch(() => process.exit(1));
