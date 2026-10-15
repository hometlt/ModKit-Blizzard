/**
 * Core (non-LSP) surface for programmatic consumers — most importantly
 * `@modkitx/layout-render`, which builds resolved frame trees on top of the
 * desc index. Exposed as the `@modkitx/layout-lang/core` subpath so consumers
 * don't reach into dist paths.
 */

export { Store, createTextDocumentFromFs } from './index/store.js'
export type { LayoutDocument, FileDescEventData, IStoreEvents } from './index/store.js'
export { DescIndex, DescNamespace, DescKind, ConstantItem, HandleItem } from './index/desc.js'
export { UIBuilder, UINavigator, UINode, FrameNode, StateGroupNode, AnimationNode } from './index/hierarchy.js'
export { LayoutProcessor } from './index/processor.js'
export { LayoutChecker } from './index/checker.js'
export { XRay } from './index/xray.js'
export { BasicLayoutWorkspace } from './index/workspace.js'
export type { LayoutArchive, LayoutWorkspace } from './index/workspace.js'
export { createRegistry } from './schema/registry.js'
export { createRegistryFromDir, readSchemaDataDir } from './schema/registry-node.js'
export type { SchemaRegistry, ComplexType } from './schema/base.js'
export { ElementDefKind } from './schema/base.js'
export type { XMLDocument, XMLElement, XMLNode, XMLAttr } from './types.js'
export { splitSlashDelimetedStr, getAttrValueKind, isConstantValueKind } from './parser/utils.js'
export { AttrValueKind, AttrValueKindOffset } from './types.js'
