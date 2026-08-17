import { bodyForStorage, stripMetadataForStorage } from './content-free-storage';

describe('content-free-storage', () => {
  describe('bodyForStorage', () => {
    it('never returns anything to store', () => {
      expect(bodyForStorage()).toBeUndefined();
    });
  });

  describe('stripMetadataForStorage', () => {
    it('keeps the media envelope and drops the blob', () => {
      const out = stripMetadataForStorage({
        media: { mimetype: 'image/jpeg', sizeBytes: 4096, data: 'AAAA'.repeat(1000) },
      });

      expect(out).toEqual({ media: { omitted: true, mimetype: 'image/jpeg', sizeBytes: 4096 } });
      expect(JSON.stringify(out)).not.toContain('AAAA');
    });

    it('drops the sender-chosen filename, which routinely carries a person name', () => {
      const out = stripMetadataForStorage({
        media: { mimetype: 'application/pdf', filename: 'contrato-joao-silva.pdf', sizeBytes: 120 },
      });

      expect(out!.media).not.toHaveProperty('filename');
      expect(JSON.stringify(out)).not.toContain('joao');
    });

    it('derives the size from the blob when the writer did not supply one', () => {
      const out = stripMetadataForStorage({ media: { mimetype: 'image/png', data: 'A'.repeat(400) } });

      expect((out!.media as Record<string, unknown>).sizeBytes).toBe(300);
    });

    it('keeps the quoted pointer but never the quoted text', () => {
      const out = stripMetadataForStorage({
        quotedMessage: { id: 'ABC123', body: 'posso remarcar para sexta?' },
      });

      expect(out).toEqual({ quotedMessage: { id: 'ABC123' } });
      expect(JSON.stringify(out)).not.toContain('remarcar');
    });

    it('keeps call events and reaction state', () => {
      const out = stripMetadataForStorage({
        call: { isVideo: true, outcome: 'missed' },
        reactions: { '5541997106938@c.us': '👍' },
      });

      expect(out).toEqual({
        call: { isVideo: true, outcome: 'missed' },
        reactions: { '5541997106938@c.us': '👍' },
      });
    });

    it('is an allowlist: an unknown key is dropped, not passed through', () => {
      const out = stripMetadataForStorage({
        media: { mimetype: 'image/jpeg' },
        someFutureField: { transcript: 'o cliente pediu corte degrade' },
      });

      expect(out).not.toHaveProperty('someFutureField');
      expect(JSON.stringify(out)).not.toContain('degrade');
    });

    it('returns undefined when nothing survives, so the column stays NULL', () => {
      expect(stripMetadataForStorage({ quotedMessage: { body: 'oi' } })).toBeUndefined();
      expect(stripMetadataForStorage({})).toBeUndefined();
      expect(stripMetadataForStorage(undefined)).toBeUndefined();
      expect(stripMetadataForStorage(null)).toBeUndefined();
    });

    it('does not mutate the caller object — the same reference is dispatched live', () => {
      const live = {
        media: { mimetype: 'image/jpeg', data: 'BLOB', filename: 'foto.jpg' },
        quotedMessage: { id: 'X', body: 'texto' },
      };
      const snapshot = JSON.parse(JSON.stringify(live));

      stripMetadataForStorage(live);

      expect(live).toEqual(snapshot);
    });
  });
});
