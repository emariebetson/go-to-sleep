type UploadInput = { bucket: string; object: string; raw: string; accessToken: string; fetch?: typeof fetch };

export async function uploadImmutableObject(input: UploadInput): Promise<void> {
  if (!/^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$/.test(input.bucket) || !/^restores\/[A-Za-z0-9._/-]{1,500}\.json$/.test(input.object) || !input.raw.endsWith("\n") || !/^[-._A-Za-z0-9]{20,4096}$/.test(input.accessToken)) throw new Error("immutable object configuration invalid");
  const request = input.fetch ?? fetch;
  const url = `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(input.bucket)}/o?uploadType=media&ifGenerationMatch=0&name=${encodeURIComponent(input.object)}`;
  const response = await request(url, { method: "POST", headers: { authorization: `Bearer ${input.accessToken}`, "content-type": "application/json" }, body: input.raw });
  if (response.status === 412) throw new Error("immutable object conflict");
  if (!response.ok) throw new Error(`immutable object upload failed:${response.status}`);
}
