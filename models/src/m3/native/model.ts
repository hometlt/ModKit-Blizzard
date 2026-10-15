import type { M3SectionList } from './binary/sections.js'
import type {
  AttachmentPoint,
  BoneInfo,
  BoundsInfo,
  HitVolume,
  LightInfo,
  MaterialInfo,
  M3StructureData,
  SectionResolver,
  TurretInfo,
  CameraInfo,
  RibbonInfo,
  ParticleSystemInfo,
  ProjectionInfo,
  ForceInfo,
  BillboardInfo,
  WarpInfo,
  ShadowboxInfo,
  RigidBodyInfo,
  PhysicsConstraintInfo,
  PhysicsJointInfo,
  PhysicsClothInfo,
  IkInfo,
} from './types.js'
import type { RenderModel } from '@modkit/codec-kit/legacy/models'
import {
  buildAttachmentPoints,
  buildMaterialList,
  buildBoneHierarchy,
  buildHitVolumes,
  buildBounds,
  buildLights,
  buildTurrets,
  buildCameras,
  buildRibbons,
  buildParticles,
  buildProjections,
  buildForces,
  buildBillboards,
  buildWarps,
  buildShadowboxes,
  buildRigidBodies,
  buildPhysicsConstraints,
  buildPhysicsJoints,
  buildPhysicsCloths,
  buildIk,
  getModelTextureFilenames,
} from './builder/metadata.js'
import { m3ModelToRenderModel, type M3RenderModelOptions } from './render-model.js'

/** Thin OOP facade over M3 binary data. Pure data accessors, no Three.js. */
export class M3Model {
  readonly sections: M3SectionList
  readonly model: M3StructureData

  #resolver: SectionResolver
  #bounds?: BoundsInfo | null
  #attachmentPoints?: AttachmentPoint[]
  #materials?: MaterialInfo[]
  #bones?: BoneInfo[]
  #hitVolumes?: { tight: HitVolume | null; hittests: HitVolume[]; attachmentVolumes: HitVolume[] }
  #lights?: LightInfo[]
  #turrets?: TurretInfo[]
  #cameras?: CameraInfo[]
  #ribbons?: RibbonInfo[]
  #particles?: ParticleSystemInfo[]
  #projections?: ProjectionInfo[]
  #forces?: ForceInfo[]
  #billboards?: BillboardInfo[]
  #warps?: WarpInfo[]
  #shadowboxes?: ShadowboxInfo[]
  #rigidBodies?: RigidBodyInfo[]
  #physicsConstraints?: PhysicsConstraintInfo[]
  #physicsJoints?: PhysicsJointInfo[]
  #physicsCloths?: PhysicsClothInfo[]
  #ik?: IkInfo[]
  #textureFilenames?: Set<string>

  constructor(sections: M3SectionList) {
    if (!sections.model) {
      throw new Error('M3SectionList does not contain a model section')
    }
    this.sections = sections
    this.model = sections.model
    this.#resolver = sections
  }

  get bounds(): BoundsInfo | null {
    if (this.#bounds === undefined) this.#bounds = buildBounds(this.model)
    return this.#bounds
  }

  get attachmentPoints(): AttachmentPoint[] {
    if (this.#attachmentPoints === undefined) {
      this.#attachmentPoints = buildAttachmentPoints(this.model, this.#resolver)
    }
    return this.#attachmentPoints
  }

  get materials(): MaterialInfo[] {
    if (this.#materials === undefined) {
      this.#materials = buildMaterialList(this.model, this.#resolver)
    }
    return this.#materials
  }

  get bones(): BoneInfo[] {
    if (this.#bones === undefined) {
      this.#bones = buildBoneHierarchy(this.model, this.#resolver)
    }
    return this.#bones
  }

  get hitVolumes(): {
    tight: HitVolume | null
    hittests: HitVolume[]
    attachmentVolumes: HitVolume[]
  } {
    if (this.#hitVolumes === undefined) {
      this.#hitVolumes = buildHitVolumes(this.model, this.#resolver)
    }
    return this.#hitVolumes
  }

  get lights(): LightInfo[] {
    if (this.#lights === undefined) {
      this.#lights = buildLights(this.model, this.#resolver)
    }
    return this.#lights
  }

  get turrets(): TurretInfo[] {
    if (this.#turrets === undefined) {
      this.#turrets = buildTurrets(this.model, this.#resolver)
    }
    return this.#turrets
  }

  get textureFilenames(): Set<string> {
    if (this.#textureFilenames === undefined) {
      this.#textureFilenames = getModelTextureFilenames(this.model, this.#resolver)
    }
    return this.#textureFilenames
  }

  get cameras(): CameraInfo[] {
    if (this.#cameras === undefined) this.#cameras = buildCameras(this.model, this.#resolver)
    return this.#cameras
  }

  get ribbons(): RibbonInfo[] {
    if (this.#ribbons === undefined) this.#ribbons = buildRibbons(this.model, this.#resolver)
    return this.#ribbons
  }

  get particles(): ParticleSystemInfo[] {
    if (this.#particles === undefined) this.#particles = buildParticles(this.model, this.#resolver)
    return this.#particles
  }

  get projections(): ProjectionInfo[] {
    if (this.#projections === undefined)
      this.#projections = buildProjections(this.model, this.#resolver)
    return this.#projections
  }

  get forces(): ForceInfo[] {
    if (this.#forces === undefined) this.#forces = buildForces(this.model, this.#resolver)
    return this.#forces
  }

  get billboards(): BillboardInfo[] {
    if (this.#billboards === undefined)
      this.#billboards = buildBillboards(this.model, this.#resolver)
    return this.#billboards
  }

  get warps(): WarpInfo[] {
    if (this.#warps === undefined) this.#warps = buildWarps(this.model, this.#resolver)
    return this.#warps
  }

  get shadowboxes(): ShadowboxInfo[] {
    if (this.#shadowboxes === undefined)
      this.#shadowboxes = buildShadowboxes(this.model, this.#resolver)
    return this.#shadowboxes
  }

  get rigidBodies(): RigidBodyInfo[] {
    if (this.#rigidBodies === undefined)
      this.#rigidBodies = buildRigidBodies(this.model, this.#resolver)
    return this.#rigidBodies
  }

  get physicsConstraints(): PhysicsConstraintInfo[] {
    if (this.#physicsConstraints === undefined) {
      this.#physicsConstraints = buildPhysicsConstraints(this.model, this.#resolver)
    }
    return this.#physicsConstraints
  }

  get physicsJoints(): PhysicsJointInfo[] {
    if (this.#physicsJoints === undefined)
      this.#physicsJoints = buildPhysicsJoints(this.model, this.#resolver)
    return this.#physicsJoints
  }

  get physicsCloths(): PhysicsClothInfo[] {
    if (this.#physicsCloths === undefined)
      this.#physicsCloths = buildPhysicsCloths(this.model, this.#resolver)
    return this.#physicsCloths
  }

  get ik(): IkInfo[] {
    if (this.#ik === undefined) this.#ik = buildIk(this.model, this.#resolver)
    return this.#ik
  }

  toRenderModel(options?: M3RenderModelOptions): RenderModel {
    return m3ModelToRenderModel(this, options)
  }
}
