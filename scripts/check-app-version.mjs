import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const expected = JSON.stringify(version);
const assetsDir = join(root, "dist", "assets");

let jsFiles;
try {
  jsFiles = readdirSync(assetsDir).filter((name) => name.endsWith(".js"));
} catch (err) {
  console.error(`Frontend assets missing at ${assetsDir}. Run \`npm run build\` first.`);
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}

if (jsFiles.length === 0) {
  console.error(`No JS bundles in ${assetsDir}`);
  process.exit(1);
}

const hits = [];
for (const name of jsFiles) {
  const source = readFileSync(join(assetsDir, name), "utf8");
  if (source.includes(expected)) {
    hits.push(name);
  }
}

if (hits.length === 0) {
  console.error(
    `Frontend bundle is missing the package.json version ${expected}. ` +
      `Checked: ${jsFiles.join(", ")}`,
  );
  process.exit(1);
}

console.log(`Found ${expected} in ${hits.join(", ")}`);
