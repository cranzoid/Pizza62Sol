#!/usr/bin/env node
/** Workspace tools only. No network unless --plan or --apply-tools-only is supplied.
 * No agent, branch, draft, publish, phone, or Pizza 62 backend API is accessible.
 * Usage: node scripts/elevenlabs-voice-tools.mjs --preview            (offline: print the reviewed manifest)
 *        node scripts/elevenlabs-voice-tools.mjs --write-review       (offline: regenerate the manifest from the code)
 *        node scripts/elevenlabs-voice-tools.mjs --plan               (read-only: list what would be created/updated)
 *        node scripts/elevenlabs-voice-tools.mjs --apply-tools-only   (after approval: create and update workspace tools)
 */
import { createHash } from 'node:crypto';
import { readFile, mkdir, mkdtemp, writeFile, open, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const AGENT_ID = 'agent_8801m53jzznme7ms8vhygeg4ggvh';
export const BRANCH_ID = 'agtbrch_9701m53k01mbea0acens2x8pma6x';
export const STATUS_ID = 'tool_2401m53vwa7tfj2vrjdgkwymf9m3';
export const SECRET_ID = '5OcBS12S6S6HJ5LeaMo8';
export const BASE = 'https://pizza62.ca';
/**
 * The per-call session secret, as a reference to the secret dynamic variable.
 * The literal template string "{{secret__voice_session}}" is sent unexpanded
 * and opens nothing (tests/voice-parity.test.ts), so it is never generated and
 * an existing tool still carrying it is planned for an in-place update.
 */
export const SESSION_HEADER = Object.freeze({ variable_name: 'secret__voice_session' });
const MANIFEST = join(ROOT, 'docs/elevenlabs-voice-tools.generated.json');
const SOURCES = ['docs/ELEVENLABS-VOICE-TOOLS.md', 'lib/voice/tools.ts', 'lib/voice/cart.ts', 'lib/voice/schedule.ts', 'app/api/voice/tools/[tool]/route.ts'];
export const NAMES = [
  'get_store_status', 'get_business_info', 'search_menu', 'get_menu_item', 'get_deals', 'get_cart', 'start_order', 'reset_order',
  'add_item', 'update_item', 'remove_item', 'set_fulfilment', 'set_customer', 'check_delivery_address',
  'get_order_slots', 'set_schedule', 'apply_coupon', 'remove_coupon', 'set_tip',
  'review_order', 'confirm_order', 'place_order',
];

const str = description => ({ type: 'string', description });
const integer = description => ({ type: 'integer', description });
const obj = (properties = {}, required = []) => ({ type: 'object', properties, required });
const arr = (items, description) => ({ type: 'array', description, items });
const fulfilment = () => ({ ...str('Pickup or delivery. Delivery by phone is accepted only when enabled by the restaurant.'), enum: ['pickup', 'delivery'] });
const placement = () => ({ ...str('Whole pizza, left half or right half. Omit for whole.'), enum: ['whole', 'left', 'right'] });
const id = what => str(`${what} returned by search_menu or get_menu_item. Use the exact ID; do not invent it. At most 80 characters; lowercase letters, digits and hyphens, beginning with a letter or digit.`);
const expectedVersion = () => integer('Optional nonnegative safe integer cartVersion from the last response. Omit if unavailable; a stale version is refused with CART_CHANGED.');
const lineId = () => str('Exact lineId returned by add_item or get_cart, for example L1. Required; at most 20 characters.');
const cartVersion = () => integer('Required safe integer cartVersion returned by review_order, unchanged through confirm_order and place_order. Never guess a version.');
const day = () => str('The day the caller named: "today", "tomorrow", a weekday such as "friday", or a date as YYYY-MM-DD. At most 40 characters. Never convert it to a timestamp; the server works out the date in Hamilton time.');

// Reviewed against readLineChoices in lib/voice/cart.ts. Object-form modifier
// values cover both ordinary option values and topping values with placement.
function lineProperties() {
  return {
    productId: id('Product ID'),
    variationId: id('Size/variation ID; omit when no size selection is needed'),
    quantity: integer('Whole number from 1 to 100; defaults to 1 on add. The server also enforces the product-specific maximum.'),
    toppings: arr(obj({ toppingId: id('Topping ID'), placement: placement() }, ['toppingId']), 'At most 30 toppings. Specialty pizza additions only; recipe toppings are supplied by the server. On update, replaces the whole list; [] clears additions.'),
    omitToppings: arr(id('Recipe topping ID to omit'), 'At most 20 recipe topping IDs to leave off a specialty pizza. On update, replaces the whole list; [] clears omissions.'),
    extraCheese: { type: 'boolean', description: 'Older form of cheese "extra". Prefer cheese. Pizza only.' },
    cheese: { ...str('Pizza cheese, as get_menu_item lists it: none, light, regular or extra. Only for items whose get_menu_item pizza.cheese is not null. Extra is priced by the server as one topping; none and light cost nothing.'), enum: ['none', 'light', 'regular', 'extra'] },
    modifiers: arr(obj({
      id: str('Exact option section ID from get_menu_item; required, nonempty and at most 80 characters.'),
      values: arr(obj({ value: str('Exact option value or topping ID from get_menu_item; at most 80 characters.'), placement: placement() }, ['value']), 'At most 20 selected values for this section. Include placement for topping sections when needed.'),
    }, ['id', 'values']), 'At most 60 option sections. Include all required choices from get_menu_item. On update, replaces the whole modifier list; [] clears it.'),
    notes: str('Optional kitchen notes, at most 200 characters, such as "cut into squares". Never payment/card details, never extra items, never allergy promises, never prices. Cheese goes in cheese, not here. On update, an empty string clears notes.'),
    expectedCartVersion: expectedVersion(),
  };
}

export function buildSchemas() {
  return {
    get_store_status: obj(),
    get_business_info: obj(),
    search_menu: obj({ query: str("The caller's words for one item; required, nonempty, at most 200 characters."), fulfilment: fulfilment(), category: str('Optional menu category ID to narrow the search. Omit if unknown; never substitute a category display name. At most 80 characters; lowercase letters, digits and hyphens, beginning with a letter or digit.') }, ['query']),
    get_menu_item: obj({ productId: id('Product ID'), fulfilment: fulfilment() }, ['productId']),
    get_deals: obj({ fulfilment: fulfilment() }),
    get_cart: obj(),
    start_order: obj({ fulfilment: fulfilment() }),
    reset_order: obj(),
    add_item: obj(lineProperties(), ['productId']),
    update_item: obj({ lineId: lineId(), ...lineProperties() }, ['lineId']),
    remove_item: obj({ lineId: lineId(), expectedCartVersion: expectedVersion() }, ['lineId']),
    set_fulfilment: obj({ fulfilment: fulfilment(), expectedCartVersion: expectedVersion() }, ['fulfilment']),
    set_customer: obj({
      name: str("Caller's name; required, 2 to 100 characters."),
      phone: str('Callback number spoken by the caller, at most 30 characters before formatting is removed. At least 10 digits; normalized number at most 16 characters. Required unless useCallerId is true and the server has a presented caller number. Read it back.'),
      useCallerId: { type: 'boolean', description: 'True only if the caller explicitly agrees to use caller ID. Server accepts only a presented caller number; forwarded, withheld or unknown caller ID cannot be used. Read the number back.' },
      expectedCartVersion: expectedVersion(),
    }, ['name']),
    check_delivery_address: obj({
      line1: str('Required street number and name; nonempty, at most 160 characters.'),
      unit: str('Optional unit/apartment; at most 40 characters.'),
      city: str('Optional city; defaults to Hamilton. At most 80 characters.'),
      province: str('Optional province; defaults to ON. At most 2 characters.'),
      postalCode: str('Required postal code; nonempty, at most 10 characters.'),
      instructions: str('Optional delivery instructions for the driver, such as "call when you arrive"; at most 200 characters. To change them, call this again with the same address.'),
    }, ['line1', 'postalCode']),
    get_order_slots: obj({ fulfilment: fulfilment(), day: day() }),
    set_schedule: obj({
      when: { ...str('"asap" for as soon as possible, or "scheduled" for a later time the caller named.'), enum: ['asap', 'scheduled'] },
      day: day(),
      time: str('Required when scheduled: the local clock time the caller named, as 24-hour HH:MM (17:45 for 5:45 PM). At most 20 characters. Times are on a 15-minute grid; the server refuses others and offers the nearest.'),
      expectedCartVersion: expectedVersion(),
    }, ['when']),
    apply_coupon: obj({ code: str('The promo code exactly as the caller says or spells it; at most 40 characters. Never a discount amount and never a gift card.'), expectedCartVersion: expectedVersion() }, ['code']),
    remove_coupon: obj({ expectedCartVersion: expectedVersion() }),
    set_tip: obj({
      type: { ...str('none, percentage (one of the restaurant\'s preset percentages) or custom (a dollar amount the caller names).'), enum: ['none', 'percentage', 'custom'] },
      percent: integer('Whole-number percentage the caller asked for, when type is percentage; must be a preset such as 10, 15 or 18.'),
      amount: str('Dollar amount the caller named, when type is custom, such as "5" or "5.50". Never cents, never computed by you.'),
      expectedCartVersion: expectedVersion(),
    }, ['type']),
    review_order: obj(),
    confirm_order: obj({ cartVersion: cartVersion(), utterance: str("Caller's explicit confirmation words, at most 300 characters. Only call after a clear yes to the complete review_order read-back.") }, ['cartVersion']),
    place_order: obj({ cartVersion: cartVersion() }, ['cartVersion']),
  };
}

export async function generateManifest() {
  const docs = await readFile(join(ROOT, SOURCES[0]), 'utf8');
  const descriptions = {};
  const blocks = docs.split(/^### 5\.\d+ /m).slice(1);
  for (const block of blocks) {
    const title = block.split('\n')[0];
    for (const name of NAMES) {
      if (!title.includes('`' + name + '`')) continue;
      const specific = block.match(new RegExp('\\*\\*Description for the LLM \\(`' + name + '`\\):\\*\\* ([^\\n]+)'));
      const generic = block.match(/\*\*Description for the LLM:\*\* ([^\n]+)/);
      const text = specific?.[1] ?? generic?.[1];
      if (text) descriptions[name] = text;
    }
  }
  const schemas = buildSchemas();
  const sourceSha256 = Object.fromEntries(await Promise.all(SOURCES.map(async file => [file, createHash('sha256').update(await readFile(join(ROOT, file))).digest('hex')])));
  const tools = NAMES.map(name => {
    if (!descriptions[name]) throw new Error(`Missing documented description: ${name}`);
    return { tool_config: {
      type: 'webhook', name, description: descriptions[name],
      api_schema: {
        url: `${BASE}/api/voice/tools/${name}`, method: 'POST',
        request_headers: {
          Authorization: { secret_id: SECRET_ID },
          'X-Voice-Session': { ...SESSION_HEADER },
          'Content-Type': 'application/json',
        },
        request_body_schema: schemas[name],
      },
    } };
  });
  return { agentId: AGENT_ID, branchId: BRANCH_ID, existingGetStoreStatusId: STATUS_ID, sourceSha256, tools };
}

export async function loadReviewedManifest() {
  const reviewed = JSON.parse(await readFile(MANIFEST, 'utf8'));
  const current = await generateManifest();
  if (!isDeepStrictEqual(reviewed, current)) throw new Error('Reviewed manifest or backend contract changed. Regenerate and review locally before applying. No API requests made.');
  return reviewed;
}

// Compare wire contracts, ignoring harmless provider defaults. Descriptions are
// compared separately: they are what the model reads, so a stale one is a change.
function wireSchema(schema) {
  if (!schema || typeof schema !== 'object') return schema;
  const result = { type: schema.type };
  if (schema.enum) result.enum = [...schema.enum].sort();
  if (schema.type === 'object') {
    result.required = [...(schema.required ?? [])].sort();
    result.properties = Object.fromEntries(Object.entries(schema.properties ?? {}).map(([key, value]) => [key, wireSchema(value)]));
  }
  if (schema.type === 'array') result.items = wireSchema(schema.items);
  for (const key of ['constant_value', 'dynamic_variable', 'is_system_provided', 'is_omitted', 'allowed_values']) {
    // Dashboard-created tools serialize an unset dynamic variable as "".
    // It is equivalent to omission; an actual nonempty variable still differs.
    if (key === 'dynamic_variable' && schema[key] === '') continue;
    // Literal responses also include constant_value:"" for LLM-supplied
    // parameters. A populated description identifies that value source.
    if (key === 'constant_value' && schema[key] === '' && typeof schema.description === 'string' && schema.description.length > 0) continue;
    if (schema[key] !== undefined && schema[key] !== null && schema[key] !== false) result[key] = schema[key];
  }
  return result;
}

function descriptionsOf(schema, path = '') {
  if (!schema || typeof schema !== 'object') return {};
  const own = typeof schema.description === 'string' && schema.description ? { [path || '.']: schema.description } : {};
  const nested = Object.entries(schema.properties ?? {}).flatMap(([key, value]) => Object.entries(descriptionsOf(value, `${path}.${key}`)));
  const items = schema.items ? Object.entries(descriptionsOf(schema.items, `${path}[]`)) : [];
  return { ...own, ...Object.fromEntries([...nested, ...items]) };
}

/**
 * What differs between a tool in the workspace and the reviewed one, or [].
 *
 * Anything that is not ours to correct in place — another URL, another method,
 * another type, query or path parameters — is a hard conflict: the tool is not
 * the one this script manages, and it refuses rather than overwrite it.
 */
export function contractDiff(existing, wanted) {
  const actual = existing.tool_config;
  const expected = wanted.tool_config;
  const api = actual?.api_schema;
  if (actual?.type !== 'webhook' || actual.name !== expected.name || api?.method !== 'POST' || api.url !== expected.api_schema.url ||
      (api.content_type && api.content_type !== 'application/json') ||
      Object.keys(api.path_params_schema ?? {}).length || Object.keys(api.query_params_schema?.properties ?? {}).length || (api.query_params_schema?.required ?? []).length) {
    throw new Error(`Existing tool ${expected.name} (${existing.id}) has a different webhook contract. Refusing to replace it or create a duplicate.`);
  }
  const headers = Object.fromEntries(Object.entries(api.request_headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]));
  const differences = [];
  if (!isDeepStrictEqual(headers.authorization, { secret_id: SECRET_ID })) differences.push('Authorization header');
  if (!isDeepStrictEqual(headers['x-voice-session'], SESSION_HEADER)) differences.push('X-Voice-Session header');
  if (headers['content-type'] && headers['content-type'] !== 'application/json') differences.push('Content-Type header');
  if (!isDeepStrictEqual(wireSchema(api.request_body_schema), wireSchema(expected.api_schema.request_body_schema))) differences.push('request body schema');
  if (actual.description !== expected.description) differences.push('tool description');
  if (!isDeepStrictEqual(descriptionsOf(api.request_body_schema), descriptionsOf(expected.api_schema.request_body_schema))) differences.push('parameter descriptions');
  return differences;
}

/** Verification after a write: the persisted tool must now be exactly the reviewed one. */
export function verifyTool(existing, wanted) {
  const differences = contractDiff(existing, wanted);
  if (differences.length) throw new Error(`Tool ${wanted.tool_config.name} (${existing.id}) still differs after writing: ${differences.join(', ')}.`);
}

export function createApi(apiKey, fetchImpl = fetch, audit = async () => {}) {
  if (!apiKey?.trim()) throw new Error('Set ELEVENLABS_API_KEY in the environment; its value is never printed.');
  return async (method, path, body) => {
    // Strict workspace-tools allowlist. Even GET /agents is prohibited.
    const toolPath = /^\/tools\/tool_[A-Za-z0-9_-]+$/.test(path);
    const allowed = (method === 'GET' && (/^\/tools\?page_size=100(?:&cursor=[^&]+)?$/.test(path) || toolPath)) ||
      (method === 'POST' && path === '/tools') || (method === 'PATCH' && toolPath);
    if (!allowed || !path.startsWith('/') || path.startsWith('//')) throw new Error('Disallowed API operation.');
    let response;
    try {
      response = await fetchImpl(`https://api.elevenlabs.io/v1/convai${path}`, {
        method, redirect: 'error', signal: AbortSignal.timeout(30_000),
        headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new Error(`${method} ${path}: network error/timeout. No automatic write retry; list existing tools on the next run.`);
    }
    await audit({ method, path, status: response.status });
    const raw = await response.text();
    let data;
    try { data = raw ? JSON.parse(raw) : null; } catch { throw new Error(`${method} ${path}: non-JSON response (HTTP ${response.status}).`); }
    if (!response.ok) {
      const detail = JSON.stringify(data?.detail ?? data).split(apiKey).join('[REDACTED]').slice(0, 6000);
      throw new Error(`${method} ${path}: HTTP ${response.status}${response.status === 422 ? ' API VALIDATION ERROR' : ''}: ${detail}`);
    }
    return data;
  };
}

export async function listTools(api) {
  const tools = new Map();
  const seen = new Set();
  let cursor;
  do {
    const query = new URLSearchParams({ page_size: '100' });
    if (cursor) query.set('cursor', cursor);
    const page = await api('GET', `/tools?${query}`);
    if (!Array.isArray(page?.tools) || typeof page.has_more !== 'boolean') throw new Error('Unexpected tool list response; cannot safely check duplicates.');
    for (const tool of page.tools) {
      if (typeof tool.id !== 'string' || !tool.id || typeof tool.tool_config?.name !== 'string') throw new Error('Incomplete tool list response.');
      tools.set(tool.id, tool);
    }
    if (!page.has_more) break;
    cursor = page.next_cursor;
    if (typeof cursor !== 'string' || !cursor || seen.has(cursor)) throw new Error('Invalid or repeated tools pagination cursor.');
    seen.add(cursor);
  } while (true);
  return [...tools.values()];
}

/**
 * Reads the workspace and decides, per tool, `unchanged`, `update` (in place,
 * keeping its ID and any agent attachment) or `create`. Read-only.
 */
export async function planWorkspaceTools(manifest, api, { save = async () => {} } = {}) {
  const all = await listTools(api);
  await save('tools-before.json', all);
  const plan = [];
  for (const wanted of manifest.tools) {
    const name = wanted.tool_config.name;
    const matches = all.filter(tool => tool.tool_config.name === name);
    if (matches.length > 1) throw new Error(`Multiple existing tools named ${name}: ${matches.map(t => t.id).join(', ')}. Resolve ambiguity before running.`);
    if (!matches.length) { plan.push({ name, id: null, action: 'create', differences: [] }); continue; }
    if (name === 'get_store_status' && matches[0].id !== STATUS_ID) throw new Error(`get_store_status is ${matches[0].id}, not the known ${STATUS_ID}. Resolve before running.`);
    const existing = await api('GET', `/tools/${encodeURIComponent(matches[0].id)}`);
    if (existing?.id !== matches[0].id) throw new Error(`Tool lookup ID mismatch: ${name}`);
    await save(`${name}.json`, existing);
    const differences = contractDiff(existing, wanted);
    plan.push({ name, id: existing.id, action: differences.length ? 'update' : 'unchanged', differences });
  }
  await save('plan.json', plan);
  return plan;
}

export async function applyWorkspaceTools(manifest, api, { save = async () => {}, log = console.log } = {}) {
  const plan = await planWorkspaceTools(manifest, api, { save });
  const results = [];
  for (const step of plan) {
    const wanted = manifest.tools.find(tool => tool.tool_config.name === step.name);
    if (step.action === 'unchanged') { results.push({ name: step.name, id: step.id, disposition: 'reused' }); continue; }
    let id = step.id;
    if (step.action === 'create') {
      // Recheck the name immediately before the write. No automatic write retries.
      const fresh = (await listTools(api)).filter(tool => tool.tool_config.name === step.name);
      if (fresh.length) throw new Error(`${step.name} appeared while planning; rerun the plan. No duplicate created.`);
      const created = await api('POST', '/tools', wanted);
      if (typeof created?.id !== 'string' || !/^tool_[A-Za-z0-9_-]+$/.test(created.id)) throw new Error(`Invalid tool ID for ${step.name}. Rerun the plan; do not blindly retry creation.`);
      await save(`${step.name}-response.json`, created);
      // The creation response itself is checked before anything else is written.
      verifyTool(created, wanted);
      id = created.id;
    } else {
      // In place: the ID, and so the agent's attachment to it, is kept.
      const updated = await api('PATCH', `/tools/${encodeURIComponent(id)}`, wanted);
      await save(`${step.name}-response.json`, updated);
    }
    const persisted = await api('GET', `/tools/${encodeURIComponent(id)}`);
    if (persisted?.id !== id) throw new Error(`Tool ID lookup mismatch after writing ${step.name}.`);
    verifyTool(persisted, wanted);
    await save(`${step.name}.json`, persisted);
    results.push({ name: step.name, id, disposition: step.action === 'create' ? 'created' : 'updated' });
    await save('tool-results.json', results);
    log(`${step.name} -> ${id} (${step.action === 'create' ? 'created' : `updated: ${step.differences.join(', ')}`})`);
  }
  // Every reviewed tool, once more, after all writes.
  const finalList = await listTools(api);
  for (const result of results) {
    const matches = finalList.filter(tool => tool.tool_config.name === result.name);
    if (matches.length !== 1 || matches[0].id !== result.id) throw new Error(`Final duplicate/ID check failed for ${result.name}.`);
    verifyTool(await api('GET', `/tools/${encodeURIComponent(result.id)}`), manifest.tools.find(tool => tool.tool_config.name === result.name));
  }
  await save('tool-results.json', results);
  log('Validated workspace tools:');
  for (const result of results) log(`${result.name} -> ${result.id} (${result.disposition})`);
  log('No agent, branch, draft, publication, telephony or Pizza 62 configuration operation was performed.');
  log('New tools are not attached to the agent; attach them in the agent draft separately.');
  return results;
}

async function main() {
  const args = process.argv.slice(2);
  const mode = args.length === 0 ? '--preview' : args[0];
  if (args.length > 1 || !['--preview', '--write-review', '--plan', '--apply-tools-only'].includes(mode)) throw new Error('Usage: node scripts/elevenlabs-voice-tools.mjs [--preview|--write-review|--plan|--apply-tools-only]');
  if (mode === '--write-review') {
    await writeFile(MANIFEST, JSON.stringify(await generateManifest(), null, 2) + '\n');
    console.log('Wrote local review manifest; no network requests.');
    return;
  }
  const manifest = await loadReviewedManifest();
  if (mode === '--preview') { console.log(JSON.stringify(manifest, null, 2)); return; }
  if (!process.env.ELEVENLABS_API_KEY?.trim()) throw new Error('Set ELEVENLABS_API_KEY in the environment; its value is never printed.');
  const work = join(ROOT, 'work/elevenlabs-voice-setup');
  await mkdir(work, { recursive: true, mode: 0o700 });
  const lockPath = join(work, 'setup.lock');
  let lock;
  try { lock = await open(lockPath, 'wx', 0o600); }
  catch { throw new Error(`Setup lock exists: ${lockPath}. Ensure no setup is running before removing a stale lock.`); }
  try {
    const run = await mkdtemp(join(work, 'run-'));
    console.error(`Private local snapshots: ${run}`);
    const save = (name, value) => writeFile(join(run, name), JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
    const requests = [];
    const api = createApi(process.env.ELEVENLABS_API_KEY, fetch, async entry => {
      requests.push(entry);
      await save('api-requests.json', requests);
    });
    if (mode === '--plan') {
      // Read-only: GET requests only, whatever the plan says.
      const readOnly = (method, path, body) => method === 'GET' ? api(method, path, body) : Promise.reject(new Error('Disallowed API operation.'));
      for (const step of await planWorkspaceTools(manifest, readOnly, { save })) {
        console.log(`${step.name}: ${step.action}${step.id ? ` (${step.id})` : ''}${step.differences.length ? ` — ${step.differences.join(', ')}` : ''}`);
      }
      return;
    }
    await applyWorkspaceTools(manifest, api, { save });
  } finally { await lock.close(); await unlink(lockPath); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(`Setup stopped: ${error.message}`); process.exitCode = 1; });
}
