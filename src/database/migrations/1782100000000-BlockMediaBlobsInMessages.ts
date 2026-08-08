import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A HARD BLOCK, in the database, on ever storing a media blob in `messages.metadata`.
 *
 * Why this is a database rule and not just application code
 * ---------------------------------------------------------
 * Measured on the live database on 2026-08-08: `messages` was 289 MB over 5.107 rows, and 286 MB of
 * that was TOAST on `metadata` — base64 media. 117 videos were 177 MB; 1.129 images were 81 MB; the
 * 3.247 text messages came to 4,8 KB in TOTAL. The blob was ~99,998% of the table, and it grows with
 * the customer base rather than with product usage: every photo anyone sends to a linked WhatsApp was
 * copied into Postgres and kept forever. On 2026-08-07 that filled the volume and took production
 * down with it — login, the AI receptionist and the schedulers all stopped at once.
 *
 * The application-side fix (`stripMediaForStorage`) is the first line, but a rule that lives only in
 * TypeScript is one careless `metadata.media = incoming.media` away from coming back, and the cost of
 * that regression is another outage. So the guarantee lives here, below every writer: no application,
 * script, migration or hand-typed INSERT can put a blob in this table.
 *
 * Why a BEFORE trigger that strips, and not a CHECK that rejects
 * -------------------------------------------------------------
 * A CHECK constraint would make the INSERT fail, and the caller treats a failed insert as a lost
 * message — the dedup oracle in session.service.ts keys off the unique-violation path, and a
 * constraint violation there would drop a real customer message on the floor. Refusing to store a
 * photo must never mean refusing to store the fact that a photo was sent. The trigger therefore
 * strips the blob and lets the row through, keeping the envelope (mimetype, filename, size) plus
 * `omitted: true` — the same shape the 50 MiB inbound cap has always produced, so readers already
 * understand it.
 *
 * Nothing loses access to the bytes: webhooks and WebSocket events dispatch the LIVE message object,
 * never the persisted row, and a client that wants an old message's media has
 * `GET /:chatId/history?includeMedia=true`, which re-downloads it from WhatsApp on demand.
 *
 * The size backstop
 * -----------------
 * `media.data` is the known offender, but the rule is "no blobs", not "no blobs shaped like the one
 * that hurt us". Anything still over MAX_METADATA_BYTES after stripping is replaced by a marker
 * naming its original size, so a future field carrying a payload cannot quietly refill the table.
 *
 * Postgres only — SQLite deployments (local/dev) have no PL/pgSQL and are not the ones that fill a
 * production volume.
 */
export class BlockMediaBlobsInMessages1782100000000 implements MigrationInterface {
  name = 'BlockMediaBlobsInMessages1782100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.connection.options.type !== 'postgres') return;

    // 16 KiB. Two orders of magnitude above a fat text envelope (the average non-media row here is
    // well under 1 KB) and three below the multi-MB payloads this exists to stop.
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION messages_block_media_blobs() RETURNS trigger AS $fn$
      DECLARE
        MAX_METADATA_BYTES CONSTANT int := 16384;
        meta   jsonb;
        blob   text;
        nbytes int;
      BEGIN
        IF NEW.metadata IS NULL OR NEW.metadata = '' THEN
          RETURN NEW;
        END IF;

        -- metadata is a text column holding JSON. Anything unparseable is left exactly as it
        -- arrived: this trigger exists to drop blobs, not to become a validator that can reject
        -- a message because some future writer sent a shape it did not expect.
        BEGIN
          meta := NEW.metadata::jsonb;
        EXCEPTION WHEN others THEN
          RETURN NEW;
        END;

        blob := meta #>> '{media,data}';
        IF blob IS NOT NULL THEN
          nbytes := (length(blob) * 3) / 4;
          meta := meta #- '{media,data}';
          meta := jsonb_set(meta, '{media,omitted}', 'true'::jsonb, true);
          -- Only fill in the size when the writer did not already know it.
          IF meta #> '{media,sizeBytes}' IS NULL THEN
            meta := jsonb_set(meta, '{media,sizeBytes}', to_jsonb(nbytes), true);
          END IF;
        END IF;

        IF octet_length(meta::text) > MAX_METADATA_BYTES THEN
          meta := jsonb_build_object(
            'truncated', true,
            'reason', 'metadata over the 16 KiB cap: blobs are not stored in this database',
            'originalBytes', octet_length(NEW.metadata)
          );
        END IF;

        NEW.metadata := meta::text;
        RETURN NEW;
      END;
      $fn$ LANGUAGE plpgsql;
    `);

    await queryRunner.query(`DROP TRIGGER IF EXISTS trg_messages_block_media_blobs ON "messages"`);
    await queryRunner.query(`
      CREATE TRIGGER trg_messages_block_media_blobs
        BEFORE INSERT OR UPDATE ON "messages"
        FOR EACH ROW EXECUTE FUNCTION messages_block_media_blobs();
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.connection.options.type !== 'postgres') return;
    await queryRunner.query(`DROP TRIGGER IF EXISTS trg_messages_block_media_blobs ON "messages"`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS messages_block_media_blobs()`);
  }
}
