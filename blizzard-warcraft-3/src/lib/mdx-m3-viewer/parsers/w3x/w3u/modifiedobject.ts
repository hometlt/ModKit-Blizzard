import BinaryStream from "../../../common/binarystream.js";
import Modification from "./modification.js";

/**
 * A modified object. MK3: v3 adds an opaque integer array before ONE modification list,
 * not a repeated list of modification sets. See MDX-PORT-PROVENANCE.json.
 */
export default class ModifiedObject {
  oldId = "\0\0\0\0";
  newId = "\0\0\0\0";
  unknownInts: number[] = [];
  modifications: Modification[] = [];

  /** Refuse invalid opaque words or a target version that would silently discard them. */
  private validateHeader(formatVersion: number): void {
    if (formatVersion < 3 && this.unknownInts.length > 0) {
      throw new TypeError("Object v3 unknown header cannot be written in an older format");
    }
    if (this.unknownInts.some(value => !Number.isInteger(value) || value < 0 || value > 0xffffffff)) {
      throw new RangeError("Object v3 unknown header must contain uint32 values");
    }
  }

  load(
    stream: BinaryStream,
    useOptionalInts: boolean,
    formatVersion: number
  ): void {
    this.oldId = stream.readBinary(4);
    this.newId = stream.readBinary(4);

    this.unknownInts = [];
    this.modifications = [];
    if (formatVersion >= 3) {
      const count = stream.readUint32();
      if (count > Math.floor((stream.remaining - 4) / 4)) {
        throw new RangeError("Object v3 unknown integer array exceeds remaining bytes");
      }
      for (let i = 0; i < count; i++) this.unknownInts.push(stream.readUint32());
    }
    const count = stream.readUint32();
    if (count > Math.floor(stream.remaining / (useOptionalInts ? 21 : 13))) {
      throw new RangeError("Object modification count exceeds remaining bytes");
    }
    for (let i = 0; i < count; i++) {
      const modification = new Modification();
      modification.load(stream, useOptionalInts);
      this.modifications.push(modification);
    }
  }

  save(
    stream: BinaryStream,
    useOptionalInts: boolean,
    formatVersion: number
  ): void {
    this.validateHeader(formatVersion);
    if (this.oldId !== "\0\0\0\0") {
      stream.writeBinary(this.oldId);
    } else {
      stream.writeUint32(0);
    }

    if (this.newId !== "\0\0\0\0") {
      stream.writeBinary(this.newId);
    } else {
      stream.writeUint32(0);
    }

    if (formatVersion >= 3) {
      stream.writeUint32(this.unknownInts.length);
      for (const value of this.unknownInts) stream.writeUint32(value);
    }

    stream.writeUint32(this.modifications.length);

    for (const modification of this.modifications) modification.save(stream, useOptionalInts);
  }

  getByteLength(useOptionalInts: boolean, formatVersion: number): number {
    this.validateHeader(formatVersion);
    let size = formatVersion >= 3 ? 16 + this.unknownInts.length * 4 : 12;
    for (const modification of this.modifications) size += modification.getByteLength(useOptionalInts);

    return size;
  }
}
