/**
 * AI commit-title generation for dsh-chat-git.
 *
 * The raw prompt makes a poor commit subject: it is long, often lists several
 * asks, and gets chopped mid-word by the length cap. This module asks the
 * harness `llm` service for one short title instead, given the prompt and the
 * files the turn actually touched.
 *
 * Everything here is best-effort by design. Any missing service, absent model
 * route, provider failure, timeout, or unusable answer returns `{ ok: false }`
 * and the caller keeps its deterministic fallback — an unreachable model must
 * never cost the user a checkpoint.
 * @module dsh-chat-git/summarize
 */

/** Wall-clock ceiling for one title call, so a turn end never stalls on the model. */
export const SUMMARIZE_TIMEOUT_MS = 8_000

/** Longest title kept; generous for the asked-for length but still a title. */
export const SUMMARY_MAX_CHARS = 40

/** Output-token ceiling; a title needs a handful of tokens. */
const MAX_TOKENS = 64

/** Characters that wrap a title the model decided to quote. */
const QUOTE_PAIRS = [
  ['"', '"'],
  ["'", "'"],
  ['\u300c', '\u300d'],
  ['\u201c', '\u201d'],
  ['\u300e', '\u300f'],
  ['\u300a', '\u300b'],
]

const SYSTEM = [
  'You write git commit subjects for an AI coding assistant.',
  'Given the user request and the files the turn changed, state in one line what this turn did.',
  'Rules:',
  '- Output the title only: no quotes, no prefix, no trailing period, no line breaks, no explanation.',
  '- Keep it short: at most 20 Chinese characters, or 10 English words.',
  '- Start with a verb or a noun phrase. Do not restate the request verbatim.',
  '- Write in the same language as the user request.',
].join('\n')

/** Read a failure message off an unknown thrown value. */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Reduce one model answer to a usable title.
 *
 * Models decorate: they wrap in quotes, prefix a label, add a trailing period,
 * or answer with a bullet. This strips that and enforces the length cap, so the
 * commit subject stays a subject whatever comes back.
 * @param text - the raw streamed answer.
 * @param max - longest title kept.
 * @returns the cleaned title, or an empty string when nothing usable remains.
 */
export function cleanSummary(text, max = SUMMARY_MAX_CHARS) {
  if (typeof text !== 'string') return ''
  let line = ''
  for (const candidate of text.split('\n')) {
    const trimmed = candidate.trim()
    if (trimmed !== '') {
      line = trimmed
      break
    }
  }
  if (line === '') return ''

  line = line.replace(/^[-*\u2022\d.)\s]+/, '')
  line = line.replace(/^(?:\u6807\u9898|\u63d0\u4ea4\u4fe1\u606f|\u63cf\u8ff0)\s*[:\uff1a]\s*/, '')
  line = line.replace(/^Ai-coding\s*[:\uff1a]\s*/iu, '')

  for (const [open, close] of QUOTE_PAIRS) {
    if (line.length > open.length + close.length && line.startsWith(open) && line.endsWith(close)) {
      line = line.slice(open.length, line.length - close.length).trim()
      break
    }
  }

  line = line.replace(/[.\u3002;\uff1b,\uff0c]+\s*$/, '').replace(/\s+/g, ' ').trim()
  if (line === '') return ''
  if (line.length <= max) return line
  return `${line.slice(0, max - 1).trimEnd()}\u2026`
}

/**
 * Assemble the single user message the title call receives.
 * @param prompt - the prompt that drove the turn (already whitespace-collapsed).
 * @param files - a compact `git diff --cached` digest, or an empty string.
 * @returns the message text.
 */
export function buildSummaryInput(prompt, files) {
  const parts = [`\u7528\u6237\u8bf7\u6c42\uff1a\n${String(prompt ?? '').trim() || '(\u65e0\u7528\u6237\u6d88\u606f)'}`]
  if (String(files ?? '').trim() !== '') {
    parts.push(`\u672c\u8f6e\u6539\u52a8\u6587\u4ef6\uff1a\n${String(files).trim()}`)
  }
  return parts.join('\n\n')
}

/**
 * Ask the model for one short title.
 * @param llm - the harness `llm` service.
 * @param selection - `{ provider, model }` naming the route to call.
 * @param input - the message text from {@link buildSummaryInput}.
 * @param signal - caller cancellation; the caller also bounds this with a timeout.
 * @returns `{ ok: true, title }` or `{ ok: false, error }`.
 */
export async function summarizeTurn(llm, selection, input, signal) {
  const messages = [{
    // `Message.id` is a branded string; the value only has to be unique.
    id: `chat-git-title-${Date.now().toString(36)}`,
    role: 'user',
    content: [{ type: 'text', text: input }],
    // The message is authored by this plugin, not by the user or the model.
    source: { kind: 'plugin', plugin: 'chat-git' },
  }]

  let text = ''
  let failure = ''
  try {
    for await (const chunk of llm.stream({
      provider: selection.provider,
      model: selection.model,
      system: SYSTEM,
      messages,
      temperature: 0,
      maxTokens: MAX_TOKENS,
      ...(signal === undefined ? {} : { signal }),
    })) {
      if (chunk === null || typeof chunk !== 'object') continue
      if (chunk.type === 'text-delta') text += typeof chunk.text === 'string' ? chunk.text : ''
      else if (chunk.type === 'finish') {
        const kind = chunk.reason?.kind
        if (kind === 'error' || kind === 'aborted') failure = chunk.reason?.failure?.message ?? kind
      }
    }
  } catch (error) {
    return { ok: false, error: messageOf(error) }
  }

  if (failure !== '') return { ok: false, error: failure }
  const title = cleanSummary(text)
  if (title === '') return { ok: false, error: 'the model returned no usable title' }
  return { ok: true, title }
}
