export declare function decodeM3Geometry(
  bytes: Uint8Array,
  budget: any,
): Promise<{ readonly primitives: readonly unknown[] }>

export declare function decodeM3UvmSource(
  bytes: Uint8Array,
  budget: any,
  signal?: AbortSignal,
): Promise<{ readonly attachmentVolumes: readonly any[]; readonly hittests: readonly any[] }>
