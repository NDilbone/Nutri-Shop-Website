import { describe, it, expect } from "vitest";
import { generateContentKey, encryptContent, decryptContent } from "@/lib/offline/crypto";

describe("content encryption", () => {
  it("round-trips content through encrypt/decrypt", async () => {
    const key = await generateContentKey();
    const content = { name: "Milk", quantity: "2", category: "dairy", fdcId: null, checked: false };
    const { iv, cipher } = await encryptContent(key, content);
    expect(await decryptContent(key, iv, cipher)).toEqual(content);
  });

  it("uses a distinct IV per write", async () => {
    const key = await generateContentKey();
    const c = { name: "X", quantity: null, category: null, fdcId: 123, checked: true };
    const a = await encryptContent(key, c);
    const b = await encryptContent(key, c);
    expect(Buffer.from(a.iv)).not.toEqual(Buffer.from(b.iv));
  });

  it("fails to decrypt with a different key", async () => {
    const k1 = await generateContentKey();
    const k2 = await generateContentKey();
    const { iv, cipher } = await encryptContent(k1, {
      name: "secret", quantity: null, category: null, fdcId: null, checked: false,
    });
    await expect(decryptContent(k2, iv, cipher)).rejects.toThrow();
  });

  it("produces a non-extractable key", async () => {
    const key = await generateContentKey();
    expect(key.extractable).toBe(false);
  });
});
