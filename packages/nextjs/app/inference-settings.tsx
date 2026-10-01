"use client";
import { useEffect, useState } from "react";
import { toUnits, tokenAmount } from "./live-data";
import { REASON_TEXT } from "./reasons";

type ProviderOption = { id: string; label: string; defaultModel: string };
type Settings = { configured: boolean; error: string | null; keySet: boolean; provider: string | null; model: string | null; baseUrl: string | null; price: string | null; providers: ProviderOption[] };

const HEADERS = { "x-accountable-setup": "1", "Content-Type": "application/json" };
const KEY_HELP: Record<string, string> = {
  gateway: "An AI Gateway API key from your Vercel dashboard. Models are named provider/model, for example moonshotai/kimi-k3 or anthropic/claude-haiku-4.5.",
  openai: "An API key from platform.openai.com.",
  anthropic: "An API key from console.anthropic.com.",
  google: "A Gemini API key from Google AI Studio.",
  "openai-compatible": "Any provider with an OpenAI-style /chat/completions endpoint, such as Groq or OpenRouter.",
};
const explain = (code: string) => REASON_TEXT[code] ? `${code}: ${REASON_TEXT[code]}` : code;

async function call<T>(method: "GET" | "POST" | "DELETE", path = "", body?: unknown): Promise<T> {
  const response = await fetch(`/setup/inference${path}`, { method, headers: HEADERS, body: body ? JSON.stringify(body) : undefined, cache: "no-store" });
  const data = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(data.error ?? `AGENT_RUNTIME_${response.status}`);
  return data;
}

/**
 * The seller chooses an LLM provider and enters its key. The key goes to the local agent runtime,
 * which writes it to the ignored .env.server; it is never stored in this browser or sent back.
 */
export function InferenceSettings({ onSaved }: { onSaved: () => void }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [offline, setOffline] = useState(false);
  const [provider, setProvider] = useState("gateway");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("moonshotai/kimi-k3");
  const [baseUrl, setBaseUrl] = useState("");
  const [price, setPrice] = useState("0.01");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    call<Settings>("GET").then(value => {
      setSettings(value);
      if (value.provider) setProvider(value.provider);
      if (value.model) setModel(value.model);
      if (value.baseUrl) setBaseUrl(value.baseUrl);
      if (value.price && /^\d+$/.test(value.price)) setPrice(tokenAmount(value.price, 6));
    }).catch(() => setOffline(true));
  }, []);

  if (offline) return <p>Start (or restart) <code className="command">npm run dev</code> to configure a provider from here: the local agent runtime stores the key.</p>;
  if (!settings) return <p>Reading provider settings…</p>;

  const keepKey = settings.keySet && settings.provider === provider;
  function chooseProvider(id: string) {
    setProvider(id);
    const option = settings!.providers.find(p => p.id === id);
    if (option?.defaultModel) setModel(option.defaultModel);
    setMessage(null);
  }
  async function run(action: "save" | "test" | "remove") {
    setBusy(true); setMessage(null);
    try {
      if (action === "save") {
        const units = toUnits(price, 6);
        if (!units) throw new Error("Enter a price in USDC, for example 0.01");
        const saved = await call<Settings>("POST", "", { provider, model: model.trim(), price: units.toString(), ...(apiKey ? { apiKey: apiKey.trim() } : {}), ...(provider === "openai-compatible" ? { baseUrl: baseUrl.trim() } : {}) });
        setApiKey(""); setSettings(saved); onSaved();
        setMessage("Saved to .env.server. Use Test to check the key with one short request.");
      } else if (action === "test") {
        const result = await call<{ provider: string; model: string; answer: string; usage: { inputTokens: number | null; outputTokens: number | null } }>("POST", "/test");
        setMessage(`${result.provider} (${result.model}) answered: “${result.answer}” (${result.usage.inputTokens ?? "?"} input, ${result.usage.outputTokens ?? "?"} output tokens, billed to your provider account)`);
      } else {
        setSettings(await call<Settings>("DELETE")); onSaved();
        setMessage("Provider removed from .env.server. The endpoint now answers 503 and charges nothing.");
      }
    } catch (reason) { setMessage(explain(reason instanceof Error ? reason.message : "FAILED")); }
    finally { setBusy(false); }
  }

  return (
    <form className="pay-form" autoComplete="off" onSubmit={event => { event.preventDefault(); void run("save"); }}>
      <label>Provider
        <select className="select" value={provider} onChange={event => chooseProvider(event.target.value)}>
          {settings.providers.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
        </select>
      </label>
      <label>API key{keepKey && " (saved; leave empty to keep it)"}
        <div className="amount-field"><input type="password" value={apiKey} onChange={event => setApiKey(event.target.value)} placeholder={keepKey ? "••••••••  saved" : "Paste the key here, not in chat"} autoComplete="new-password" spellCheck={false} /></div>
        <small>{KEY_HELP[provider]} It is written to .env.server on this computer, which git ignores, and is never shown again.</small>
      </label>
      {provider === "openai-compatible" && <label>Base URL<div className="amount-field"><input value={baseUrl} onChange={event => setBaseUrl(event.target.value)} placeholder="https://api.groq.com/openai/v1" /></div></label>}
      <label>Model<div className="amount-field"><input value={model} onChange={event => setModel(event.target.value)} spellCheck={false} /></div></label>
      <label>Price per request<div className="amount-field"><input value={price} onChange={event => setPrice(event.target.value)} inputMode="decimal" /><span>USDC</span></div></label>
      <div className="pay-actions">
        <button className="primary" type="submit" disabled={busy || !model.trim() || (!apiKey && !keepKey)}>{busy ? "Working…" : "Save provider"}</button>
        <button className="secondary" type="button" disabled={busy || !settings.configured} onClick={() => void run("test")}>Test</button>
        <button className="secondary" type="button" disabled={busy || !settings.keySet} onClick={() => void run("remove")}>Remove</button>
      </div>
      {settings.error && <div className="notice"><div>Saved settings are invalid: {explain(settings.error)}</div></div>}
      {message && <div className="notice" role="status"><div>{message}</div></div>}
    </form>
  );
}
