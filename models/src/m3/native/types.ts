import type { M3StructureDescription } from './binary/structures.js'

/** Primitive numeric types supported in M3 binary fields. */
export type M3PrimitiveType = 'uint8' | 'int16' | 'uint16' | 'int32' | 'uint32' | 'uint64' | 'float'

/** Metadata for a primitive type: byte size and DataView accessor names. */
export interface PrimitiveFieldMeta {
  size: number
  getter:
    'getUint8' | 'getInt16' | 'getUint16' | 'getInt32' | 'getUint32' | 'getBigUint64' | 'getFloat32'
  setter:
    'setUint8' | 'setInt16' | 'setUint16' | 'setInt32' | 'setUint32' | 'setBigUint64' | 'setFloat32'
}

/** A single parsed field record from structures.xml. */
export interface FieldRecord {
  field: M3Field
  sinceVersion: number
  tillVersion: number
}

/** Shared base class interface for all M3 fields. */
export interface M3Field {
  name: string
  size: number
  fromBuffer(data: M3StructureData, buffer: ArrayBuffer, offset: number): void
  toBuffer(data: M3StructureData, buffer: ArrayBuffer, offset: number): void
}

/** Reference object used in M3 to point to other sections/data. */
export interface M3Reference {
  entries: number
  index: number
  flags?: number
}

/** Helper type for section resolver functions. */
export type SectionResolver = {
  getSectionByReference(ref: M3Reference | null | undefined): M3Section | null
}

/** Legacy type alias for backwards compatibility. */
export type SectionGetter = SectionResolver

/** Structure instance created from an M3StructureDescription. */
export interface M3StructureData {
  desc: M3StructureDescription
  fromBuffer(buffer: ArrayBuffer, offset?: number): void
  toBuffer(buffer: ArrayBuffer, offset?: number): void
  bitGet(fieldName: string, bitName: string): boolean
  [key: string]:
    | number
    | string
    | boolean
    | bigint
    | M3Reference
    | M3StructureData
    | Uint8Array
    | undefined
    | M3StructureDescription
    | ((buffer: ArrayBuffer, offset?: number) => void)
    | ((fieldName: string, bitName: string) => boolean)
}

/** A parsed M3 file section. */
export interface M3Section {
  desc: M3StructureDescription
  indexEntry: M3StructureData
  references: M3Section[]
  content: (M3StructureData | number | bigint | string)[]
  rawBytes: ArrayBuffer | null
  model?: M3StructureData | null
  getSectionByReference(reference: M3Reference | null | undefined): M3Section | null
}

/** A built vertex object ready for geometry construction. */
export interface BuiltVertex {
  position: number[]
  normal?: number[]
  /** xyzw; w = bitangent handedness (±1) from the vertex sign byte. */
  tangent?: number[]
  uv0?: number[]
  uv1?: number[]
  uv2?: number[]
  uv3?: number[]
  uv4?: number[]
  fuv0?: number[]
  fuv1?: number[]
  fuv2?: number[]
  fuv3?: number[]
  color?: number[]
  weights?: number[]
  boneIndices?: number[]
  [key: string]: number[] | undefined
}

/** A lightweight material description. */
export interface MaterialInfo {
  name: string
  textures: { label: string; filename: string }[]
}

/** A bone entry. */
export interface BoneInfo {
  index: number
  name: string
  parentIndex: number
  flags: number
}

/** A hit volume descriptor. matrix4 is a 16-element column-major flat array. */
export interface HitVolume {
  index: number
  shape: number
  boneIndex: number
  matrix4: number[]
  size0: number
  size1: number
  size2: number
}

/** Bounds descriptor. */
export interface BoundsInfo {
  left: number
  right: number
  back: number
  front: number
  bottom: number
  top: number
  radius: number
}

/** Light descriptor. */
export interface LightInfo {
  index: number
  name: string
  /** M3 LITE shape: 0 = directional, 1 = point, 2 = spot. */
  type: number
  shape: string
  boneIndex: number
  flags: number
  color: [number, number, number]
  intensity: number
  specularColor: [number, number, number]
  specularIntensity: number
  /** Authored distance-falloff exponent. */
  decay: number
  attenuationNear: number
  attenuationFar: number
  hotspot: number
  falloff: number
}

/** Turret part descriptor. */
export interface TurretPart {
  boneIndex: number
  boneName: string
}

/** Turret descriptor. */
export interface TurretInfo {
  index: number
  name: string
  parts: TurretPart[]
}

/** Attachment point descriptor. */
export interface AttachmentPoint {
  name: string
  boneIndex: number
}

/** Camera descriptor. */
export interface CameraInfo {
  index: number
  name: string
  boneIndex: number
  fieldOfView: number
  farClip: number
  nearClip: number
  shadowClipDistance: number
  focusDistance: number
  farFocusRange: number
  nearFocusRange: number
  nearFalloffStart: number
  nearFalloffEnd: number
  dofType: number
  bokehFStop: number
  bokehMaxCoCDiameter: number
  /** @deprecated Use shadowClipDistance. */
  clip2: number
  /** @deprecated Use focusDistance. */
  focalDepth: number
  /** @deprecated Use farFocusRange. */
  falloffStart: number
  /** @deprecated Use nearFocusRange. */
  falloffEnd: number
  depthOfField: number
  useVerticalFov: boolean
}

/** Ribbon descriptor. */
export interface RibbonInfo {
  index: number
  name: string
  boneIndex: number
  materialIndex: number
  materialName: string
  segments: number
  edge: number
  color: [number, number, number]
  alpha: number
  size: [number, number, number]
  duration: number
  lifespan: number
  speed: number
  gravityX: number
  gravityY: number
  gravityZ: number
  drag: number
  colorBase: [number, number, number, number]
  colorMid: [number, number, number, number]
  colorTip: [number, number, number, number]
  colorAnimMid: number
  sizeBase: [number, number, number]
  sizeMid: [number, number, number]
  sizeTip: [number, number, number]
  sizeAnimMid: number
  ribbonType: number
  divisions: number
  sides: number
  starRatio: number
  segmentLength: number
  flags: number
  textureFilename: string | null
}

/** Particle system descriptor. */
export interface ParticleSystemInfo {
  index: number
  name: string
  boneIndex: number
  materialIndex: number
  materialName: string
  particleType: string
  emitType: string
  emitShape: string
  emitRate: number
  lifespan: number
  maxParticles: number
  gravity: number
  friction: number
  drag: number
  emitSpeed: number
  emitAngleX: number
  emitAngleY: number
  emitSpreadX: number
  emitSpreadY: number
  emitShapeSize: [number, number, number]
  emitShapeRadius: number
  sizeInit: [number, number, number]
  sizeMid: [number, number, number]
  sizeEnd: [number, number, number]
  sizeRandomInit: [number, number, number]
  sizeRandomMid: [number, number, number]
  sizeRandomEnd: [number, number, number]
  sizeRandomize: boolean
  sizeAnimMid: number
  colorInit: [number, number, number, number]
  colorMid: [number, number, number, number]
  colorEnd: [number, number, number, number]
  colorAnimMid: number
  flags: number
  localSpace: boolean
  textureFilename: string | null
}

/** Projection descriptor. */
export interface ProjectionInfo {
  index: number
  name: string
  projectionType: number
  type: string
  boneIndex: number
  materialIndex: number
  materialName: string
  offset: [number, number, number]
  pitch: number
  yaw: number
  roll: number
  fieldOfView: number
  aspectRatio: number
  near: number
  far: number
  boxOffsetZBottom: number
  boxOffsetZTop: number
  boxOffsetXLeft: number
  boxOffsetXRight: number
  boxOffsetYFront: number
  boxOffsetYBack: number
  falloff: number
  alphaInit: number
  alphaMid: number
  alphaEnd: number
  lifetimeAttack: number
  lifetimeAttackTo: number
  lifetimeHold: number
  lifetimeHoldTo: number
  lifetimeDecay: number
  lifetimeDecayTo: number
  attenuationDistance: number
  active: number
  layer: number
  lodReduce: number
  lodCut: number
  flags: number
}

/** Force descriptor. */
export interface ForceInfo {
  index: number
  name: string
  boneIndex: number
  forceType: number
  type: string
  shape: number
  shapeName: string
  unknownFor0: number
  flags: number
  channels: number
  falloff: boolean
  heightGradient: boolean
  unbounded: boolean
  strength: number
  height: number
  width: number
  length: number
}

/** Billboard descriptor. */
export interface BillboardInfo {
  index: number
  name: string
  boneIndex: number
  /** Name of `billboardType`: world-x/y/z lock, bone-x/y lock, unused (4) or free (6). */
  type: string
  /** BBSC.billboard_type as stored. */
  billboardType: number
  /** BBSC.camera_look_at: aim from the eye rather than along the view. */
  cameraLookAt: boolean
  /** BBSC correction quaternions [x, y, z, w]. */
  up: [number, number, number, number]
  forward: [number, number, number, number]
}

/** Warp descriptor. */
export interface WarpInfo {
  index: number
  name: string
  boneIndex: number
  /** structures.xml keeps this field hash-named; Whiteout identifies it as the warp type. */
  unknown861f507b: number
  warpType: number
  unknowncf03b856: number
  radius: number
  /** structures.xml hash-named field; Whiteout identifies it as height. */
  unknown9306aac0: number
  height: number
  strength: number
  /** Hash-named animated components with Whiteout's provisional semantic aliases. */
  unknown50c7f2b4: number
  angular: number
  unknown8d9c977c: number
  axial: number
  unknownca6025a2: number
  radial: number
}

/** Shadowbox descriptor. */
export interface ShadowboxInfo {
  index: number
  name: string
  /** Authoritative SHBX oriented-volume transform. */
  matrix4: number[]
  position: [number, number, number]
  halfExtents: [number, number, number]
  size: [number, number, number]
}

/** One primitive from a rigid body's referenced PHSH section. */
export interface RigidBodyShapeInfo {
  index: number
  shape: 'Box' | 'Sphere' | 'Capsule' | 'Cylinder' | 'ConvexHull' | 'Mesh' | 'Unknown'
  shapeCode: number
  matrix4: number[]
  size: [number, number, number]
  vertices: [number, number, number][]
}

/** Rigid body descriptor. */
export interface RigidBodyInfo {
  index: number
  name: string
  boneIndex: number
  shape: string
  size: [number, number, number]
  mass: number
  friction: number
  restitution: number
  simulationType: number
  physicalMaterial: number
  dampingLinear: number
  dampingAngular: number
  gravityFactor: number
  flags: number
  localForces: number
  worldForces: number
  priority: number
  shapes: RigidBodyShapeInfo[]
}

/** Physics joint descriptor. */
export interface PhysicsJointInfo {
  index: number
  name: string
  boneIndex0: number
  boneIndex1: number
  boneName0: string
  boneName1: string
  type: string
  position: [number, number, number]
  limits: { min: number; max: number }
}

/** PHCT constraint linking two rigid bodies and its dependent constraint indices. */
export interface PhysicsConstraintInfo {
  index: number
  dependentIndices: number[]
  rigidBodyIndex0: number
  rigidBodyIndex1: number
  flags: number
  breakForce: number
}

/** Physics cloth descriptor. */
export interface PhysicsClothInfo {
  index: number
  name: string
  boneIndices: number[]
  vertexCount: number
  stiffness: number
}

/** A single M3 animation track keyframe entry. */
export interface AnimIdMapEntry {
  sdSection: M3Section
  sdIdx: number
}

/** IK (Inverse Kinematics) descriptor. */
export interface IkInfo {
  index: number
  name: string
  boneIndex: number
  targetBoneIndex: number
  effectorBoneIndex: number
  type: string
  weight: number
  enabled: boolean
}
