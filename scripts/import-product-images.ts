/**
 * Bulk-imports menu photographs from a folder and attaches each to its product.
 *
 * The admin screen takes one picture at a time, which is the right shape for
 * changing one dish and the wrong shape for photographing the whole menu in an
 * afternoon. This is that afternoon: a folder of pictures, resized, uploaded and
 * linked in one pass.
 *
 * **It never holds a credential of its own.** It signs in as the owner with
 * `PIZZA62_EMAIL` / `PIZZA62_PASSWORD` from the environment, and works through
 * the same endpoints and the same permission checks as the admin screen —
 * nothing here reaches the database directly. So it can be pointed at production
 * without production trusting it any further than it trusts a browser with the
 * owner signed in.
 *
 * **It writes nothing until asked twice.** Without `--apply` it resolves and
 * optimizes everything, prints exactly which file would land on which product,
 * and stops. Read that list before running it again with `--apply`.
 *
 * Usage:
 *
 *   PIZZA62_EMAIL=... PIZZA62_PASSWORD=... \
 *   node --experimental-strip-types --import ./register-alias.mjs \
 *     scripts/import-product-images.ts ./PICTURES --base-url https://pizza62.ca
 *
 * Name each file after the dish. Subfolders are walked, so the shape the photos
 * arrive in — `Speciality/Butter Chicken.png` — is the shape they can stay in,
 * and the folder name is used to break a tie when a name belongs to more than
 * one product (a `Meatball` in the specialty folder is the pizza, not the sub).
 * Spelling is matched loosely enough to absorb a slip: `Candian.png` finds
 * Canadian. Anything it cannot place, or can place two ways, it refuses to guess
 * at and lists instead — name it exactly, or pass `--map "Pisa=product-id"`.
 */
import { readdir, readFile, mkdtemp, rm } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { MAX_UPLOAD_BYTES } from "@/lib/image-validation";

const run = promisify(execFile);

/** Matches `MAX_STORED_EDGE` in the admin editor, so both paths store alike. */
const MAX_STORED_EDGE = 1600;
const WEBP_QUALITY = "82";
/**
 * How many characters may be wrong before this is a different word.
 *
 * Scaled by length rather than fixed, because the same allowance means different
 * things at different sizes: two wrong letters in "Greek" is a different dish,
 * while three in "Mediterannian" is one hand slipping across a long word. A
 * fixed two placed "Mediterannian" (distance 3 from Mediterranean) out of reach
 * while still being loose enough to worry about on a five-letter name.
 */
function tolerance(key: string): number {
  if (key.length >= 10) return 3;
  if (key.length >= 6) return 2;
  return 1;
}

/** Anything macOS can decode; `sips` normalises the rest of the pipeline. */
const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".heic", ".heif", ".tif", ".tiff"]);

type Product = { id: string; category_id: string; name: string; image_url: string | null };
type Category = { id: string; name: string };
type Found = { absolute: string; label: string; nameKey: string; folderKey: string };
type Plan = { file: Found; product: Product; how: string; bytes: number; optimizedBytes: number; optimized: string };

function fail(message: string): never {
  console.error(`\n  ${message}\n`);
  process.exit(1);
}

const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Levenshtein, so `Candian` can still find Canadian. */
function distance(left: string, right: string): number {
  const row = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i++) {
    let previous = row[0];
    row[0] = i;
    for (let j = 1; j <= right.length; j++) {
      const swap = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (left[i - 1] === right[j - 1] ? 0 : 1));
      previous = swap;
    }
  }
  return row[right.length];
}

/**
 * The names a person might reasonably write on a file for this product.
 *
 * The trailing "Pizza" is dropped because the menu carries it and a photograph
 * of it does not: the file for "Butter Chicken Pizza" is going to be called
 * `Butter Chicken`.
 */
function keysFor(product: Product): string[] {
  const keys = new Set<string>();
  const add = (value: string) => {
    const key = normalize(value);
    if (key) keys.add(key);
  };
  add(product.id);
  add(product.id.replace(/^specialty-/, ""));
  add(product.name);
  add(product.name.replace(/\s*pizza\s*$/i, ""));
  return [...keys];
}

/** Which menu category a folder is named after, if any. */
function categoryFor(folderKey: string, categories: Category[]): string | null {
  if (!folderKey) return null;
  for (const category of categories) {
    const full = normalize(category.name);
    const firstWord = normalize(category.name.split(/\s+/)[0]);
    // "Speciality" is a folder for "Specialty Pizzas": one letter out from the
    // first word, nowhere near the whole name.
    if (full === folderKey || distance(full, folderKey) <= tolerance(folderKey)) return category.id;
    if (firstWord === folderKey || distance(firstWord, folderKey) <= tolerance(folderKey)) return category.id;
  }
  return null;
}

function resolve(
  file: Found,
  products: Product[],
  categories: Category[],
  overrides: Map<string, string>,
): { product?: Product; how?: string; ambiguous?: Product[] } {
  const override = overrides.get(file.nameKey);
  if (override) {
    const product = products.find((candidate) => candidate.id === override);
    if (!product) fail(`--map points ${file.label} at "${override}", which is not a product id.`);
    return { product, how: "mapped" };
  }

  const narrow = (candidates: Product[], how: string) => {
    if (candidates.length === 1) return { product: candidates[0], how };
    // More than one product answers to this name. The folder it was filed under
    // is the tiebreaker — the specialty folder means the pizza, not the sub.
    const category = categoryFor(file.folderKey, categories);
    const inCategory = category ? candidates.filter((candidate) => candidate.category_id === category) : [];
    if (inCategory.length === 1) return { product: inCategory[0], how: `${how} + folder` };
    return { ambiguous: candidates };
  };

  const exact = products.filter((product) => keysFor(product).includes(file.nameKey));
  if (exact.length) return narrow(exact, "exact");

  const allowed = tolerance(file.nameKey);
  let best = allowed + 1;
  let close: Product[] = [];
  for (const product of products) {
    const nearest = Math.min(...keysFor(product).map((key) => distance(key, file.nameKey)));
    if (nearest < best) {
      best = nearest;
      close = [product];
    } else if (nearest === best) {
      close.push(product);
    }
  }
  if (best <= allowed && close.length) return narrow(close, `close (${best})`);
  return {};
}

/** Every image under `folder`, however deeply it is filed. */
async function walk(folder: string, root = folder): Promise<Found[]> {
  const entries = await readdir(folder, { withFileTypes: true });
  const found: Found[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const absolute = path.join(folder, entry.name);
    if (entry.isDirectory()) {
      found.push(...(await walk(absolute, root)));
    } else if (IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      found.push({
        absolute,
        label: path.relative(root, absolute),
        nameKey: normalize(entry.name.replace(/\.[^.]+$/, "")),
        folderKey: normalize(path.basename(folder)),
      });
    }
  }
  return found;
}

/**
 * Turns whatever the camera produced into the same 1600px WebP the browser
 * would have made.
 *
 * `sips` first, always, even when the format needs no converting: it is the step
 * that reads HEIC, and the step that applies the EXIF orientation. Without it a
 * photograph taken in portrait is encoded on its side, because `cwebp` copies
 * the orientation tag through rather than acting on it.
 */
async function optimize(source: string, workDir: string, slug: string): Promise<string> {
  const normalized = path.join(workDir, `${slug}.normalized.png`);
  const destination = path.join(workDir, `${slug}.webp`);
  await run("sips", ["-s", "format", "png", source, "--out", normalized]);
  const { width, height } = await dimensionsOf(normalized);
  // Only ever downward. `cwebp -resize` is unconditional, so asking it for 1600
  // on a picture that is already 900 wide enlarges it — more bytes carrying no
  // more detail, which is the opposite of the point.
  const resize = Math.max(width, height) <= MAX_STORED_EDGE
    ? []
    // A zero means "keep the aspect ratio". The cap is on the long edge, so a
    // portrait picture is bounded by its height instead of its width.
    : height > width
      ? ["-resize", "0", String(MAX_STORED_EDGE)]
      : ["-resize", String(MAX_STORED_EDGE), "0"];
  await run("cwebp", ["-q", WEBP_QUALITY, ...resize, "-quiet", normalized, "-o", destination]);
  return destination;
}

async function dimensionsOf(file: string): Promise<{ width: number; height: number }> {
  const { stdout } = await run("sips", ["-g", "pixelWidth", "-g", "pixelHeight", file]);
  return {
    width: Number(/pixelWidth:\s*(\d+)/.exec(stdout)?.[1] ?? 0),
    height: Number(/pixelHeight:\s*(\d+)/.exec(stdout)?.[1] ?? 0),
  };
}

/**
 * Asks for something the script needs and was not given.
 *
 * Here so that the owner's password never has to be typed on a command line,
 * where it would be written to the shell history and sit there in clear. The
 * environment variables still work — a second run, or a machine with no
 * terminal, needs them — but nobody has to use them to get through this once.
 */
async function ask(question: string, hidden: boolean): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  // The prompt is written by `question` itself, so the echo is silenced only
  // afterwards: that hides the keystrokes without hiding what is being asked.
  const pending = rl.question(question);
  if (hidden) (rl as unknown as { _writeToOutput: (text: string) => void })._writeToOutput = () => {};
  const answer = await pending;
  rl.close();
  if (hidden) process.stdout.write("\n");
  return answer.trim();
}

/** Signs in and returns the session cookie, which every later call carries. */
async function signIn(baseUrl: string, email: string, password: string): Promise<string> {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!response.ok) {
    const detail = (await response.json().catch(() => ({}))) as { error?: string };
    fail(`Could not sign in: ${detail.error ?? `the site answered ${response.status}`}`);
  }
  const cookie = response.headers.getSetCookie().find((entry) => entry.startsWith("p62_staff_session="));
  if (!cookie) fail("Signed in, but the site sent no session cookie.");
  return cookie.split(";")[0];
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const overrides = new Map<string, string>();
  let baseUrl = "http://localhost:3000";
  const positional: string[] = [];
  for (let index = 0; index < args.length; index++) {
    if (args[index] === "--apply") continue;
    if (args[index] === "--base-url") {
      baseUrl = args[++index] ?? baseUrl;
      continue;
    }
    if (args[index] === "--map") {
      const [name, id] = (args[++index] ?? "").split("=");
      if (!name || !id) fail(`--map wants "File Name=product-id".`);
      overrides.set(normalize(name.replace(/\.[^.]+$/, "")), id);
      continue;
    }
    positional.push(args[index]);
  }
  baseUrl = baseUrl.replace(/\/$/, "");
  const folder = positional[0];

  if (!folder) fail("Give me the folder of pictures: scripts/import-product-images.ts ./PICTURES");
  // Only the run that writes needs to sign in. A dry run reads the public menu
  // and works on local files, so it should not ask for the owner's password to
  // show what it would do.
  let email = process.env.PIZZA62_EMAIL ?? "";
  let password = process.env.PIZZA62_PASSWORD ?? "";
  if (apply && (!email || !password) && !process.stdin.isTTY) {
    fail("Set PIZZA62_EMAIL and PIZZA62_PASSWORD, or run this where it can ask you.");
  }

  for (const tool of ["sips", "cwebp"]) {
    await run("which", [tool]).catch(() => fail(`\`${tool}\` is not installed. \`brew install webp\` provides cwebp.`));
  }

  const catalogResponse = await fetch(`${baseUrl}/api/catalog`);
  if (!catalogResponse.ok) fail(`Could not read the menu from ${baseUrl} (${catalogResponse.status}).`);
  const catalog = (await catalogResponse.json()) as { products: Product[]; categories: Category[] };

  const files = await walk(path.resolve(folder));
  if (files.length === 0) fail(`No pictures in ${folder}.`);

  const workDir = await mkdtemp(path.join(tmpdir(), "pizza62-images-"));
  const plans: Plan[] = [];
  const unresolved: { file: Found; ambiguous?: Product[] }[] = [];
  const claimed = new Map<string, string>();
  try {
    for (const file of files) {
      const { product, how, ambiguous } = resolve(file, catalog.products, catalog.categories, overrides);
      if (!product || !how) {
        unresolved.push({ file, ambiguous });
        continue;
      }
      // Two files for one product would upload twice and leave whichever
      // finished last, silently. Better to say so.
      const already = claimed.get(product.id);
      if (already) fail(`Both ${already} and ${file.label} resolve to ${product.name}. Rename one, or use --map.`);
      claimed.set(product.id, file.label);

      const optimized = await optimize(file.absolute, workDir, product.id);
      const bytes = (await readFile(file.absolute)).byteLength;
      const optimizedBytes = (await readFile(optimized)).byteLength;
      if (optimizedBytes > MAX_UPLOAD_BYTES) fail(`${file.label} is still ${optimizedBytes} bytes after optimizing.`);
      plans.push({ file, product, how, bytes, optimizedBytes, optimized });
    }

    const totalBefore = plans.reduce((sum, plan) => sum + plan.bytes, 0);
    const totalAfter = plans.reduce((sum, plan) => sum + plan.optimizedBytes, 0);
    console.log(`\n  ${plans.length} of ${files.length} picture(s) resolved on ${baseUrl}:\n`);
    for (const plan of plans) {
      const saved = Math.round((1 - plan.optimizedBytes / plan.bytes) * 100);
      const replacing = plan.product.image_url ? "  ← replaces its current photo" : "";
      console.log(
        `    ${plan.file.label.padEnd(34)} → ${plan.product.name.padEnd(22)} ` +
        `${(plan.bytes / 1024 / 1024).toFixed(2)} MB → ${String(Math.round(plan.optimizedBytes / 1024)).padStart(4)} KB ` +
        `(−${saved}%)  [${plan.how}]${replacing}`,
      );
    }
    if (plans.length) {
      console.log(
        `\n    ${(totalBefore / 1024 / 1024).toFixed(1)} MB of photographs becomes ` +
        `${(totalAfter / 1024 / 1024).toFixed(1)} MB served.`,
      );
    }

    if (unresolved.length) {
      console.log(`\n  ${unresolved.length} picture(s) NOT resolved — nothing will be done with these:\n`);
      for (const { file, ambiguous } of unresolved) {
        const why = ambiguous?.length
          ? `could be ${ambiguous.map((product) => product.id).join(" or ")}`
          : "matched no product";
        console.log(`    ${file.label.padEnd(34)} ${why}`);
      }
      console.log(`\n  Rename them after the dish, or pass --map "Name=product-id". The menu has:\n`);
      const byCategory = new Map<string, Product[]>();
      for (const product of catalog.products) {
        byCategory.set(product.category_id, [...(byCategory.get(product.category_id) ?? []), product]);
      }
      for (const category of catalog.categories) {
        const inCategory = byCategory.get(category.id) ?? [];
        if (!inCategory.length) continue;
        console.log(`    ${category.name}`);
        for (const product of inCategory) console.log(`      ${product.id.padEnd(32)} ${product.name}`);
      }
    }

    if (!apply) {
      console.log(`\n  Nothing was uploaded. Re-run with --apply once the list above is right.\n`);
      return;
    }

    // Asked for now rather than at startup, so a mapping that turns out to be
    // wrong is found before anyone has typed a password for it.
    if (!email) email = await ask("\n  Owner email: ", false);
    if (!password) password = await ask("  Password (not shown, not saved): ", true);
    const cookie = await signIn(baseUrl, email, password);
    console.log("");
    for (const plan of plans) {
      const form = new FormData();
      form.set("file", new File([await readFile(plan.optimized)], `${plan.product.id}.webp`, { type: "image/webp" }));
      const uploaded = await fetch(`${baseUrl}/api/uploads`, { method: "POST", headers: { cookie }, body: form });
      const uploadBody = await uploaded.text();
      let url: string | undefined;
      try {
        url = (JSON.parse(uploadBody) as { url?: string }).url;
      } catch {
        // Same lesson as the editor: a refusal in front of the route is not JSON.
      }
      if (!uploaded.ok || !url) fail(`Uploading ${plan.file.label} failed (${uploaded.status}): ${uploadBody.slice(0, 200)}`);

      const linked = await fetch(`${baseUrl}/api/admin/config`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ action: "product.update", productId: plan.product.id, imageUrl: url }),
      });
      if (!linked.ok) fail(`Linking ${plan.file.label} to ${plan.product.name} failed (${linked.status}).`);
      console.log(`    ✓ ${plan.product.name.padEnd(22)} ${url}`);
    }
    console.log(`\n  ${plans.length} photo(s) live.\n`);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

await main();
