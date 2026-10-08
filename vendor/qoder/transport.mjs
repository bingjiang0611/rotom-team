import { randomUUID } from 'node:crypto';
import { QoderError } from './auth.mjs';
import { creditFields, createCreditCollector } from './credits.mjs';
import { LEGACY_URL, LEGACY_MODEL_IDS, legacyBody, legacyHeaders } from './legacy.mjs';

export const BASE_URL = 'https://api2-v2.qoder.sh/model/v1';
export const CHAT_URL = `${BASE_URL}/chat/completions`;
// Exact routing keys from the account's assistant catalog, never display-name slugs.
// Registration separately requires a current account-scoped catalog entry.
export const SUPPORTED_MODEL_IDS = Object.freeze(['lite', 'performance', 'auto', 'qmodel', 'kmodel', 'gmodel', 'dmodel', 'ultimate', ...LEGACY_MODEL_IDS.filter(id => id !== 'ultimate')]);
// Reasoning routes retain fixed enabled mode unless an independently reviewed
// effort profile below is also present in the current bound account catalog.
export const REASONING_MODEL_IDS = Object.freeze(['qmodel', 'kmodel', 'gmodel', 'dmodel', 'ultimate', ...LEGACY_MODEL_IDS.filter(id => id !== 'efficient' && id !== 'ultimate')]);
// Reviewed request controls, intersected with each current account catalog by
// the provider. An advertised off mode is not sufficient: several tested routes
// still emitted reasoning when disabled, so those off controls remain excluded.
export const VERIFIED_THINKING_LEVELS = Object.freeze(Object.fromEntries(Object.entries({
  ultimate: ['low', 'medium', 'high', 'xhigh', 'max'], smodel: ['low', 'medium', 'high', 'xhigh', 'max'],
  qmodel_38max: ['off', 'low', 'medium', 'xhigh'], qfmodel: ['low', 'medium', 'xhigh'],
  kmodel_latest: ['low', 'high', 'max'], gfmodel: ['high', 'max'], dmodel: ['high', 'max'], dfmodel: ['low', 'high', 'max'],
}).map(([id, levels]) => [id, Object.freeze(levels)])));
export const QODER_REASONING_FORMAT = 'rotom-qoder-ultimate-v1';
export const SONUS_REASONING_FORMAT = 'rotom-qoder-sonus-v1';
export const ULTIMATE_COSY_REASONING_FORMAT = 'rotom-qoder-ultimate-cosy-v1';
export const OPAQUE_MODEL_IDS = Object.freeze(['ultimate', 'smodel']);
const encoder = new TextEncoder();
const fail = (code) => { throw new QoderError(code); };
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonnegative = (n) => Number.isSafeInteger(n) && n >= 0;
export const EXPANDED_INPUT_MODEL_IDS = Object.freeze(['ultimate', 'kmodel_latest', 'dfmodel']);
export function inputCapabilities(entry) {
  const reviewed = EXPANDED_INPUT_MODEL_IDS.includes(entry?.id) && entry.enabled === true && entry.reviewed === true && entry.format === 'openai';
  const expanded = reviewed && entry.reportedContexts?.includes(400000) === true;
  // Pi's window includes answer/safety space and the native compaction reserve,
  // so it is a managed budget, not the upstream limit. The maintainer aligned it
  // with the Codex-declared 272000 to keep one compaction percentage across
  // providers; the fixed 400K wire selector still is not an advertised capacity.
  // Consequence, measured: full 4096 output needs input <= window - 8192, so the
  // researched >=272K single-request input is upstream capability, not product
  // capacity, and oversized single turns lose answer budget instead of failing.
  return Object.freeze({ images: reviewed && entry.reportedImages === true, contextWindow: expanded ? 272000 : Math.min(32000, entry?.reportedContextWindow ?? 32000), contextLength: expanded ? 400000 : Math.min(32000, entry?.reportedContextWindow ?? 32000) });
}
// Only inline, canonical base64 in the three exercised codecs.
export function imageByteLength(data, mime) {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(mime) || typeof data !== 'string' || !data.length) fail('invalid_image');
  if (data.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) fail('invalid_image');
  const bytes = Buffer.from(data, 'base64');
  if (bytes.toString('base64') !== data) fail('invalid_image');
  const valid = mime === 'image/png' ? bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) : mime === 'image/jpeg' ? bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 : bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
  if (!valid) fail('invalid_image');
  return bytes.length;
}

// Lossless adapters for the observed Ultimate and Sonus replay schemas. Opaque
// server state is never decrypted, interpreted as instructions or used as auth.
// Pi persists native reasoning.encrypted details. Sonus and Ultimate COSY use
// distinct formats packing target_hash with ciphertext, without recomputing it.
function reasoningItem(item, modelId = 'ultimate', cosyUltimate = false) {
  if (!OPAQUE_MODEL_IDS.includes(modelId)) fail('opaque_reasoning_replay_unsupported');
  const hashed = modelId === 'smodel' || modelId === 'ultimate' && cosyUltimate;
  if (!record(item) || Object.keys(item).sort().join(',') !== (hashed ? 'encrypted_content,id,target_hash' : 'encrypted_content,id') ||
      typeof item.id !== 'string' || !/^[\x21-\x7e]{1,256}$/.test(item.id) ||
      typeof item.encrypted_content !== 'string' || !item.encrypted_content ||
      Buffer.byteLength(item.encrypted_content) > 64 * 1024 || /[\x00-\x1f\x7f]/.test(item.encrypted_content)) fail('opaque_reasoning_replay_unsupported');
  if (hashed && (typeof item.target_hash !== 'string' || !/^[\x21-\x7e]{64}$/.test(item.target_hash))) fail('opaque_reasoning_replay_unsupported');
  return { id: item.id, encrypted_content: item.encrypted_content, ...(hashed ? { target_hash: item.target_hash } : {}) };
}
export function reasoningDetailsToItem(details, modelId = 'ultimate') {
  if (!Array.isArray(details) || details.length !== 1) fail('opaque_reasoning_replay_unsupported');
  const d = details[0];
  const formats = modelId === 'smodel' ? [SONUS_REASONING_FORMAT] : modelId === 'ultimate' ? [QODER_REASONING_FORMAT, ULTIMATE_COSY_REASONING_FORMAT] : [];
  if (!record(d) || Object.keys(d).sort().join(',') !== 'data,format,id,type' || d.type !== 'reasoning.encrypted' || !formats.includes(d.format)) fail('opaque_reasoning_replay_unsupported');
  if (modelId === 'smodel' || d.format === ULTIMATE_COSY_REASONING_FORMAT) {
    if (typeof d.data !== 'string' || Buffer.byteLength(d.data) > 128 * 1024) fail('opaque_reasoning_replay_unsupported');
    let item; try { item = JSON.parse(d.data); } catch { fail('opaque_reasoning_replay_unsupported'); }
    if (item?.id !== d.id) fail('opaque_reasoning_replay_unsupported');
    return reasoningItem(item, modelId, d.format === ULTIMATE_COSY_REASONING_FORMAT);
  }
  return reasoningItem({ id: d.id, encrypted_content: d.data }, modelId);
}
export function validateReasoningSignature(signature, modelId = 'ultimate') {
  if (typeof signature !== 'string' || Buffer.byteLength(signature) > 128 * 1024) fail('opaque_reasoning_replay_unsupported');
  let details;
  try { details = JSON.parse(signature); } catch { fail('opaque_reasoning_replay_unsupported'); }
  reasoningDetailsToItem(details, modelId);
}

// Stop waiting even when a local read or injected transport ignores cancellation.
// The operation may finish later; racing is not proof of remote cancellation.
export async function abortable(operation, signal) {
  if (signal.aborted) fail('aborted');
  let abort;
  const cancelled = new Promise((_, reject) => {
    abort = () => reject(new QoderError('aborted'));
    signal.addEventListener('abort', abort, { once: true });
  });
  try {
    return await Promise.race([Promise.resolve().then(() => {
      if (signal.aborted) fail('aborted');
      return operation(signal);
    }), cancelled]);
  } finally { signal.removeEventListener('abort', abort); }
}

function usageOnly(usage) {
  if (!record(usage) || !['prompt_tokens', 'completion_tokens', 'total_tokens'].every(k => nonnegative(usage[k]))) fail('invalid_usage');
  const result = Object.fromEntries(['prompt_tokens', 'completion_tokens', 'total_tokens'].map(k => [k, usage[k]]));
  const cached = usage.prompt_tokens_details?.cached_tokens;
  if (cached !== undefined) {
    if (!nonnegative(cached) || cached > usage.prompt_tokens) fail('invalid_usage');
    result.prompt_tokens_details = { cached_tokens: cached };
  }
  const reasoning = usage.completion_tokens_details?.reasoning_tokens;
  if (reasoning !== undefined) {
    if (!nonnegative(reasoning)) fail('invalid_usage');
    result.completion_tokens_details = { reasoning_tokens: reasoning };
  }
  return result;
}

function legacyTiming(value) {
  return record(value) && Object.keys(value).length === 3 && ['firstTokenDuration', 'totalDuration', 'serverDuration'].every(k => Number.isFinite(value[k]) && value[k] >= 0);
}
function parseFrame(lines, onDiagnostic, allowLegacyEnvelope) {
  // Qoder may also wrap the literal SSE field prefix itself, not just JSON.
  // Restore only an exact literal data: prefix within this same frame, using
  // existing bytes. Never add a field prefix or cross a blank frame boundary.
  let prefix = '';
  for (let i = 0; i < Math.min(lines.length, 5); i++) {
    prefix += lines[i];
    if (prefix.startsWith('data:')) {
      if (i > 0) { lines = [prefix, ...lines.slice(i + 1)]; try { void Promise.resolve(onDiagnostic?.({ code: 'field_prefix_continuation', parts: i + 1 })).catch(() => {}); } catch { /* Metadata only. */ } }
      break;
    }
    if (!'data:'.startsWith(prefix)) break;
  }
  let data, joined = '', hasData = false, raw = false, fieldLike = 0, errorEvent = false;
  for (const line of lines) {
    if (line.startsWith('event:') && line.slice(6).trim() === 'error') {
      if (!hasData) fail('upstream_error_event');
      errorEvent = true;
    }
    if (line.startsWith('data:')) {
      const part = line.slice(5).replace(/^ /, '');
      data = hasData ? `${data}\n${part}` : part;
      // A raw continuation may literally begin with 'data:' inside a JSON
      // string. Standard SSE JSON wins whenever it is already valid.
      joined += hasData ? line : part;
      if (hasData) fieldLike++;
      hasData = true;
    } else {
      const field = line.startsWith(':') || /^(event|id|retry):/.test(line);
      if (!hasData) { if (!field) fail('unexpected_sse_field'); continue; }
      // Qoder wraps serialized JSON at arbitrary positions, including ':'
      // which looks like an SSE comment. Preserve those exact bytes. We only
      // remove physical line separators, never unescape text, add JSON syntax,
      // or join across frame boundaries.
      joined += line;
      if (field) fieldLike++; else raw = true;
    }
  }
  if (!hasData || (!raw && !fieldLike)) return data;
  let standardValid = false;
  try { JSON.parse(data); standardValid = true; } catch { /* Try bounded same-frame Qoder framing below. */ }
  if (standardValid || data === '[DONE]' || data.startsWith('[NOT_') || data.startsWith('[NOTIFICATIONS]')) {
    if (errorEvent) fail('upstream_error_event');
    if (raw) fail('unexpected_sse_field');
    return data;
  }
  let candidate;
  try { candidate = JSON.parse(joined); } catch { if (errorEvent) fail('upstream_error_event'); return data; }
  const legacy = allowLegacyEnvelope && record(candidate) && ((typeof candidate.body === 'string' && Number.isInteger(candidate.statusCodeValue)) || legacyTiming(candidate));
  if (!record(candidate) || (!Array.isArray(candidate.choices) && !legacy)) fail('nonstandard_content_frame');
  const usageOnly = candidate.choices?.length === 0 && record(candidate.usage);
  try { void Promise.resolve(onDiagnostic?.({ code: usageOnly ? 'usage_continuation' : 'frame_continuation', raw, fieldLike })).catch(() => {}); } catch { /* Metadata only, fail open. */ }
  return joined;
}

// Terminal sentinel for the structured chunk stream. The service's own literal
// DONE marker stays inside the wire parser; downstream consumers must not infer
// termination from EOF, a usage frame, or a missing sentinel.
export const STREAM_DONE = Symbol('qoder-stream-done');

// Structured Qoder frame parser. This owns every Qoder-specific wire concern:
// field-prefix continuation, arbitrarily wrapped JSON, legacy COSY envelopes,
// metrics-only trailers, quota markers, tool-delta identity and opaque reasoning
// items. It yields validated chunk records plus STREAM_DONE, never SSE bytes, so
// the translator does not re-encode and re-parse a second OpenAI-shaped stream.
export async function* qoderChunks(body, { signal, toolNames = [], onDiagnostic, onCreditUsage, maxFrameBytes = 1024 * 1024, maxTotalBytes = 16 * 1024 * 1024, allowReasoning = false, allowOpaqueReasoning = false, allowLegacyEnvelope = false, allowLegacyMetricsDone = false, opaqueModelId = 'ultimate' } = {}) {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const calls = new Map(), wireIndexes = new Map();
  const freeIndex = () => { let index = 0; while (calls.has(index)) index++; if (index >= 64) fail('invalid_tool_delta'); return index; };
  let buffer = '', lines = [], frameSize = 0, total = 0, finished = false, usageSeen = false, done = false, opaqueSeen = false, timingSeen = false;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', cancel, { once: true });
  const checkCalls = () => {
    const ids = new Set();
    for (const call of calls.values()) {
      if (!call.id || ids.has(call.id) || !toolNames.includes(call.name)) fail('invalid_tool_call');
      ids.add(call.id);
      let args;
      try { args = JSON.parse(call.arguments); } catch { fail('invalid_tool_arguments'); }
      if (!record(args)) fail('invalid_tool_arguments');
    }
  };
  const convert = (data) => {
    if (data === undefined) return;
    // Legacy service appends one metrics-only trailer after the model's DONE.
    // No content, error, duplicate DONE or unrecognized trailer is discarded.
    if (done && allowLegacyEnvelope && !timingSeen) {
      let trailer; try { trailer = JSON.parse(data); } catch { /* Not a metrics trailer. */ }
      if (legacyTiming(trailer)) { timingSeen = true; return; }
    }
    if (done) fail('data_after_done');
    if (allowLegacyEnvelope && allowLegacyMetricsDone && !timingSeen) {
      let trailer; try { trailer = JSON.parse(data); } catch { /* Not a trailer. */ }
      // MiniMax/Sonus legacy protocols have no literal DONE. Their explicit
      // finish + usage + exact service trailer jointly prove completion; EOF
      // alone, partial tools, metrics without finish/usage, and later data do not.
      if (legacyTiming(trailer)) {
        if (!finished || !usageSeen) fail('incomplete_stream');
        checkCalls(); done = true; timingSeen = true; return STREAM_DONE;
      }
    }
    if (allowLegacyEnvelope && !data.startsWith('[')) {
      let envelope;
      try { envelope = JSON.parse(data); } catch { fail('invalid_sse_json'); }
      if (!record(envelope) || envelope.statusCodeValue !== 200) {
        const body = typeof envelope?.body === 'string' ? envelope.body.toLowerCase() : '';
        try { void Promise.resolve(onDiagnostic?.({ code: 'legacy_error', status: Number.isSafeInteger(envelope?.statusCodeValue) ? envelope.statusCodeValue : null, categories: ['tool', 'content', 'null', 'reasoning', 'model', 'parameter', 'quota', 'permission', 'invalid'].filter(k => body.includes(k)) })).catch(() => {}); } catch { /* Allowlisted metadata only. */ }
        fail('upstream_error_frame');
      }
      if (typeof envelope.body !== 'string') fail('invalid_legacy_envelope');
      data = envelope.body;
    }
    if (data === '[DONE]') {
      if (!finished || !usageSeen) fail('incomplete_stream');
      checkCalls(); done = true;
      return STREAM_DONE;
    }
    if (data === '[NOT_EXCEED_QUOTA]' || data.startsWith('[NOTIFICATIONS]')) return;
    if (data.startsWith('[EXCEED_QUOTA]')) fail('quota_exceeded');
    let chunk;
    try { chunk = JSON.parse(data); } catch (error) {
      // Structural counters only. Never expose JSON.parse's message: V8 may
      // include model text or account metadata in it.
      const parsedPosition = Number(error.message.match(/at position (\d+)(?: \(line \d+ column \d+\))?$/)?.[1] ?? -1);
      const position = Number.isSafeInteger(parsedPosition) && parsedPosition <= data.length ? parsedPosition : -1;
      const category = error.message.startsWith('Unterminated string') ? 'unterminated_string' : error.message.startsWith('Unexpected non-whitespace') ? 'trailing_data' : 'syntax';
      const fieldCounts = { data: 0, comment: 0, event: 0, id: 0, retry: 0, raw: 0 };
      for (const line of lines) fieldCounts[line.startsWith('data:') ? 'data' : line.startsWith(':') ? 'comment' : line.startsWith('event:') ? 'event' : line.startsWith('id:') ? 'id' : line.startsWith('retry:') ? 'retry' : 'raw']++;
      try { void Promise.resolve(onDiagnostic?.({ code: 'invalid_sse_json', bytes: encoder.encode(data).length, position, category, fieldCounts })).catch(() => {}); } catch { /* Optional diagnostics cannot change inference. */ }
      fail('invalid_sse_json');
    }
    if (!record(chunk) || chunk.error || (chunk.code !== undefined && chunk.code !== 0 && chunk.code !== 200)) {
      try { void Promise.resolve(onDiagnostic?.({ code: 'upstream_error_frame', status: Number.isSafeInteger(chunk?.code) ? chunk.code : null, hasError: Boolean(chunk?.error) })).catch(() => {}); } catch { /* Allowlisted metadata only. */ }
      fail('upstream_error_frame');
    }
    if (!Array.isArray(chunk.choices)) fail('invalid_choices');
    if (chunk.choices.length > 1) fail('multiple_choices_unsupported');
    const choices = chunk.choices.map(choice => {
      if (choice.index !== undefined && choice.index !== 0) fail('invalid_choice_index');
      // Observed Sonus/Ultimate COSY frames use function_call with modern
      // tool_calls deltas. Still require complete tools and validated EOF;
      // never reinterpret the direct HTTP route or legacy function_call deltas.
      if (allowLegacyEnvelope && ['smodel', 'ultimate'].includes(opaqueModelId) && choice.finish_reason === 'function_call') choice = { ...choice, finish_reason: 'tool_calls' };
      // Ultimate may omit delta on explicit text or tool-continuation terminals
      // when no opaque item is emitted. Preserve that absence; complete tool
      // arguments, usage and DONE are still required below, never synthesized.
      const delta = choice.delta === undefined && allowOpaqueReasoning && opaqueModelId === 'ultimate' && ['stop', 'tool_calls'].includes(choice.finish_reason) && !('message' in choice) ? {} : choice.delta;
      if (!record(delta)) fail('invalid_delta');
      // Preserve only supported model content, never raw_usage/account metadata.
      if (delta.reasoning_details || delta.reasoning_content_signature) fail('opaque_reasoning_replay_unsupported');
      let opaque;
      if (delta.reasoning_item != null) {
        if (!allowReasoning || !allowOpaqueReasoning || opaqueSeen || finished) fail('opaque_reasoning_replay_unsupported');
        opaque = reasoningItem(delta.reasoning_item, opaqueModelId, allowLegacyEnvelope && opaqueModelId === 'ultimate' && Object.hasOwn(delta.reasoning_item, 'target_hash')); opaqueSeen = true;
      }
      if (delta.reasoning || delta.reasoning_text) fail('unsupported_reasoning_field');
      if (delta.reasoning_content && !allowReasoning) fail('reasoning_not_validated');
      const output = {};
      if (opaque) output.reasoning_details = [{ type: 'reasoning.encrypted', format: opaqueModelId === 'smodel' ? SONUS_REASONING_FORMAT : Object.hasOwn(opaque, 'target_hash') ? ULTIMATE_COSY_REASONING_FORMAT : QODER_REASONING_FORMAT, id: opaque.id, data: Object.hasOwn(opaque, 'target_hash') ? JSON.stringify(opaque) : opaque.encrypted_content }];
      for (const field of ['role', 'content', 'reasoning_content']) {
        if (delta[field] !== undefined && delta[field] !== null) {
          if (typeof delta[field] !== 'string') fail('invalid_delta');
          if (finished && delta[field] && field !== 'role') fail('content_after_finish');
          output[field] = delta[field];
        }
      }
      if (delta.tool_calls !== undefined && delta.tool_calls !== null) {
        if (finished || !Array.isArray(delta.tool_calls)) fail('invalid_tool_delta');
        output.tool_calls = delta.tool_calls.map(t => {
          const wireIndex = t.index ?? 0;
          if (!Number.isSafeInteger(wireIndex) || wireIndex < 0 || wireIndex >= 64 || !record(t.function)) fail('invalid_tool_delta');
          if (t.type !== undefined && t.type !== 'function') fail('unsupported_tool_type');
          let index = wireIndexes.get(wireIndex);
          if (index === undefined) { index = calls.has(wireIndex) ? freeIndex() : wireIndex; wireIndexes.set(wireIndex, index); }
          let call = calls.get(index) ?? { id: '', name: '', arguments: '' };
          // Observed Ultimate batches restart index 0 for each serial tool.
          // Rebase only a new full, unique identity after a complete prior call
          // and with an explicit declared function name. Never concatenate IDs,
          // alias a correction, or guess an interleaved/unfinished call's owner.
          if (allowOpaqueReasoning && opaqueModelId === 'ultimate' && !allowLegacyEnvelope && wireIndex === 0 && t.index === 0 && call.id && typeof t.id === 'string' && t.id && call.id !== t.id) {
            let args; try { args = JSON.parse(call.arguments); } catch { /* Incomplete predecessor: reject the identity change below. */ }
            if (record(args) && toolNames.includes(call.name) && toolNames.includes(t.function.name) && t.id.length <= 512 && !t.id.startsWith(call.id) && !call.id.startsWith(t.id) && ![...calls.values()].some(c => c.id === t.id)) {
              index = freeIndex(); wireIndexes.set(wireIndex, index); call = { id: '', name: '', arguments: '' };
            }
          }
          const out = { index, type: 'function', function: {} };
          if (t.id !== undefined && t.id !== '') {
            if (typeof t.id !== 'string' || t.id.length > 512 || (call.id && call.id !== t.id)) fail('invalid_tool_id');
            call.id = out.id = t.id;
          }
          for (const field of ['name', 'arguments']) {
            if (t.function[field] !== undefined) {
              if (typeof t.function[field] !== 'string') fail('invalid_tool_delta');
              call[field] += t.function[field]; out.function[field] = t.function[field];
            }
          }
          if (call.name.length > 512 || call.arguments.length > maxFrameBytes) fail('tool_call_oversized');
          calls.set(index, call);
          return out;
        });
      }
      let finish = choice.finish_reason;
      if (finish !== undefined && finish !== null) {
        if (finished || !['stop', 'tool_calls', 'length'].includes(finish)) fail('invalid_finish_reason');
        finished = true;
        if (finish === 'length' && calls.size) fail('truncated_tool_call');
        if (finish === 'tool_calls' && !calls.size) fail('missing_tool_call');
        if (finish === 'stop' && calls.size) finish = 'tool_calls';
      }
      return { index: 0, delta: output, finish_reason: finish ?? null };
    });
    const normalized = { choices };
    for (const key of ['id', 'model', 'object', 'created']) if (chunk[key] !== undefined) normalized[key] = chunk[key];
    if (chunk.usage !== undefined && chunk.usage !== null) {
      normalized.usage = usageOnly(chunk.usage); usageSeen = true;
      try { void Promise.resolve(onCreditUsage?.(creditFields(chunk.usage))).catch(() => {}); } catch { /* Optional sanitized metering cannot break inference. */ }
    }
    return normalized;
  };
  try {
    for (;;) {
      if (signal?.aborted) fail('aborted');
      const next = await reader.read();
      if (signal?.aborted) fail('aborted');
      total += next.value?.byteLength ?? 0;
      if (total > maxTotalBytes) fail('stream_oversized');
      buffer += next.done ? decoder.decode() : decoder.decode(next.value, { stream: true });
      let index;
      while ((index = buffer.search(/[\r\n]/)) !== -1) {
        // A CR at the chunk boundary may still be followed by LF.
        if (buffer[index] === '\r' && index === buffer.length - 1 && !next.done) break;
        const width = buffer[index] === '\r' && buffer[index + 1] === '\n' ? 2 : 1;
        const line = buffer.slice(0, index); buffer = buffer.slice(index + width);
        frameSize += encoder.encode(line).length;
        if (frameSize > maxFrameBytes) fail('frame_oversized');
        if (line === '') {
          if (lines.length) { const value = convert(parseFrame(lines, onDiagnostic, allowLegacyEnvelope)); if (value) yield value; }
          lines = []; frameSize = 0;
        } else lines.push(line);
      }
      if (encoder.encode(buffer).length + frameSize > maxFrameBytes) fail('frame_oversized');
      if (next.done) break;
    }
    if (buffer.trim() || lines.length || !done) fail('incomplete_stream');
  } catch (error) {
    if (error instanceof QoderError) throw error;
    if (!signal?.aborted) {
      try { void Promise.resolve(onDiagnostic?.({ code: 'transport_failure', phase: 'stream' })).catch(() => {}); } catch { /* Allowlisted metadata only. */ }
    }
    throw new QoderError(signal?.aborted ? 'aborted' : 'stream_failed');
  } finally {
    signal?.removeEventListener('abort', cancel);
    // A stalled underlying cancel must not stall terminal error delivery.
    cancel();
    reader.releaseLock();
  }
}

// Maintenance/compatibility view of the same validated stream, re-encoded as
// OpenAI-shaped SSE. The product translator consumes `qoderChunks` directly;
// this exists for wire probes and the frame-semantics regression suite, and adds
// no parsing, recovery or termination rule of its own.
export async function* normalizeSSE(body, options) {
  for await (const value of qoderChunks(body, options)) {
    yield value === STREAM_DONE ? 'data: [DONE]\n\n' : `data: ${JSON.stringify(value)}\n\n`;
  }
}

// Eager Qoder dispatch shared by the product translator and the SSE compat
// wrapper. Validates the request payload against the bound model contract,
// encodes the direct or COSY wire body, and performs the single HTTP dispatch
// with credential, metering, timeout and abort handling. Pre-stream failures
// (scope, auth, HTTP status, content type) reject synchronously; the returned
// `chunks` async iterable yields validated chunk records and surfaces
// stream-time failures. It never yields STREAM_DONE, so normal completion of
// `chunks` is itself proof of clean termination because qoderChunks fails
// closed on any incomplete or malformed stream ending.
export async function openQoderStream({ payload, getToken, getLegacyCredential, legacyModel, fetchImpl = globalThis.fetch, modelId = 'lite', sessionId = randomUUID(), timeoutMs = 60000, onDiagnostic, onMetering, reasoningMode, signal } = {}) {
  // Models.json, onPayload and SDK overrides must never redirect credentials.
  const input = inputCapabilities(legacyModel?.id === modelId ? legacyModel : undefined);
  if (signal?.aborted) fail('aborted');
  if (!SUPPORTED_MODEL_IDS.includes(modelId) || !record(payload) || payload.model !== modelId || !Array.isArray(payload.messages) || payload.stream !== true) fail('request_scope_rejected');
  if (['custom_model', 'model_config', 'provider', 'patches', 'thinking', 'reasoning', 'chat_template_kwargs', 'chat_template_args'].some(key => payload[key] !== undefined)) fail('request_scope_rejected');
  // Revalidate after Pi onPayload hooks: unsupported modalities must not be
  // silently dropped or sent using overrides of the registered model contract.
  for (const m of payload.messages) {
    if (!record(m)) fail('images_not_validated');
    if (Object.keys(m).some(k => !['role', 'content', 'name', 'tool_call_id', 'tool_calls', 'reasoning_content', 'reasoning_details', 'reasoning_item', 'reasoning_content_signature'].includes(k))) fail('request_scope_rejected');
    if (m.content == null || typeof m.content === 'string') continue;
    if (!Array.isArray(m.content)) fail('images_not_validated');
    for (const c of m.content) {
      if (record(c) && c.type === 'text' && typeof c.text === 'string' && Object.keys(c).every(k => ['type', 'text'].includes(k))) continue;
      if (!input.images || legacyModel?.id !== modelId || m.role !== 'user') fail('images_not_validated');
      if (!record(c) || c.type !== 'image_url' || Object.keys(c).some(k => !['type', 'image_url'].includes(k)) || !record(c.image_url) || Object.keys(c.image_url).some(k => !['url', 'detail'].includes(k)) || c.image_url.detail !== undefined && c.image_url.detail !== 'auto') fail('invalid_image');
      const match = typeof c.image_url.url === 'string' && c.image_url.url.match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/);
      if (!match) fail('invalid_image');
      imageByteLength(match[2], match[1]);
    }
  }
  const allowReasoning = REASONING_MODEL_IDS.includes(modelId);
  payload.messages = payload.messages.map(m => {
    // Raw replay overrides are rejected; only the explicit Pi signature
    // contract is converted back to the original two-field server item.
    if (m.reasoning_item != null || m.reasoning_content_signature != null) fail('opaque_reasoning_replay_unsupported');
    if (m.reasoning_details == null) return m;
    if (!OPAQUE_MODEL_IDS.includes(modelId) || m.role !== 'assistant') fail('opaque_reasoning_replay_unsupported');
    const { reasoning_details, ...message } = m;
    if (!LEGACY_MODEL_IDS.includes(modelId) && Array.isArray(reasoning_details) && reasoning_details.some(d => d?.format === ULTIMATE_COSY_REASONING_FORMAT)) fail('opaque_reasoning_replay_unsupported');
    return { ...message, reasoning_item: reasoningDetailsToItem(reasoning_details, modelId) };
  });
  if (reasoningMode !== undefined) {
    if (!record(reasoningMode) || Object.keys(reasoningMode).sort().join(',') !== 'effort,enabled' || typeof reasoningMode.enabled !== 'boolean' || reasoningMode.enabled !== (reasoningMode.effort !== 'none') || !VERIFIED_THINKING_LEVELS[modelId]?.includes(reasoningMode.effort === 'none' ? 'off' : reasoningMode.effort)) fail('reasoning_mode_rejected');
    // This request-local mode was selected against the bound catalog BEFORE
    // native serialization. Hooks cannot substitute a different valid effort.
    if (payload.reasoning_effort !== reasoningMode.effort || payload.enable_thinking !== undefined && payload.enable_thinking !== reasoningMode.enabled) fail('reasoning_mode_rejected');
    if (payload.messages.some(m => m.reasoning_content != null && (m.role !== 'assistant' || typeof m.reasoning_content !== 'string'))) fail('reasoning_mode_rejected');
    payload.enable_thinking = reasoningMode.enabled;
  } else if (allowReasoning) {
    if (payload.enable_thinking === false || payload.reasoning_effort != null) fail('reasoning_mode_rejected');
    if (payload.messages.some(m => m.reasoning_content != null && (m.role !== 'assistant' || typeof m.reasoning_content !== 'string'))) fail('reasoning_mode_rejected');
    payload.enable_thinking = true;
    delete payload.reasoning_effort;
  } else {
    if (payload.enable_thinking === true || (payload.reasoning_effort != null && payload.reasoning_effort !== 'none') || payload.messages.some(m => m.reasoning_content)) fail('reasoning_not_validated');
    payload.enable_thinking = false;
    payload.reasoning_effort = 'none';
  }
  if (payload.tools !== undefined && (!Array.isArray(payload.tools) || payload.tools.some(t => !record(t) || t.type !== 'function' || !record(t.function) || typeof t.function.name !== 'string'))) fail('request_scope_rejected');
  const maxTokens = payload.max_tokens ?? 4096;
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > 4096) fail('request_limits_rejected');
  payload.max_tokens = maxTokens;
  const requestId = randomUUID();
  payload.metadata = { context: { request_id: requestId, request_set_id: requestId, session_id: sessionId, task_id: 'common', client_type: 'rotom' } };
  const legacy = LEGACY_MODEL_IDS.includes(modelId);
  const wireBody = legacy ? legacyBody(payload, legacyModel, requestId, sessionId, reasoningMode, input) : JSON.stringify(payload);
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const timer = setTimeout(abort, timeoutMs);
  const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
  const meter = createCreditCollector(); let dispatchStarted = false, meterFinished = false;
  const report = outcome => {
    if (!dispatchStarted || meterFinished) return; meterFinished = true;
    try { void Promise.resolve(onMetering?.({ modelId, requestId, ...meter.finish(outcome) })).catch(() => {}); } catch { /* Metadata only, no retry or effect on inference. */ }
  };
  let response;
  try {
    if (controller.signal.aborted) fail('aborted');
    const token = await abortable(getToken, controller.signal);
    if (controller.signal.aborted) fail('aborted');
    let headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'text/event-stream', 'User-Agent': 'rotom-qoder/1.0', 'X-Request-ID': requestId, 'X-Session-ID': sessionId };
    if (legacy) {
      // Request-local credential captured by the same bound token lookup;
      // never consult a mutable current-user record after authentication.
      const credential = getLegacyCredential?.();
      if (credential?.accessToken !== token) fail('legacy_auth_unavailable');
      headers = legacyHeaders(credential, wireBody, modelId);
    }
    response = await abortable(async () => {
      dispatchStarted = true;
      const result = await fetchImpl(legacy ? LEGACY_URL : CHAT_URL, {
        method: 'POST', redirect: 'error', signal: controller.signal,
        headers,
        body: wireBody,
      });
      if (controller.signal.aborted) { void result.body?.cancel().catch(() => {}); fail('aborted'); }
      return result;
    }, controller.signal);
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      fail(`http_${response.status}`);
    }
    if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream')) { void response.body?.cancel().catch(() => {}); fail('invalid_content_type'); }
  } catch (error) {
    report(controller.signal.aborted ? 'aborted' : 'error'); cleanup();
    if (error instanceof QoderError) throw error;
    if (!controller.signal.aborted) {
      try { void Promise.resolve(onDiagnostic?.({ code: 'transport_failure', phase: 'request' })).catch(() => {}); } catch { /* Allowlisted metadata only. */ }
    }
    throw new QoderError(controller.signal.aborted ? 'aborted' : 'request_failed');
  }
  const frames = qoderChunks(response.body, { signal: controller.signal, onDiagnostic, onCreditUsage: usage => meter.observe(usage), allowReasoning: allowReasoning && reasoningMode?.enabled !== false, allowOpaqueReasoning: OPAQUE_MODEL_IDS.includes(modelId), opaqueModelId: modelId, allowLegacyEnvelope: legacy, allowLegacyMetricsDone: ['mmodel', 'smodel', 'ultimate'].includes(modelId), toolNames: (payload.tools ?? []).map(t => t.function?.name) });
  async function* chunks() {
    try {
      // STREAM_DONE is swallowed: downstream consumers treat normal completion
      // of this generator as the clean-termination signal, and any trailing
      // data after DONE makes qoderChunks throw before we ever finish here.
      for await (const value of frames) { if (value !== STREAM_DONE) yield value; }
      report('complete');
    } catch (error) {
      report(controller.signal.aborted ? 'aborted' : 'error');
      if (error instanceof QoderError) throw error;
      throw new QoderError(controller.signal.aborted ? 'aborted' : 'request_failed');
    } finally {
      controller.abort();
      try { await frames.return?.(); } catch { /* reader already settled */ }
      cleanup();
      if (!meterFinished) report('aborted');
    }
  }
  return { chunks: chunks(), requestId, controller };
}

// Thin fetch-compatible wrapper: probes and regression tests exercise the wire
// contract through fetch(url, init) and expect DONE-terminated SSE. Pre-stream
// failures reject the returned promise; stream-time failures surface while the
// caller reads the body, matching the original transport behavior.
export function createQoderFetch(options = {}) {
  const { modelId = 'lite', legacyModel } = options;
  return async (url, init) => {
    // Models.json, onPayload and SDK overrides must never redirect credentials.
    const input = inputCapabilities(legacyModel?.id === modelId ? legacyModel : undefined);
    if (init?.signal?.aborted) fail('aborted');
    const inboundLimit = (input.contextLength === 400000 ? 12 : 2) * 1024 * 1024;
    if (String(url) !== CHAT_URL || init?.method?.toUpperCase() !== 'POST' || typeof init.body !== 'string' || (!input.images && Buffer.byteLength(init.body) > inboundLimit)) fail('request_scope_rejected');
    let payload;
    try { payload = JSON.parse(init.body); } catch { fail('invalid_request'); }
    const { chunks } = await openQoderStream({ ...options, payload, signal: init.signal });
    const iterator = chunks[Symbol.asyncIterator]();
    const stream = new ReadableStream({
      async pull(out) {
        try {
          const next = await iterator.next();
          if (next.done) { out.enqueue(encoder.encode('data: [DONE]\n\n')); out.close(); return; }
          out.enqueue(encoder.encode(`data: ${JSON.stringify(next.value)}\n\n`));
        } catch (error) { out.error(error); }
      },
      async cancel() { try { await iterator.return?.(); } catch { /* already settled */ } },
    });
    return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } });
  };
}
