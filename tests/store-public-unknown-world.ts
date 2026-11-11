/**
 * Stand-ins for tests/store-public-unknown.test.ts: the image library that
 * scales a store's photo ("sharp") and the drawing of the store's letter
 * ("next/og"). Neither is a native or WebAssembly module here, so the route
 * runs in plain Node. The scaled photo starts with "PHOTO:", the drawn letter
 * with "LETTER:", so a test can tell which one an icon is.
 */
export const world = { scalingFails: false };

export default function sharp(bytes: Uint8Array) {
  const chain = {
    resize: () => chain,
    png: () => chain,
    toBuffer: async () => {
      if (world.scalingFails) throw new Error("synthetic scaling failure");
      return Buffer.concat([Buffer.from("PHOTO:"), Buffer.from(bytes)]);
    },
  };
  return chain;
}

export class ImageResponse {
  async arrayBuffer(): Promise<ArrayBuffer> {
    const bytes = new TextEncoder().encode("LETTER:");
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  }
}
