export type ContentFields = {
  name: string;
  quantity: string | null;
  category: string | null;
  fdcId: number | null;
  checked: boolean;
};

export async function generateContentKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    /* extractable */ false,
    ["encrypt", "decrypt"],
  );
}

export async function encryptContent(
  key: CryptoKey,
  content: ContentFields,
): Promise<{ iv: Uint8Array; cipher: ArrayBuffer }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode(JSON.stringify(content));
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as BufferSource }, key, data);
  return { iv, cipher };
}

export async function decryptContent(
  key: CryptoKey,
  iv: Uint8Array,
  cipher: ArrayBuffer,
): Promise<ContentFields> {
  const data = await crypto.subtle.decrypt({ name: "AES-GCM", iv: iv as BufferSource }, key, cipher);
  return JSON.parse(new TextDecoder().decode(data)) as ContentFields;
}
