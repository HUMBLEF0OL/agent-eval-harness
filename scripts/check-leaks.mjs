import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

// Covers every import form that can reach a vendor SDK — static `from "x"`,
// bare `import "x"`, dynamic `import("x")`, `require("x")` — and any subpath
// (`openai/resources`), because each of those bypassed the old `from`-only regex.
// Only `openai` is a dependency now; the two removed SDKs stay in the pattern on
// purpose, so re-adding an adapter outside src/provider/ fails here rather than
// after someone has already imported it in three places.
const VENDOR = /\b(?:from|import|require)\s*\(?\s*["'](?:openai|@anthropic-ai\/sdk|@google\/genai)(?:\/[^"']*)?["']/;
// A display string, deliberately NOT path.join: joining produced "src\provider" on
// Windows and "src/provider" on Linux, so this script's own output differed by platform
// and read as the mixed "src\provider/" once the trailing slash was appended. The
// comparison below still uses path.sep, because that one is about real paths.
const ALLOWED = "src/provider";
const offenders = [];

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { walk(p); continue; }
    if (!p.endsWith(".ts")) continue;
    if (relative("src", p).split(sep)[0] === "provider") continue;
    if (VENDOR.test(readFileSync(p, "utf8"))) offenders.push(p.split(sep).join("/"));
  }
}

walk("src");

if (offenders.length) {
  console.error("Vendor SDK imported outside src/provider/ (TSD §1.1):");
  for (const o of offenders) console.error("  " + o);
  process.exit(1);
}
console.log(`leak check ok — no vendor imports outside ${ALLOWED}/`);
