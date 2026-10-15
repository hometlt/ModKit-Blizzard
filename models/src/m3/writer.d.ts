export declare function encodeM3JsonModel(
  model: any,
  options: any,
  budget: any,
  signal?: AbortSignal,
): Promise<{
  readonly bytes: Uint8Array
  readonly files?: readonly unknown[]
  readonly issues: readonly { readonly code: string }[]
}>
