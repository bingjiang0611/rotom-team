// Qoder response translator.
//
// Consumes the validated chunk records produced by `openQoderStream`
// (transport.mjs) and emits the standard Pi `AssistantMessageEvent` lifecycle,
// replacing the round-trip through the OpenAI SDK stream parser. The chunk
// records are already fully validated upstream — single choice, normalized and
// unique tool-call indices, complete/parseable tool arguments, bounded usage,
// at most one reasoning signature — so this layer only maps them onto Pi's
// event and content model. It adds no recovery, retry or termination rule of
// its own: normal completion of the source iterable is the clean-termination
// proof, and any thrown QoderError becomes a partial-preserving `error` event.
//
// The reasoning-signature encoding is deliberately identical to the encoding
// `buildQoderPayload` (messages.mjs) reads back: plain reasoning uses the
// literal signature `reasoning_content`; opaque reasoning stores the encrypted
// `reasoning_details` array as `JSON.stringify(details)` in the signature slot.
// Because Qoder sessions are pinned to `api: "qoder"` and never share history
// with the former `openai-completions` identity, the two ends only need to be
// mutually consistent, which this contract guarantees for replay round-trips.

import { QoderError } from './auth.mjs';

const zeroUsage = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });

// Mirror the documented OpenAI/OpenRouter usage semantics used by pi-ai:
// cached_tokens is a cache-read count already included in prompt_tokens, and
// completion_tokens already includes reasoning_tokens. usageOnly() in the
// transport has already rejected any negative or inconsistent counts.
function applyUsage(usage, raw) {
  const prompt = raw.prompt_tokens || 0;
  const cacheRead = raw.prompt_tokens_details?.cached_tokens ?? 0;
  const output = raw.completion_tokens || 0;
  const input = Math.max(0, prompt - cacheRead);
  usage.input = input;
  usage.output = output;
  usage.cacheRead = cacheRead;
  usage.cacheWrite = 0;
  usage.reasoning = raw.completion_tokens_details?.reasoning_tokens || 0;
  usage.totalTokens = input + output + cacheRead;
}

const FINISH_REASON = { stop: 'stop', tool_calls: 'toolUse', length: 'length' };

function parseSignatureDetails(signature) {
  if (!signature) return [];
  try { const parsed = JSON.parse(signature); return Array.isArray(parsed) ? parsed : []; } catch { return []; }
}

export async function* translateQoderStream(chunks, model) {
  const output = {
    role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id,
    usage: zeroUsage(), stopReason: 'pending', timestamp: Date.now(),
  };
  const blocks = output.content;
  const indexOf = block => blocks.indexOf(block);
  let textBlock = null, thinkingBlock = null, hasFinish = false;
  const toolByIndex = new Map();

  const ensureThinking = signature => {
    if (!thinkingBlock) {
      thinkingBlock = { type: 'thinking', thinking: '', thinkingSignature: signature };
      blocks.push(thinkingBlock);
      return { started: true };
    }
    return { started: false };
  };

  yield { type: 'start', partial: output };
  try {
    for await (const chunk of chunks) {
      if (chunk.usage) applyUsage(output.usage, chunk.usage);
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      const delta = choice.delta ?? {};

      if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
        if (ensureThinking('reasoning_content').started) yield { type: 'thinking_start', contentIndex: indexOf(thinkingBlock), partial: output };
        thinkingBlock.thinking += delta.reasoning_content;
        yield { type: 'thinking_delta', contentIndex: indexOf(thinkingBlock), delta: delta.reasoning_content, partial: output };
      }

      if (Array.isArray(delta.reasoning_details)) {
        // Opaque reasoning carries no plaintext; the encrypted details are held
        // in the signature slot so buildQoderPayload can replay them verbatim.
        if (ensureThinking('').started) yield { type: 'thinking_start', contentIndex: indexOf(thinkingBlock), partial: output };
        const preserved = parseSignatureDetails(thinkingBlock.thinkingSignature);
        for (const detail of delta.reasoning_details) preserved.push(detail);
        thinkingBlock.thinkingSignature = JSON.stringify(preserved);
      }

      if (typeof delta.content === 'string' && delta.content) {
        if (!textBlock) {
          textBlock = { type: 'text', text: '' };
          blocks.push(textBlock);
          yield { type: 'text_start', contentIndex: indexOf(textBlock), partial: output };
        }
        textBlock.text += delta.content;
        yield { type: 'text_delta', contentIndex: indexOf(textBlock), delta: delta.content, partial: output };
      }

      if (Array.isArray(delta.tool_calls)) {
        for (const call of delta.tool_calls) {
          let block = toolByIndex.get(call.index);
          if (!block) {
            block = { type: 'toolCall', id: typeof call.id === 'string' ? call.id : '', name: '', arguments: {}, partialArgs: '' };
            toolByIndex.set(call.index, block);
            blocks.push(block);
            yield { type: 'toolcall_start', contentIndex: indexOf(block), partial: output };
          }
          if (typeof call.id === 'string' && call.id) block.id = call.id;
          if (typeof call.function?.name === 'string') block.name += call.function.name;
          if (typeof call.function?.arguments === 'string' && call.function.arguments) {
            block.partialArgs += call.function.arguments;
            yield { type: 'toolcall_delta', contentIndex: indexOf(block), delta: call.function.arguments, partial: output };
          }
        }
      }

      if (choice.finish_reason) {
        hasFinish = true;
        output.stopReason = FINISH_REASON[choice.finish_reason] ?? 'stop';
      }
    }
  } catch (error) {
    // Preserve whatever content already streamed and surface the stable Qoder
    // code through errorMessage; the session-policy help path matches on it.
    for (const block of blocks) if (block.type === 'toolCall') delete block.partialArgs;
    output.stopReason = error instanceof QoderError && error.code === 'aborted' ? 'aborted' : 'error';
    output.errorMessage = error instanceof Error ? error.message : String(error);
    yield { type: 'error', reason: output.stopReason, error: output };
    return;
  }

  // Finalize blocks in content order so persisted indices stay stable.
  for (const block of blocks) {
    if (block.type === 'text') {
      yield { type: 'text_end', contentIndex: indexOf(block), content: block.text, partial: output };
    } else if (block.type === 'thinking') {
      yield { type: 'thinking_end', contentIndex: indexOf(block), content: block.thinking, partial: output };
    } else if (block.type === 'toolCall') {
      // qoderChunks already proved these arguments parse to an object at DONE;
      // this re-parse only materializes the object for the persisted tool call.
      let args;
      try { args = JSON.parse(block.partialArgs || '{}'); } catch { throw new QoderError('invalid_tool_arguments'); }
      if (args === null || typeof args !== 'object' || Array.isArray(args)) throw new QoderError('invalid_tool_arguments');
      block.arguments = args;
      delete block.partialArgs;
      yield { type: 'toolcall_end', contentIndex: indexOf(block), toolCall: block, partial: output };
    }
  }

  if (!hasFinish) output.stopReason = blocks.some(block => block.type === 'toolCall') ? 'toolUse' : 'stop';
  yield { type: 'done', reason: output.stopReason, message: output };
}
