export const ATLAS_ANGULAR_MAGIC = "ASTATLS1";
export const ATLAS_JOINT_MAGIC = "ASTJNT01";
export const ATLAS_FORMAT_VERSION = 1;
export const ATLAS_HEADER_BYTES = 32;
export const ATLAS_ANGULAR_RECORD_BYTES = 16;
export const ATLAS_JOINT_RECORD_BYTES = 20;
function readHeader(buffer, magic, recordBytes) {
    if (buffer.byteLength < ATLAS_HEADER_BYTES)
        throw new Error("Atlas binary is shorter than its header");
    const actualMagic = String.fromCharCode(...new Uint8Array(buffer, 0, magic.length));
    if (actualMagic !== magic)
        throw new Error(`Unsupported atlas magic: ${actualMagic}`);
    const view = new DataView(buffer);
    const version = view.getUint32(8, true);
    const count = view.getUint32(12, true);
    if (version !== ATLAS_FORMAT_VERSION || view.getUint32(16, true) !== recordBytes || view.getUint32(20, true) !== ATLAS_HEADER_BYTES) {
        throw new Error("Atlas binary header does not match its declared format");
    }
    if (buffer.byteLength !== ATLAS_HEADER_BYTES + count * recordBytes) {
        throw new Error("Atlas binary byte length does not match its record count");
    }
    return count;
}
export function decodeAtlasAngularCells(buffer) {
    const count = readHeader(buffer, ATLAS_ANGULAR_MAGIC, ATLAS_ANGULAR_RECORD_BYTES);
    const surveyIndex = new Uint16Array(count);
    const nside = new Uint16Array(count);
    const pixel = new Uint32Array(count);
    const objectCount = new Uint32Array(count);
    const view = new DataView(buffer);
    for (let index = 0; index < count; index += 1) {
        const offset = ATLAS_HEADER_BYTES + index * ATLAS_ANGULAR_RECORD_BYTES;
        surveyIndex[index] = view.getUint16(offset, true);
        nside[index] = view.getUint16(offset + 2, true);
        pixel[index] = view.getUint32(offset + 4, true);
        objectCount[index] = view.getUint32(offset + 8, true);
    }
    return { count, surveyIndex, nside, pixel, objectCount };
}
export function decodeAtlasJointCells(buffer) {
    const count = readHeader(buffer, ATLAS_JOINT_MAGIC, ATLAS_JOINT_RECORD_BYTES);
    const surveyIndex = new Uint16Array(count);
    const nside = new Uint16Array(count);
    const radialBins = new Uint16Array(count);
    const radialBin = new Uint16Array(count);
    const pixel = new Uint32Array(count);
    const objectCount = new Uint32Array(count);
    const view = new DataView(buffer);
    for (let index = 0; index < count; index += 1) {
        const offset = ATLAS_HEADER_BYTES + index * ATLAS_JOINT_RECORD_BYTES;
        surveyIndex[index] = view.getUint16(offset, true);
        nside[index] = view.getUint16(offset + 2, true);
        radialBins[index] = view.getUint16(offset + 4, true);
        radialBin[index] = view.getUint16(offset + 6, true);
        pixel[index] = view.getUint32(offset + 8, true);
        objectCount[index] = view.getUint32(offset + 12, true);
    }
    return { count, surveyIndex, nside, radialBins, radialBin, pixel, objectCount };
}
export function atlasAngularByteLength(recordCount) {
    return ATLAS_HEADER_BYTES + recordCount * ATLAS_ANGULAR_RECORD_BYTES;
}
export function atlasJointByteLength(recordCount) {
    return ATLAS_HEADER_BYTES + recordCount * ATLAS_JOINT_RECORD_BYTES;
}
