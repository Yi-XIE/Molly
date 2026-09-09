import { mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const piHome = join(projectRoot, ".pi-home");
const sessionDir = join(projectRoot, ".pi", "sessions");
const executable = join(
  projectRoot,
  "node_modules",
  "@earendil-works",
  "pi-coding-agent",
  "dist",
  "bundle",
  "cli.js"
);

mkdirSync(piHome, { recursive: true });
mkdirSync(sessionDir, { recursive: true });

const result = spawnSync(process.execPath, [executable, "--session-dir", sessionDir, ...process.argv.slice(2)], {
  cwd: projectRoot,
  env: {
    ...process.env,
    PI_CODING_AGENT_DIR: piHome,
    PI_CODING_AGENT_SESSION_DIR: sessionDir,
    PI_TELEMETRY: "0",
    PI_SKIP_VERSION_CHECK: "1"
  },
  stdio: "inherit",
  shell: false
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
