// Qoder request builder.
//
// Produces the OpenAI-shaped chat-completions payload that `openQoderStream`
// (transport.mjs) then validates and encodes onto the direct or COSY wire. This
// replaces the OpenAI SDK's `buildParams`/`convertMessages`/`transformMessages`
// pipeline for the self-owned `api: "qoder"` provider, so the extension no
// longer round-trips through the SDK just to reach its own transport.
//
// The output shape is deliberately the same OpenAI-compatible payload the Qoder
// service already accepts and that openQoderStream already validates key-by-key;
// "not pretending to be OpenAI" here means owning the api identity and the
// encode/parse code, not inventing a new wire dialect the server would reject.
//
// Compatibility is fixed for the Qoder model contract (see provider.mjs MODEL):
//   - system role only (no developer role)
//   - reasoning carried as `reasoning_content` (plain) or `reasoning_details`
//     (opaque, encrypted) exactly as translate.mjs signs it, so replay round-
//     trips; opaque details are never decrypted or interpreted
//   - function tools without strict mode or grammar constrained sampling
//   - `stream_options.include_usage` so the service reports usage
// Anything outside this contract is rejected upstream by openQoderStream, which
// remains the single authoritative request gate; this module must not widen it.

import { createHash } from 'node:crypto';
import { QoderError } from './auth.mjs';

// Drop unpaired UTF-16 surrogates before they reach the wire, matching pi-ai's
// sanitizeSurrogates. Orphaned surrogates are not valid text and some providers
// reject or corrupt them.
const sanitize = text => text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '');

const NON_VISION_USER_IMAGE_PLACEHOLDER = '(image omitted: model does not support images)';
const NON_VISION_TOOL_IMAGE_PLACEHOLDER = '(tool image omitted: model does not support images)';
const REASONING_CONTENT_FIELDS = ['reasoning', 'reasoning_content', 'reasoning_text'];

function replaceImagesWithPlaceholder(content, placeholder) {
  const result = [];
  let previousWasPlaceholder = false;
  for (const block of content) {
    if (block.type === 'image') {
      if (!previousWasPlaceholder) result.push({ type: 'text', text: placeholder });
      previousWasPlaceholder = true;
      continue;
    }
    result.push(block);
    previousWasPlaceholder = block.type === 'text' && block.text === placeholder;
  }
  return result;
}

function downgradeUnsupportedImages(messages, model) {
  if (model.input.includes('image')) return messages;
  return messages.map(msg => {
    if (msg.role === 'user' && Array.isArray(msg.content)) return { ...msg, content: replaceImagesWithPlaceholder(msg.content, NON_VISION_USER_IMAGE_PLACEHOLDER) };
    if (msg.role === 'toolResult') return { ...msg, content: replaceImagesWithPlaceholder(msg.content, NON_VISION_TOOL_IMAGE_PLACEHOLDER) };
    return msg;
  });
}

// Shared with the provider preflight: only this exact identity can retain
// signatures on the wire. Cross-model conversion never edits persisted history.
export function isSameModelAssistant(message, model) {
  return message.role === 'assistant' && message.provider === model.provider && message.api === model.api && message.model === model.id;
}

// OpenAI Responses persists `{call_id}|{item_id}` identifiers. Qoder's
// OpenAI-shaped replay accepts only the compact identifier form, so normalize
// foreign IDs request-locally and apply the same mapping to their tool results.
// The item-derived hash preserves uniqueness when one call_id owns multiple
// response items; same-model Qoder IDs always remain byte-for-byte unchanged.
function normalizeForeignToolCallId(id) {
  if (typeof id !== 'string' || !id.includes('|')) return id;
  const separator = id.indexOf('|');
  const callId = id.slice(0, separator).replace(/[^a-zA-Z0-9_-]/g, '_') || 'call';
  const itemId = id.slice(separator + 1).replace(/[^a-zA-Z0-9_-]/g, '_');
  const combined = itemId ? `${callId}_${itemId}` : callId;
  if (combined.length <= 40) return combined;
  const hash = createHash('sha256').update(id).digest('hex').slice(0, 8);
  return `${callId.slice(0, Math.max(1, 39 - hash.length))}_${hash}`;
}

// First/second-pass history normalization, ported from pi-ai transformMessages
// for the Qoder subset. It keeps encrypted/signed thinking only for the same
// model, normalizes foreign OpenAI Responses tool IDs, skips errored/aborted
// assistant turns, and inserts synthetic results for orphaned tool calls.
function transformMessages(messages, model) {
  const normalized = messages.map(msg => (msg.content == null ? { ...msg, content: [] } : msg));
  const imageAware = downgradeUnsupportedImages(normalized, model);
  const toolCallIdMap = new Map();
  const transformed = imageAware.map(msg => {
    if (msg.role === 'toolResult') {
      const id = toolCallIdMap.get(msg.toolCallId);
      return id && id !== msg.toolCallId ? { ...msg, toolCallId: id } : msg;
    }
    if (msg.role !== 'assistant') return msg;
    const isSameModel = isSameModelAssistant(msg, model);
    const content = msg.content.flatMap(block => {
      if (block.type === 'thinking') {
        if (block.redacted) return isSameModel ? block : [];
        if (isSameModel && block.thinkingSignature) return block;
        if (!block.thinking || block.thinking.trim() === '') return [];
        return isSameModel ? block : { type: 'text', text: block.thinking };
      }
      if (block.type === 'text') return isSameModel ? block : { type: 'text', text: block.text };
      if (block.type === 'toolCall') {
        let copy = block;
        if (!isSameModel && block.thoughtSignature) { copy = { ...copy }; delete copy.thoughtSignature; }
        if (!isSameModel) {
          const id = normalizeForeignToolCallId(block.id);
          if (id !== block.id) { toolCallIdMap.set(block.id, id); copy = { ...copy, id }; }
        }
        return copy;
      }
      return block;
    });
    return { ...msg, content };
  });

  const result = [];
  let pendingToolCalls = [];
  let existingToolResultIds = new Set();
  const insertSynthetic = () => {
    if (!pendingToolCalls.length) return;
    for (const tc of pendingToolCalls) {
      if (!existingToolResultIds.has(tc.id)) result.push({ role: 'toolResult', toolCallId: tc.id, toolName: tc.name, content: [{ type: 'text', text: 'No result provided' }], isError: true, timestamp: Date.now() });
    }
    pendingToolCalls = [];
    existingToolResultIds = new Set();
  };
  for (const msg of transformed) {
    if (msg.role === 'assistant') {
      insertSynthetic();
      // Incomplete turns must not be replayed; the model retries from the last
      // valid state instead of re-ingesting partial reasoning/tool calls.
      if (msg.stopReason === 'error' || msg.stopReason === 'aborted') continue;
      const toolCalls = msg.content.filter(b => b.type === 'toolCall');
      if (toolCalls.length) { pendingToolCalls = toolCalls; existingToolResultIds = new Set(); }
      result.push(msg);
    } else if (msg.role === 'toolResult') {
      existingToolResultIds.add(msg.toolCallId);
      result.push(msg);
    } else if (msg.role === 'user') {
      insertSynthetic();
      result.push(msg);
    } else {
      result.push(msg);
    }
  }
  insertSynthetic();
  return result;
}

function reasoningDetailsFromSignature(signature) {
  if (typeof signature !== 'string' || !signature) return undefined;
  try {
    const parsed = JSON.parse(signature);
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : undefined;
  } catch { return undefined; }
}

function convertMessages(model, context) {
  const params = [];
  const messages = transformMessages(context.messages, model);
  if (context.systemPrompt) params.push({ role: 'system', content: sanitize(context.systemPrompt) });

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    if (msg.role === 'user') {
      if (typeof msg.content === 'string') { params.push({ role: 'user', content: sanitize(msg.content) }); continue; }
      const content = msg.content.map(item => {
        if (item.type === 'text') return { type: 'text', text: sanitize(item.text) };
        if (item.type === 'image') return { type: 'image_url', image_url: { url: `data:${item.mimeType};base64,${item.data}` } };
        return null;
      }).filter(Boolean);
      params.push({ role: 'user', content });
      continue;
    }

    if (msg.role === 'assistant') {
      const assistant = { role: 'assistant', content: null };
      const textParts = msg.content.filter(b => b.type === 'text' && b.text.trim().length > 0).map(b => sanitize(b.text));
      const assistantText = textParts.join('');
      const thinkingBlocks = msg.content.filter(b => b.type === 'thinking');
      const toolCalls = msg.content.filter(b => b.type === 'toolCall');
      // Opaque reasoning is replayed structurally via reasoning_details; the
      // signature slot holds the encrypted array translate.mjs produced.
      const preservedReasoningDetails = thinkingBlocks.map(b => reasoningDetailsFromSignature(b.thinkingSignature)).find(d => d !== undefined);
      const nonEmptyThinking = thinkingBlocks.filter(b => b.thinking.trim().length > 0);

      if (nonEmptyThinking.length > 0) {
        if (assistantText.length > 0) assistant.content = assistantText;
        if (!preservedReasoningDetails) {
          const signature = nonEmptyThinking[0].thinkingSignature;
          if (signature && REASONING_CONTENT_FIELDS.includes(signature)) assistant[signature] = nonEmptyThinking.map(b => b.thinking).join('\n');
        }
      } else if (assistantText.length > 0) {
        assistant.content = assistantText;
      }

      if (toolCalls.length > 0) assistant.tool_calls = toolCalls.map(tc => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: JSON.stringify(tc.arguments) } }));
      if (preservedReasoningDetails) assistant.reasoning_details = preservedReasoningDetails;

      const content = assistant.content;
      const hasContent = content !== null && content !== undefined && (typeof content === 'string' ? content.length > 0 : content.length > 0);
      if (!hasContent && !assistant.tool_calls) continue;
      params.push(assistant);
      continue;
    }

    if (msg.role === 'toolResult') {
      // Batch consecutive tool results into individual tool messages, then emit
      // any attached images as one following user message. Only user-role
      // messages may carry images on the wire (openQoderStream enforces this).
      const imageBlocks = [];
      let j = i;
      for (; j < messages.length && messages[j].role === 'toolResult'; j++) {
        const toolMsg = messages[j];
        const textResult = toolMsg.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
        const hasImages = toolMsg.content.some(b => b.type === 'image');
        const text = textResult.length > 0 ? textResult : hasImages ? '(see attached image)' : '(no tool output)';
        params.push({ role: 'tool', content: sanitize(text), tool_call_id: toolMsg.toolCallId });
        if (hasImages && model.input.includes('image')) {
          for (const block of toolMsg.content) if (block.type === 'image') imageBlocks.push({ type: 'image_url', image_url: { url: `data:${block.mimeType};base64,${block.data}` } });
        }
      }
      i = j - 1;
      if (imageBlocks.length > 0) params.push({ role: 'user', content: [{ type: 'text', text: 'Attached image(s) from tool result:' }, ...imageBlocks] });
      continue;
    }
  }
  return params;
}

function convertTools(tools) {
  return tools.map(tool => {
    // Qoder does not advertise strict json-schema or grammar constrained
    // sampling; a tool that hard-requires strict mode fails closed rather than
    // being silently downgraded to an unconstrained tool.
    if (tool.constrainedSampling && tool.constrainedSampling.type === 'json_schema' && tool.constrainedSampling.strict === 'require') throw new QoderError('tool_constrained_sampling_unsupported');
    return { type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } };
  });
}

function hasToolHistory(messages) {
  return messages.some(m => m.role === 'toolResult' || (m.role === 'assistant' && Array.isArray(m.content) && m.content.some(b => b.type === 'toolCall')));
}

// Assemble the payload openQoderStream validates. reasoning_effort is set only
// when a validated reasoning mode is bound; openQoderStream owns enable_thinking
// and the non-reasoning defaults, so this must not pre-set them.
export function buildQoderPayload(model, context, { maxTokens, reasoningMode } = {}) {
  const payload = {
    model: model.id,
    messages: convertMessages(model, context),
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: maxTokens,
  };
  if (reasoningMode) payload.reasoning_effort = reasoningMode.effort;
  const tools = context.tools ?? [];
  if (tools.length > 0) payload.tools = convertTools(tools);
  else if (hasToolHistory(context.messages)) payload.tools = [];
  return payload;
}
