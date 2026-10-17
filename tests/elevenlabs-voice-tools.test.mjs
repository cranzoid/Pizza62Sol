import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';
import {
  AGENT_ID, BRANCH_ID, STATUS_ID, SECRET_ID, BASE, ROOT, NAMES, SESSION_HEADER,
  generateManifest, loadReviewedManifest, buildSchemas, contractDiff,
  createApi, applyWorkspaceTools, planWorkspaceTools, listTools,
} from '../scripts/elevenlabs-voice-tools.mjs';
import { assertOnlyFields, ToolInputError } from '../lib/voice/cart.ts';

const manifest = await loadReviewedManifest();
const LEGACY = new Set(['get_store_status', 'search_menu', 'get_menu_item', 'get_deals', 'get_cart', 'start_order', 'reset_order', 'add_item', 'update_item', 'remove_item', 'set_fulfilment', 'set_customer', 'check_delivery_address', 'review_order', 'confirm_order', 'place_order']);
const idFor = name => (name === 'get_store_status' ? STATUS_ID : `tool_existing_${name}`);
/** The workspace exactly as reviewed. */
const currentTools = () => manifest.tools.map(tool => ({ id: idFor(tool.tool_config.name), ...structuredClone(tool) }));
/** The workspace as the first setup left it: 16 tools, the session header as a template string. */
const legacyTools = () => currentTools().filter(tool => LEGACY.has(tool.tool_config.name)).map(tool => {
  tool.tool_config.api_schema.request_headers['X-Voice-Session'] = '{{secret__voice_session}}';
  delete tool.tool_config.api_schema.request_body_schema.properties.cheese;
  return tool;
});

function fakeApi({ tools = currentTools(), invalidCreation = false, rejectCreation = false } = {}) {
  const calls = [], saved = new Map(), output = [];
  const api = async (method, path, body) => {
    calls.push({ method, path, body: structuredClone(body) });
    if (method === 'GET' && path.startsWith('/tools?')) return { tools: structuredClone(tools), has_more: false, next_cursor: null };
    if (method === 'GET' && path.startsWith('/tools/')) return structuredClone(tools.find(t => t.id === decodeURIComponent(path.slice('/tools/'.length))));
    if (method === 'POST' && path === '/tools') {
      if (rejectCreation) throw new Error('HTTP 422 API VALIDATION ERROR');
      const created = { id: `tool_created_${tools.length}`, ...structuredClone(body) };
      tools.push(created);
      return invalidCreation ? { id: created.id } : created;
    }
    if (method === 'PATCH' && path.startsWith('/tools/')) {
      const target = tools.find(t => t.id === decodeURIComponent(path.slice('/tools/'.length)));
      target.tool_config = structuredClone(body.tool_config);
      return structuredClone(target);
    }
    throw new Error(`Non-workspace API operation ${method} ${path}`);
  };
  return { api, calls, saved, output, options: { save: async (name, data) => saved.set(name, structuredClone(data)), log: value => output.push(value) } };
}
const writes = calls => calls.filter(c => c.method !== 'GET');

test('review manifest is deterministic, covers every backend tool field exactly, and uses the session variable reference', async () => {
  assert.deepEqual(await generateManifest(), manifest);
  const toolsSource = ts.createSourceFile('tools.ts', await readFile(`${ROOT}/lib/voice/tools.ts`, 'utf8'), ts.ScriptTarget.Latest, true);
  const cartSource = ts.createSourceFile('cart.ts', await readFile(`${ROOT}/lib/voice/cart.ts`, 'utf8'), ts.ScriptTarget.Latest, true);
  function initializer(source, name) {
    for (const statement of source.statements) {
      if (!ts.isVariableStatement(statement)) continue;
      for (const declaration of statement.declarationList.declarations) if (declaration.name.getText(source) === name) return declaration.initializer;
    }
    throw new Error(`Missing ${name}`);
  }
  const lineFields = initializer(cartSource, 'LINE_FIELDS').expression.elements.map(node => node.text);
  const registry = initializer(toolsSource, 'TOOLS');
  const schemas = buildSchemas();
  const registered = registry.properties.map(entry => entry.name.text);
  assert.deepEqual([...registered].sort(), [...NAMES].sort(), 'every backend tool has a reviewed contract, and nothing else does');
  for (const entry of registry.properties) {
    const fields = entry.initializer.properties.find(p => p.name.text === 'fields').initializer.elements.flatMap(node => ts.isSpreadElement(node) ? lineFields : [node.text]);
    assert.deepEqual(Object.keys(schemas[entry.name.text].properties).sort(), fields.sort(), entry.name.text);
  }
  const allowedKeys = new Set(['type', 'description', 'properties', 'required', 'items', 'enum']);
  function checkSchema(schema) {
    for (const key of Object.keys(schema)) assert.ok(allowedKeys.has(key), `Unsupported schema keyword ${key}`);
    for (const required of schema.required ?? []) assert.ok(Object.hasOwn(schema.properties, required));
    for (const value of Object.values(schema.properties ?? {})) checkSchema(value);
    if (schema.items) checkSchema(schema.items);
  }
  const money = /price|subtotal|total|tax|fee|discount|cents|giftcard|token|card|channel|policy|staff|idempotency|scheduledfor/i;
  for (const { tool_config: tool } of manifest.tools) {
    assert.equal(tool.api_schema.url, `${BASE}/api/voice/tools/${tool.name}`);
    assert.equal(tool.api_schema.method, 'POST');
    assert.deepEqual(tool.api_schema.request_headers.Authorization, { secret_id: SECRET_ID });
    assert.deepEqual(tool.api_schema.request_headers['X-Voice-Session'], { variable_name: 'secret__voice_session' });
    assert.ok(!JSON.stringify(tool).includes('{{secret__voice_session}}'), 'never the unexpanded template');
    assert.ok(!Object.hasOwn(tool.api_schema, 'query_params_schema'));
    assert.ok(!Object.hasOwn(tool.api_schema, 'path_params_schema'));
    checkSchema(tool.api_schema.request_body_schema);
    for (const field of Object.keys(tool.api_schema.request_body_schema.properties)) assert.doesNotMatch(field, money, `${tool.name}.${field} looks server-controlled`);
  }
  assert.deepEqual(Object.keys(schemas), NAMES);
  assert.equal(NAMES.length, 22);
  assert.deepEqual(schemas.start_order.required, []);
  assert.deepEqual(schemas.set_customer.required, ['name']);
  assert.deepEqual(schemas.update_item.required, ['lineId']);
  assert.deepEqual(schemas.set_schedule.required, ['when']);
  assert.deepEqual(schemas.apply_coupon.required, ['code']);
  assert.deepEqual(schemas.set_tip.properties.type.enum, ['none', 'percentage', 'custom']);
  assert.deepEqual(schemas.add_item.properties.cheese.enum, ['none', 'light', 'regular', 'extra']);
  assert.equal(schemas.add_item.properties.quantity.type, 'integer');
});

test('actual validator accepts empty objects and rejects dummy fields for zero-argument tools', () => {
  for (const name of ['get_store_status', 'get_business_info', 'get_cart', 'reset_order', 'review_order']) {
    assert.deepEqual(buildSchemas()[name], { type: 'object', properties: {}, required: [] });
    assert.deepEqual(assertOnlyFields({}, []), {});
    assert.throws(() => assertOnlyFields({ dummy: '' }, []), error => error instanceof ToolInputError && error.issues[0].code === 'UNKNOWN_FIELD');
  }
});

test('a workspace that already matches is left alone: no writes, no agent request', async () => {
  const mock = fakeApi();
  const result = await applyWorkspaceTools(manifest, mock.api, mock.options);
  assert.equal(result.length, 22);
  assert.ok(result.every(tool => tool.disposition === 'reused'));
  assert.equal(writes(mock.calls).length, 0);
  assert.ok(mock.calls.every(c => c.path.startsWith('/tools')));
});

test('from the first setup: 16 tools updated in place (IDs kept) and 6 new tools created', async () => {
  const mock = fakeApi({ tools: legacyTools() });
  const plan = await planWorkspaceTools(manifest, mock.api, mock.options);
  assert.equal(writes(mock.calls).length, 0, 'planning is read-only');
  assert.deepEqual(plan.filter(step => step.action === 'create').map(step => step.name), ['get_business_info', 'get_order_slots', 'set_schedule', 'apply_coupon', 'remove_coupon', 'set_tip']);
  assert.ok(plan.filter(step => step.action === 'update').every(step => step.differences.includes('X-Voice-Session header')));
  assert.ok(plan.find(step => step.name === 'add_item').differences.includes('request body schema'), 'add_item gains cheese');
  const result = await applyWorkspaceTools(manifest, mock.api, mock.options);
  assert.equal(result.filter(t => t.disposition === 'updated').length, 16);
  assert.equal(result.filter(t => t.disposition === 'created').length, 6);
  assert.deepEqual(writes(mock.calls).filter(c => c.method === 'PATCH').map(c => c.path).sort(), [...LEGACY].map(name => `/tools/${idFor(name)}`).sort());
  assert.equal(result.find(t => t.name === 'get_store_status').id, STATUS_ID, 'the agent keeps its attachment to the same tool ID');
  for (const name of LEGACY) assert.equal(result.find(t => t.name === name).id, idFor(name));
  const priorCount = mock.calls.length;
  const second = await applyWorkspaceTools(manifest, mock.api, mock.options);
  assert.ok(second.every(t => t.disposition === 'reused'));
  assert.equal(writes(mock.calls.slice(priorCount)).length, 0);
});

test('a stale description or parameter text is an update, not a conflict', async () => {
  const tools = currentTools();
  tools.find(t => t.tool_config.name === 'set_tip').tool_config.description = 'Suggest a 20% tip.';
  tools.find(t => t.tool_config.name === 'set_schedule').tool_config.api_schema.request_body_schema.properties.time.description = 'A unix timestamp.';
  const mock = fakeApi({ tools });
  const plan = await planWorkspaceTools(manifest, mock.api, mock.options);
  assert.deepEqual(plan.find(step => step.name === 'set_tip').differences, ['tool description']);
  assert.deepEqual(plan.find(step => step.name === 'set_schedule').differences, ['parameter descriptions']);
  await applyWorkspaceTools(manifest, mock.api, mock.options);
  assert.deepEqual(writes(mock.calls).map(c => c.method), ['PATCH', 'PATCH']);
});

test('provider empty dynamic_variable defaults are inactive, but real variables differ', () => {
  const [wanted] = manifest.tools;
  const existing = { id: STATUS_ID, ...structuredClone(wanted) };
  existing.tool_config.api_schema.request_body_schema = { ...existing.tool_config.api_schema.request_body_schema, dynamic_variable: '', is_omitted: false };
  assert.deepEqual(contractDiff(existing, wanted), []);
  existing.tool_config.api_schema.request_body_schema.dynamic_variable = 'real_variable';
  assert.deepEqual(contractDiff(existing, wanted), ['request body schema']);
});

test('LLM literal response empty constant default is inert; nonempty constants differ', () => {
  const wanted = manifest.tools.find(tool => tool.tool_config.name === 'search_menu');
  const existing = { id: 'tool_existing_search_menu', ...structuredClone(wanted) };
  existing.tool_config.api_schema.request_body_schema.properties.query.constant_value = '';
  assert.deepEqual(contractDiff(existing, wanted), []);
  existing.tool_config.api_schema.request_body_schema.properties.query.constant_value = 'forced query';
  assert.deepEqual(contractDiff(existing, wanted), ['request body schema']);
});

test('duplicate names, a foreign tool under our name, or a moved get_store_status fail before writes', async () => {
  const duplicate = currentTools();
  duplicate.push({ ...structuredClone(duplicate[2]), id: 'tool_duplicate_search' });
  const foreign = currentTools();
  foreign[2].tool_config.api_schema.url = 'https://other.example/search_menu';
  const moved = currentTools();
  moved[0].id = 'tool_someone_else';
  for (const [tools, error] of [[duplicate, /Multiple existing tools/], [foreign, /different webhook contract/], [moved, /not the known/]]) {
    const mock = fakeApi({ tools });
    await assert.rejects(applyWorkspaceTools(manifest, mock.api, mock.options), error);
    assert.equal(writes(mock.calls).length, 0);
  }
});

test('an incompatible creation response stops immediately without creating the next tool', async () => {
  const mock = fakeApi({ tools: currentTools().filter(t => t.tool_config.name !== 'get_business_info' && t.tool_config.name !== 'set_tip'), invalidCreation: true });
  await assert.rejects(applyWorkspaceTools(manifest, mock.api, mock.options), /different webhook contract|still differs after writing/);
  assert.equal(writes(mock.calls).length, 1);
});

test('an API validation failure stops immediately with no retries or agent calls', async () => {
  const mock = fakeApi({ tools: currentTools().filter(t => t.tool_config.name !== 'get_order_slots'), rejectCreation: true });
  await assert.rejects(applyWorkspaceTools(manifest, mock.api, mock.options), /API VALIDATION ERROR/);
  assert.equal(writes(mock.calls).length, 1);
  assert.ok(mock.calls.every(c => c.path.startsWith('/tools')));
});

test('tools pagination must exhaust all pages and rejects repeated cursors', async () => {
  const calls = [];
  const all = currentTools();
  const tools = await listTools(async (method, path) => {
    calls.push(path);
    return calls.length === 1 ? { tools: all.slice(0, 1), has_more: true, next_cursor: 'page2' } : { tools: all.slice(1), has_more: false };
  });
  assert.equal(tools.length, 22);
  assert.match(calls[1], /cursor=page2/);
  await assert.rejects(listTools(async () => ({ tools: [], has_more: true, next_cursor: 'repeat' })), /repeated tools pagination/);
});

test('API uses the environment key, redacts errors, allows only workspace tool reads/creates/updates, and forbids publishing', async () => {
  const key = 'fake-api-key-for-local-tests';
  let called = 0;
  const api = createApi(key, async (url, init) => {
    called += 1;
    assert.match(url, /^https:\/\/api\.elevenlabs\.io\/v1\/convai\/tools/);
    assert.equal(init.headers['xi-api-key'], key);
    assert.equal(init.redirect, 'error');
    return new Response(JSON.stringify({ detail: [{ loc: ['body', 'tool_config'], msg: `invalid ${key}` }] }), { status: 422 });
  });
  await assert.rejects(api('POST', '/tools', {}), error => {
    assert.match(error.message, /API VALIDATION ERROR/);
    assert.match(error.message, /tool_config/);
    assert.ok(!error.message.includes(key));
    return true;
  });
  await assert.rejects(api('PATCH', '/tools/tool_existing_add_item', {}), /API VALIDATION ERROR/, 'an in-place tool update is allowed');
  for (const [method, path] of [['PATCH', `/agents/${AGENT_ID}?branch_id=${BRANCH_ID}`], ['GET', `/agents/${AGENT_ID}`], ['GET', `/agents/${AGENT_ID}/branches`], ['POST', `/agents/${AGENT_ID}/drafts?branch_id=${BRANCH_ID}`], ['DELETE', `/agents/${AGENT_ID}/drafts`], ['POST', `/agents/${AGENT_ID}/deployments`], ['DELETE', '/tools/tool_existing_add_item'], ['PATCH', '/tools'], ['GET', '/tools/../agents']]) {
    await assert.rejects(api(method, path, {}), /Disallowed API operation/);
  }
  assert.equal(called, 2);
  assert.throws(() => createApi(''), /ELEVENLABS_API_KEY/);
  assert.deepEqual(SESSION_HEADER, { variable_name: 'secret__voice_session' });
});
