import esbuild from "esbuild";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const production = process.argv[2] === "production";
const vaultDir = process.env.OBSIDIAN_VAULT;

/** Mirrors the built files into the vault so a rebuild lands on the phone immediately. */
const copyToVault = {
  name: "copy-to-vault",
  setup(build) {
    build.onEnd(() => {
      if (!vaultDir) return;
      const dest = path.join(vaultDir, ".obsidian", "plugins", "pi-harness");
      fs.mkdirSync(dest, { recursive: true });
      for (const file of ["main.js", "manifest.json", "styles.css"]) {
        const src = path.join(process.cwd(), file);
        if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dest, file));
      }
      console.log(`[copy-to-vault] synced to ${dest}`);
    });
  },
};

const ctx = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: ["obsidian", "electron"],
  format: "cjs",
  target: "es2020",
  logLevel: "info",
  sourcemap: production ? false : "inline",
  minify: production,
  outfile: "main.js",
  plugins: [copyToVault],
});

if (production) {
  await ctx.rebuild();
  await ctx.dispose();
} else {
  await ctx.watch();
}
