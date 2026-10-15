import type {
  ContributionContext,
  NativeModelEncoder,
  NativeModelEncodeRequest,
  NativeModelEncodeResult,
} from '@modkit/sdk'

export declare const abiVersion: 1
export declare const provides: readonly ['common.model/native-encoder']

export interface NativeModelEncoderSelection {
  readonly contract: 'common.model/native-encoder'
  readonly major: 1
  readonly offerId: 'm3-from-uvm' | 'm3a-from-uvm'
  readonly contractSelectionKey: 'format=m3' | 'format=m3a'
}

export declare function createProvider(
  selection: NativeModelEncoderSelection,
  context: Pick<ContributionContext, 'budgets'>,
): {
  readonly value: NativeModelEncoder & {
    encode(request: NativeModelEncodeRequest): Promise<NativeModelEncodeResult>
  }
  release(): Promise<void>
}
