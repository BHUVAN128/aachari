import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Loads the repository's local environment files (`.env.local`, then `.env`) into
 * `process.env` without overriding values already set in the real environment, so
 * a shell-provided credential wins over the checked-out file. No third-party
 * dependency: the harness must stay runnable with only the repo's normal deps.
 */
const parseEnvFile = (path: string): Record<string, string> => {
  const values: Record<string, string> = {};
  for (const rawLine of readFileSync(path, "utf8").split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    values[key] = value;
  }
  return values;
};

export const loadRepoEnv = () => {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  for (const file of [".env.local", ".env"]) {
    const path = `${root}${file}`;
    if (!existsSync(path)) continue;
    for (const [key, value] of Object.entries(parseEnvFile(path))) {
      if (process.env[key] === undefined) process.env[key] = value;
    }
  }
};