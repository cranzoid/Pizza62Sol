# Pizza 62 ElevenLabs local setup review

> **Superseded in part (website parity pass, 17 October 2026, later).** The script now manages 22 tools, generates the `X-Voice-Session` header as the dynamic-variable reference `{ "variable_name": "secret__voice_session" }` (the `{{secret__voice_session}}` template string below is sent unexpanded and opens nothing), and can update existing tools **in place** (`PATCH /v1/convai/tools/{id}`, IDs kept) as well as create missing ones. New modes: `--plan` (read-only) and `--apply-tools-only` (writes). Nothing has been run against the workspace since; see [VOICE-WEB-PARITY.md §11](VOICE-WEB-PARITY.md#11-rollout-checklist). The record below describes the first setup run.

Updated 17 October 2026 after the user approved **workspace tools only**.

All 15 remaining tools were created, and all 16 tool contracts were read back and
validated. get_store_status was reused. No agent, branch, draft, publication,
telephony or Pizza 62 backend API request was made. The temporary credential file
was removed after completion. The local inventory is in the Git-ignored
`work/elevenlabs-voice-setup/completed-result.json`.

The executable is [scripts/elevenlabs-voice-tools.mjs](../scripts/elevenlabs-voice-tools.mjs).
The complete, exact 15 create-tool request bodies, including every nested body schema,
are in [elevenlabs-voice-tools.generated.json](elevenlabs-voice-tools.generated.json).
Its `tools` array contains the bodies to send to `POST /v1/convai/tools`.

## Local commands

Requires Node 22 or later, with built-in fetch; no ElevenLabs SDK is required.

```sh
# Offline only; this is also the default with no arguments.
node scripts/elevenlabs-voice-tools.mjs --preview

# AFTER explicit approval, using an already populated environment variable:
node scripts/elevenlabs-voice-tools.mjs --apply-tools-only
```

The script reads `process.env.ELEVENLABS_API_KEY` only in apply-tools-only mode. It never prints
the key or loads an env file. The workspace Authorization secret reference is
`5OcBS12S6S6HJ5LeaMo8`; the existing secret must resolve to the full
`Bearer <VOICE_TOOL_SECRET>` header value, as for the working get_store_status tool.

## Scope and exact schema inventory

The reviewed schemas expose these backend fields. The generated JSON is the
authoritative wire representation; descriptions also record limits from the actual
validators. Optional values are omitted rather than filled with fabricated defaults.

| Tool | Required body fields | Optional body fields |
|---|---|---|
| search_menu | query | fulfilment, category |
| get_menu_item | productId | fulfilment |
| get_deals | none | fulfilment |
| get_cart | none | none |
| start_order | none | fulfilment |
| reset_order | none | none |
| add_item | productId | variationId, quantity, toppings, omitToppings, extraCheese, modifiers, notes, expectedCartVersion |
| update_item | lineId | productId, variationId, quantity, toppings, omitToppings, extraCheese, modifiers, notes, expectedCartVersion |
| remove_item | lineId | expectedCartVersion |
| set_fulfilment | fulfilment | expectedCartVersion |
| set_customer | name | phone, useCallerId, expectedCartVersion |
| check_delivery_address | line1, postalCode | unit, city, province, instructions |
| review_order | none | none |
| confirm_order | cartVersion | utterance |
| place_order | cartVersion | none |

For set_customer, the backend requires phone unless useCallerId is true AND a
presented caller number is available. That condition cannot be expressed by a
simple unconditional required list. The server continues to enforce it.

Each URL is `https://pizza62.ca/api/voice/tools/<tool_name>`, each method is POST,
and each has Authorization by workspace secret ID plus
`X-Voice-Session: {{secret__voice_session}}`. No query/path schemas are sent.

The three zero-argument schemas are exactly:

```json
{"type":"object","properties":{},"required":[]}
```

No dummy property is sent. The existing get_store_status tool is verified and
reused by its supplied ID; it is not recreated or modified.

## Approved execution scope: workspace tools only

The previous draft-attachment proposal is superseded by the user's instruction.
The executable now has no agent attachment or draft-writing code. Its API
allowlist permits only GET tool lists/details and POST /v1/convai/tools. All
agent, branch, draft, publication, deletion, existing-tool updates, telephony and
Pizza 62 backend requests are prohibited, including agent GET requests.

The existing dashboard draft was neither read nor changed. No tool IDs were
attached to the agent during this setup. That step awaits separate instructions.

## Compatibility findings

- Current ElevenLabs webhook API uses property maps and required-name arrays,
  with nested object/array schemas. It accepts `integer` in its published SDK
  schema; quantities and versions retain that type.
- Payloads use the documented subset: type, properties, required, items,
  description and string enum. They do not send `additionalProperties`, minimum,
  maximum, maxLength, minLength, maxItems, pattern, or conditional/union keywords.
  The SDK does not define those constraint fields, although it allows extra
  fields in its models. Their rejection has **not** been tested against your
  workspace; omission is a conservative compatibility choice, not a claim that
  every such keyword was rejected.
- Numeric ranges, safe-integer requirements, text/list limits, ID syntax and
  conditional requirements remain in descriptions and in unchanged backend
  validation. Backend top-level unknown-field rejection remains intact.
- Modifiers use the documented object form `{value, placement?}`, which the actual
  backend accepts. No union with the backend's alternative string form is needed.
- Nullable alternatives are not advertised. Optional fields may be omitted;
  empty strings clear notes and empty arrays clear topping/modifier choices.
- Zero-argument POST uses the empty-object schema the user verified through the
  API; dashboard minimum-property validation is bypassed by using that API.
- Agent PATCH is a publish operation. This workspace-only script does not make
  any agent or draft request.

All 15 create-tool requests returned HTTP 200. All 16 final tool contracts
passed persisted read-back validation. No request-body schema adjustment was
needed. The provider serializes inactive defaults as `dynamic_variable: ""` and,
for LLM literal parameters with populated descriptions, `constant_value: ""`.
Those response defaults initially caused overly strict comparison failures; the
comparison now handles them. Real nonempty variables/constants still fail a
contract mismatch. Creation payloads were unchanged.

No API validation error was encountered. Any such error stops execution with
HTTP status and field/message detail, without silent schema changes or retries.

## Reruns and safeguards

The script lists every tool page, matches exact names, GETs and checks existing
webhook contracts, and refuses ambiguous names or mismatched contracts. It never
updates shared existing tools. It rechecks names immediately before each missing
tool is created and reads each persisted tool back before final verification.

Use one operator at a time. The local lock prevents concurrent runs in this
checkout, but ElevenLabs provides no documented atomic create-if-name-absent or
conditional-write guarantee. Do not run another setup copy or edit the
dashboard during execution. Writes have no automatic retries. If a request times
out after the server may have created a tool, the next run lists tools again.

A rerun reuses compatible exact-name tools without updates or duplicate creation.
An interrupted run that created only some tools reuses them on the next run.
No agent or dashboard-draft state is checked or modified. No rollback deletes
shared tools. The response/request audit and persisted contracts remain local.

Apply output includes one `tool name -> tool ID` line for every Pizza 62 tool.
Private snapshots and fully populated request payloads go under Git-ignored
`work/elevenlabs-voice-setup/run-*` with restrictive permissions. No API key is
persisted. Existing configuration snapshots can contain private configuration,
so do not commit that directory.

## Local verification

```sh
node --check scripts/elevenlabs-voice-tools.mjs
node --test --experimental-strip-types --import ./tests/register.mjs tests/elevenlabs-voice-tools.test.mjs
npx eslint scripts/elevenlabs-voice-tools.mjs tests/elevenlabs-voice-tools.test.mjs
```

Eleven tests passed using local mocks. They cover actual registry field coverage,
real zero-argument validation, pagination, partial creation/reruns, duplicate names,
incompatible responses/contracts, response-default normalization, API error
redaction, and prohibiting all agent/draft/branch/publication requests.
Syntax checks and focused ESLint also passed. Production source and configuration
were unchanged. Only ElevenLabs workspace tools were created.

## Primary API references

- [Create tool](https://elevenlabs.io/docs/api-reference/tools/create)
- [List tools and pagination](https://elevenlabs.io/docs/api-reference/tools/list)
- [Webhook API schema](https://github.com/elevenlabs/elevenlabs-python/blob/main/src/elevenlabs/types/webhook_tool_api_schema_config_input.py)
- [Object schema](https://github.com/elevenlabs/elevenlabs-python/blob/main/src/elevenlabs/types/object_json_schema_property_input.py)
- [Literal types, including integer](https://github.com/elevenlabs/elevenlabs-python/blob/main/src/elevenlabs/types/literal_json_schema_property_type.py)
- [Get agent with branch_id](https://elevenlabs.io/docs/api-reference/agents/get)
- [Update agent with branch_id](https://elevenlabs.io/docs/api-reference/agents/update)
- [Update/publish semantics](https://elevenlabs.io/docs/eleven-agents/operate/architect/external-assistants)
- [Create unpublished draft](https://elevenlabs.io/docs/api-reference/agents/drafts/create)
- [Branch listing and draft_exists](https://elevenlabs.io/docs/api-reference/agents/branches/list)
