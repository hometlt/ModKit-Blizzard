/**
 * The real SC2Layout schema, reachable from the language provider.
 *
 * The provider has been answering from a sixty-line table written beside the port while the schema
 * the game actually uses — 2150 entries, compiled into `generated/sc2layout-schema-data.json` — sat
 * next to it, read only by the codec's render and validate operations. Two vocabularies of the same
 * format disagree eventually, and the one a modder sees while typing was the smaller one.
 *
 * The store is the ported `Store`, indexed from plain text, so the checker that runs here is the
 * same `LayoutChecker` the codec runs. Nothing about what is valid is decided in this file.
 *
 * `registry.js` rather than `registry-node.js` on purpose: the pure half loads in a browser worker,
 * which is what this provider's `portable` variant promises.
 */
import { layoutSchemaRegistry } from './schema-registry.js'
import { Store } from './layout-engine/sc2-layout-core/index/store.js'
import { XRay } from './layout-engine/sc2-layout-core/index/xray.js'
import { ExpressionParser } from './layout-engine/sc2-layout-core/parser/expressions.js'
import { LayoutChecker } from './layout-engine/sc2-layout-core/index/checker.js'
import {
  type AnimationNode,
  FrameNode,
  type StateGroupNode,
  UIBuilder,
  type UINode,
  UINavigator,
} from './layout-engine/sc2-layout-core/index/hierarchy.js'
import { LayoutProcessor } from './layout-engine/sc2-layout-core/index/processor.js'
import { DescKind, type DescNamespace } from './layout-engine/sc2-layout-core/index/desc.js'
import type { XMLElement } from './layout-engine/sc2-layout-core/types.js'
import { AttrValueKind, AttrValueKindOffset, type AttrValueConstant } from './layout-engine/sc2-layout-core/types.js'
import {
  getAttrValueKind,
  getSelectionIndexAtPosition,
  isConstantValueKind,
} from './layout-engine/sc2-layout-core/parser/utils.js'
import { reValueColor } from './layout-engine/sc2-layout-core/schema/validation.js'
import {
  BuiltinTypeKind,
  ElementDefKind,
  type Attribute,
  type ComplexType,
  type ElementDef,
  type SimpleType,
} from './layout-engine/sc2-layout-core/schema/base.js'

export interface LayoutTextDocument {
  readonly uri: string
  readonly text: string
  readonly version?: number
}

/** The language projection re-exports the shared schema authority for existing consumers. */
export { layoutSchemaRegistry, SC2_LAYOUT_SCHEMA_REVISION } from './schema-registry.js'

/** Frame types the schema declares, filtered by what the reader has typed so far. */
export function layoutFrameTypes(prefix = ''): readonly string[] {
  const wanted = prefix.toLocaleLowerCase()
  return [...layoutSchemaRegistry().frameTypes.keys()]
    .filter(name => name.toLocaleLowerCase().startsWith(wanted))
    .sort((left, right) => left.localeCompare(right))
}

export interface LayoutSchemaCompletionItem {
  readonly label: string
  readonly kind: 'enum' | 'property' | 'struct' | 'snippet' | 'variable' | 'class' | 'interface' | 'event'
  readonly detail?: string
  readonly documentation?: string
  readonly filterText?: string
  readonly sortText?: string
  readonly insertText?: string
  readonly insertTextFormat?: 'snippet'
}

export interface LayoutSchemaCompletionContext {
  readonly mode: 'root' | 'attribute-name' | 'attribute-value' | 'element'
  readonly items: readonly LayoutSchemaCompletionItem[]
  readonly valueKind?: string
}

/**
 * Completion entries for the compact `:` and `@` forms used inside frame bodies (`.` is
 * `layoutFrameChildCompletions`). Their replacement starts at the `:` or `@`, so each carries the
 * form it completes as its filter text.
 */
export function layoutFrameAbbreviationCompletions(
  frameTypeName: string,
  phrase: string,
): readonly LayoutSchemaCompletionItem[] {
  const frameType = layoutSchemaRegistry().frameTypes.get(frameTypeName)
  if (frameType === undefined) return []
  if (phrase.startsWith(':')) {
    const prefix = phrase.slice(1).toLocaleLowerCase()
    // As MK2: `[BLZ]` on the types only Blizzard's own layouts may use, the type's label and docs, the snippet.
    return layoutFrameTypes(prefix).map(name => {
      const type = layoutSchemaRegistry().frameTypes.get(name)
      const insertText = `<Frame type="${name}" name="\${1:${name}}">$0</Frame>`
      return {
        label: name,
        kind: 'snippet' as const,
        detail: `${type?.blizzOnly ? '[BLZ] ' : ''}${type?.complexType.label ?? 'SC2Layout frame type'}`,
        documentation: [type?.complexType.documentation, `\`\`\`sc2layout\n${insertText.replace('$0', '\n')}\n\`\`\``]
          .filter(Boolean)
          .join('\n'),
        filterText: `:${name}`,
        insertText,
        insertTextFormat: 'snippet' as const,
      }
    })
  }
  if (!phrase.startsWith('@')) return []
  const [rawGroup = '', rawProperty] = phrase.slice(1).split('/', 2)
  const groups = new Map<string, Map<string, ElementDef>>()
  for (const description of layoutSchemaRegistry().getFrameDescs(frameType)) {
    const entries = new Map<string, ElementDef>()
    for (const element of description.struct.values()) entries.set(element.name, element)
    if (entries.size > 0) groups.set(description.name.replace(/^C/u, ''), entries)
  }
  for (const frameClass of frameType.fclasses.values()) {
    const entries = new Map<string, ElementDef>()
    for (const property of frameClass.properties.values())
      entries.set(property.name, property.etype)
    if (entries.size > 0) groups.set(frameClass.name.replace(/^C/u, ''), entries)
  }
  if (rawProperty === undefined) {
    const prefix = rawGroup.toLocaleLowerCase()
    return [...groups]
      .filter(([name]) => name.toLocaleLowerCase().startsWith(prefix))
      .map(([name, entries]) => ({
        label: name,
        kind: 'struct' as const,
        detail: `${entries.size} frame properties`,
        documentation: [...entries.keys()].sort().join(', '),
        filterText: `@${name}/`,
        insertText: `@${name}/`,
      }))
  }
  const entries = groups.get(rawGroup)
  if (entries === undefined) return []
  const prefix = rawProperty.toLocaleLowerCase()
  return [...entries.values()]
    .filter(element => element.name.toLocaleLowerCase().startsWith(prefix))
    .map(element => ({
      ...elementItem(element),
      kind: 'property' as const,
      filterText: `@${rawGroup}/${element.name}`,
    }))
}

function simpleTypeItems(type: SimpleType): LayoutSchemaCompletionItem[] {
  return [...layoutSchemaRegistry().flattenSTypeEnumeration(type).values()].map(item => ({
    label: item.value,
    kind: 'enum',
    detail: item.label === '' ? item.originType.name : `${item.originType.name} — ${item.label}`,
  }))
}

function attributeSnippet(attribute: Attribute): string {
  const initial = attribute.default === undefined ? '$1' : `\${1:${attribute.default.replaceAll('$', '\\$')}}`
  return `${attribute.name}="${initial}"`
}

function elementSnippet(element: ElementDef, variant?: string): string {
  let index = 0
  let insertText = `<${element.name}`
  for (const attribute of element.type.attributes.values()) {
    if (!attribute.required && attribute.default === undefined) continue
    if (attribute.name === 'type' && variant !== undefined) {
      insertText += ` type="${variant}"`
      continue
    }
    index += 1
    // An enumeration without a default is offered as a choice, as MK2's snippets did (parity 3.9).
    const choices = attribute.default === undefined
      ? [...layoutSchemaRegistry().flattenSTypeEnumeration(attribute.type).values()].map(item =>
          item.value.replace(/[\\,|$}]/gu, character => `\\${character}`))
      : []
    const initial = attribute.default !== undefined
      ? `\${${index}:${attribute.default.replaceAll('$', '\\$')}}`
      : choices.length > 0 && choices.length <= 32 ? `\${${index}|${choices.join(',')}|}` : `$${index}`
    insertText += ` ${attribute.name}="${initial}"`
  }
  return element.type.struct.size === 0 && element.nodeKind !== ElementDefKind.Frame
    ? `${insertText}/>`
    : `${insertText}>$0</${element.name}>`
}

function elementItem(element: ElementDef): LayoutSchemaCompletionItem {
  const property =
    element.nodeKind === ElementDefKind.FrameProperty
      ? layoutSchemaRegistry().getFrameProperty(element)
      : undefined
  return {
    label: property === undefined ? element.name : `${element.name} [${property.fclass.name}]`,
    ...(property === undefined ? {} : { filterText: element.name }),
    kind: element.nodeKind === ElementDefKind.FrameProperty ? 'property' : 'struct',
    ...(element.label === undefined ? {} : { documentation: element.label }),
    detail: property === undefined ? element.type.name : property.etype.type.name,
    insertText: elementSnippet(element),
    insertTextFormat: 'snippet',
  }
}

function elementItems(type: ComplexType): LayoutSchemaCompletionItem[] {
  const items: LayoutSchemaCompletionItem[] = []
  for (const element of type.struct.values()) {
    if (
      element.altType === undefined ||
      !['Action', 'When', 'Controller'].includes(element.name)
    )
      items.push(elementItem(element))
    else {
      for (const [variant, statement] of element.altType.statements) {
        const specialized: ElementDef = { ...element, type: statement.type, altType: statement.altType }
        const item = elementItem(specialized)
        items.push({
          ...item,
          label: `${element.name}:${variant}`,
          detail: statement.type.name,
          insertText: elementSnippet(specialized, variant),
        })
      }
    }
  }
  return items
}

/**
 * MK2's frame shortcuts: an anchor per side, filled as authors usually write it (`$parent`, Min for
 * Left/Top, Max for Right/Bottom, offset 0), and a state group with one to five states and a default.
 */
function frameShortcutItems(type: ComplexType): LayoutSchemaCompletionItem[] {
  const items: LayoutSchemaCompletionItem[] = []
  const anchor = type.struct.get('Anchor')
  for (const side of anchor === undefined ? [] : ['Left', 'Right', 'Top', 'Bottom']) {
    let index = 0
    let insertText = `<${anchor!.name}`
    for (const attribute of anchor!.type.attributes.values()) {
      const value =
        attribute.name === 'side' ? side
        : attribute.name === 'relative' ? `\${${++index}:\\$parent}`
        : attribute.name === 'pos' ? `\${${++index}:${side === 'Left' || side === 'Top' ? 'Min' : 'Max'}}`
        : attribute.name === 'offset' ? `\${${++index}:0}`
        : `$${++index}`
      insertText += ` ${attribute.name}="${value}"`
    }
    items.push({
      label: `${anchor!.name}:${side}`,
      kind: 'snippet',
      detail: anchor!.label ?? anchor!.type.name,
      insertText: `${insertText}/>`,
      insertTextFormat: 'snippet',
    })
  }
  const group = type.struct.get('StateGroup')
  for (let states = 1; group !== undefined && states <= 5; states += 1) {
    const fallback = states + 2
    const lines = [
      `<${group.name} name="\${1:${group.name}${states}}">`,
      `\t<DefaultState val="\${${fallback}:Default}"/>`,
      ...Array.from({ length: states }, (_, state) => `\t<State name="\${${state + 2}:${state + 1}}">\n\t</State>`),
      `\t<State name="\${${fallback}:Default}">\n\t</State>`,
      `</${group.name}>`,
    ]
    items.push({
      label: `${group.name}:${states}`,
      kind: 'snippet',
      detail: group.type.name,
      insertText: lines.join('\n'),
      insertTextFormat: 'snippet',
    })
  }
  return items
}

/**
 * Adapt the compiled SC2Layout schema to the protocol-neutral MK3 completion vocabulary.
 *
 * The cursor parser and workspace ownership remain in the provider. This function only translates
 * the schema annotation already attached by `Store`, so adding or correcting a schema definition
 * automatically changes editor completion without another hand-written table.
 */
/** A frame's properties by its type; every frame class's when the frame is not known. */
function frameProperties(store: Store, frame: UINode | undefined): LayoutSchemaCompletionItem[] {
  const desc = frame?.mainDesc
  const declaration = desc === undefined ? undefined : ([...desc.xDecls][0] as XMLElement | undefined)
  const frameType = declaration?.lang.stype === undefined ? undefined : store.schema.getFrameType(declaration.lang.stype)
  const properties =
    frameType === undefined
      ? [...store.schema.frameClassProps.values()].map(group => group[0]).filter(property => property !== undefined)
      : [...frameType.fprops.values()]
  return properties.map(property => ({ label: property.name, kind: 'property', detail: `Property of ${property.fclass.name}` }))
}

/**
 * The properties `{Path/@…}` can bind (parity plan 3.16, MK2 suggestPropertyBind): those of the frame
 * the path leads to from the action's frame. `undefined` when the element has no frame to start from.
 */
export function layoutBoundFrameProperties(
  store: Store,
  uri: string,
  nodeStart: number,
  path: string,
): readonly LayoutSchemaCompletionItem[] | undefined {
  const document = store.documents.get(uri)
  const element = document?.findNodeAt(Math.min(document.text.length, nodeStart + 1)) as XMLElement | undefined
  const xray = new XRay(store)
  const origin = element === undefined ? undefined : xray.determineActionFrameNode(element)
  if (origin === undefined) return undefined
  const frame = path === '' ? origin : xray.uNavigator.resolveSelection(origin, new ExpressionParser().parsePathSelector(path).path).target
  return frameProperties(store, frame)
}

/**
 * What the frame an element addresses offers for a name (parity plan 3.10, 3.11, 3.17, MK2
 * determineTargetFrameNode): its properties, animations, state groups, the states of the group the
 * element names (`group=`, or the attribute itself in a `<When type="StateGroup" Group="…"/>`), and
 * the events its animations declare. `undefined` for any other kind.
 */
function targetFrameItems(
  store: Store,
  node: XMLElement,
  key: { builtinType: BuiltinTypeKind; name: string },
  attributeName?: string,
): LayoutSchemaCompletionItem[] | undefined {
  const xray = new XRay(store)
  const frame = () => xray.determineTargetFrameNode(node)
  const childrenOf = <T extends UINode>(kind: DescKind) => {
    const target = frame()
    return target === undefined ? [] : [...xray.uNavigator.getChildrenOfType<T>(target, kind).values()]
  }
  switch (key.builtinType) {
    case BuiltinTypeKind.PropertyName:
      return frameProperties(store, frame())
    case BuiltinTypeKind.AnimationName:
      return childrenOf<AnimationNode>(DescKind.Animation).map(animation => ({ label: animation.name, kind: 'variable', detail: `Animation of ${animation.parent?.name ?? ''}` }))
    case BuiltinTypeKind.StateGroupName:
      return childrenOf<StateGroupNode>(DescKind.StateGroup).map(group => ({
        label: group.name,
        kind: 'class',
        detail: `States: ${[...group.states.keys()].join(', ')}${group.defaultState === undefined ? '' : ` (default ${group.defaultState})`}`,
      }))
    case BuiltinTypeKind.StateGroupStateName: {
      const group = xray.determineTargetStateGroup(node, attributeName)
      return [...(group?.states.keys() ?? [])].map(state => ({ label: state, kind: 'interface', detail: `State of ${group?.name}` }))
    }
    case BuiltinTypeKind.EventName: {
      // Only a key or an action sends an event; an `<Event event=…/>` declares one and takes the native names too.
      const kind = node.lang.sdef?.nodeKind
      if (kind !== ElementDefKind.AnimationControllerKey && kind !== ElementDefKind.StateGroupStateAction) return undefined
      return childrenOf<AnimationNode>(DescKind.Animation).flatMap(animation =>
        [...animation.getEvents()].map(([event, declarations]) => ({
          label: event,
          kind: 'event' as const,
          detail: `[${animation.name}] ${declarations.map(item => item.getAttributeValue('action')).join(' | ')}`,
        })),
      )
    }
  }
  // `<When type="AnimationState" Fade="…"/>` names an animation by a key the schema leaves untyped.
  return key.name === 'AnimationStateName' ? targetFrameItems(store, node, { builtinType: BuiltinTypeKind.AnimationName, name: '' }) : undefined
}

export function layoutSchemaCompletions(
  store: Store,
  uri: string,
  nodeStart: number | undefined,
  mode: LayoutSchemaCompletionContext['mode'],
  attributeName?: string,
): LayoutSchemaCompletionContext {
  if (mode === 'root') {
    return {
      mode,
      items: [
        {
          label: 'fdesc',
          kind: 'snippet',
          detail: 'SC2Layout document',
          insertText:
            '<?xml version="1.0" encoding="utf-8" standalone="yes"?>\n<Desc>\n\t$0\n</Desc>',
          insertTextFormat: 'snippet',
        },
      ],
    }
  }
  const document = store.documents.get(uri)
  const node =
    document === undefined || nodeStart === undefined
      ? undefined
      : document.findNodeAt(Math.min(document.text.length, nodeStart + 1))
  const type = node?.lang.stype
  if (node === undefined || type === undefined) return { mode, items: [] }
  if (mode === 'element') {
    return {
      mode,
      items: node.lang.sdef?.nodeKind === ElementDefKind.Frame
        ? [...elementItems(type), ...frameShortcutItems(type)]
        : elementItems(type),
    }
  }
  if (mode === 'attribute-name') {
    if (!('attributes' in node)) return { mode, items: [] }
    const present = new Set(
      Object.keys((node as XMLElement).attributes).map(name => name.toLocaleLowerCase()),
    )
    const element = node as XMLElement
    /*
     * A When or an Action takes one attribute the schema leaves open — a property, an animation or a
     * state group of the frame it addresses — once its required ones are there (parity plan 3.10).
     */
    const open = new XRay(store).matchIndeterminateAttr(element, element.attributes[attributeName ?? '']?.name ?? '')
    const openNames = open === undefined ? [] : (targetFrameItems(store, element, open.key) ?? [])
    return {
      mode,
      items: [
        ...[...type.attributes.values()]
          .filter(attribute => !present.has(attribute.name.toLocaleLowerCase()))
          .map(attribute => ({
            label: attribute.name,
            kind: 'property' as const,
            detail: `${attribute.type.name}${attribute.required ? ' (required)' : ''}`,
            ...(attribute.label === undefined ? {} : { documentation: attribute.label }),
            insertText: attributeSnippet(attribute),
            insertTextFormat: 'snippet' as const,
          })),
        ...openNames.map(item => ({ ...item, insertText: `${item.label}="$0"`, insertTextFormat: 'snippet' as const })),
      ],
    }
  }
  const element = node as XMLElement
  const rawName = attributeName === undefined ? '' : (element.attributes?.[attributeName]?.name ?? attributeName)
  const open = type.attributes.get(attributeName ?? '') === undefined ? new XRay(store).matchIndeterminateAttr(element, rawName) : undefined
  let valueType = type.attributes.get(attributeName ?? '')?.type ?? open?.value
  if (valueType === undefined) return { mode, items: [] }
  // A property's value takes the property's own type (parity plan 3.11, MK2 getElPropertyType).
  if (valueType.builtinType === BuiltinTypeKind.PropertyValue)
    valueType = new LayoutProcessor(store, store.index).getElPropertyType(element, attributeName ?? '') ?? valueType
  const items = targetFrameItems(store, element, valueType, open === undefined ? undefined : rawName) ?? simpleTypeItems(valueType)
  return {
    mode,
    items,
    valueKind: BuiltinTypeKind[valueType.builtinType],
  }
}

/**
 * What `name=` can take when the element has no `file=`: the children its parent inherits through
 * templates that this parent does not already declare. Anything else would declare a new child,
 * which the reader types rather than picks; MK2 offered only these (suggestDescNames).
 */
export function layoutInheritedChildNames(
  store: Store,
  uri: string,
  nodeStart: number,
): readonly LayoutSchemaCompletionItem[] {
  const document = store.documents.get(uri)
  const node = document?.findNodeAt(Math.min(document.text.length, nodeStart + 1)) as XMLElement | undefined
  const parent = node?.parent as XMLElement | undefined
  if (node === undefined || parent === undefined) return []
  switch (parent.lang.sdef?.nodeKind) {
    case ElementDefKind.Frame:
    case ElementDefKind.Animation:
    case ElementDefKind.StateGroup:
      break
    default:
      return []
  }
  const parentDesc = store.index.resolveElementDesc(parent)
  const currentDesc = store.index.resolveElementDesc(node)
  if (parentDesc === undefined || currentDesc === undefined) return []
  const inherited = new UIBuilder(store.schema, store.index).buildNodeFromDesc(parentDesc)
  if (inherited === undefined) return []
  const items: LayoutSchemaCompletionItem[] = []
  for (const child of new UINavigator(store.schema, store.index).getChildrenOfType(inherited, currentDesc.kind).values()) {
    // Declared under this parent already, other than by the element being typed.
    const declared = [...child.descs].some(
      desc => !(desc.xDecls.has(node) && child.descs.size > 1) && desc.parent === parentDesc,
    )
    if (declared) continue
    items.push({
      label: child.name,
      kind: 'struct',
      ...(child.mainDesc?.stype === undefined ? {} : { detail: `[${child.mainDesc.stype.name}]` }),
      ...(child.mainDesc === undefined ? {} : { documentation: child.mainDesc.fqn }),
    })
  }
  return items
}

/** The element that declares a description: `<Frame type="…">`, `<Animation>` or `<StateGroup>`. */
function declarationOf(desc: DescNamespace | undefined): { tag: string; type?: string } | undefined {
  const element = desc === undefined ? undefined : ([...desc.xDecls][0] as XMLElement | undefined)
  const tag = element?.lang.sdef?.name
  if (desc === undefined || tag === undefined) return undefined
  if (desc.kind !== DescKind.Frame) return { tag }
  const type = desc.stype === undefined ? undefined : layoutSchemaRegistry().getFrameType(desc.stype)?.name
  return type === undefined ? undefined : { tag, type }
}

function declarationSnippet(declaration: { tag: string; type?: string }, name: string, file?: string): string {
  const type = declaration.type === undefined ? '' : ` type="${declaration.type}"`
  return `<${declaration.tag}${type} name="${name}"${file === undefined ? '' : ` file="${file}"`}>$0</${declaration.tag}>`
}

/**
 * `/File/Frame/Child` at the top of a document, one segment at a time over every description the
 * workspace snapshot holds, as MK2 offered it (ABR provideDescOverrides): files, then their frames,
 * then the children those frames have through their templates. A path that names a frame also offers
 * `[expand]`, the local override `<Frame … name="Frame/Child" file="File">`. Each item carries the
 * whole path as its filter text, because its replacement starts at the `/`.
 */
/**
 * The children at a desc path of the snapshot: the layout files at the root, a file's descs, then
 * their children through the template chains (UIBuilder/UINavigator).
 */
function descChildrenAt(store: Store, segments: readonly string[]) {
  const [file, top, ...rest] = segments
  if (file === undefined || top === undefined) {
    const parent = file === undefined ? store.index.rootNs : store.index.rootNs.get(file)
    return [...(parent?.children.values() ?? [])].map(desc => ({ name: desc.name, desc: desc as DescNamespace | undefined, count: desc.children.size }))
  }
  const topDesc = store.index.rootNs.getMulti(file, top)
  let node = topDesc === undefined ? undefined : new UIBuilder(store.schema, store.index).buildNodeFromDesc(topDesc)
  const navigator = new UINavigator(store.schema, store.index)
  if (node !== undefined && rest.length > 0) node = navigator.resolveChild(node, rest)
  return [...(node?.children.keys() ?? [])].map(name => {
    const child = navigator.resolveChild(node!, name)
    return { name, desc: child?.mainDesc, count: child?.children.size ?? 0 }
  })
}

/** An element's `attributeName=` value, or the element itself. */
function elementSite(element: XMLElement | undefined, attributeName?: string): { uri: string; start: number; end: number } | undefined {
  const uri = element?.getDocument().lang.tdoc?.uri
  if (element === undefined || uri === undefined) return undefined
  // A file's declaration is its XML document, which has no attributes.
  const attribute = attributeName === undefined ? undefined : (element.attributes as XMLElement['attributes'] | undefined)?.[attributeName]
  // `startValue` is the opening quote.
  return attribute?.startValue !== undefined && attribute.value !== undefined
    ? { uri, start: attribute.startValue + 1, end: attribute.startValue + 1 + attribute.value.length }
    : { uri, start: element.start, end: element.startTagEnd ?? element.end }
}

/** Where a desc is declared: its first declaring element's `name=` value, or the element itself. */
function declarationSite(desc: DescNamespace | undefined): { uri: string; start: number; end: number } | undefined {
  return elementSite(desc === undefined ? undefined : ([...desc.xDecls][0] as XMLElement | undefined), 'name')
}

/**
 * Where the segment under the caret of a reference value is declared (parity plan 3.23, MK2
 * definition by selection): a template's or a file's segments through the snapshot's descs, a
 * frame reference's through the frames it resolves to from the current frame (handles included).
 */
export function layoutReferenceSite(
  store: Store,
  uri: string,
  nodeStart: number,
  attributeName: string,
  typeName: string | undefined,
  value: string,
  offsetInValue: number,
): { readonly uri: string; readonly start: number; readonly end: number } | undefined {
  const segments = value.split('/')
  const index = value.slice(0, offsetInValue).split('/').length - 1
  if (attributeName.toLowerCase() === 'template' || typeName === 'DescTemplateName' || typeName === 'FileDescName') {
    const path = segments.slice(0, index + 1).filter(Boolean)
    return path.length === 0 ? undefined : declarationSite(store.index.rootNs.getMulti(...path))
  }
  const document = store.documents.get(uri)
  const element = document?.findNodeAt(Math.min(document.text.length, nodeStart + 1)) as XMLElement | undefined
  if (element === undefined) return undefined
  // `name=` beside `file=` names a description of that file, which the element extends there.
  const file = element.getAttributeValue('file')
  if (typeName === 'DescName' && attributeName.toLowerCase() === 'name' && file) {
    const path = segments.slice(0, index + 1).filter(Boolean)
    return path.length === 0 ? undefined : declarationSite(store.index.rootNs.getMulti(file, ...path))
  }
  const xray = new XRay(store)
  // `{Frame/@Property}`: on the path, the frame of the segment from the action's frame; on the property, its field.
  if (getAttrValueKind(value) === AttrValueKind.PropertyBind) {
    const bind = new ExpressionParser().parsePropertyBind(value)
    const origin = xray.determineActionFrameNode(element)
    if (origin === undefined || bind.path.length === 0) return undefined
    const chain = xray.uNavigator.resolveSelection(origin, bind.path).chain
    const at = getSelectionIndexAtPosition(bind, offsetInValue)
    if (at !== undefined) return declarationSite(chain[at]?.mainDesc)
    const frame = chain.length === bind.path.length ? chain.at(-1) : undefined
    const property = bind.property?.name?.toLowerCase()
    if (frame === undefined || property === undefined || offsetInValue < bind.property.pos) return undefined
    for (const desc of frame.descs)
      for (const declaration of desc.xDecls as Set<XMLElement>)
        for (const field of declaration.children) if (field.tag?.toLowerCase() === property) return elementSite(field)
    return undefined
  }
  const wanted = attributeName.toLowerCase()
  const builtin = [...(element.lang.stype?.attributes.values() ?? [])].find(item => item.name.toLowerCase() === wanted)?.type.builtinType
  // A frame's internal part (`<NormalImage val="Image"/>`): the path from the frame that declares it.
  if (builtin === BuiltinTypeKind.DescInternal) {
    const desc = store.index.resolveElementDesc(element)
    const selection = new ExpressionParser().parsePathSelector(value)
    const at = getSelectionIndexAtPosition(selection, offsetInValue)
    if (desc === undefined || at === undefined) return undefined
    return declarationSite(new LayoutChecker(store, store.index).resolveDescPath(desc, selection).items[at]?.[0])
  }
  // An event a controller key sends: the `<Event event=…/>` of an animation of the frame it drives.
  if (builtin === BuiltinTypeKind.EventName) {
    const target = xray.determineTargetFrameNode(element)
    if (target === undefined) return undefined
    for (const animation of xray.uNavigator.getChildrenOfType<AnimationNode>(target, DescKind.Animation).values()) {
      const event = animation.getEvents().get(value)?.[0]
      if (event !== undefined) return elementSite(event, 'event')
    }
    return undefined
  }
  if (typeName !== 'FrameReference') return undefined
  const origin = frameReferenceOrigin(xray, element, attributeName)
  if (origin === undefined) return undefined
  const selection = new ExpressionParser().parsePathSelector(segments.slice(0, index + 1).join('/'))
  const resolved = xray.uNavigator.resolveSelection(origin, selection.path)
  return resolved.chain.length > index ? declarationSite(resolved.chain[index]?.mainDesc) : undefined
}

/** The frame a frame reference starts from: a StateGroup action's attributes other than `frame` start from the action's frame. */
function frameReferenceOrigin(xray: XRay, element: XMLElement, attributeName: string) {
  const fromAction =
    element.lang.sdef?.nodeKind === ElementDefKind.StateGroupStateAction && attributeName.toLowerCase() !== 'frame'
  return fromAction ? xray.determineActionFrameNode(element) : xray.determineCurrentFrameNode(element)
}

/** One segment of a frame reference value, its span in the value and every declaration of the frame it reaches. */
export interface LayoutFrameReferenceSegment {
  readonly text: string
  readonly start: number
  readonly end: number
  readonly sites: readonly LayoutSite[]
  /**
   * For a named segment that reaches nothing from the reference's own frame (`$parent/Backdrop`
   * inside a template): the declarations of the frame it reaches from each instance of that
   * template, and whether every instance was resolved.
   */
  readonly instances?: { readonly reached: readonly (readonly LayoutSite[])[]; readonly complete: boolean }
}

/** The `name=` site of every element declaring a frame the hierarchy holds. */
function frameSites(node: { readonly descs: ReadonlySet<DescNamespace> } | undefined): LayoutSite[] {
  const sites: LayoutSite[] = []
  for (const desc of node?.descs ?? [])
    for (const declaration of desc.xDecls as Set<XMLElement>) {
      const site = elementSite(declaration, 'name')
      if (site !== undefined) sites.push(site)
    }
  return sites
}

/** Instances resolved for one reference at most, across nested templates. */
const MAX_TEMPLATE_INSTANCES = 256
/** Templates of templates followed for one reference. */
const MAX_TEMPLATE_DEPTH = 3

/**
 * What a path inside a template reaches from each instance of it: a template's frame takes its
 * `$parent` from the frame the template is used under. An instance that sits in a template itself
 * is resolved through that template's instances in turn. `complete` is false when the template has
 * no instance in the snapshot (the game creates it), an instance reaches nothing, or the bounds stop
 * the walk.
 */
function templateInstanceReach(
  xray: XRay,
  store: Store,
  desc: DescNamespace,
  path: Parameters<XRay['uNavigator']['resolveSelection']>[1],
  segment: number,
  depth: number,
  budget: { left: number },
): { reached: LayoutSite[][]; complete: boolean } {
  const names: string[] = []
  let top: DescNamespace | undefined = desc
  while (top?.parent !== undefined && top.parent.kind !== DescKind.File) {
    names.unshift(top.name)
    top = top.parent
  }
  const users = top === undefined ? undefined : store.index.tplRefs.get(top.fqn)
  if (users === undefined || users.size === 0) return { reached: [], complete: false }
  const reached: LayoutSite[][] = []
  let complete = true
  for (const user of users) {
    if (budget.left-- <= 0) return { reached, complete: false }
    const built = xray.uBuilder.buildNodeFromDesc(user)
    const node = built === undefined || names.length === 0 ? built : xray.uNavigator.resolveChild(built, names)
    const origin = node === undefined ? undefined : xray.uNavigator.getContextFrameNode(node)
    const chain = origin === undefined ? [] : xray.uNavigator.resolveSelection(origin, path).chain
    if (chain.length > segment) {
      reached.push(frameSites(chain[segment]))
      continue
    }
    const deeper = depth > 0 ? templateInstanceReach(xray, store, user, path, segment, depth - 1, budget) : undefined
    if (deeper === undefined || deeper.reached.length === 0) {
      complete = false
      continue
    }
    reached.push(...deeper.reached)
    if (!deeper.complete) complete = false
  }
  return { reached, complete }
}

/**
 * Each segment of a frame reference value (`relative="$parent/Title"`, `frame="Panel/Title"`) with
 * the `name=` site of every element declaring the frame it reaches from the reference's own frame —
 * the resolution `layoutReferenceSite` uses, handles and template chains included. A frame an
 * instance holds is declared by its template and by any local override, so every declaration counts.
 * References and rename match frames through it rather than by a short name, which many frames of
 * Core share. `undefined` when the attribute is not a frame reference or its element has no frame to
 * start from; a segment the path does not reach has no sites.
 */
export function layoutFrameReferenceTargets(
  store: Store,
  uri: string,
  nodeStart: number,
  attributeName: string,
  typeName: string | undefined,
  value: string,
): readonly LayoutFrameReferenceSegment[] | undefined {
  if (typeName !== 'FrameReference') return undefined
  const document = store.documents.get(uri)
  const element = document?.findNodeAt(Math.min(document.text.length, nodeStart + 1)) as XMLElement | undefined
  if (element === undefined) return undefined
  const xray = new XRay(store)
  const origin = frameReferenceOrigin(xray, element, attributeName)
  if (origin === undefined) return undefined
  const path = new ExpressionParser().parsePathSelector(value).path
  const resolved = xray.uNavigator.resolveSelection(origin, path)
  const desc = store.index.resolveElementDesc(element)
  const budget = { left: MAX_TEMPLATE_INSTANCES }
  const segments: LayoutFrameReferenceSegment[] = []
  let start = 0
  for (const [index, text] of value.split('/').entries()) {
    const sites = frameSites(resolved.chain[index])
    const named = text !== '' && !text.startsWith('$')
    const instances =
      sites.length > 0 || !named || desc === undefined
        ? undefined
        : templateInstanceReach(xray, store, desc, path, index, MAX_TEMPLATE_DEPTH, budget)
    segments.push({ text, start, end: start + text.length, sites, ...(instances === undefined ? {} : { instances }) })
    start += text.length + 1
  }
  return segments
}

/** What `{Path/@Property}` binds (parity plan 3.22): the frame the path reaches and the property's type. */
export function layoutBindTarget(
  store: Store,
  uri: string,
  nodeStart: number,
  value: string,
): { readonly frame: string; readonly frameType?: string; readonly property: string; readonly type?: string } | undefined {
  const document = store.documents.get(uri)
  const element = document?.findNodeAt(Math.min(document.text.length, nodeStart + 1)) as XMLElement | undefined
  if (element === undefined) return undefined
  const xray = new XRay(store)
  const bind = new ExpressionParser().parsePropertyBind(value)
  const origin = xray.determineActionFrameNode(element)
  const frame = origin === undefined || bind.path.length === 0 ? undefined : xray.uNavigator.resolveSelection(origin, bind.path).target
  const name = bind.property?.name
  if (frame === undefined || !name) return undefined
  const frameType = declarationOf(frame.mainDesc)?.type
  const type = store.schema.getPropertyByName(name)?.etype.type.attributes.get('val')?.type.name
  return { frame: frame.fqn, ...(frameType === undefined ? {} : { frameType }), property: name, ...(type === undefined ? {} : { type }) }
}

/** Where an event a key or an action sends is handled: each `<Event event=…/>` of the frame's animations. */
export function layoutEventTargets(
  store: Store,
  uri: string,
  nodeStart: number,
  event: string,
): readonly { readonly animation: string; readonly action: string }[] | undefined {
  const document = store.documents.get(uri)
  const element = document?.findNodeAt(Math.min(document.text.length, nodeStart + 1)) as XMLElement | undefined
  const kind = element?.lang.sdef?.nodeKind
  if (element === undefined || (kind !== ElementDefKind.AnimationControllerKey && kind !== ElementDefKind.StateGroupStateAction)) return undefined
  const xray = new XRay(store)
  const frame = xray.determineTargetFrameNode(element)
  if (frame === undefined) return undefined
  return [...xray.uNavigator.getChildrenOfType<AnimationNode>(frame, DescKind.Animation).values()].flatMap(animation =>
    (animation.getEvents().get(event) ?? []).map(declaration => ({ animation: animation.name, action: declaration.getAttributeValue('action') ?? '' })),
  )
}

export interface LayoutSite {
  readonly uri: string
  readonly start: number
  readonly end: number
}

/**
 * Where an element names an animation or a state group, and which kind it names: an attribute typed
 * AnimationName or StateGroupName (its value), or the open attribute of a When (its name).
 */
function memberReference(
  xray: XRay,
  element: XMLElement,
  attribute: XMLElement['attributes'][string],
): { kind: DescKind; name: string; start: number; end: number } | undefined {
  const declared = element.lang.stype?.attributes.get(attribute.name.toLowerCase())
  const kindOf = (key: { builtinType: BuiltinTypeKind; name: string }) =>
    key.builtinType === BuiltinTypeKind.StateGroupName
      ? DescKind.StateGroup
      : key.builtinType === BuiltinTypeKind.AnimationName || key.name === 'AnimationStateName'
        ? DescKind.Animation
        : undefined
  if (declared !== undefined) {
    const kind = kindOf(declared.type)
    const start = attribute.startValue === undefined ? undefined : attribute.startValue + 1
    return kind === undefined || start === undefined || !attribute.value
      ? undefined
      : { kind, name: attribute.value, start, end: start + attribute.value.length }
  }
  const open = xray.matchIndeterminateAttr(element, attribute.name)
  const kind = open === undefined ? undefined : kindOf(open.key)
  return kind === undefined ? undefined : { kind, name: attribute.name, start: attribute.start, end: attribute.start + attribute.name.length }
}

/**
 * The animation or state group under the caret — at its `name=` or where an element names it — and
 * every place naming the same one (parity plan 3.24). A name resolves through the frame the element
 * addresses (`frame=` included), so one inherited through a template counts and the same name in
 * another frame does not. `undefined` when the caret is on neither.
 */
export function layoutFrameMemberSites(
  store: Store,
  uri: string,
  offset: number,
):
  | {
      readonly name: string
      readonly under: LayoutSite
      readonly declarations: readonly LayoutSite[]
      readonly references: readonly LayoutSite[]
    }
  | undefined {
  const document = store.documents.get(uri)
  const element = document?.findNodeAt(Math.min(document.text.length, offset)) as XMLElement | undefined
  const attribute = element?.attributes === undefined ? undefined : element.findAttributeAt(offset)
  if (element === undefined || attribute === null || attribute === undefined) return undefined
  const xray = new XRay(store)
  const resolve = (at: XMLElement, kind: DescKind, name: string) => {
    const frame = xray.determineTargetFrameNode(at)
    const lower = name.toLowerCase()
    return frame === undefined
      ? undefined
      : [...xray.uNavigator.getChildrenOfType(frame, kind).values()].find(node => node.name.toLowerCase() === lower)
  }
  let target: { kind: DescKind; name: string; descs: Set<DescNamespace>; under: LayoutSite } | undefined
  const nodeKind = element.lang.sdef?.nodeKind
  if ((nodeKind === ElementDefKind.Animation || nodeKind === ElementDefKind.StateGroup) && attribute.name.toLowerCase() === 'name') {
    const desc = store.index.resolveElementDesc(element)
    const site = elementSite(element, 'name')
    if (desc !== undefined && site !== undefined && attribute.value)
      target = { kind: desc.kind, name: attribute.value, descs: new Set([desc]), under: site }
  } else {
    const reference = memberReference(xray, element, attribute)
    const node = reference === undefined ? undefined : resolve(element, reference.kind, reference.name)
    if (reference !== undefined && node !== undefined)
      target = { ...reference, descs: new Set(node.descs), under: { uri, start: reference.start, end: reference.end } }
  }
  if (target === undefined) return undefined
  const sites: LayoutSite[] = []
  const declared = new Set(target.descs)
  const lower = target.name.toLowerCase()
  const visit = (node: XMLElement, documentUri: string) => {
    for (const attr of Object.values(node.attributes ?? {})) {
      if (attr.value?.toLowerCase() !== lower && attr.name.toLowerCase() !== lower) continue
      const reference = memberReference(xray, node, attr)
      if (reference?.kind !== target.kind || reference.name.toLowerCase() !== lower) continue
      const named = resolve(node, reference.kind, reference.name)
      if (named === undefined || ![...named.descs].some(desc => target.descs.has(desc))) continue
      for (const desc of named.descs) declared.add(desc)
      sites.push({ uri: documentUri, start: reference.start, end: reference.end })
    }
    for (const child of node.children) visit(child, documentUri)
  }
  for (const [documentUri, root] of store.documents) for (const child of root.children) visit(child as XMLElement, documentUri)
  // ponytail: one pass — an override found only through a second reference is not followed.
  const declarations = [...declared].flatMap(desc =>
    [...(desc.xDecls as Set<XMLElement>)].flatMap(declaration => elementSite(declaration, 'name') ?? []),
  )
  return { name: target.name, under: target.under, declarations, references: sites }
}

/**
 * The names a frame reference takes at the segment under the caret (parity plan 3.15, MK2
 * suggestSelection for FrameReference): first the handles and the current frame's children, after
 * a segment the children of the frame the path so far resolves to, through the template chains, and
 * `$parent`. A StateGroup action's attributes other than `frame` start from the action's frame.
 * `undefined` when the element has no frame to start from; `[]` when the path resolves to nothing.
 */
export function layoutFrameReferenceSegments(
  store: Store,
  uri: string,
  nodeStart: number,
  attributeName: string,
  typed: string,
): readonly { readonly name: string; readonly kind: 'keyword' | 'struct'; readonly detail: string }[] | undefined {
  const document = store.documents.get(uri)
  const element = document?.findNodeAt(Math.min(document.text.length, nodeStart + 1)) as XMLElement | undefined
  if (element === undefined) return undefined
  const xray = new XRay(store)
  const fromAction =
    element.lang.sdef?.nodeKind === ElementDefKind.StateGroupStateAction && attributeName.toLowerCase() !== 'frame'
  const origin = fromAction ? xray.determineActionFrameNode(element) : xray.determineCurrentFrameNode(element)
  if (origin === undefined) return undefined
  const segments = typed.split('/')
  const partial = (segments.pop() ?? '').toLocaleLowerCase()
  const handle = (name: string) => ({ name, kind: 'keyword' as const, detail: 'SC2Layout frame handle' })
  const items: { name: string; kind: 'keyword' | 'struct'; detail: string }[] = []
  let target = origin
  if (segments.length === 0) {
    items.push(...['$this', '$parent', '$sibling', '$ancestor', '$layer'].map(handle))
    // Named handles (`<Handle val="Name"/>`) anywhere in the snapshot, at the start only.
    for (const named of store.index.handles.values()) {
      if (named.isOrphan()) continue
      const desc = named.desc
      items.push({
        name: `$${named.name}`,
        kind: 'keyword',
        detail: `${declarationOf(desc)?.type ?? 'Frame'} ${desc?.fqn ?? ''}`.trim(),
      })
    }
  } else {
    const selection = new ExpressionParser().parsePathSelector(segments.join('/'))
    const resolved = xray.uNavigator.resolveSelection(origin, selection.path)
    const last = resolved.chain.at(-1)
    if (last === undefined || resolved.chain.length < selection.path.length) return []
    target = last
    items.push(handle('$parent'))
  }
  if (!target.build) xray.uBuilder.expandNode(target, [])
  for (const name of target.children.keys()) {
    const child = xray.uNavigator.resolveChild(target, name)
    if (child?.mainDesc?.kind !== DescKind.Frame) continue
    items.push({ name, kind: 'struct', detail: `${declarationOf(child.mainDesc)?.type ?? 'Frame'} ${child.fqn}` })
  }
  /*
   * `$ancestor[type=…]`, `[oftype=…]`, `[name=…]`: the keys, then the frame types or the names of
   * the frames above, each as the whole segment so the editor filters it like any other.
   */
  if (partial.startsWith('$ancestor[')) {
    const key = /^\$ancestor\[(\w*)=/u.exec(partial)?.[1]
    if (key === undefined) {
      for (const name of ['type', 'oftype', 'name'])
        items.push({ name: `$ancestor[${name}=`, kind: 'keyword', detail: 'SC2Layout ancestor selector' })
    } else if (key === 'type' || key === 'oftype') {
      for (const type of store.schema.frameTypes.values())
        items.push({ name: `$ancestor[${key}=${type.name}]`, kind: 'keyword', detail: 'Frame type' })
    } else if (key === 'name') {
      for (let above = target.parent; above?.mainDesc?.kind === DescKind.Frame; above = above.parent)
        items.push({ name: `$ancestor[name=${above.name}]`, kind: 'keyword', detail: above.fqn })
    }
  }
  return items.filter(item => item.name.toLocaleLowerCase().startsWith(partial))
}

/**
 * The names a `template=` or `file=` value may take at its last segment (parity plan 3.14, MK2
 * suggestSelection): the snapshot's layout files first, then a file's descs and their children.
 * `filesOnly` stops at the files (`file=` names one).
 */
export function layoutDescSegments(
  store: Store,
  typed: string,
  filesOnly = false,
): readonly { readonly name: string; readonly detail: string }[] {
  const segments = typed.split('/')
  const partial = (segments.pop() ?? '').toLocaleLowerCase()
  if (filesOnly && segments.length > 0) return []
  return descChildrenAt(store, segments)
    .filter(child => child.name.toLocaleLowerCase().startsWith(partial))
    .map(child => {
      const declaration = declarationOf(child.desc)
      return { name: child.name, detail: `${declaration?.type ?? declaration?.tag ?? 'File'} (${child.count})` }
    })
}

export function layoutDescPathCompletions(store: Store, typed: string): readonly LayoutSchemaCompletionItem[] {
  const segments = typed.split('/')
  const partial = segments.pop() ?? ''
  const children = descChildrenAt(store, segments)
  const wanted = partial.toLocaleLowerCase()
  const items: LayoutSchemaCompletionItem[] = []
  for (const child of children) {
    if (!child.name.toLocaleLowerCase().startsWith(wanted)) continue
    const path = [...segments, child.name].join('/')
    const declaration = declarationOf(child.desc)
    items.push({
      label: child.name,
      kind: 'struct',
      detail: `${declaration?.type ?? declaration?.tag ?? 'File'} (${child.count})`,
      filterText: `/${path}`,
      insertText: `/${path}`,
    })
    // A frame of a file, or deeper: overriding it locally is what the path is usually typed for.
    if (segments.length >= 1 && declaration !== undefined && child.name.toLocaleLowerCase() === wanted) {
      const [owner = '', ...inside] = path.split('/')
      items.push({
        label: `${path} [expand]`,
        kind: 'snippet',
        detail: 'Create a local description override',
        filterText: `/${path}`,
        insertText: declarationSnippet(declaration, inside.join('/'), owner),
        insertTextFormat: 'snippet',
      })
    }
  }
  return items
}

/**
 * `.` in a frame body, as MK2 offered it (ABR provideChildrenNodes): the children this frame has
 * through its whole template chain and does not declare yet, then the hookups its frame type expects
 * that nothing provides — under their `HookupAlias` name, required ones marked `*` and sorted first.
 * `undefined` when the element is not a frame.
 */
export function layoutFrameChildCompletions(
  store: Store,
  uri: string,
  nodeStart: number,
): readonly LayoutSchemaCompletionItem[] | undefined {
  const document = store.documents.get(uri)
  const element = document?.findNodeAt(Math.min(document.text.length, nodeStart + 1)) as XMLElement | undefined
  const current = element === undefined ? undefined : store.index.resolveElementDesc(element)
  if (element === undefined || current?.kind !== DescKind.Frame) return undefined
  const node = new XRay(store).determineCurrentFrameNode(element)
  if (node === undefined) return undefined
  const navigator = new UINavigator(store.schema, store.index)
  const items: LayoutSchemaCompletionItem[] = []
  for (const name of node.children.keys()) {
    const child = navigator.resolveChild(node, name)
    if (child === undefined) continue
    // Declared under this frame already, other than by the element being typed.
    if ([...child.descs].some(desc => !(desc.xDecls.has(element) && child.descs.size > 1) && desc.parent === current))
      continue
    const declaration = declarationOf(child.mainDesc)
    if (declaration === undefined) continue
    const label = `${child.name}[${declaration.type ?? declaration.tag}]`
    items.push({
      label,
      kind: 'struct',
      detail: `${child.fqn} (${child.children.size})`,
      filterText: `.${label}`,
      sortText: `1${label}`,
      insertText: declarationSnippet(declaration, child.name),
      insertTextFormat: 'snippet',
    })
  }
  if (node instanceof FrameNode && node.mainDesc?.stype !== undefined) {
    const aliases = node.propHookupAlias
    for (const hookup of store.schema.getFrameType(node.mainDesc.stype).hookups.values()) {
      const path = aliases.get(hookup.path)?.alias || hookup.path
      if (navigator.resolveChild(node, path.split('/')) !== undefined) continue
      const type = hookup.fClass.name.replace(/^C/u, '')
      const label = `${path}[${type}] /H${hookup.required ? '*' : ''}`
      items.push({
        label,
        kind: 'snippet',
        detail: `Hookup - ${hookup.required ? '[Required]' : '[Optional]'}`,
        filterText: `.${label}`,
        sortText: `${hookup.required ? 0 : 2}${label}`,
        insertText: `<Frame type="${type}" name="${path}">$0</Frame>`,
        insertTextFormat: 'snippet',
      })
    }
  }
  return items
}

/** A schema-indexed store over the documents a language request carries. */
export function layoutStore(documents: readonly LayoutTextDocument[]): Store {
  const store = new Store(layoutSchemaRegistry())
  for (const document of documents) {
    store.updateDocument(document.uri, document.text, document.version ?? 1)
  }
  return store
}

export interface LayoutSchemaColorValue {
  /** Authored attribute-value offsets, excluding the XML quotes. */
  readonly start: number
  readonly end: number
  /** Literal value after resolving a constant chain, when one was authored. */
  readonly value: string
}

export interface LayoutSchemaHoverInfo {
  readonly name: string
  readonly typeName: string
  readonly required?: boolean
  readonly label?: string
  readonly documentation?: string
  /** Every value the attribute's type admits, when it is an enumeration. */
  readonly values?: readonly { readonly value: string; readonly label?: string }[]
  /** An element's attributes, as MK2's element hover listed them. */
  readonly attributes?: readonly { readonly name: string; readonly typeName: string; readonly required: boolean; readonly label?: string }[]
  /** A frame element's type, and whether only Blizzard's own layouts may use it. */
  readonly frameType?: { readonly name: string; readonly blizzardOnly: boolean }
}

/**
 * The attribute a When or an Action leaves open (a property, an animation, a state group), typed by
 * what it names: a property's value by the property's own type (MK2's hover fell back onto it too).
 */
function openAttribute(store: Store, element: XMLElement, attributeName: string): Attribute | undefined {
  if (!('attributes' in element)) return undefined
  const name = element.attributes[attributeName.toLocaleLowerCase()]?.name ?? attributeName
  const open = new XRay(store).matchIndeterminateAttr(element, name)
  if (open === undefined) return undefined
  const type =
    open.value.builtinType === BuiltinTypeKind.PropertyValue
      ? (new LayoutProcessor(store, store.index).getElPropertyType(element, name.toLocaleLowerCase()) ?? open.value)
      : open.value
  return { name: open.key.name, type, required: true }
}

/** Schema identity and documentation attached to an indexed element or attribute. */
export function layoutSchemaHoverInfo(
  store: Store,
  uri: string,
  nodeStart: number,
  attributeName?: string,
): LayoutSchemaHoverInfo | undefined {
  const document = store.documents.get(uri)
  const node = document?.findNodeAt(Math.min(document.text.length, nodeStart + 1))
  const type = node?.lang.stype
  if (node === undefined || type === undefined) return undefined
  if (attributeName !== undefined) {
    const wanted = attributeName.toLocaleLowerCase()
    const attribute =
      type.attributes.get(attributeName) ??
      [...type.attributes.values()].find(item => item.name.toLocaleLowerCase() === wanted) ??
      openAttribute(store, node as XMLElement, attributeName)
    if (attribute === undefined) return undefined
    const enumeration = [
      ...layoutSchemaRegistry().flattenSTypeEnumeration(attribute.type).values(),
    ].map(item => ({ value: item.value, ...(item.label ? { label: item.label } : {}) }))
    return {
      name: attribute.name,
      typeName: attribute.type.name,
      required: attribute.required,
      ...(enumeration.length === 0 ? {} : { values: enumeration }),
      ...(attribute.label === undefined ? {} : { label: attribute.label }),
      ...(attribute.documentation === undefined
        ? attribute.type.documentation === undefined
          ? {}
          : { documentation: attribute.type.documentation }
        : { documentation: attribute.documentation }),
    }
  }
  const definition = node.lang.sdef
  const frameType = definition?.nodeKind === ElementDefKind.Frame ? store.schema.getFrameType(type) : undefined
  return {
    name:
      definition?.name ??
      ('tag' in node && typeof node.tag === 'string' ? node.tag : type.name),
    typeName: type.name,
    attributes: [...type.attributes.values()].map(item => ({
      name: item.name,
      typeName: item.type.name,
      required: item.required,
      ...(item.label === undefined ? {} : { label: item.label }),
    })),
    ...(frameType === undefined ? {} : { frameType: { name: frameType.name, blizzardOnly: frameType.blizzOnly } }),
    ...((definition?.label ?? type.label) === undefined
      ? {}
      : { label: definition?.label ?? type.label }),
    ...((definition?.documentation ?? type.documentation) === undefined
      ? {}
      : { documentation: definition?.documentation ?? type.documentation }),
  }
}

function canContainColor(type: SimpleType): boolean {
  return (
    type.builtinType === BuiltinTypeKind.Color ||
    type.builtinType === BuiltinTypeKind.Mixed ||
    type.builtinType === BuiltinTypeKind.PropertyValue
  )
}

/**
 * Color literals exposed by the real schema for one indexed document.
 *
 * The returned range always selects the authored value. A `#Constant` therefore keeps its source
 * range while `value` contains the terminal literal used for the swatch, matching the former LSP
 * provider without exposing its transport or server classes.
 */
export function layoutSchemaColorValues(
  store: Store,
  uri: string,
): readonly LayoutSchemaColorValue[] {
  const document = store.documents.get(uri)
  const root = document?.getRootNode()
  if (root === undefined) return []
  const xray = new XRay(store)
  const values: LayoutSchemaColorValue[] = []

  const visit = (element: XMLElement): void => {
    const type = element.lang.stype
    if (type !== undefined) {
      for (const attribute of Object.values(element.attributes)) {
        if (attribute.startValue === undefined || attribute.value === undefined) continue
        const declared = type.attributes.get(attribute.name)
        const valueType =
          declared?.type ?? xray.matchIndeterminateAttr(element, attribute.name)?.value
        const kind = getAttrValueKind(attribute.value)
        let value: string | undefined
        if (isConstantValueKind(kind)) {
          const chain = store.index.resolveConstantDeep(
            attribute.value.slice(AttrValueKindOffset[kind as AttrValueConstant]),
          )
          value = chain?.at(-1)?.value
        } else if (valueType !== undefined && canContainColor(valueType)) {
          value = attribute.value
        }
        if (value === undefined || !reValueColor.test(value)) continue
        values.push({
          start: attribute.startValue + 1,
          end: attribute.startValue + 1 + attribute.value.length,
          value: value.trim(),
        })
      }
    }
    for (const child of element.children) visit(child as XMLElement)
  }
  visit(root)
  return values
}

export interface LayoutSchemaTextValue {
  /** Offsets of the whole authored value, prefix included. */
  readonly start: number
  readonly end: number
  readonly element: string
  readonly attribute: string
  readonly value: string
}

/**
 * Every attribute value the real schema types as `Text`, including indeterminate `Action`
 * properties matched through XRay. This is the authority a lighter scanner is checked against: a
 * GameStrings key rename that misses one of these leaves a layout pointing at a key that is gone.
 */
export function layoutSchemaTextValues(store: Store, uri: string): readonly LayoutSchemaTextValue[] {
  const document = store.documents.get(uri)
  const root = document?.getRootNode()
  if (root === undefined) return []
  const xray = new XRay(store)
  const values: LayoutSchemaTextValue[] = []
  const visit = (element: XMLElement): void => {
    const type = element.lang.stype
    if (type !== undefined) {
      for (const attribute of Object.values(element.attributes)) {
        if (attribute.startValue === undefined || attribute.value === undefined) continue
        const valueType =
          type.attributes.get(attribute.name)?.type ??
          xray.matchIndeterminateAttr(element, attribute.name)?.value
        if (valueType?.builtinType !== BuiltinTypeKind.Text) continue
        values.push({
          start: attribute.startValue + 1,
          end: attribute.startValue + 1 + attribute.value.length,
          element: element.tag ?? '',
          attribute: attribute.name,
          value: attribute.value,
        })
      }
    }
    for (const child of element.children) visit(child as XMLElement)
  }
  visit(root)
  return values
}

export interface LayoutSchemaFinding {
  readonly start: number
  readonly end: number
  readonly category: number
  readonly message: string
  /** The checker rule (`sc2-layout/schema/<rule>`, parity plan 3.27). */
  readonly code: string
}

/**
 * What the ported checker says about one document.
 *
 * It answers an empty list rather than throwing when the document is not in the store: a caller
 * that sent a workspace without the file it is asking about has a bug, but reporting it as a
 * checker failure would blame the file.
 */
export function layoutSchemaFindings(
  store: Store,
  uri: string,
): readonly LayoutSchemaFinding[] {
  const document = store.documents.get(uri)
  if (document === undefined) return []
  return new LayoutChecker(store, store.index).checkFile(document).map(item => ({
    start: item.start,
    end: item.end,
    category: item.category,
    message: item.message,
    code: item.code ?? 'sc2-layout/schema',
  }))
}
