import esbuild from "esbuild";
import postcss from "postcss";
import tailwindcss from "@tailwindcss/postcss";
import { readFile } from "node:fs/promises";

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

const tailwindPlugin = {
  name: "tailwind",
  setup(build) {
    build.onLoad({ filter: /\.css$/ }, async (args) => {
      const css = await readFile(args.path, "utf-8");
      const result = await postcss([tailwindcss]).process(css, {
        from: args.path,
      });
      return { contents: result.css, loader: "css" };
    });
  },
};

const extensionConfig = {
  entryPoints: ["src/extension.ts"],
  outfile: "dist/extension.js",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  minify: production,
  sourcemap: !production,
  external: ["vscode"],
  logLevel: "info",
};

const webviewConfig = {
  entryPoints: ["webview/index.tsx"],
  outdir: "dist",
  outbase: "webview",
  bundle: true,
  platform: "browser",
  format: "iife",
  target: "es2022",
  jsx: "automatic",
  minify: production,
  sourcemap: !production,
  plugins: [tailwindPlugin],
  logLevel: "info",
};

if (watch) {
  const [extCtx, webCtx] = await Promise.all([
    esbuild.context(extensionConfig),
    esbuild.context(webviewConfig),
  ]);
  await Promise.all([extCtx.watch(), webCtx.watch()]);
  console.log("[standboy] watching for changes...");
} else {
  await Promise.all([
    esbuild.build(extensionConfig),
    esbuild.build(webviewConfig),
  ]);
  console.log("[standboy] build complete");
}
