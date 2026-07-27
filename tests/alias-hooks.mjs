// Resolves the project's "@/..." path alias for the plain node test runner, so
// tests can import any module in the app the same way the app imports it.
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function resolve(specifier, context, nextResolve) {
  if (!specifier.startsWith("@/")) return nextResolve(specifier, context);
  const target = path.join(root, specifier.slice(2));
  const resolved = [target, `${target}.ts`, `${target}.tsx`, path.join(target, "index.ts")].find(existsSync);
  if (!resolved) return nextResolve(specifier, context);
  return { url: pathToFileURL(resolved).href, shortCircuit: true };
}
