import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

function frontendBuildId(): string {
  const supplied = process.env.ITLES_FRONTEND_BUILD_ID?.trim();
  if (supplied !== undefined)
    return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(supplied)
      ? supplied
      : "unknown";

  const root = new URL("../", import.meta.url);
  if (!existsSync(new URL(".git", root))) return "unknown";
  const git = (args: string[]) =>
    execFileSync("git", args, {
      cwd: fileURLToPath(root),
      encoding: "utf8",
      timeout: 2_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  try {
    const sha = git(["rev-parse", "--short=12", "HEAD"]);
    if (!/^[a-f0-9]{12}$/.test(sha)) return "unknown";
    const dirty = git([
      "status",
      "--porcelain",
      "--untracked-files=normal",
      "--",
      "frontend",
    ]);
    return `${sha}${dirty ? "-dirty" : ""}`;
  } catch {
    return "unknown";
  }
}

export default defineConfig({
  plugins: [react()],
  define: { __ITLES_FRONTEND_BUILD_ID__: JSON.stringify(frontendBuildId()) },
  build: { outDir: "dist", emptyOutDir: true },
  test: {
    environment: "jsdom",
    setupFiles: "./src/test/setup.ts",
  },
});
