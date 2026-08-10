#!/usr/bin/env node
// Build on git installs / local checkout. Skip for registry installs that already ship dist/.
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const hasGit = existsSync(join(root, ".git"));
const hasDist = existsSync(join(root, "dist", "index.js"));

if (!hasGit && hasDist) {
  process.exit(0);
}

const result = spawnSync("npm", ["run", "build"], {
  cwd: root,
  stdio: "inherit",
  shell: process.platform === "win32",
});
process.exit(result.status ?? 1);
