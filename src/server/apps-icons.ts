import { HttpError } from "./errors";

export const APP_ICON_MAX_BYTES = 1024 * 1024;
export type AppIconMime = "image/png" | "image/jpeg" | "image/webp";
export const APP_ICON_EXTENSIONS: Record<AppIconMime, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};
function dimensions(width: number, height: number) {
  if (width < 1 || height < 1 || width > 4096 || height > 4096)
    throw new HttpError(
      400,
      "App icons must have dimensions from 1 to 4096 pixels.",
    );
}
/** Validate actual raster headers/structure, not filenames or client MIME alone.
 * No SVG, arbitrary URLs, or image execution/remote decoder is involved. */
export function appIconMime(bytes: Uint8Array, declared?: string): AppIconMime {
  if (!bytes.length || bytes.length > APP_ICON_MAX_BYTES)
    throw new HttpError(413, "App icons must be nonempty and at most 1 MiB.");
  const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let mime: AppIconMime | undefined;
  if (
    data.length >= 45 &&
    data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  ) {
    let offset = 8;
    let header = false;
    let pixels = false;
    let end = false;
    while (offset + 12 <= data.length) {
      const length = data.readUInt32BE(offset);
      const kind = data.toString("ascii", offset + 4, offset + 8);
      if (length > data.length - offset - 12) break;
      if (!header) {
        if (kind !== "IHDR" || length !== 13) break;
        dimensions(
          data.readUInt32BE(offset + 8),
          data.readUInt32BE(offset + 12),
        );
        const depth = data[offset + 16];
        const color = data[offset + 17];
        const depths: Record<number, number[]> = {
          0: [1, 2, 4, 8, 16],
          2: [8, 16],
          3: [1, 2, 4, 8],
          4: [8, 16],
          6: [8, 16],
        };
        if (
          !depths[color!]?.includes(depth!) ||
          data[offset + 18] !== 0 ||
          data[offset + 19] !== 0 ||
          data[offset + 20]! > 1
        )
          break;
        header = true;
      } else if (kind === "IHDR") break;
      if (kind === "IDAT" && length > 0) pixels = true;
      offset += length + 12;
      if (kind === "IEND") {
        end = length === 0 && offset === data.length;
        break;
      }
    }
    if (header && pixels && end) mime = "image/png";
  } else if (
    data.length >= 12 &&
    data[0] === 0xff &&
    data[1] === 0xd8 &&
    data[data.length - 2] === 0xff &&
    data[data.length - 1] === 0xd9
  ) {
    let offset = 2;
    let frame = false;
    let scan = false;
    while (offset + 4 <= data.length) {
      if (data[offset] !== 0xff) break;
      while (data[offset] === 0xff) offset++;
      const marker = data[offset++]!;
      if (marker === 0xd9 || marker === 0x00 || marker === 0xd8) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > data.length) break;
      const length = data.readUInt16BE(offset);
      if (length < 2 || offset + length > data.length) break;
      if ([0xc0, 0xc1, 0xc2].includes(marker)) {
        if (length < 8 || data[offset + 2] !== 8) break;
        dimensions(
          data.readUInt16BE(offset + 5),
          data.readUInt16BE(offset + 3),
        );
        frame = true;
      }
      if (marker === 0xda) {
        scan = frame && length >= 6 && offset + length < data.length - 2;
        break;
      }
      offset += length;
    }
    if (scan) mime = "image/jpeg";
  } else if (
    data.length >= 30 &&
    data.toString("ascii", 0, 4) === "RIFF" &&
    data.readUInt32LE(4) === data.length - 8 &&
    data.toString("ascii", 8, 12) === "WEBP"
  ) {
    let offset = 12;
    let pixels = false;
    while (offset + 8 <= data.length) {
      const kind = data.toString("ascii", offset, offset + 4);
      const length = data.readUInt32LE(offset + 4);
      const body = offset + 8;
      if (length > data.length - body) break;
      if (
        kind === "VP8 " &&
        length >= 10 &&
        data
          .subarray(body + 3, body + 6)
          .equals(Buffer.from([0x9d, 0x01, 0x2a]))
      ) {
        dimensions(
          data.readUInt16LE(body + 6) & 0x3fff,
          data.readUInt16LE(body + 8) & 0x3fff,
        );
        pixels = true;
      }
      if (kind === "VP8L" && length >= 5 && data[body] === 0x2f) {
        const bits = data.readUInt32LE(body + 1);
        if (bits >>> 29 !== 0) break;
        dimensions((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
        pixels = true;
      }
      if (kind === "VP8X" && length === 10) {
        const width = data.readUIntLE(body + 4, 3) + 1;
        const height = data.readUIntLE(body + 7, 3) + 1;
        dimensions(width, height);
      }
      if (kind === "ANMF" && length >= 24) {
        dimensions(
          data.readUIntLE(body + 6, 3) + 1,
          data.readUIntLE(body + 9, 3) + 1,
        );
        let frame = body + 16;
        while (frame + 8 <= body + length) {
          const frameKind = data.toString("ascii", frame, frame + 4);
          const frameLength = data.readUInt32LE(frame + 4);
          const frameBody = frame + 8;
          if (frameLength > body + length - frameBody) break;
          if (
            (frameKind === "VP8 " &&
              frameLength >= 10 &&
              data
                .subarray(frameBody + 3, frameBody + 6)
                .equals(Buffer.from([0x9d, 0x01, 0x2a]))) ||
            (frameKind === "VP8L" &&
              frameLength >= 5 &&
              data[frameBody] === 0x2f)
          )
            pixels = true;
          frame = frameBody + frameLength + (frameLength % 2);
        }
        if (frame !== body + length) break;
      }
      offset = body + length + (length % 2);
    }
    if (pixels && offset === data.length) mime = "image/webp";
  }
  if (!mime)
    throw new HttpError(400, "Upload a valid PNG, JPEG, or WebP raster icon.");
  if (
    declared !== undefined &&
    declared.split(";", 1)[0]?.trim().toLowerCase() !== mime
  )
    throw new HttpError(
      415,
      "Icon Content-Type must match its actual PNG, JPEG, or WebP format.",
    );
  return mime;
}
