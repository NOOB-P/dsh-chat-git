/**
 * Timeline folding for dsh-chat-git.
 *
 * The checkpoint store only knows the turns that produced a commit. The panel
 * has to list *every* turn of a conversation, in order, with the sequence each
 * one closed on — and that is exactly what the session log already records.
 *
 * `Session.snapshotEvents()` yields the append log, whose declared event map
 * carries `turn/start`, `user/message`, `assistant/message`, and `turn/end`
 * (with the turn number and, on a `SessionEvent`, its own `seq`). Folding that
 * log is authoritative: it does not depend on which turns the chat view happens
 * to have rendered, so a turn scrolled far out of the window still gets a usable
 * fork boundary.
 * @module dsh-chat-git/timeline
 */

/** Longest prompt kept per turn; the panel renders a card, not a transcript. */
export const PROMPT_MAX_CHARS = 300

/** Newest turns kept, so a very long conversation cannot grow the answer without bound. */
export const TIMELINE_MAX_TURNS = 500

/** Collapse whitespace and clip to a maximum length. */
function clip(text, max) {
  const flat = String(text).replace(/\s+/g, ' ').trim()
  if (flat === '') return ''
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}\u2026`
}

/**
 * Extract the plain text of a message across the content shapes the harness
 * uses. Only the scalar text is read; the live message object is never copied,
 * stringified, or retained.
 * @param message - a session event's message payload.
 * @returns the concatenated text blocks, or an empty string.
 */
export function textOfMessage(message) {
  if (typeof message !== 'object' || message === null) return ''
  const direct = message.text
  if (typeof direct === 'string') return direct
  const content = message.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join(' ')
}

/**
 * Fold a session log into an ordered turn journal.
 *
 * One entry per `turn/start`, carrying the turn's first user message as its
 * prompt and its `turn/end` sequence as its fork boundary. A turn that never
 * ended (still open, or the log was cut short) keeps a null `seq`, which the
 * callers treat as "cannot branch here" rather than guessing a boundary.
 * @param events - the session's events, in append order.
 * @returns the journal, oldest turn first.
 */
export function buildTimeline(events) {
  const turns = []
  /** A user message that arrived before its `turn/start`, held for it. */
  let pendingPrompt = ''
  let current = null

  for (const event of events) {
    if (event === null || typeof event !== 'object') continue
    const data = event.data
    const seq = typeof event.seq === 'number' ? event.seq : null
    const time = typeof event.time === 'number' ? event.time : 0

    if (event.type === 'turn/start') {
      const turn = data?.turn
      if (typeof turn !== 'number') continue
      current = { turn, seq: null, prompt: pendingPrompt, at: time, steps: 0, endReason: '' }
      pendingPrompt = ''
      // A retried turn re-appends `turn/start` for the same number; the newest
      // attempt is the one that can still be branched, so it replaces the old.
      const at = turns.findIndex((entry) => entry.turn === turn)
      if (at >= 0) turns[at] = current
      else turns.push(current)
      continue
    }

    if (event.type === 'user/message') {
      const text = textOfMessage(data)
      if (text === '') continue
      // Only the first user message of a turn is "the prompt"; anything later is
      // steering, which must not rewrite the card's title.
      if (current === null) pendingPrompt = text
      else if (current.prompt === '') current.prompt = text
      continue
    }

    if (current === null) continue

    if (event.type === 'assistant/message') {
      current.steps += 1
      continue
    }

    if (event.type === 'turn/end') {
      if (data?.turn !== current.turn) continue
      current.seq = seq
      if (time !== 0) current.at = time
      current.endReason = typeof data.reason?.kind === 'string' ? data.reason.kind : ''
      current = null
    }
  }

  const clipped = turns.map((entry) => ({
    turn: entry.turn,
    at: entry.at,
    prompt: clip(entry.prompt, PROMPT_MAX_CHARS),
    seq: entry.seq,
    steps: entry.steps,
    endReason: entry.endReason,
  }))
  return clipped.length <= TIMELINE_MAX_TURNS ? clipped : clipped.slice(-TIMELINE_MAX_TURNS)
}
