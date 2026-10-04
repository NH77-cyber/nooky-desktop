// Bundles tests/*.test.ts with esbuild (already installed with Vite) and runs
// them with node:test. Usage: npm test
import { build } from "esbuild";
import { readdirSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(tmpdir(), "nooky-tests");
mkdirSync(out, { recursive: true });
const files = readdirSync(join(root, "tests")).filter((f) => f.endsWith(".test.ts"));
const outs = [];
for (const f of files) {
  const outfile = join(out, f.replace(/\.ts$/, ".mjs"));
  await build({ entryPoints: [join(root, "tests", f)], bundle: true, platform: "node", format: "esm", outfile, logLevel: "error" });
  outs.push(outfile);
}
const r = spawnSync(process.execPath, ["--test", ...outs], { stdio: "inherit" });
process.exit(r.status ?? 1);
