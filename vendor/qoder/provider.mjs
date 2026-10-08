import { findPackageJSON } from 'node:module';
import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readLocalCredential, createCredentialAccess, QoderError } from './auth.mjs';
import { BASE_URL, SUPPORTED_MODEL_IDS, REASONING_MODEL_IDS, openQoderStream, abortable, validateReasoningSignature, OPAQUE_MODEL_IDS, VERIFIED_THINKING_LEVELS, EXPANDED_INPUT_MODEL_IDS, inputCapabilities, imageByteLength } from './transport.mjs';
import { buildQoderPayload, isSameModelAssistant } from './messages.mjs';
import { translateQoderStream } from './translate.mjs';
import { catalogMetadata, fetchCatalog, parseCatalogMetadata, CATALOG_TTL_MS } from './catalog.mjs';
import { createBrowserOAuth, createOAuthEnvelope } from './oauth.mjs';
import { fetchQuota } from './credits.mjs';

export const PROVIDER_ID = 'qoder';
export const MODEL = {
  id: 'lite', name: 'Qoder Lite',
  // Self-owned api identity: the extension builds the request payload and
  // translates the response itself (messages.mjs + translate.mjs), so sessions
  // are pinned to "qoder" and never share replay history with the former
  // "openai-completions" identity. Older sessions fail model_scope by design.
  api: 'qoder', provider: PROVIDER_ID, baseUrl: BASE_URL,
  reasoning: false, input: ['text'],
  // Conservative adapter limits, not a claim about the service's capacity.
  contextWindow: 32000, maxTokens: 4096,
  // Pi requires numeric prices. These placeholders are NOT zero-cost evidence.
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  compat: { supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: false, supportsStrictMode: false, maxTokensField: 'max_tokens' },
};

// Offline baseline retains the two historical identities; named labels come from discovery.
export const MODELS = Object.freeze(['lite', 'performance'].map(id => Object.freeze({
  ...MODEL, id, name: `Qoder ${id === 'lite' ? 'Lite' : 'Performance'}`,
})));

const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
function controlsFor(entry, declared = false) {
  const reviewed = VERIFIED_THINKING_LEVELS[entry?.id];
  if (!reviewed || !declared && !entry.reportedThinking) return;
  const levels = reviewed.filter(level => declared || (level === 'off' ? entry.reportedThinking.disabled : entry.reportedThinking.efforts.includes(level)));
  if (!levels.length) return;
  return { levels, defaultLevel: levels.includes(entry.reportedThinking?.defaultEffort) ? entry.reportedThinking.defaultEffort : levels.find(l => l !== 'off') ?? 'off' };
}
const thinkingMap = levels => Object.freeze(Object.fromEntries(THINKING_LEVELS.map(l => [l, levels.includes(l) ? l === 'off' ? 'none' : l : null])));
function catalogModel(entry, declared = false) {
  const declaredExpanded = declared && EXPANDED_INPUT_MODEL_IDS.includes(entry.id);
  const { id, name, contextWindow = declaredExpanded ? 272000 : 32000 } = entry, reasoning = REASONING_MODEL_IDS.includes(id), controls = controlsFor(entry, declared);
  return Object.freeze({ ...MODEL, id, name: `Qoder ${name}`, contextWindow, reasoning, input: Object.freeze(declaredExpanded || inputCapabilities(entry).images ? ['text', 'image'] : ['text']),
    ...(reasoning ? { thinkingLevelMap: controls ? thinkingMap(controls.levels) : { off: null, minimal: null, low: null, medium: 'enabled', high: null, xhigh: null, max: null } } : {}),
    ...(controls ? { compat: { ...MODEL.compat, supportsReasoningEffort: true } } : {}),
  });
}
// Pi selects an explicit/resumed model before session_start; refreshing the
// provider catalog does not replace that session's selected model object. Declare
// reviewed upper bounds here so native image/budget gates see them at startup,
// without programmatically reselecting the user's model or thinking level.
// Availability still filters to the baseline until discovery. Current-account
// dispatch gates reject absent/narrowed capabilities, including stale maxima.
const DECLARED_MODELS = Object.freeze(SUPPORTED_MODEL_IDS.map(id => MODELS.find(m => m.id === id) ?? catalogModel({ id, name: `${id} [catalog required]` }, true)));

// Pi's extension loader aliases the ai root to compat.js, so importing an
// arbitrary ai subpath through jiti would become compat.js/api/…. Resolve the
// public export from the launcher-verified Pi (or explicit SDK probe Pi), never
// from the business cwd or an unrelated global installation.
async function nativeOutputBudget() {
  const executable = process.env.ROTOM_VERIFIED_PI_EXECUTABLE ?? process.env.ROTOM_PI;
  if (!executable || !isAbsolute(executable)) throw new QoderError('pi_budget_runtime_unavailable');
  const metadata = findPackageJSON('@earendil-works/pi-ai/api/simple-options', pathToFileURL(executable));
  const pkg = JSON.parse(await readFile(metadata, 'utf8'));
  const exported = pkg.exports?.['./api/*']?.import;
  if (pkg.name !== '@earendil-works/pi-ai' || exported !== './dist/api/*.js') throw new QoderError('pi_budget_runtime_unavailable');
  return (await import(new URL(exported.replace('*', 'simple-options'), pathToFileURL(metadata)).href)).clampMaxTokensToContext;
}

export async function createQoderProvider({ piAI, clampMaxTokens, getToken, getCredential, captureBinding, captureMetering, fetchImpl, onDiagnostic, onMetering,
  authMode = process.env.ROTOM_QODER_AUTH ?? 'browser', oauthOptions = {}, refreshCatalog } = {}) {
  if (!['browser', 'qodercli'].includes(authMode)) throw new QoderError('invalid_auth_mode');
  const envelope = authMode === 'browser' ? createOAuthEnvelope() : undefined;
  let browserFingerprint;
  const browserBinding = captureBinding ?? (() => fingerprint => {
    if (browserFingerprint && browserFingerprint !== fingerprint) throw new QoderError('account_changed_start_new_session');
    browserFingerprint = fingerprint;
  });
  piAI ??= await import('@earendil-works/pi-ai');
  const authDir = process.env.ROTOM_QODER_AUTH_DIR;
  let catalogState, observedCLI;
  const sourceCLI = getCredential ?? (!getToken ? () => readLocalCredential({ authDir }) : undefined);
  const readCLI = sourceCLI ? async signal => { const c = await sourceCLI(signal); observedCLI = c.fingerprint; return c; } : undefined;
  const baseline = id => MODELS.some(m => m.id === id);
  const currentModels = () => catalogState?.models ?? DECLARED_MODELS;
  const checkCatalog = (credential, id, snapshot) => {
    if (snapshot !== catalogState) throw new QoderError('catalog_changed_select_again');
    if (baseline(id) && (!snapshot || snapshot.fingerprint !== credential.fingerprint)) return;
    if (!snapshot || snapshot.expiresAt <= Date.now()) throw new QoderError('catalog_refresh_required');
    if (snapshot.fingerprint !== credential.fingerprint) throw new QoderError('catalog_account_mismatch');
    if (!snapshot.models.some(m => m.id === id)) throw new QoderError('catalog_model_unavailable');
  };
  let checkAuth = getToken;
  if (!getToken && !envelope) {
    const access = createCredentialAccess({ readCredential: readCLI, captureBinding: browserBinding });
    getToken = access.getToken; checkAuth = access.check;
  }
  const prepare = async (method, model, context, options) => {
    // Pi 1.0 carries prompt/tool deltas in system messages. Qoder's wire API
    // needs one current prompt and tool set; replay through Pi's native helpers
    // so deferred tools and removals are neither lost nor resurrected.
    const transcript = piAI.normalizeContext(context);
    context = {
      systemPrompt: piAI.getCurrentSystemPrompt(transcript.messages),
      tools: piAI.getCurrentTools(transcript.messages),
      messages: transcript.messages.filter(message => message.role !== 'system'),
    };
    const reasoning = REASONING_MODEL_IDS.includes(model.id);
    if (!SUPPORTED_MODEL_IDS.includes(model.id) || model.provider !== PROVIDER_ID || model.baseUrl !== BASE_URL || model.api !== MODEL.api || model.reasoning !== reasoning || !Number.isSafeInteger(model.contextWindow) || model.contextWindow < 4096 || model.contextWindow > (EXPANDED_INPUT_MODEL_IDS.includes(model.id) ? 272000 : 32000) || model.maxTokens > 4096) throw new QoderError('model_scope_rejected');
    if (options.signal?.aborted) throw new QoderError('aborted');
    // Refresh through the session's native registry before building any payload,
    // including tool continuations and compaction. Never retry an inference.
    // Standalone/offline providers without this seam retain explicit discovery.
    if (refreshCatalog && (catalogState ? catalogState.expiresAt <= Date.now() : !baseline(model.id))) {
      await refreshCatalog({ signal: options.signal });
    }
    if (options.signal?.aborted) throw new QoderError('aborted');
    const snapshot = catalogState;
    if ((!baseline(model.id) && !snapshot) || snapshot?.expiresAt <= Date.now()) throw new QoderError('catalog_refresh_required');
    if (snapshot && !snapshot.models.some(m => m.id === model.id)) throw new QoderError('catalog_model_unavailable');
    const entry = snapshot?.entries.find(e => e.id === model.id), controls = controlsFor(entry), input = inputCapabilities(entry);
    if (model.contextWindow > input.contextWindow) throw new QoderError('catalog_changed_select_again');
    let reasoningMode;
    // Simple API encodes a selected off as an omitted option. If refreshed
    // capabilities remove off, do not reinterpret it as the server default/on.
    if (reasoning && model.thinkingLevelMap?.off != null && options.reasoning === undefined && options.reasoningEffort === undefined && !controls?.levels.includes('off')) throw new QoderError('catalog_changed_select_again');
    if (controls) {
      const key = method === 'streamSimple' ? 'reasoning' : 'reasoningEffort', other = method === 'streamSimple' ? 'reasoningEffort' : 'reasoning';
      if (options[other] !== undefined || options.thinkingBudgets !== undefined) throw new QoderError('reasoning_controls_not_validated');
      // Pi represents off by an omitted reasoning option. Models without an off
      // control retain their catalog default when SDK callers omit the option.
      const requested = options[key] ?? (controls.levels.includes('off') ? 'off' : controls.defaultLevel), level = requested === 'none' ? 'off' : requested;
      if (method === 'streamSimple' && requested === 'none' || !controls.levels.includes(level)) throw new QoderError('reasoning_controls_not_validated');
      reasoningMode = Object.freeze({ enabled: level !== 'off', effort: level === 'off' ? 'none' : level });
    } else if (reasoning ? (options.reasoning && options.reasoning !== 'medium') || options.reasoningEffort : options.reasoning || options.reasoningEffort) throw new QoderError('reasoning_controls_not_validated');
    for (const message of context.messages) {
      for (const block of Array.isArray(message.content) ? message.content : []) {
        if (block.type === 'image') {
          if (!input.images || !['user', 'toolResult'].includes(message.role)) throw new QoderError('images_not_validated');
          imageByteLength(block.data, block.mimeType);
        }
        // The builder removes foreign assistant signatures, retaining visible
        // text and tool/result pairing. Validate only signatures it can replay;
        // image gates above and post-hook wire validation are never bypassed.
        if (message.role === 'assistant' && !isSameModelAssistant(message, model)) continue;
        if (block.type === 'toolCall' && block.thoughtSignature) throw new QoderError('opaque_reasoning_replay_unsupported');
        if (block.type !== 'thinking' || !block.thinkingSignature) continue;
        if (message.role !== 'assistant') throw new QoderError('opaque_reasoning_replay_unsupported');
        if (reasoning && block.thinkingSignature === 'reasoning_content') continue;
        if (!OPAQUE_MODEL_IDS.includes(model.id)) throw new QoderError('opaque_reasoning_replay_unsupported');
        validateReasoningSignature(block.thinkingSignature, model.id);
      }
    }
    let requestCredential, recordMetering;
    try { recordMetering = captureMetering?.(); } catch { /* Optional accounting cannot bypass or block the binding gate. */ }
    const requestToken = envelope || readCLI ? createCredentialAccess({
      readCredential: async signal => {
        const c = envelope ? envelope.read(options.apiKey) : await readCLI(signal);
        checkCatalog(c, model.id, snapshot);
        requestCredential = c;
        return c;
      }, captureBinding: browserBinding,
    }).getToken : getToken;
    // Repeated long-history summarization can exceed 60 seconds. Reasoning
    // requests retain a bounded total deadline and immediate native cancellation;
    // extending that deadline is not a retry of an expired/unknown dispatch.
    // Native model view: corrected image capability and thinking controls for
    // request building and the persisted message identity. Pi retains
    // serialization, tool execution, context/branch management and the rest of
    // the agent lifecycle; only request encoding and response translation move
    // in-house here.
    const nativeModel = { ...model, contextWindow: input.contextWindow, input: input.images ? ['text', 'image'] : ['text'], ...(controls ? { thinkingLevelMap: thinkingMap(controls.levels), compat: { ...MODEL.compat, supportsReasoningEffort: true } } : {}) };
    clampMaxTokens ??= await nativeOutputBudget();
    const maxTokens = clampMaxTokens(nativeModel, context, Math.min(options.maxTokens ?? MODEL.maxTokens, MODEL.maxTokens));
    let payload = buildQoderPayload(nativeModel, context, { maxTokens, reasoningMode });
    // Preserve Pi's BeforeProviderRequest hook: an extension may rewrite the
    // payload, but openQoderStream re-validates the result against the bound
    // model contract, so a hook cannot smuggle an unsupported modality, a
    // different effort, or a credential/endpoint override past the gate.
    const hookedPayload = await options.onPayload?.(payload, nativeModel);
    if (hookedPayload !== undefined) payload = hookedPayload;
    // openQoderStream performs the single authoritative request validation, wire
    // encoding and HTTP dispatch, then yields validated chunk records; a
    // pre-stream failure rejects here and lazyStream turns it into an error
    // event carrying the stable "Qoder: <code>" message the session-policy reads.
    const { chunks } = await openQoderStream({ payload, getToken: requestToken, getLegacyCredential: () => requestCredential, legacyModel: entry, reasoningMode, fetchImpl, signal: options.signal, modelId: model.id, timeoutMs: reasoning ? 180000 : 60000, onDiagnostic, sessionId: options.sessionId, onMetering(data) {
      for (const notify of [() => recordMetering?.({ ...data, fingerprint: requestCredential?.fingerprint }), () => onMetering?.(data)]) {
        try { void Promise.resolve(notify()).catch(() => {}); } catch { /* Scoped metadata only; never retry a model request. */ }
      }
    } });
    return translateQoderStream(chunks, model);
  };
  const wrap = method => (model, context, options = {}) => piAI.lazyStream(model, async () => {
    try { return await prepare(method, model, context, options); }
    catch (error) {
      // Pi lazyStream labels setup exceptions as errors. Cancellation during
      // pre-dispatch discovery/auth must instead remain a native aborted event.
      if (!(error instanceof QoderError) || error.code !== 'aborted') throw error;
      return translateQoderStream((async function* () { throw error; })(), model);
    }
  });
  const provider = piAI.createProvider({
    id: PROVIDER_ID, name: 'Qoder', baseUrl: BASE_URL,
    models: DECLARED_MODELS,
    auth: envelope ? { oauth: { ...createBrowserOAuth(oauthOptions), toAuth: envelope.toAuth } } : { apiKey: {
      name: 'Read-only Qoder CLI login (no automatic refresh)',
      async resolve({ signal } = {}) {
        const deadline = AbortSignal.timeout(60000);
        await abortable(checkAuth, signal ? AbortSignal.any([signal, deadline]) : deadline);
        // Never hand the real token to Pi's overrides, hooks or credential store.
        return { auth: { apiKey: 'local-qoder-auth-resolved-at-dispatch' }, source: 'Qoder CLI local login, read-only' };
      },
    } },
    api: { stream: wrap('stream'), streamSimple: wrap('streamSimple') },
  });
  // Use the same ModelsStore publication seam as other dynamic providers. The
  // non-secret scope prevents a cached account catalog from crossing identities.
  return {
    ...provider, getModels: currentModels,
    filterModels(models, credential) {
      // A filter must never reintroduce a model removed by the caller/config.
      if (!catalogState) return models.filter(m => baseline(m.id));
      const fingerprint = envelope ? credential?.fingerprint : observedCLI;
      if (fingerprint !== catalogState.fingerprint) return models.filter(m => baseline(m.id));
      // Keep a stale disk catalog selectable while refresh is attempted. Dispatch
      // still requires a fresh catalog through prepare/checkCatalog.
      return models;
    },
    async refreshModels(context) {
      if (context.signal.aborted) return;
      let c;
      try {
        if (envelope) {
          const auth = await envelope.toAuth(context.credential);
          c = envelope.read(auth.apiKey);
        } else {
          if (!readCLI) throw new QoderError('catalog_identity_unavailable');
          c = await abortable(readCLI, context.signal);
        }
      } catch (error) {
        // Cache-only initialization without a configured credential must remain
        // equivalent to every other unavailable provider.
        if (!context.allowNetwork) return;
        throw error;
      }
      if (!catalogState && context.stored?.scope === c.fingerprint) {
        let entries;
        try { entries = parseCatalogMetadata(context.stored.metadata); } catch { entries = undefined; }
        if (entries) {
          const models = Object.freeze(entries.filter(e => e.enabled && e.reviewed && e.format === 'openai').map(e => catalogModel(e)));
          const checkedAt = Number.isSafeInteger(context.stored.checkedAt) ? context.stored.checkedAt : 0;
          if (!(await context.publish({ update: () => { catalogState = { fingerprint: c.fingerprint, expiresAt: checkedAt + CATALOG_TTL_MS, entries, models }; } }))) return;
        }
      }
      if (!context.allowNetwork || context.signal.aborted) return;
      if (!context.force && catalogState?.fingerprint === c.fingerprint && catalogState.expiresAt > Date.now()) return;
      const entries = await fetchCatalog(c, { fetchImpl, signal: context.signal });
      const models = Object.freeze(entries.filter(e => e.enabled && e.reviewed && e.format === 'openai').map(e => catalogModel(e)));
      if (context.signal.aborted) return;
      const checkedAt = Date.now();
      await context.publish({
        persist: { models, checkedAt, scope: c.fingerprint, metadata: catalogMetadata(entries) },
        update: () => { catalogState = { fingerprint: c.fingerprint, expiresAt: checkedAt + CATALOG_TTL_MS, entries, models }; },
      });
    },
    async getQuotaUsage({ apiKey, expectedFingerprint, signal } = {}) {
      const deadline = AbortSignal.timeout(15000), bounded = signal ? AbortSignal.any([signal, deadline]) : deadline;
      if (!envelope && !readCLI) throw new QoderError('quota_identity_unavailable');
      const c = envelope ? envelope.read(apiKey) : await abortable(readCLI, bounded);
      if (expectedFingerprint && expectedFingerprint !== c.fingerprint) throw new QoderError('account_changed_start_new_session');
      return fetchQuota(c, { fetchImpl, signal: bounded });
    },
    // Metadata only for the explicit command; never return credentials/raw bodies.
    getCatalogStatus: () => catalogState?.entries ?? [],
  };
}
