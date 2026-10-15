import { type LayoutDocument, Store } from './store.js'
import {
  XMLElement,
  XMLNode,
  type DiagnosticReport,
  XMLDocument,
  type AttrValueConstant,
  AttrValueKindOffset,
  type SC2Layout,
} from '../types.js'
import * as sch from '../schema/base.js'
import { splitSlashDelimetedStr, getAttrValueKind, isConstantValueKind } from '../parser/utils.js'
import { StringIcaseMap } from '../common.js'

export class DescXRef {
  declarations = new Set<XMLElement>()

  constructor(
    public readonly name: string,
    protected readonly dIndex: DescIndex,
  ) {}

  isOrphan() {
    return this.declarations.size === 0
  }

  // addDecl(el: XMLElement) {
  //     this.declarations.add(el);
  // }
}

export class DescXRefMap<T extends DescXRef> extends Map<string, T> {
  protected descGroup = new Map<XMLDocument, Set<XMLElement>>()
  protected nodeIndex = new Map<XMLElement, T>()

  constructor(
    protected dIndex: DescIndex,
    protected itemType: { new (name: string, dIndex: DescIndex): T },
    protected indexAttrKey = 'name',
  ) {
    super()
  }

  appendOrCreate(el: XMLElement, xdoc: XMLDocument) {
    const key = el.getAttributeValue(this.indexAttrKey)! // FIX TS2345: ! — indexed elements always have the key attr
    let item = this.get(key)
    if (!item) {
      item = new this.itemType(key, this.dIndex)
      this.set(key, item)
    }

    item.declarations.add(el)
    this.nodeIndex.set(el, item)

    //
    if (!xdoc) xdoc = el.getDocument()
    let descGroupEntry = this.descGroup.get(xdoc)
    if (!descGroupEntry) {
      descGroupEntry = new Set<XMLElement>()
      this.descGroup.set(xdoc, descGroupEntry)
    }
    descGroupEntry.add(el)
  }

  removeOrDestroy(el: XMLElement) {
    // const key = el.getAttributeValue(this.indexAttrKey);
    // let item = this.get(key);
    const item = this.nodeIndex.get(el)
    if (item) {
      this.nodeIndex.delete(el)
      item.declarations.delete(el)
      if (item.isOrphan()) {
        this.delete(item.name)
      }
    }
  }

  purgeDocumentDecls(xdoc: XMLDocument) {
    const entries = this.descGroup.get(xdoc)
    if (!entries) return
    for (const item of entries) {
      this.removeOrDestroy(item)
    }
    this.descGroup.delete(xdoc)
  }
}

export class ConstantItem extends DescXRef {
  get value() {
    let r: string | undefined // FIX TS2322+TS2454: widen to allow undefined
    for (const decl of this.declarations) {
      r = decl.getAttributeValue('val', undefined)
      if (r) break // getAttributeValue returns '' (falsy) when the attr is absent
    }
    return r
  }
}

export class HandleItem extends DescXRef {
  get desc() {
    const parentEl = Array.from(this.declarations)[0]!.parent as XMLElement // FIX TS2532: ! — only called when declarations non-empty
    return this.dIndex.resolveElementDesc(parentEl)
  }
}

// ===

// Runtime consumers compare and reflect these values after package compilation.
export enum DescKind {
  Undeclared,
  Root,
  File,
  Frame,
  Animation,
  StateGroup,
}

export interface DescStrCaseMissmatchInfo<T> {
  _icaseMissmatch?: string
  r: T
}

export class DescNamespace {
  kind: DescKind
  parent?: DescNamespace
  readonly name: string
  readonly children = new StringIcaseMap<DescNamespace>()
  readonly xDecls = new Set<XMLNode>()
  readonly descExtensions?: Map<string, Set<DescNamespace>> // FileDesc

  constructor(
    name: string,
    kind = DescKind.Undeclared,
    parent?: DescNamespace,
    protected sInitialType?: sch.ComplexType,
  ) {
    this.name = name
    this.kind = kind
    if (parent) {
      this.parent = parent
      parent.children.set(name, this)
    }

    if (this.kind === DescKind.File) {
      this.descExtensions = new Map()
    }
  }

  getOrCreate(name: string, kind: DescKind) {
    let tmp = this.children.get(name)
    if (!tmp) {
      tmp = new DescNamespace(name, kind, this)
    }
    return tmp
  }

  purgeOrphansDeep() {
    for (const tmp of this.children.values()) {
      tmp.purgeOrphansDeep()
    }
    if (this.children.size) return
    this.parent!.children.delete(this.name) // FIX TS2532: ! — only called on non-root nodes that have a parent
    ;(this as any).parent = void 0 // FIX TS2412: exactOptionalPropertyTypes — cast to bypass strict undefined-to-optional check
  }

  get(name: string) {
    return this.children.get(name)
  }

  getMulti(...names: string[]) {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    let current: DescNamespace | undefined = this // FIX TS2322: widen to allow undefined from Map.get
    for (const tmp of names) {
      current = current!.children.get(tmp) // ! — current is defined at loop top (early return guards it)
      if (!current) return
    }
    return current
  }

  getStrictCase(...names: string[]) {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    let current: DescNamespace | undefined = this // FIX TS2322: widen
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    let strictCurrent: DescNamespace | undefined = this // FIX TS2322: widen
    let strICaseMiss: string | undefined // FIX TS2454: widen to allow undefined
    for (const tmp of names) {
      strictCurrent = current!.children.getStrictCase(tmp) // ! — current defined at loop top
      if (!strictCurrent) {
        current = current!.children.get(tmp) // ! — same invariant
        if (!current) return

        strICaseMiss = tmp
      } else {
        current = strictCurrent
      }
    }

    if (strICaseMiss) {
      return <DescStrCaseMissmatchInfo<DescNamespace>>{
        r: current!, // FIX TS2322: ! — current is defined when we haven't returned early
        _icaseMissmatch: strICaseMiss, // narrowed to string by truthiness guard above
      }
    }

    return current
  }

  getDeep(name: string) {
    const parts = splitSlashDelimetedStr(name)
    if (parts.length === 0) return void 0

    // eslint-disable-next-line @typescript-eslint/no-this-alias
    let tmp: DescNamespace | undefined = this // FIX TS2322: widen
    let i = 0
    while (tmp && i < parts.length) {
      tmp = tmp.children.get(parts[i]!) // FIX TS2345: ! — i < parts.length guarantees in-bounds
      ++i
    }
    return tmp
  }

  public ancestorOfKind(kind: DescKind): DescNamespace | undefined {
    // FIX TS7023: explicit return type breaks circular inference
    let tmp: DescNamespace | undefined = this.parent
    while (tmp) {
      if (tmp.kind === kind) return tmp
      tmp = tmp.parent
    }
  }

  get fqn(): string {
    return this.parent && this.parent.kind !== DescKind.Root
      ? `${this.parent.fqn}/${this.name}`
      : this.name
  }

  get descRelativeName(): string {
    return this.parent && this.parent.kind !== DescKind.Root && this.parent.kind !== DescKind.File
      ? `${this.parent.descRelativeName}/${this.name}`
      : this.name
  }

  get descRelativeChain() {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    let tmp: DescNamespace | undefined = this // FIX TS2322: widen to allow undefined from parent traversal
    const chain: DescNamespace[] = []
    while (tmp) {
      if (tmp.kind === DescKind.Root || tmp.kind === DescKind.File) break
      chain.push(tmp)
      tmp = tmp.parent
    }
    return chain.reverse()
  }

  get topDescItem() {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    let tmp: DescNamespace = this
    while (tmp.parent) {
      if (tmp.parent.kind === DescKind.Root || tmp.parent.kind === DescKind.File) break
      tmp = tmp.parent
    }
    return tmp
  }

  get stype() {
    if (this.xDecls.size === 0) {
      return this.sInitialType
    }
    return Array.from(this.xDecls.values())[0]!.lang.stype // FIX TS2532: ! — xDecls.size > 0 checked above
  }

  get template() {
    const tmp = Array.from(this.xDecls.values())[0]
    return (<XMLElement>tmp).getAttributeValue('template', undefined) // FIX TS2345: null→undefined
  }

  get file() {
    const tmp = Array.from(this.xDecls.values())[0]
    return (<XMLElement>tmp).getAttributeValue('file', undefined) // FIX TS2345: null→undefined
  }

  get targetFile(): string {
    // FIX TS7023: explicit return type breaks circular inference
    let f = this.topDescItem.file
    if (!f) {
      // getAttributeValue returns '' (falsy) when 'file' attr is absent
      f = this.ancestorOfKind(DescKind.File)!.name // FIX: ! — File ancestor exists when no explicit file attr
    }
    return f!
  }
}

export class DocumentState {
  readonly xdeclDescMap = new Map<XMLNode, DescNamespace>()

  constructor(public readonly xdoc: XMLDocument) {}
}

function getDeclDescKind(xdecl: XMLElement) {
  switch (
    xdecl.lang.sdef!.nodeKind // FIX TS18048: ! — only called after sdef null-check in bindWorker
  ) {
    case sch.ElementDefKind.Frame:
      return DescKind.Frame
    case sch.ElementDefKind.Animation:
      return DescKind.Animation
    case sch.ElementDefKind.StateGroup:
      return DescKind.StateGroup
  }
  throw new Error()
}

export class DescIndex {
  protected xdocState!: Map<XMLDocument, DocumentState> // FIX TS2564: ! — initialized in clear() called from constructor
  rootNs!: DescNamespace // FIX TS2564
  tplRefs!: StringIcaseMap<Set<DescNamespace>> // FIX TS2564
  fileRefs!: Map<string, Map<string, Set<DescNamespace>>> // FIX TS2564

  constants!: DescXRefMap<ConstantItem> // FIX TS2564
  handles!: DescXRefMap<HandleItem> // FIX TS2564

  constructor(protected readonly schema: sch.SchemaRegistry) {
    this.clear()
  }

  public clear() {
    this.xdocState = new Map<XMLDocument, DocumentState>()
    this.rootNs = new DescNamespace('$root', DescKind.Root, void 0, this.schema.fileRootType)
    this.tplRefs = new StringIcaseMap()
    this.fileRefs = new Map()

    this.constants = new DescXRefMap<ConstantItem>(this, ConstantItem, 'name')
    this.handles = new DescXRefMap<HandleItem>(this, HandleItem, 'val')
  }

  protected bindWorker(parentNs: DescNamespace, currXNode: XMLElement, docState: DocumentState) {
    if (!currXNode.lang.sdef || !currXNode.lang.stype) return

    const isInFDesc = parentNs.kind === DescKind.File

    switch (currXNode.lang.sdef.nodeKind) {
      case sch.ElementDefKind.Animation:
      case sch.ElementDefKind.StateGroup:
      case sch.ElementDefKind.Frame: {
        let name = currXNode.getAttributeValue('name', undefined)
        if (!name) {
          // getAttributeValue returns '' (falsy) when 'name' attr is absent
          for (let i = 0; ; ++i) {
            name = `${currXNode.lang.stype.name}_${i}`
            if (!parentNs.get(name)) break
            if (i < 50) {
              name = undefined // FIX TS2322: null→undefined
              break
            }
          }
          if (name === undefined) break // FIX: null→undefined
        }
        const currDesc = parentNs.getOrCreate(name, getDeclDescKind(currXNode))

        // TODO: validate type?
        if (currDesc.xDecls.size > 0) {
          // empty
        }
        currDesc.xDecls.add(currXNode)
        docState.xdeclDescMap.set(currXNode, currDesc)

        // desc extension
        const file = currXNode.getAttributeValue('file', undefined)
        if (file) {
          // getAttributeValue returns '' (falsy) when 'file' attr is absent
          let fdmap = this.fileRefs.get(file)
          if (!fdmap) {
            fdmap = new Map()
            this.fileRefs.set(file, fdmap)
          }
          let frefs = fdmap.get(currDesc.name)
          if (!frefs) {
            frefs = new Set()
            fdmap.set(currDesc.name, frefs)
          }
          frefs.add(currDesc)
        }

        // track templates
        const tpl = currXNode.getAttributeValue('template', undefined)
        if (tpl) {
          // getAttributeValue returns '' (falsy) when 'template' attr is absent
          let trefs = this.tplRefs.get(tpl)
          if (!trefs) {
            trefs = new Set()
            this.tplRefs.set(tpl, trefs)
          }
          trefs.add(currDesc)
        }

        //
        if (currXNode.lang.sdef.nodeKind === sch.ElementDefKind.Frame) {
          for (const xsub of currXNode.children) {
            this.bindWorker(currDesc, xsub, docState)
          }
        }

        break
      }

      case sch.ElementDefKind.Constant: {
        this.constants.appendOrCreate(currXNode, docState.xdoc)
        return
      }

      case sch.ElementDefKind.FrameProperty: {
        const natVal = currXNode.lang.stype.attributes.get('val')
        if (!natVal) return
        switch (natVal.type.builtinType) {
          case sch.BuiltinTypeKind.Handle: {
            this.handles.appendOrCreate(currXNode, docState.xdoc)
            break
          }
        }
        return
      }

      default: {
        // console.log(`# unknown ${currXNode.tag}[${currXNode.lang.stype.name}]`);
        return
      }
    }
  }

  bindDocument(doc: LayoutDocument) {
    const docState = new DocumentState(doc)
    this.xdocState.set(doc, docState)

    const fiDesc = this.rootNs.getOrCreate(doc.lang.descName!, DescKind.File) // FIX TS2345: ! — layout docs always have a descName
    fiDesc.xDecls.add(doc)
    docState.xdeclDescMap.set(doc, fiDesc)

    if (doc.getRootNode()) {
      for (const xsub of doc.getRootNode().children) {
        this.bindWorker(fiDesc, xsub, docState)
      }
    }

    return fiDesc
  }

  unbindDocument(doc: LayoutDocument) {
    this.constants.purgeDocumentDecls(doc)
    this.handles.purgeDocumentDecls(doc)

    const docState = this.xdocState.get(doc)
    for (const [xDecl, descNode] of docState!.xdeclDescMap) {
      // FIX TS18048: ! — doc was registered in bindDocument
      descNode.xDecls.delete(xDecl)

      switch (descNode.kind) {
        case DescKind.Frame:
        case DescKind.Animation:
        case DescKind.StateGroup: {
          const tpl = (<XMLElement>xDecl).getAttributeValue('template', undefined)
          if (tpl) {
            // getAttributeValue returns '' (falsy) when 'template' attr is absent
            const trefs = this.tplRefs.get(tpl)

            // elements with the same name are grouped under the same DescNamespace
            // so we have to double check whether the reference wasn't already deleted
            if (trefs) {
              trefs.delete(descNode)
              if (!trefs.size) {
                this.tplRefs.delete(tpl)
              }
            }
          }

          const file = (<XMLElement>xDecl).getAttributeValue('file', undefined)
          if (file) {
            // getAttributeValue returns '' (falsy) when 'file' attr is absent
            const fdmap = this.fileRefs.get(file)
            if (fdmap) {
              const frefs = fdmap.get(descNode.name)

              // elements with the same name are grouped under the same DescNamespace
              // so we have to double check whether the reference wasn't already deleted
              if (frefs) {
                frefs.delete(descNode)
                if (frefs.size <= 0) {
                  fdmap.delete(descNode.name)
                  if (fdmap.size <= 0) {
                    this.fileRefs.delete(file)
                  }
                }
              }
            }
          }
        }
      }
    }

    for (const descNode of docState!.xdeclDescMap.values()) {
      // FIX TS18048: !
      if (descNode.xDecls.size) continue
      if (!descNode.parent) continue
      descNode.purgeOrphansDeep()
    }

    this.xdocState.delete(doc)
  }

  resolveElementDesc(xEl: XMLElement | XMLDocument, kind: DescKind | null = null) {
    // FIX TS2322: widen param to DescKind | null
    const docState = this.xdocState.get(xEl.getDocument())
    do {
      const elDesc = docState!.xdeclDescMap.get(xEl) // FIX TS18048: ! — docState exists for bound docs
      if (elDesc && (kind === null || elDesc.kind === kind)) return elDesc
      // eslint-disable-next-line no-cond-assign
    } while ((xEl = <XMLElement>xEl.parent))
  }

  resolveConstantDeep(name: string) {
    const rs: ConstantItem[] = []
    let tmp: ConstantItem | undefined // FIX TS2322: widen to allow undefined from Map.get
    // eslint-disable-next-line no-cond-assign
    while ((tmp = this.constants.get(name))) {
      rs.push(tmp)
      const vKind = <AttrValueConstant>getAttrValueKind(tmp.value!) // ! — value is string when constant is found in map
      if (!isConstantValueKind(vKind)) {
        return rs
      }
      name = tmp.value!.substr(AttrValueKindOffset[vKind]) // ! — same invariant
    }
  }
}
