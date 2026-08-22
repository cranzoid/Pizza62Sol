"use client";

/**
 * The Integrations screen.
 *
 * Written for the person sitting in the restaurant with the Clover dashboard
 * open on another tab, not for a developer. So it is organised by *service* —
 * everything Clover needs together, everything Twilio needs together — rather
 * than by variable name, and each group ends with a test button, because a
 * credential that is present but wrong looks exactly like one that is right
 * until an order arrives.
 *
 * Three deliberate choices:
 *
 * - **Secrets are never rendered.** A configured key shows `••••1234` and an
 *   empty input. Typing replaces it; leaving it blank changes nothing. There is
 *   no way to read a stored value back, including for the owner.
 * - **The callback URLs are generated and copyable.** They are the strings that
 *   must be pasted into someone else's dashboard, and mistyping one is the most
 *   common reason an integration is "configured" and still does not work.
 * - **Readiness is stated in plain terms** — "customers can pay online" rather
 *   than "CLOVER_WEBHOOK_SECRET is set" — because the useful question is what
 *   works, not which variable is populated.
 */

import { useCallback, useEffect, useState } from "react";

type SecretStatus = {
  key: string;
  configured: boolean;
  source: "database" | "environment" | "unset";
  display: string | null;
  updatedAt: number | null;
};

type Readiness = {
  onlinePayment: boolean;
  cloverCheckout: boolean;
  cloverWebhook: boolean;
  email: boolean;
  emailProvider: string | null;
  sms: boolean;
  voice: boolean;
  restaurantEmail: boolean;
  publicBaseUrl: string | null;
};

type Payload = {
  encryptionConfigured: boolean;
  secrets: SecretStatus[];
  callbacks: { cloverWebhook: string; cloverReturn: string; twilioVoiceAck: string } | null;
  readiness: Readiness;
};

type FieldSpec = {
  key: string;
  label: string;
  hint?: string;
  type?: "text" | "password" | "select";
  options?: Array<{ value: string; label: string }>;
  placeholder?: string;
};

const CLOVER_FIELDS: FieldSpec[] = [
  {
    key: "CLOVER_ENVIRONMENT",
    label: "Environment",
    type: "select",
    options: [
      { value: "sandbox", label: "Sandbox — test cards only" },
      { value: "production", label: "Production — real money" },
    ],
    hint: "Start in sandbox. Switch to production only after a test order has worked end to end.",
  },
  {
    key: "CLOVER_MERCHANT_ID",
    label: "Merchant ID",
    hint: "In the address bar of your Clover dashboard, after /m/.",
    placeholder: "e.g. ABCD1234EFGH5",
  },
  {
    key: "CLOVER_API_TOKEN",
    label: "Private API token",
    type: "password",
    hint: "The server half of the key pair. Takes the payment. Never leaves the server.",
  },
  {
    key: "CLOVER_PUBLIC_TOKEN",
    label: "Public API token",
    hint: "The browser half of the same pair. Runs the card form on our own checkout page. Safe to be visible.",
    placeholder: "e.g. 1a2b3c4d5e6f...",
  },
  {
    key: "CLOVER_IFRAME_ENABLED",
    label: "Where customers enter their card",
    type: "select",
    options: [
      { value: "false", label: "On Clover's page — the customer is redirected" },
      { value: "true", label: "On our checkout — card and Apple Pay, no redirect" },
    ],
    hint: "Switching back takes effect within 30 seconds and needs no deploy. Use it if anything looks wrong during service.",
  },
  {
    key: "CLOVER_WEBHOOK_SECRET",
    label: "Webhook signing secret",
    type: "password",
    hint: "Clover dashboard → Settings → Ecommerce → Hosted Checkout. This is what proves a payment notice really came from Clover.",
  },
];

const EMAIL_FIELDS: FieldSpec[] = [
  {
    key: "EMAIL_PROVIDER",
    label: "Provider",
    type: "select",
    options: [
      { value: "resend", label: "Resend — free up to 100/day" },
      { value: "sendgrid", label: "SendGrid" },
    ],
  },
  { key: "EMAIL_API_KEY", label: "API key", type: "password" },
  {
    key: "EMAIL_FROM",
    label: "Send from",
    placeholder: "orders@yourdomain.ca",
    hint: "Must be on a domain you have verified with the provider. A gmail.com address will not work as a sender — it will be rejected or land in spam.",
  },
];

const TWILIO_FIELDS: FieldSpec[] = [
  { key: "TWILIO_ACCOUNT_SID", label: "Account SID", placeholder: "AC…" },
  { key: "TWILIO_AUTH_TOKEN", label: "Auth token", type: "password" },
  {
    key: "TWILIO_FROM_NUMBER",
    label: "Twilio number",
    placeholder: "+19055550100",
    hint: "The number calls and texts come from. Must include the country code.",
  },
  {
    key: "RESTAURANT_ALERT_PHONE",
    label: "Number to ring in the kitchen",
    placeholder: "+19055475777",
    hint: "Not necessarily the number customers call. This is the one that should ring when an order arrives.",
  },
  { key: "VOICE_RETRY_LIMIT", label: "Times to call back", hint: "If nobody presses 1. Default 3." },
  { key: "VOICE_RETRY_MINUTES", label: "Minutes between calls", hint: "Default 2." },
  {
    key: "CUSTOMER_SMS_ENABLED",
    label: "Text customers too",
    type: "select",
    options: [
      { value: "false", label: "Off — recommended" },
      { value: "true", label: "On" },
    ],
    hint: "Leave off until the Twilio number is registered for business texting. Canadian carriers silently drop unregistered texts, so customers would think they were told and never be.",
  },
];

export function AdminIntegrationsPanel() {
  const [data, setData] = useState<Payload | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);

  /**
   * Fetches without touching state, so the caller decides what to do with the
   * result. That keeps the mount effect below free of a synchronous setState
   * and lets it discard a response that arrives after the panel is gone.
   */
  const fetchStatus = useCallback(async (): Promise<Payload | { error: string }> => {
    const response = await fetch("/api/admin/integrations");
    const result = (await response.json()) as Payload & { error?: string };
    if (!response.ok) return { error: result.error ?? "Integrations could not be loaded." };
    return result;
  }, []);

  const load = useCallback(async () => {
    const result = await fetchStatus();
    if ("error" in result) setMessage({ tone: "bad", text: result.error });
    else setData(result);
  }, [fetchStatus]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = await fetchStatus();
      if (cancelled) return;
      if ("error" in result) setMessage({ tone: "bad", text: result.error });
      else setData(result);
    })();
    return () => {
      cancelled = true;
    };
  }, [fetchStatus]);

  const save = async (key: string) => {
    const value = drafts[key] ?? "";
    setBusy(key);
    setMessage(null);
    const response = await fetch("/api/admin/integrations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "secret.set", key, value }),
    });
    const result = (await response.json()) as { error?: string };
    setBusy("");
    if (!response.ok) {
      setMessage({ tone: "bad", text: result.error ?? "That could not be saved." });
      return;
    }
    // Clear the input rather than echo the value back: what is on screen should
    // never be a stored credential.
    setDrafts((current) => ({ ...current, [key]: "" }));
    setMessage({ tone: "ok", text: value ? `${key} saved.` : `${key} cleared.` });
    await load();
  };

  const runTest = async (action: "test.email" | "test.sms" | "test.voice", label: string) => {
    setBusy(action);
    setMessage(null);
    const response = await fetch("/api/admin/integrations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action }),
    });
    const result = (await response.json()) as { error?: string; provider?: string };
    setBusy("");
    setMessage(
      response.ok
        ? { tone: "ok", text: `${label} sent via ${result.provider}. Check it arrived.` }
        : { tone: "bad", text: result.error ?? `The ${label.toLowerCase()} test failed.` },
    );
  };

  if (!data) return <div className="staff-empty">Loading integrations…</div>;
  const status = (key: string) => data.secrets.find((entry) => entry.key === key);

  return (
    <div className="admin-stack admin-controls">
      {!data.encryptionConfigured ? (
        <div className="setup-alert" role="alert">
          <strong>Credentials cannot be saved here yet</strong>
          <p>
            This deployment has no <code>SETTINGS_ENCRYPTION_KEY</code>, so there is nothing to encrypt them
            with. Until it is set, credentials have to come from the hosting environment. Everything below is
            read-only.
          </p>
        </div>
      ) : null}

      <ReadinessPanel readiness={data.readiness} />

      {data.callbacks ? (
        <section className="staff-panel">
          <div className="staff-panel-head">
            <h2>Addresses to paste elsewhere</h2>
            <span className="live-chip">Copy these exactly</span>
          </div>
          <div className="setup-list">
            <CopyRow
              label="Clover → Settings → Ecommerce → Webhook URL"
              value={data.callbacks.cloverWebhook}
            />
            {/* The app also sends these on every checkout session, but sending them
                alone was not enough: a live session created with `redirectUrls` and
                nothing in Clover's dashboard did not redirect — the customer paid
                and stayed on Clover's confirmation page. Clover documents the
                dashboard as taking precedence, so it is the entry that actually
                works. Same strings either way, so whichever wins behaves the same. */}
            <CopyRow
              label="Clover → View all settings → Ecommerce → Hosted Checkout → Success URL"
              value={`${data.callbacks.cloverReturn}?session_id={CHECKOUT_SESSION_ID}`}
            />
            <CopyRow
              label="Clover → View all settings → Ecommerce → Hosted Checkout → Failure URL"
              value={`${data.callbacks.cloverReturn}?status=failed`}
            />
            <CopyRow label="Twilio → Voice callback (set automatically)" value={data.callbacks.twilioVoiceAck} />
          </div>
        </section>
      ) : (
        <section className="staff-panel">
          <div className="staff-panel-head">
            <h2>Addresses to paste elsewhere</h2>
          </div>
          <p className="editor-hint">
            Set the public web address below first — Clover and Twilio both need a reachable URL, and these are
            built from it.
          </p>
          <SecretField
            spec={{
              key: "PUBLIC_BASE_URL",
              label: "Public web address",
              placeholder: "https://order.pizza62.ca",
              hint: "The address customers reach the site on, with no trailing slash.",
            }}
            status={status("PUBLIC_BASE_URL")}
            draft={drafts.PUBLIC_BASE_URL ?? ""}
            disabled={!data.encryptionConfigured}
            busy={busy === "PUBLIC_BASE_URL"}
            onChange={(value) => setDrafts((current) => ({ ...current, PUBLIC_BASE_URL: value }))}
            onSave={() => void save("PUBLIC_BASE_URL")}
          />
        </section>
      )}

      <IntegrationCard
        title="Card payments — Clover"
        summary="Lets customers pay online. Delivery orders require it; pickup can be pay-at-store without it."
        fields={CLOVER_FIELDS}
        data={data}
        drafts={drafts}
        busy={busy}
        setDrafts={setDrafts}
        onSave={save}
      />

      <IntegrationCard
        title="Email"
        summary="Order confirmations to customers and new-order alerts to the restaurant. This is the channel that carries the customer's tracking link, so it matters more than any other."
        fields={EMAIL_FIELDS}
        data={data}
        drafts={drafts}
        busy={busy}
        setDrafts={setDrafts}
        onSave={save}
        test={{
          label: "Test email",
          disabled: !data.readiness.email,
          running: busy === "test.email",
          onRun: () => void runTest("test.email", "Test email"),
        }}
      />

      <IntegrationCard
        title="Calls and texts — Twilio"
        summary="Phones the kitchen when an order arrives and keeps calling until someone presses 1."
        fields={TWILIO_FIELDS}
        data={data}
        drafts={drafts}
        busy={busy}
        setDrafts={setDrafts}
        onSave={save}
        test={{
          label: "Test call",
          disabled: !data.readiness.voice,
          running: busy === "test.voice",
          onRun: () => void runTest("test.voice", "Test call"),
        }}
        secondaryTest={{
          label: "Test text",
          disabled: !data.readiness.sms,
          running: busy === "test.sms",
          onRun: () => void runTest("test.sms", "Test text"),
        }}
      />

      {message ? (
        <p className={message.tone === "bad" ? "form-error" : "admin-message"} role="status">
          {message.text}
        </p>
      ) : null}
    </div>
  );
}

/** What works right now, in the words the owner would use. */
function ReadinessPanel({ readiness }: { readiness: Readiness }) {
  const rows: Array<[boolean, string, string]> = [
    [
      readiness.onlinePayment,
      "Customers can pay online",
      readiness.cloverCheckout && !readiness.cloverWebhook
        ? "Clover can take a card, but nothing confirms the payment — add the webhook secret."
        : "Needs the Clover merchant ID, private token and webhook secret.",
    ],
    [
      readiness.email,
      "Customers get a confirmation email",
      "Needs an email provider API key and a verified sender address.",
    ],
    [readiness.restaurantEmail, "The restaurant is emailed about new orders", "Set the restaurant's address in Settings."],
    [readiness.voice, "The kitchen is phoned about new orders", "Needs Twilio credentials and the public web address."],
    [readiness.sms, "Texts can be sent", "Needs Twilio credentials."],
  ];
  const ready = rows.filter(([ok]) => ok).length;
  return (
    <section className="staff-panel">
      <div className="staff-panel-head">
        <h2>What is working</h2>
        <span className="live-chip">
          <i /> {ready} of {rows.length} ready
        </span>
      </div>
      <div className="setup-list">
        {rows.map(([ok, title, missing]) => (
          <div className="setup-item" key={title}>
            <b aria-hidden>{ok ? "✓" : "—"}</b>
            <div>
              <strong>{title}</strong>
              <p>{ok ? "Ready." : missing}</p>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function IntegrationCard({
  title,
  summary,
  fields,
  data,
  drafts,
  busy,
  setDrafts,
  onSave,
  test,
  secondaryTest,
}: {
  title: string;
  summary: string;
  fields: FieldSpec[];
  data: Payload;
  drafts: Record<string, string>;
  busy: string;
  setDrafts: (update: (current: Record<string, string>) => Record<string, string>) => void;
  onSave: (key: string) => Promise<void>;
  test?: { label: string; disabled: boolean; running: boolean; onRun: () => void };
  secondaryTest?: { label: string; disabled: boolean; running: boolean; onRun: () => void };
}) {
  return (
    <section className="staff-panel">
      <div className="staff-panel-head">
        <h2>{title}</h2>
        <div className="integration-actions">
          {secondaryTest ? (
            <button className="staff-button" disabled={secondaryTest.disabled || secondaryTest.running} onClick={secondaryTest.onRun}>
              {secondaryTest.running ? "Sending…" : secondaryTest.label}
            </button>
          ) : null}
          {test ? (
            <button className="staff-button" disabled={test.disabled || test.running} onClick={test.onRun}>
              {test.running ? "Sending…" : test.label}
            </button>
          ) : null}
        </div>
      </div>
      <p className="editor-hint">{summary}</p>
      <div className="setup-list">
        {fields.map((spec) => (
          <SecretField
            key={spec.key}
            spec={spec}
            status={data.secrets.find((entry) => entry.key === spec.key)}
            draft={drafts[spec.key] ?? ""}
            disabled={!data.encryptionConfigured}
            busy={busy === spec.key}
            onChange={(value) => setDrafts((current) => ({ ...current, [spec.key]: value }))}
            onSave={() => void onSave(spec.key)}
          />
        ))}
      </div>
    </section>
  );
}

function SecretField({
  spec,
  status,
  draft,
  disabled,
  busy,
  onChange,
  onSave,
}: {
  spec: FieldSpec;
  status?: SecretStatus;
  draft: string;
  disabled: boolean;
  busy: boolean;
  onChange: (value: string) => void;
  onSave: () => void;
}) {
  const configured = status?.configured ?? false;
  return (
    <div className="integration-field">
      <label>
        <span className="integration-field-label">
          {spec.label}
          {configured ? (
            <small className="integration-set">
              set{status?.source === "environment" ? " in hosting" : ""} · {status?.display}
            </small>
          ) : (
            <small className="integration-unset">not set</small>
          )}
        </span>
        {spec.type === "select" ? (
          <select value={draft || (configured ? String(status?.display ?? "") : "")} onChange={(event) => onChange(event.target.value)} disabled={disabled}>
            <option value="">Leave unchanged</option>
            {(spec.options ?? []).map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        ) : (
          <input
            type={spec.type === "password" ? "password" : "text"}
            value={draft}
            autoComplete="off"
            spellCheck={false}
            placeholder={configured ? "Leave blank to keep the current value" : spec.placeholder}
            onChange={(event) => onChange(event.target.value)}
            disabled={disabled}
          />
        )}
      </label>
      {spec.hint ? <p className="editor-hint">{spec.hint}</p> : null}
      <div className="integration-field-actions">
        <button className="staff-button" disabled={disabled || busy || !draft} onClick={onSave}>
          {busy ? "Saving…" : "Save"}
        </button>
        {configured && status?.source === "database" ? (
          <button
            className="text-button danger-text"
            disabled={disabled || busy}
            onClick={() => {
              onChange("");
              onSave();
            }}
          >
            Clear
          </button>
        ) : null}
      </div>
    </div>
  );
}

function CopyRow({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="setup-item">
      <b aria-hidden>→</b>
      <div>
        <strong>{label}</strong>
        <div className="manual-punch">
          <input readOnly value={value} aria-label={label} onFocus={(event) => event.target.select()} />
          <button
            className="staff-button"
            onClick={() => {
              void navigator.clipboard?.writeText(value).then(
                () => {
                  setCopied(true);
                  window.setTimeout(() => setCopied(false), 2000);
                },
                () => undefined,
              );
            }}
          >
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
      </div>
    </div>
  );
}
