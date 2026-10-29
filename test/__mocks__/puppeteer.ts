// puppeteer 25 is ESM-only. Production loads it through Node 24's require(esm),
// but Jest's CommonJS runtime cannot parse it, and no unit test launches a real
// browser. This stub lets whatsapp-web.js be required under Jest.
const unavailable = (): never => {
  throw new Error('puppeteer is not available in unit tests');
};

export const launch = unavailable;
export const connect = unavailable;
export default { launch, connect };
