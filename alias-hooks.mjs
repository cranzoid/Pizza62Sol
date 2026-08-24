// Resolves the project's "@/..." path alias for plain node processes — the test
// runner and the migration script — so they import modules exactly as the app
// does. Lives at the repo root because it is used outside tests as well.
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const root = path.dirname(fileURLToPath(import.meta.url));

export function resolve(specifier, context, nextResolve) {
  if (!specifier.startsWith("@/")) return nextResolve(specifier, context);
  const target = path.join(root, specifier.slice(2));
  const resolved = [target, `${target}.ts`, `${target}.tsx`, path.join(target, "index.ts")].find(existsSync);
  if (!resolved) return nextResolve(specifier, context);
  return { url: pathToFileURL(resolved).href, shortCircuit: true };
}
