export interface LayoutAnchor {
  side?: string
  relative?: string
  pos?: string
  offset?: string
  attrs: Record<string, string>
}

export interface LayoutProperty {
  name: string
  val?: string
  attrs: Record<string, string>
}

export interface LayoutFrame {
  name: string
  type: string
  template?: string
  file?: string
  anchors: LayoutAnchor[]
  properties: LayoutProperty[]
  animations: LayoutAnimation[]
  children: LayoutFrame[]
}

export interface LayoutConstant {
  name: string
  val: string
}

export interface LayoutAnimation {
  name: string
}

export interface LayoutReference {
  raw: string
  prefix: '@' | '@@'
  value: string
  namespace: string
  frame: string
  property: string
}

export interface SC2LayoutFile {
  frames: LayoutFrame[]
  constants: LayoutConstant[]
  includes: string[]
  animations: LayoutAnimation[]
  templates: string[]
  references: LayoutReference[]
}
