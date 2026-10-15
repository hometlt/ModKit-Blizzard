/** Global runtime configuration for the M3 loader. */
export interface M3LoaderConfig {
  /** Whether the current environment is Node.js. */
  readonly isNode: boolean
  /** Path to the structures.xml file (Node.js only). Defaults to `./structures.xml` relative to module. */
  structuresXmlPath?: string
  /** Embedded XML string for browser environments. */
  embeddedStructuresXml?: string
}

let _config: M3LoaderConfig = {
  isNode: typeof process !== 'undefined' && process.versions?.node != null,
}

/** Get the current loader configuration. */
export function getConfig(): M3LoaderConfig {
  return _config
}

/** Update the loader configuration. Merges with existing values. */
export function setConfig(partial: Partial<M3LoaderConfig>): void {
  _config = { ..._config, ...partial }
}
