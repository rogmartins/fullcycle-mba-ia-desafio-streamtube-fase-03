const KNOWN_ISO_BMFF_BOX_TYPES = new Set([
  'ftyp',
  'moov',
  'mdat',
  'free',
  'skip',
  'wide',
  'pnot',
  'uuid',
  'moof',
  'mfra',
  'meco',
  'meta',
  'styp',
  'sidx',
  'ssix',
  'prft',
]);

export function detectMoovPlacementFromHeadChunk(
  chunk: Buffer,
): boolean | null {
  let offset = 0;
  let sawKnownBox = false;

  while (offset + 8 <= chunk.length) {
    let size = chunk.readUInt32BE(offset);
    const type = chunk.toString('ascii', offset + 4, offset + 8);
    let headerSize = 8;

    if (size === 1) {
      if (offset + 16 > chunk.length) break;
      size = Number(chunk.readBigUInt64BE(offset + 8));
      headerSize = 16;
    }

    if (!KNOWN_ISO_BMFF_BOX_TYPES.has(type)) {
      if (!sawKnownBox) return null;
      break;
    }
    sawKnownBox = true;

    if (type === 'moov') return false;
    if (type === 'mdat') return true;
    if (size === 0 || size < headerSize) break;

    offset += size;
  }

  return sawKnownBox ? true : null;
}
