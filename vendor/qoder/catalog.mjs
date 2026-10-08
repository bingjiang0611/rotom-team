import { QoderError } from './auth.mjs';
import { CATALOG_URL, catalogHeaders } from './catalog-auth.mjs';
import { abortable, SUPPORTED_MODEL_IDS, inputCapabilities } from './transport.mjs';

export const CATALOG_TTL_MS = 60 * 60 * 1000;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = code => { throw new QoderError(code); };
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 128 && !/[\p{C}\r\n]/u.test(value);

function thinkingConfig(value) {
  if (!record(value) || !record(value.enabled) || !record(value.enabled.efforts)) return;
  const efforts = ['low', 'medium', 'high', 'xhigh', 'max'].filter(k => record(value.enabled.efforts[k]));
  if (!efforts.length) return;
  const defaults = efforts.filter(k => value.enabled.efforts[k].is_default === true);
  return Object.freeze({ efforts: Object.freeze(efforts), disabled: record(value.disabled), ...(defaults.length === 1 ? { defaultEffort: defaults[0] } : {}) });
}

function contextSelectors(value) {
  if (!record(value) || Object.keys(value).length > 16) return Object.freeze([]);
  return Object.freeze([['200K', 200000], ['400K', 400000], ['1M', 1000000]].filter(([key, count]) => record(value[key]) && value[key].token_count === count).map(([, count]) => count));
}

export function parseCatalog(body) {
  if (!record(body) || !Array.isArray(body.assistant) || body.assistant.length > 256) fail('catalog_invalid');
  const seen = new Set(), entries = [];
  for (const raw of body.assistant) {
    if (!record(raw)) fail('catalog_invalid');
    // BYOK/enterprise entries require a different request contract. Never infer
    // custom_model or another scene/endpoint from server-provided metadata.
    if (raw.source !== 'system') continue;
    if (!/^[a-z][a-z0-9_.-]{0,95}$/.test(raw.key ?? '') || !text(raw.display_name) || typeof raw.enable !== 'boolean' || seen.has(raw.key)) fail('catalog_invalid');
    seen.add(raw.key);
    // max_input_tokens is optional: some system entries now advertise capacity
    // through context_config only. A present value must still be a sane bound
    // (a corrupt value fails the catalog closed), but an absent one leaves the
    // reported window unknown and lets inputCapabilities fall back to its
    // conservative default, so one such entry no longer rejects the whole
    // account catalog. COSY models still require this field at dispatch
    // (legacy.mjs), which fails only that model, never the catalog.
    const limit = raw.max_input_tokens;
    const hasLimit = limit !== undefined && limit !== null;
    if (hasLimit && (!Number.isSafeInteger(limit) || limit < 4096 || limit > 100000000)) fail('catalog_invalid');
    const entry = { id: raw.key, name: raw.display_name, enabled: raw.enable,
      reviewed: SUPPORTED_MODEL_IDS.includes(raw.key), format: raw.format === 'openai' ? 'openai' : 'unsupported',
      reportedContextWindow: hasLimit ? limit : undefined, reportedContexts: contextSelectors(raw.context_config),
      // Claims require the reviewed profile AND the current account declaration.
      reportedImages: raw.is_vl === true, reportedReasoning: raw.is_reasoning === true,
      reportedThinking: thinkingConfig(raw.thinking_config),
    };
    entries.push(Object.freeze({ ...entry, contextWindow: inputCapabilities(entry).contextWindow }));
  }
  if (!entries.length) fail('catalog_empty');
  return Object.freeze(entries);
}

const CONTEXT_LABELS = new Map([[200000, '200K'], [400000, '400K'], [1000000, '1M']]);

/** Persist only the bounded, validated catalog fields needed to reconstruct account capabilities. */
export function catalogMetadata(entries) {
  return { version: 1, assistant: entries.map(entry => ({
    source: 'system', key: entry.id, display_name: entry.name, enable: entry.enabled, format: entry.format,
    max_input_tokens: entry.reportedContextWindow, is_vl: entry.reportedImages, is_reasoning: entry.reportedReasoning,
    context_config: Object.fromEntries(entry.reportedContexts.map(count => [CONTEXT_LABELS.get(count), { token_count: count }]).filter(([key]) => key)),
    ...(entry.reportedThinking ? { thinking_config: {
      enabled: { efforts: Object.fromEntries(entry.reportedThinking.efforts.map(level => [level, { is_default: level === entry.reportedThinking.defaultEffort }])) },
      ...(entry.reportedThinking.disabled ? { disabled: {} } : {}),
    } } : {}),
  })) };
}

/** Re-run the authoritative parser before trusting a provider-owned disk cache. */
export function parseCatalogMetadata(value) {
  if (!record(value) || value.version !== 1) fail('catalog_invalid');
  return parseCatalog({ assistant: value.assistant });
}

export async function fetchCatalog(credential, { fetchImpl = globalThis.fetch, signal, timeoutMs = 15000 } = {}) {
  const controller = new AbortController();
  let response, reader;
  const abort = () => { controller.abort(); void reader?.cancel().catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const timer = setTimeout(abort, timeoutMs);
  try {
    const headers = catalogHeaders(credential);
    return await abortable(async () => {
      response = await fetchImpl(CATALOG_URL, { method: 'GET', redirect: 'error', headers, signal: controller.signal });
      if (controller.signal.aborted) { void response.body?.cancel().catch(() => {}); fail('aborted'); }
      if (!response.ok) { void response.body?.cancel().catch(() => {}); fail(`catalog_http_${response.status}`); }
      if (!response.body) fail('catalog_invalid');
      let size = 0; const chunks = [];
      reader = response.body.getReader();
      for (;;) {
        const { value, done } = await reader.read();
        if (controller.signal.aborted) fail('aborted');
        if (done) break;
        size += value.length;
        if (size > 512 * 1024) fail('catalog_oversized');
        chunks.push(value);
      }
      if (controller.signal.aborted) fail('aborted');
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail('catalog_encoding_unsupported'); }
      return parseCatalog(body);
    }, controller.signal);
  } catch (error) {
    if (error instanceof QoderError) throw error;
    throw new QoderError(controller.signal.aborted ? 'aborted' : 'catalog_request_failed');
  } finally {
    clearTimeout(timer); signal?.removeEventListener('abort', abort);
    if (reader) { void reader.cancel().catch(() => {}); reader.releaseLock(); }
    else void response?.body?.cancel().catch(() => {});
  }
}
