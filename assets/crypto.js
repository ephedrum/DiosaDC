/* DCrypt — password-based file encryption, same code in the browser and in
 * Node ≥ 20. Uses only WebCrypto.
 *
 * File format (binary):  "DCX1" | salt(16) | iv(12) | AES-256-GCM ciphertext+tag
 * Key: PBKDF2-SHA256(password, salt, 600 000 iterations) → AES-256-GCM.
 * Every file carries the salt so it is self-describing; all files of one set
 * share the same salt so the (slow) key derivation happens once per session.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DCrypt = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const MAGIC = [0x44, 0x43, 0x58, 0x31]; // "DCX1"
  const SALT_LEN = 16;
  const IV_LEN = 12;
  const TAG_LEN = 16;
  const ITERATIONS = 600000;
  const HEADER_LEN = MAGIC.length + SALT_LEN + IV_LEN;

  const subtle = globalThis.crypto.subtle;
  const textEnc = new TextEncoder();
  const textDec = new TextDecoder();

  function randomBytes(n) {
    const b = new Uint8Array(n);
    globalThis.crypto.getRandomValues(b);
    return b;
  }

  function toBase64(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  }

  function fromBase64(str) {
    const s = atob(str);
    const b = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
    return b;
  }

  async function deriveKey(password, salt, extractable) {
    const base = await subtle.importKey(
      'raw', textEnc.encode(String(password).normalize('NFKC')), 'PBKDF2', false, ['deriveKey']
    );
    return subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations: ITERATIONS, hash: 'SHA-256' },
      base,
      { name: 'AES-GCM', length: 256 },
      !!extractable,
      ['encrypt', 'decrypt']
    );
  }

  async function exportKey(key) {
    return new Uint8Array(await subtle.exportKey('raw', key));
  }

  async function importKey(raw) {
    return subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  }

  /* Split a file into its parts. Throws on anything that is not a DCX1 file. */
  function parse(buf) {
    const u = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    const ok = u.length >= HEADER_LEN + TAG_LEN && MAGIC.every((m, i) => u[i] === m);
    if (!ok) throw new Error('El archivo no tiene el formato esperado');
    let o = MAGIC.length;
    const salt = u.slice(o, o += SALT_LEN);
    const iv = u.slice(o, o += IV_LEN);
    const body = u.slice(o);
    return { salt, iv, body };
  }

  function readSalt(buf) {
    return parse(buf).salt;
  }

  async function encryptBytes(key, salt, plain) {
    const iv = randomBytes(IV_LEN);
    const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, key, plain));
    const out = new Uint8Array(HEADER_LEN + ct.length);
    out.set(MAGIC, 0);
    out.set(salt, MAGIC.length);
    out.set(iv, MAGIC.length + SALT_LEN);
    out.set(ct, HEADER_LEN);
    return out;
  }

  /* Returns plaintext bytes. A wrong key fails GCM authentication and throws. */
  async function decryptBytes(key, buf) {
    const { iv, body } = parse(buf);
    try {
      return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv }, key, body));
    } catch (e) {
      throw new Error('Contraseña incorrecta o archivo dañado');
    }
  }

  async function encryptJSON(key, salt, obj) {
    return encryptBytes(key, salt, textEnc.encode(JSON.stringify(obj)));
  }

  async function decryptJSON(key, buf) {
    return JSON.parse(textDec.decode(await decryptBytes(key, buf)));
  }

  return {
    ITERATIONS, SALT_LEN,
    randomBytes, toBase64, fromBase64,
    deriveKey, exportKey, importKey,
    parse, readSalt,
    encryptBytes, decryptBytes, encryptJSON, decryptJSON,
  };
});
