const encoder = new TextEncoder();

function field(target: Uint8Array, offset: number, length: number, value: string) {
  const bytes = encoder.encode(value);
  if (bytes.length > length) throw new Error("tar_field_too_long");
  target.set(bytes, offset);
}
function octal(value: number, length: number) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("tar_size_invalid");
  const text = value.toString(8);
  if (text.length > length - 1) throw new Error("tar_size_too_large");
  return `${text.padStart(length - 1, "0")}\0`;
}

export function tarHeader(name: string, size: number) {
  if (!/^[A-Za-z0-9_.-]{1,100}$/.test(name)) throw new Error("tar_name_invalid");
  const header = new Uint8Array(512);
  field(header, 0, 100, name); field(header, 100, 8, octal(0o600, 8)); field(header, 108, 8, octal(0, 8)); field(header, 116, 8, octal(0, 8));
  field(header, 124, 12, octal(size, 12)); field(header, 136, 12, octal(0, 12)); header.fill(0x20, 148, 156); header[156] = 0x30;
  field(header, 257, 6, "ustar\0"); field(header, 263, 2, "00"); field(header, 265, 32, "NearYou"); field(header, 297, 32, "NearYou");
  const checksum = header.reduce((sum, value) => sum + value, 0); field(header, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
  return header;
}

export function tarPadding(size: number) { return new Uint8Array((512 - (size % 512)) % 512); }
