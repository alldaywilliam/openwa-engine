/**
 * We do not keep what people wrote.
 *
 * `stripMediaForStorage` (2026-08-08) stopped the DATABASE filling up: media blobs were 99,998% of
 * `messages` and took production down when the volume ran out. This module is the next step and it is
 * not about disk — after that fix the whole database is ~6 MB and grows under a megabyte a month.
 * It is about what the row IS. `messages` held 9.695 real conversations between barbershops and their
 * clients, the oldest from 2024-09-26, and nothing in the product ever read a single one back: the
 * barbershop API asks the gateway only for a message's delivery `status` and `chatId`, webhooks and
 * WebSocket dispatch the LIVE object rather than the stored row, and old media is re-downloaded from
 * WhatsApp on demand. So the text was pure liability — an archive of other people's conversations,
 * kept forever, serving nothing.
 *
 * What the row keeps is the operational log, which is what the product actually uses: who it was for,
 * when, which direction, what KIND of message, and whether it arrived. That is enough for a screen to
 * say "o cliente mandou uma foto às 14:32 e você respondeu" without holding either sentence.
 *
 * Two layers, for the same reason the media fix has two: a rule that lives only in TypeScript is one
 * distracted `body: incoming.body` away from coming back, and the cost of that regression is a silent
 * return to archiving customers' conversations. The database trigger in
 * `1782200000000-BlockMessageContent.ts` is the layer no writer can bypass; this one keeps the blob
 * from ever being sent in the first place.
 */

/**
 * Metadata keys that survive persistence, and what survives inside each.
 *
 * An ALLOWLIST, not a denylist: a metadata key added by a future feature is dropped until someone
 * deliberately adds it here. A privacy rule that fails open is not a rule — the failure mode of
 * guessing wrong must be "the screen is missing a field", never "we quietly started keeping
 * conversations again".
 *
 * - `media` — the envelope only: what kind of file and how big. Enough to render "enviou uma foto".
 *   `filename` is deliberately NOT kept: it is text a person chose, and it routinely carries a name
 *   ("contrato-joao-silva.pdf").
 * - `quotedMessage` — the id of the message being replied to, never its `body`. The id is a pointer;
 *   the body was a verbatim copy of an earlier message, stored a second time.
 * - `call` — that a call happened. An event, not something anyone wrote.
 * - `reactions` — kept on purpose. It is a per-message state map the engine serves through
 *   `GET /:chatId/:messageId/reactions`; dropping it would silently break a shipped endpoint, and an
 *   emoji acknowledgement is not the message body this module exists to stop keeping.
 */
const MEDIA_ENVELOPE_KEYS = ['mimetype', 'sizeBytes', 'omitted'] as const;

type Metadata = Record<string, unknown>;

function isRecord(value: unknown): value is Metadata {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The media envelope: kind and size, never the bytes and never the caller's filename. */
function mediaEnvelope(media: Metadata): Metadata {
  const out: Metadata = { omitted: true };
  for (const key of MEDIA_ENVELOPE_KEYS) {
    if (key !== 'omitted' && media[key] !== undefined) out[key] = media[key];
  }
  // Derive the size when the writer only had the blob, so "how big was it" survives the strip.
  if (out.sizeBytes === undefined && typeof media.data === 'string') {
    out.sizeBytes = Math.floor((media.data.length * 3) / 4);
  }
  return out;
}

/**
 * The storable form of a message's metadata.
 *
 * Returns a NEW object and never mutates the input: the same `metadata` reference is handed to the
 * webhook and WebSocket dispatch, so stripping in place would remove the payload from the LIVE event
 * that consumers depend on — the exact trap called out in `stripMediaForStorage`.
 *
 * `undefined` (not `{}`) comes back when nothing survives, so the column stays NULL instead of
 * accumulating empty JSON objects.
 */
export function stripMetadataForStorage(metadata: Metadata | undefined | null): Metadata | undefined {
  if (!isRecord(metadata)) return undefined;

  const out: Metadata = {};

  if (isRecord(metadata.media)) out.media = mediaEnvelope(metadata.media);
  if (isRecord(metadata.quotedMessage) && metadata.quotedMessage.id !== undefined) {
    out.quotedMessage = { id: metadata.quotedMessage.id };
  }
  if (metadata.call !== undefined) out.call = metadata.call;
  if (metadata.reactions !== undefined) out.reactions = metadata.reactions;

  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * What goes in the `body` column: nothing, ever.
 *
 * A named function rather than an omitted field at each call site so the intent is greppable and a
 * reviewer sees a decision instead of a dropped line — and so the reason lives one jump away.
 *
 * Returns `undefined` rather than `null` because the entity declares `body: string` (the column is
 * `nullable: true`, but the TypeScript type is not) and TypeORM's `DeepPartial<Message>` rejects
 * `null`. `undefined` makes TypeORM omit the column, so the INSERT stores NULL — and on the UPDATE
 * path, where omitting a field means "leave it alone", the database trigger is what actually holds
 * the line. That is the division of labour on purpose: this layer keeps content from being sent,
 * the trigger is the guarantee.
 */
export function bodyForStorage(): undefined {
  return undefined;
}
