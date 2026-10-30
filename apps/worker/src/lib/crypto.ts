/**
 * 推送密钥加密模块（开发交付文档 V1.1.0 §7 安全与加密）。
 *
 * 用 Web Crypto API 实现 AES-GCM 加密/解密，仅用于 Worker 内存内对
 * Webhook URL 与签名密钥的加解密。主密钥 `PUSH_ENC_KEY`（32B Base64）
 * 存于 Workers Secrets，永不出 Worker；前端接口永不返回明文密钥。
 *
 * 存储格式：`base64(iv) + "." + base64(ciphertext)`（文档 §7.2）。
 */

const KEY_ALGORITHM = 'AES-GCM';
const IV_BYTES = 12;

/** 解析 32B Base64 主密钥，导入为 AES-GCM 原始密钥 */
async function importKey(secretB64: string): Promise<CryptoKey> {
  const raw = b64ToBuf(secretB64);
  if (raw.byteLength !== 32) {
    throw new Error(`PUSH_ENC_KEY 必须为 32 字节，当前 ${raw.byteLength} 字节`);
  }
  return crypto.subtle.importKey('raw', raw, KEY_ALGORITHM, false, ['encrypt', 'decrypt']);
}

/** Base64 字符串 → Uint8Array（新分配的 ArrayBuffer，可作 BufferSource） */
export function b64ToBuf(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const bytes = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) {
    bytes[i] = bin.charCodeAt(i);
  }
  return bytes;
}

/** Uint8Array → Base64 字符串 */
export function bufToB64(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) {
    bin += String.fromCharCode(bytes[i]!);
  }
  return btoa(bin);
}

/**
 * AES-GCM 加密。
 * @returns `base64(iv).base64(ciphertext)`
 */
export async function encryptSecret(plain: string, secretB64: string): Promise<string> {
  const key = await importKey(secretB64);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = await crypto.subtle.encrypt(
    { name: KEY_ALGORITHM, iv },
    key,
    new TextEncoder().encode(plain),
  );
  return `${bufToB64(iv)}.${bufToB64(ct)}`;
}

/**
 * AES-GCM 解密。
 * @param stored `base64(iv).base64(ciphertext)`
 */
export async function decryptSecret(stored: string, secretB64: string): Promise<string> {
  const key = await importKey(secretB64);
  const dot = stored.indexOf('.');
  if (dot < 0) throw new Error('密文格式错误：缺少 iv 分隔符');
  const iv = b64ToBuf(stored.slice(0, dot));
  const ct = b64ToBuf(stored.slice(dot + 1));
  const pt = await crypto.subtle.decrypt({ name: KEY_ALGORITHM, iv }, key, ct as BufferSource);
  return new TextDecoder().decode(pt);
}
