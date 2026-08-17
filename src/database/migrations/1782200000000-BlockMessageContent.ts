import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A HARD BLOCK, in the database, on storing what anyone WROTE — and a one-time scrub of everything
 * already written.
 *
 * This is the sibling of BlockMediaBlobsInMessages1782100000000, and the reason is different.
 * -----------------------------------------------------------------------------------------
 * That migration was about survival: media blobs were 99,998% of `messages`, they filled the volume
 * on 2026-08-07, and login, the AI receptionist and the schedulers went down together. It worked —
 * measured on the live database on 2026-08-17, the whole `zion_wa` database is ~6 MB and `messages`
 * is 5,5 MB over 9.695 rows, with no blob left in it.
 *
 * This one is not about space. The remaining text is 502 kB; deleting it will not be felt. It is
 * about the fact that those 9.695 rows are real conversations between barbershops and their clients,
 * the oldest dated 2024-09-26, and NOTHING in the product has ever read one back:
 *
 *   - the barbershop API asks the gateway for exactly two fields, `status` and `chatId`
 *     (sonic-lab-api `src/utils/zionWa.js` → `messageStatus`), never `body`;
 *   - webhooks and WebSocket dispatch the LIVE message object, never the persisted row;
 *   - old media is re-downloaded from WhatsApp on demand via `GET /:chatId/history?includeMedia=true`;
 *   - the one `body` reader in this codebase is `MessageService.reply()`, which uses it for a quoted
 *     preview, already wraps it in try/catch, and already falls back to `''`.
 *
 * So the text was liability with no counterparty: an archive of other people's conversations, kept
 * forever, serving nothing. "Forever" is not a defensible answer for how long we hold a stranger's
 * WhatsApp messages, and the cheapest way to never have to defend it is to not have them.
 *
 * Why a trigger and not just the application strip
 * ------------------------------------------------
 * Same reasoning as the media fix, which is now proven: the application layer
 * (`common/privacy/content-free-storage.ts`) is one distracted `body: incoming.body` away from
 * silently resuming the archive, and a regression here is invisible — nothing breaks, the table just
 * starts filling with conversations again. The guarantee therefore lives below every writer: no
 * application, script, migration or hand-typed INSERT can put message content in this table.
 *
 * Why it STRIPS instead of REJECTING, again
 * -----------------------------------------
 * A CHECK constraint would fail the INSERT, and `session.service.ts` treats a failed insert as a lost
 * message (its dedup oracle keys off the unique-violation path). Refusing to store the SENTENCE must
 * never mean refusing to store the FACT that a message happened — the operational log is the part the
 * product actually uses.
 *
 * The metadata rule is an ALLOWLIST
 * ---------------------------------
 * Only `media` (envelope: mimetype/sizeBytes/omitted), `quotedMessage.id`, `call` and `reactions`
 * survive. A key some future feature adds is dropped until someone deliberately allows it here. A
 * denylist fails open, and the failure mode of failing open is "we quietly started keeping
 * conversations again" — which is exactly the thing this migration exists to make impossible.
 *
 * `reactions` is kept on purpose: it is a per-message state map served by
 * `GET /:chatId/:messageId/reactions`, so dropping it would silently break a shipped endpoint, and an
 * emoji acknowledgement is not the message body this is about.
 *
 * Postgres only — SQLite (local/dev) has no PL/pgSQL, and is not where customer conversations live.
 */
export class BlockMessageContent1782200000000 implements MigrationInterface {
  name = 'BlockMessageContent1782200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.connection.options.type !== 'postgres') return;

    // Left deliberately generous. The surviving shape is a few hundred bytes (the largest metadata in
    // production today is 535 bytes); this only exists so a `reactions` map on a huge group cannot
    // become the next thing that grows without a bound.
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION messages_block_content() RETURNS trigger AS $fn$
      DECLARE
        MAX_METADATA_BYTES CONSTANT int := 16384;
        meta  jsonb;
        kept  jsonb;
        media jsonb;
      BEGIN
        -- The body column never holds anything again, on INSERT or UPDATE.
        NEW.body := NULL;

        IF NEW.metadata IS NULL OR NEW.metadata = '' THEN
          RETURN NEW;
        END IF;

        BEGIN
          meta := NEW.metadata::jsonb;
        EXCEPTION WHEN others THEN
          -- Unparseable metadata is DROPPED, not passed through. This function cannot look inside it,
          -- so it cannot promise it holds no content — and "I could not check" must resolve to the
          -- safe side. (The media trigger passes it through instead, because its job is only to find
          -- a blob at a known path; this one is making a guarantee about the whole column.)
          NEW.metadata := NULL;
          RETURN NEW;
        END;

        kept := '{}'::jsonb;

        -- media: what kind of file and how big, never the bytes and never the sender's filename.
        IF jsonb_typeof(meta -> 'media') = 'object' THEN
          media := jsonb_build_object('omitted', to_jsonb(true));
          IF meta #> '{media,mimetype}' IS NOT NULL THEN
            media := jsonb_set(media, '{mimetype}', meta #> '{media,mimetype}');
          END IF;
          IF meta #> '{media,sizeBytes}' IS NOT NULL THEN
            media := jsonb_set(media, '{sizeBytes}', meta #> '{media,sizeBytes}');
          ELSIF jsonb_typeof(meta #> '{media,data}') = 'string' THEN
            -- Derive the size from the blob on its way out, so "how big was it" survives the strip.
            media := jsonb_set(media, '{sizeBytes}', to_jsonb((length(meta #>> '{media,data}') * 3) / 4));
          END IF;
          kept := jsonb_set(kept, '{media}', media, true);
        END IF;

        -- quotedMessage: the pointer, never the quoted text (which is a second copy of someone's
        -- earlier message).
        IF meta #> '{quotedMessage,id}' IS NOT NULL THEN
          kept := jsonb_set(kept, '{quotedMessage}', jsonb_build_object('id', meta #> '{quotedMessage,id}'), true);
        END IF;

        IF meta ? 'call' THEN
          kept := jsonb_set(kept, '{call}', meta -> 'call', true);
        END IF;

        IF meta ? 'reactions' THEN
          kept := jsonb_set(kept, '{reactions}', meta -> 'reactions', true);
        END IF;

        IF kept = '{}'::jsonb THEN
          NEW.metadata := NULL;
        ELSIF octet_length(kept::text) > MAX_METADATA_BYTES THEN
          NEW.metadata := jsonb_build_object(
            'truncated', true,
            'reason', 'metadata over the 16 KiB cap: message content is not stored in this database',
            'originalBytes', octet_length(NEW.metadata)
          )::text;
        ELSE
          NEW.metadata := kept::text;
        END IF;

        RETURN NEW;
      END;
      $fn$ LANGUAGE plpgsql;
    `);

    // A SECOND trigger rather than a replacement for trg_messages_block_media_blobs. The media rule
    // keeps standing on its own — it is the one that was paid for with an outage, and it should not
    // disappear because someone reverts this migration. Postgres fires BEFORE-row triggers in name
    // order, so `..._block_media_blobs` runs before `..._block_message_content`; both are idempotent
    // and the allowlist below would drop a blob regardless of which ran first.
    await queryRunner.query(`DROP TRIGGER IF EXISTS trg_messages_block_message_content ON "messages"`);
    await queryRunner.query(`
      CREATE TRIGGER trg_messages_block_message_content
        BEFORE INSERT OR UPDATE ON "messages"
        FOR EACH ROW EXECUTE FUNCTION messages_block_content();
    `);

    // The history already on disk. The trigger only governs rows written from now on, so without this
    // the 9.695 conversations already in the table would simply sit there under a rule that arrived
    // too late for them. Setting `body = NULL` is enough to fire the trigger, which rewrites
    // `metadata` through the same allowlist — one pass, one rule, no second implementation to drift.
    const scrubbed = await queryRunner.query(`
      UPDATE "messages"
         SET body = NULL
       WHERE body IS NOT NULL
          OR (metadata IS NOT NULL AND metadata <> '')
    `);
    // TypeORM returns the affected count differently per driver; log whatever it gives us so the
    // deploy log records how much history this removed.
    // eslint-disable-next-line no-console
    console.log(`[migration] BlockMessageContent scrubbed message content from existing rows`, {
      affected: Array.isArray(scrubbed) ? scrubbed[1] : scrubbed,
    });
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.connection.options.type !== 'postgres') return;
    // Only the rule is reversible. The scrubbed content is gone on purpose — that was the point.
    await queryRunner.query(`DROP TRIGGER IF EXISTS trg_messages_block_message_content ON "messages"`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS messages_block_content()`);
  }
}
