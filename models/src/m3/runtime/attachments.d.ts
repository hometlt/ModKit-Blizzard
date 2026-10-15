export interface DecodedM3Attachments {
  readonly sockets: readonly { readonly sourceName?: string; readonly nodeId: string }[]
  readonly volumes: readonly unknown[]
  readonly primaryAnimationHash: number
  readonly additionalAnimationHashes: readonly number[]
  readonly animationHashes: readonly number[]
  readonly fatal: boolean
}

export declare function decodeM3Attachments(
  bytes: Uint8Array,
  budget: any,
  signal?: AbortSignal,
): Promise<DecodedM3Attachments>
