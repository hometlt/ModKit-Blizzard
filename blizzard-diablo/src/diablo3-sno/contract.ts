import type { SnoTypeRegistry } from './registry.js'

/** The SNO type registry of an installed Diablo III, served by `blizzard/diablo3-sno-registry`. */
export const SNO_REGISTRY_CONTRACT = 'blizzard/diablo3-sno-registry'

/** The installation is the host's: the one the user selected, or discovery confirmed. */
export interface SnoRegistryRequest {
  readonly signal?: AbortSignal
}

export interface SnoRegistryService {
  readonly contract: typeof SNO_REGISTRY_CONTRACT
  registry(request: SnoRegistryRequest): Promise<SnoTypeRegistry>
}
