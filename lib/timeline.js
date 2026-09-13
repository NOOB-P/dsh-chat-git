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
 * Extract the durable image references of a user message.
 *
 * A prompt is not always text: a message may carry images, and 编辑并发送 has to
 * hand those back too, or the rebuilt conversation would start from a question
 * the user never asked — the same failure the unclipped prompt exists to
 * prevent, one content kind over.
 *
 * Only the **handle** is copied, projected leaf by leaf, never the live
 * attachment object and never its bytes: the browser half re-reads the bytes
 * through the source session's own authorization when it rebuilds the draft,
 * and everything else about the image (its media type, its name, its size)
 * comes back from that read rather than from this fold.
 * @param message - a session event's message payload.
 * @returns `{ attachmentId }` handles, in content order.
 */
export function imagesOfMessage(message) {
  if (typeof message !== 'object' || message === null) return []
  const content = message.content
  if (!Array.isArray(content)) return []
  const images = []
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue
    if (block.type !== 'image') continue
    const attachment = block.attachment
    if (attachment === null || typeof attachment !== 'object') continue
    if (typeof attachment.attachmentId !== 'string' || attachment.attachmentId === '') continue
    images.push({ attachmentId: attachment.attachmentId })
  }
  return images
}

/**
 * Whether one `user/message` is the harness's own compaction checkpoint.
 *
 * Compaction replaces a span of the surface with a synthesized user message
 * carrying the summary, and that message is a `user/message` like any other. It
 * is identified by its source marker (`{ kind: 'plugin', plugin: 'compact' }`,
 * plus the compaction id) rather than by its text, so this stays a shape check
 * instead of a phrase match. The marker is spelled out rather than imported
 * because this package has no dependencies, and a marker that ever changes can
 * only cost the old behaviour — never a crash.
 * @param message - a `user/message` event's payload.
 * @returns whether that message was written by the compaction backend.
 */
function isCompactionCheckpoint(message) {
  const source = message?.source
  if (source === null || typeof source !== 'object') return false
  return source.kind === 'plugin' && source.plugin === 'compact'
}

/**
 * Fold a session log into an ordered turn journal, prompts left whole.
 *
 * One entry per `turn/start`, carrying the turn's first user message as its
 * prompt and its `turn/end` sequence as its fork boundary. A turn that never
 * ended (still open, or the log was cut short) keeps a null `seq`, which the
 * callers treat as "cannot branch here" rather than guessing a boundary.
 *
 * The prompt is deliberately **not** clipped here, and {@link buildTimeline} is
 * the only place that clips it. The panel renders a card rather than a
 * transcript, so clipping is right for display — but the same prompt is what
 * 编辑并发送 hands back to the input box, and seeding an editor with a clip would
 * quietly ask the user to send something they never wrote.
 * @param events - the session's events, in append order.
 * @returns the journal, oldest turn first, every prompt unclipped.
 */
function fold(events) {
  const turns = []
  /** A user message that arrived before its `turn/start`, held for it. */
  let pendingPrompt = { text: '', images: [], seen: false }
  let current = null

  for (const event of events) {
    if (event === null || typeof event !== 'object') continue
    const data = event.data
    const seq = typeof event.seq === 'number' ? event.seq : null
    const time = typeof event.time === 'number' ? event.time : 0

    if (event.type === 'turn/start') {
      const turn = data?.turn
      if (typeof turn !== 'number') continue
      current = {
        turn,
        seq: null,
        prompt: pendingPrompt.text,
        images: pendingPrompt.images,
        promptSeen: pendingPrompt.seen,
        at: time,
        steps: 0,
        endReason: '',
      }
      pendingPrompt = { text: '', images: [], seen: false }
      // A retried turn re-appends `turn/start` for the same number; the newest
      // attempt is the one that can still be branched, so it replaces the old.
      const at = turns.findIndex((entry) => entry.turn === turn)
      if (at >= 0) turns[at] = current
      else turns.push(current)
      continue
    }

    if (event.type === 'user/message') {
      // A compaction checkpoint is a `user/message` that the harness synthesized
      // from the summary — not something the user typed. Letting it stand as the
      // prompt would put "This is an automatically generated checkpoint …" on the
      // card, and 编辑并发送 would then hand that preamble back as if it were the
      // request. Skipping it leaves the turn's real prompt in place.
      if (isCompactionCheckpoint(data)) continue
      const text = textOfMessage(data)
      const images = imagesOfMessage(data)
      // An image-only message is still a prompt: dropping it would leave the
      // card claiming the turn had no request at all.
      if (text === '' && images.length === 0) continue
      // Only the first user message of a turn is "the prompt"; anything later is
      // steering, which must not rewrite the card's title.
      if (current === null) {
        if (pendingPrompt.seen) continue
        pendingPrompt = { text, images, seen: true }
      } else if (!current.promptSeen) {
        current.prompt = text
        current.images = images
        current.promptSeen = true
      }
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

  return turns
}

/**
 * Fold a session log for display: the journal with every prompt clipped.
 *
 * The images are reported as a count rather than as references: the card only
 * has to say that this turn carried some, and the references are read from
 * {@link turnPrompt} by the one caller that actually needs to move them.
 * @param events - the session's events, in append order.
 * @returns the journal, oldest turn first.
 */
export function buildTimeline(events) {
  const clipped = fold(events).map((entry) => ({
    turn: entry.turn,
    at: entry.at,
    prompt: clip(entry.prompt, PROMPT_MAX_CHARS),
    imageCount: entry.images.length,
    seq: entry.seq,
    steps: entry.steps,
    endReason: entry.endReason,
  }))
  return clipped.length <= TIMELINE_MAX_TURNS ? clipped : clipped.slice(-TIMELINE_MAX_TURNS)
}

/**
 * The whole request one turn was started with: its text and its images.
 *
 * This is what the History pane's 编辑并发送 seeds the input box with, so it is
 * read from the same fold the panel uses rather than kept anywhere else: the
 * session log is the only record of what was asked.
 * @param events - the session's events, in append order.
 * @param turn - the turn whose prompt is wanted.
 * @returns `{ text, images }`, or null when this log has no such turn.
 */
export function turnPrompt(events, turn) {
  if (!Array.isArray(events)) return null
  const entry = fold(events).find((candidate) => candidate.turn === turn)
  if (entry === undefined) return null
  return { text: entry.prompt, images: entry.images }
}