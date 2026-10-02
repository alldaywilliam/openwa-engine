describe('redact-signal-logs', () => {
  it('keeps the session message and drops the key object', async () => {
    const seen: unknown[][] = [];
    const orig = console.info;
    console.info = (...a: unknown[]) => { seen.push(a); };
    jest.isolateModules(() => { require('./redact-signal-logs'); });
    console.info('Closing session:', { currentRatchet: { privKey: Buffer.from('x') } });
    console.info('plain', { ok: 1 });
    console.info = orig;
    expect(seen[0]).toEqual(['Closing session:', '[keys redacted]']);
    expect(seen[1]).toEqual(['plain', { ok: 1 }]);
  });
});
