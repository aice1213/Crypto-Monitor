import { describe, it, expect, beforeAll } from 'vitest';
import { encryptSecret, decryptSecret, b64ToBuf, bufToB64 } from './crypto.js';

/**
 * AES-GCM 加密模块单测（开发交付文档 V1.1.0 §7.2）。
 *
 * 覆盖：
 * 1. 往返加解密（密文能解回原文）
 * 2. 每次加密 IV 随机 → 同一明文两次密文不同
 * 3. 存储格式 `base64(iv).base64(ct)` 含分隔符
 * 4. 错误密钥解密失败（AES-GCM 认证失败）
 * 5. 密钥长度校验（非 32B 抛错）
 * 6. 密文格式错误抛错
 */

// 测试主密钥：32 字节 Base64（"a".repeat(32) 的 base64）
const KEY = btoa('a'.repeat(32));
const OTHER_KEY = btoa('b'.repeat(32));

// Node 环境 crypto.subtle 需要全局可用
beforeAll(() => {
  if (!globalThis.crypto?.subtle) {
    throw new Error('当前环境缺少 crypto.subtle，无法测试 AES-GCM');
  }
});

describe('AES-GCM 加解密（PUSH_ENC_KEY）', () => {
  it('加密后能解密回原文（往返）', async () => {
    const plain = 'https://oapi.dingtalk.com/robot/send?access_token=test123';
    const stored = await encryptSecret(plain, KEY);
    const decrypted = await decryptSecret(stored, KEY);
    expect(decrypted).toBe(plain);
  });

  it('同一明文两次加密产生不同密文（IV 随机）', async () => {
    const plain = 'https://open.feishu.cn/open-apis/bot/v2/hook/abc';
    const a = await encryptSecret(plain, KEY);
    const b = await encryptSecret(plain, KEY);
    expect(a).not.toBe(b);
    // 两段都能解回原文
    expect(await decryptSecret(a, KEY)).toBe(plain);
    expect(await decryptSecret(b, KEY)).toBe(plain);
  });

  it('存储格式为 base64(iv).base64(ct)，含分隔符且两部分非空', async () => {
    const stored = await encryptSecret('secret', KEY);
    const dot = stored.indexOf('.');
    expect(dot).toBeGreaterThan(0);
    const ivPart = stored.slice(0, dot);
    const ctPart = stored.slice(dot + 1);
    expect(ivPart.length).toBeGreaterThan(0);
    expect(ctPart.length).toBeGreaterThan(0);
    // iv 是 12 字节 → base64 长度为 16
    expect(ivPart).toHaveLength(16);
  });

  it('错误密钥解密失败（AES-GCM 认证失败）', async () => {
    const stored = await encryptSecret('webhook-secret', KEY);
    await expect(decryptSecret(stored, OTHER_KEY)).rejects.toThrow();
  });

  it('密文被篡改后解密失败（认证保护）', async () => {
    const stored = await encryptSecret('webhook-secret', KEY);
    const dot = stored.indexOf('.');
    const ct = stored.slice(dot + 1);
    // 翻转最后一个字符（认证标签位于密文末尾，翻转必破坏 AES-GCM 认证）
    const lastChar = ct.slice(-1);
    const flippedChar = lastChar === 'A' ? 'B' : 'A';
    const tamperedCt = ct.slice(0, -1) + flippedChar;
    const tampered = `${stored.slice(0, dot)}.${tamperedCt}`;
    await expect(decryptSecret(tampered, KEY)).rejects.toThrow();
  });

  it('非 32 字节密钥抛错', async () => {
    const shortKey = btoa('short');
    await expect(encryptSecret('x', shortKey)).rejects.toThrow(/32/);
  });

  it('密文格式错误（无分隔符）抛错', async () => {
    await expect(decryptSecret('not-a-valid-format', KEY)).rejects.toThrow(/格式/);
  });
});

describe('Base64 工具', () => {
  it('b64ToBuf 与 bufToB64 互为逆运算', () => {
    const b64 = btoa('hello world');
    const buf = b64ToBuf(b64);
    expect(bufToB64(buf)).toBe(b64);
    expect(new TextDecoder().decode(buf)).toBe('hello world');
  });

  it('32 字节密钥解码后字节数为 32', () => {
    expect(b64ToBuf(KEY).byteLength).toBe(32);
  });
});
