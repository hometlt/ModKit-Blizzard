import { transformUvmPrimitiveGeometry } from '@modkit/scene/uvm/static-model'
import { invertMaterialFrame, IDENTITY_MATERIAL_FRAME } from '@modkit/scene/materials'
import { appendUvmAccessors } from '@modkit/uv/model/accessor-write'
import { readUvmAccessor } from '@modkit/uv/model/accessor'
import { readUvmOrderedEulerChains } from '@modkit/scene/uvm/ordered-euler-chains'
import { readUvmModel } from '@modkit/scene/uvm/model'
import { readUvmPrimitiveVisibility } from '@modkit/uv/model/animation-clips'
import { decomposeMatrix4 } from '@modkit/scene/model/matrix'
import { composeTrsMatrix } from '@modkit/codec-kit/model-math/sequence-pose'

function matrixTrs(matrix, node) {
  const invalid = () =>
    new TypeError('fresh rigid M3 requires a finite TRS-representable affine node matrix')
  if (
    !Array.isArray(matrix) ||
    matrix.length !== 16 ||
    !matrix.every(value => Number.isFinite(value) && Number.isFinite(Math.fround(value))) ||
    [3, 7, 11].some(component => matrix[component] !== 0) ||
    matrix[15] !== 1 ||
    ['translation', 'rotation', 'scale'].some(key => node[key] !== undefined)
  )
    throw invalid()
  const original = Float32Array.from(matrix)
  const diagonal = [1, 2, 4, 6, 8, 9].every(component => original[component] === 0)
  // Keep exact diagonal signed scales, including reflected PIE unit frames. The shared
  // decomposition returns positive scales; reconstruction rejects other reflections.
  const pose = diagonal
    ? {
        translation: matrix.slice(12, 15),
        rotation: [0, 0, 0, 1],
        scaling: [matrix[0], matrix[5], matrix[10]],
      }
    : decomposeMatrix4(original)
  if (
    [0, 4, 8].some(offset => original.slice(offset, offset + 3).every(value => value === 0)) ||
    ![...pose.translation, ...pose.rotation, ...pose.scaling].every(value =>
      Number.isFinite(Math.fround(value)),
    ) ||
    pose.scaling.some(value => Math.fround(value) === 0)
  )
    throw invalid()
  const reconstructed = new Float32Array(16)
  composeTrsMatrix(
    reconstructed,
    0,
    pose.translation.map(Math.fround),
    pose.rotation.map(Math.fround),
    pose.scaling.map(Math.fround),
  )
  if (!reconstructed.every(Number.isFinite)) throw invalid()
  // Native tracks use float32. Allow only its rounding envelope, relative to each basis
  // column: large translations or a different unit scale must never hide local shear.
  for (const offset of [0, 4, 8]) {
    const tolerance = Math.max(...original.slice(offset, offset + 3).map(Math.abs)) * 8 * 2 ** -23
    for (let row = 0; row < 3; row++)
      if (Math.abs(reconstructed[offset + row] - original[offset + row]) > tolerance)
        throw invalid()
  }
  return { translation: pose.translation, rotation: pose.rotation, scale: pose.scaling }
}

function portableAnimation(document, binary, budget, signal) {
  const variants = document.extensions?.UV_game_variants
  if (variants !== undefined && Object.keys(variants).some(key => key !== 'visibility'))
    throw new TypeError('fresh rigid M3 cannot preserve non-visibility variants')
  const visibility = readUvmPrimitiveVisibility(document, signal)
  if (visibility.some(value => value.value !== 1))
    throw new TypeError('fresh rigid M3 cannot preserve non-default primitive visibility')
  // Validate the original channels before consuming an exact, inert representation. In
  // particular, malformed accessor/time/pointer data must not disappear during lowering.
  const parsed = readUvmModel(document, binary, budget, signal)
  for (const clip of parsed.rig.clips) {
    if (clip.unsupportedChannels)
      throw new TypeError('fresh rigid M3 cannot preserve unsupported animation channels')
    if (clip.repeatCount > 1)
      throw new TypeError('fresh M3 cannot encode a finite animation repeat count above one')
    for (const channel of clip.channels) {
      if (channel.repeatCount > 0)
        throw new TypeError('fresh M3 cannot encode a finite channel repeat count')
      if (channel.kind === 'visibility' && channel.samples.some(sample => sample.value[0] !== 1))
        throw new TypeError('fresh rigid M3 cannot preserve animated primitive visibility')
    }
  }
  const stripRepeat = value => {
    if (value?.extras?.uv?.repeatCount === undefined) return value
    const { repeatCount: _repeat, ...uv } = value.extras.uv
    return { ...value, extras: { ...value.extras, uv } }
  }
  return document.animations?.map(animation => ({
    ...stripRepeat(animation),
    channels: animation.channels
      // The common reader above admits only a known visibility pointer. All those channels
      // and defaults are identically one; M3's visible default is an exact representation.
      .filter(channel => channel.target.path !== 'pointer')
      .map(stripRepeat),
  }))
}

/** M3 expresses rigid node motion through bones. Keep each authored TRS node and bind its
 * local vertices with weight one and identity inverse bind: worldBone * localVertex is
 * exactly the original rigid draw transform. No key resampling or geometry baking. */
export function prepareRigidM3Container(source, budget, signal) {
  let document = source.document
  if (document.skins?.length) {
    const referenced = (document.nodes ?? []).some(node => node.skin !== undefined) ||
      (document.meshes ?? []).some(mesh => (mesh.primitives ?? []).some(primitive =>
        Object.keys(primitive.attributes ?? {}).some(key => /^(?:JOINTS|WEIGHTS)_/u.test(key))))
    if (referenced) return prepareMixedM3Container(source, budget, signal)
    // A declared but unused skin does not skin any glTF draw. Validate the original
    // table before lowering the rigid node motion; keep its accessors and bytes intact.
    for (const skin of document.skins)
      if (!skin || typeof skin !== 'object' || Array.isArray(skin) ||
          Object.keys(skin).some(key => !['joints','inverseBindMatrices','skeleton'].includes(key)))
        throw new TypeError('fresh rigid M3 cannot discard unknown unused skin fields')
    readUvmModel(document, source.binary, budget, signal)
    const { skins: _unusedSkins, ...rigidDocument } = document
    document = rigidDocument
    source = { ...source, document }
  }
  const sourceNodes = document.nodes ?? []
  const hasSockets = sourceNodes.some(node => node.extensions?.UV_game_socket !== undefined)
  const hasNodeAnimation = document.animations?.some(animation => animation.channels.length > 0)
  if (!hasSockets && !hasNodeAnimation) return source
  if (document.scenes?.length !== 1 || (document.scene ?? 0) !== 0)
    throw new TypeError('fresh rigid M3 requires one scene')
  if (sourceNodes.length + 1 > Math.min(65535, budget.maxNodes))
    throw new RangeError('fresh rigid M3 node count exceeds bone budget')
  const supported = new Set([
    'UV_asset',
    'UV_provenance',
    'UV_units',
    'UV_game_material',
    'UV_game_socket',
    'UV_game_animation_clips',
    'UV_ordered_euler_chains',
    'UV_game_variants',
    'KHR_animation_pointer',
  ])
  for (const name of [
    ...Object.keys(document.extensions ?? {}),
    ...(document.extensionsUsed ?? []),
    ...(document.extensionsRequired ?? []),
  ])
    if (!supported.has(name))
      throw new TypeError(`fresh rigid M3 cannot preserve extension ${name}`)
  // This extension documents the ordinary parent chain; retaining those nodes retains its
  // rotation order. Validate it before consuming the declaration for the native target.
  readUvmOrderedEulerChains(document)
  const animations = portableAnimation(document, source.binary, budget, signal)

  const inputs = [],
    meshBindings = [],
    sockets = [],
    usedMeshes = new Set()
  let influenceBytes = 0
  const nodes = sourceNodes.map((sourceNode, index) => {
    signal?.throwIfAborted()
    const { mesh, extensions, matrix, ...node } = sourceNode
    node.name ??= `Node_${index}`
    if (matrix !== undefined) {
      Object.assign(node, matrixTrs(matrix, node))
    }
    if (extensions !== undefined) {
      const { UV_game_socket: socket, ...rest } = extensions
      if (Object.keys(rest).length) node.extensions = rest
      if (socket !== undefined) {
        if (socket.role !== 'attach' || typeof socket.sourceName !== 'string' || !socket.sourceName)
          throw new TypeError('fresh rigid M3 socket requires attach role and sourceName')
        if (socket.forward !== undefined || socket.up !== undefined)
          throw new TypeError('fresh rigid M3 cannot encode authored socket orientation axes')
        sockets.push({ parent: index, socket })
      }
    }
    if (mesh !== undefined) {
      const authoredMesh = document.meshes?.[mesh]
      if (!authoredMesh) throw new TypeError('fresh rigid M3 mesh reference is absent')
      usedMeshes.add(mesh)
      meshBindings.push({
        parent: index,
        source: authoredMesh,
        inputs: authoredMesh.primitives.map(primitive => {
          if (
            primitive.attributes.JOINTS_0 !== undefined ||
            primitive.attributes.WEIGHTS_0 !== undefined
          )
            throw new TypeError('fresh rigid M3 cannot infer undeclared skin bindings')
          const position = readUvmAccessor(
            document,
            source.binary,
            primitive.attributes.POSITION,
            { maxScalarBytes: budget.maxScalarBytes },
            'rigid M3 positions',
            signal,
          )
          if (position.count > 65535)
            throw new RangeError('fresh rigid M3 region exceeds 65535 vertices')
          influenceBytes += position.count * 24
          if (!Number.isSafeInteger(influenceBytes) || influenceBytes * 4 > budget.maxScalarBytes)
            throw new RangeError('fresh rigid M3 influences exceed scalar budget')
          const weights = new Float32Array(position.count * 4)
          const joints = new Uint16Array(position.count * 4)
          for (let vertex = 0; vertex < position.count; vertex++) {
            weights[vertex * 4] = 1
            joints[vertex * 4] = index
          }
          const start = inputs.length
          inputs.push({ type: 'VEC4', values: joints }, { type: 'VEC4', values: weights })
          return start
        }),
      })
    }
    return node
  })
  if (usedMeshes.size !== (document.meshes?.length ?? 0))
    throw new TypeError('fresh rigid M3 refuses unused meshes')
  if (nodes.length + 1 + meshBindings.length + sockets.length > budget.maxNodes)
    throw new RangeError('fresh rigid M3 expanded nodes exceed node budget')
  const appended = appendUvmAccessors(
    source,
    inputs,
    {
      maxInputBytes: Number(
        budget.maxInputBytes > 0xffffffffn ? 0xffffffffn : budget.maxInputBytes,
      ),
      maxJsonBytes: budget.maxScalarBytes,
      maxScalarBytes: budget.maxScalarBytes,
      maxDepth: budget.maxDepth,
      maxNodes: budget.maxNodes,
    },
    signal,
  )
  const root = nodes.length
  nodes.push({ name: 'Rigid scene root', children: [...document.scenes[0].nodes] })
  const roots = [root]
  const meshes = meshBindings.map((binding, mesh) => {
    roots.push(nodes.length)
    nodes.push({ name: `${nodes[binding.parent].name} mesh`, mesh, skin: 0 })
    return {
      ...binding.source,
      primitives: binding.source.primitives.map((primitive, index) => ({
        ...primitive,
        attributes: {
          ...primitive.attributes,
          JOINTS_0: appended.accessors[binding.inputs[index]],
          WEIGHTS_0: appended.accessors[binding.inputs[index] + 1],
        },
      })),
    }
  })
  for (const { parent, socket } of sockets) {
    nodes[parent].children = [...(nodes[parent].children ?? []), nodes.length]
    nodes.push({ name: socket.sourceName, extensions: { UV_game_socket: socket } })
  }
  const consumed = new Set(['UV_ordered_euler_chains', 'UV_game_variants', 'KHR_animation_pointer'])
  const extensions = Object.fromEntries(
    Object.entries(document.extensions ?? {}).filter(([name]) => !consumed.has(name)),
  )
  return {
    ...appended.container,
    document: {
      ...appended.container.document,
      nodes,
      meshes,
      scenes: [{ ...document.scenes[0], nodes: roots }],
      ...(animations === undefined ? {} : { animations }),
      skins: [{ joints: Array.from({ length: root + 1 }, (_, index) => index), skeleton: root }],
      extensions,
      ...Object.fromEntries(
        ['extensionsUsed', 'extensionsRequired']
          .filter(key => document[key] !== undefined)
          .map(key => [key, document[key].filter(name => !consumed.has(name))]),
      ),
    },
  }
}

/** Attach rigid draws owned by existing joints to the same skin. IBM^-1 moves local
 * geometry to bind space, so J(t) * IBM * v_bind equals the original J(t) * v_local. */
function prepareMixedM3Container(source, budget, signal) {
  const document = source.document, nodes = document.nodes ?? []
  const draws = nodes.flatMap((node, index) => node.mesh !== undefined && node.skin === undefined ? [{node,index}] : [])
  if (!draws.length) return source
  if (document.skins.length !== 1 || document.scenes?.length !== 1 || (document.scene ?? 0) !== 0)
    throw new TypeError('mixed M3 requires one skin and one scene')
  const parsed = readUvmModel(document, source.binary, budget, signal)
  const skin = document.skins[0], inputs = [], replacements = new Map()
  const ibm = skin.inverseBindMatrices === undefined ? undefined : readUvmAccessor(document, source.binary,
    skin.inverseBindMatrices, budget, 'mixed M3 inverse binds', signal)
  const primitives = new Map(parsed.scene.primitives.map(p => [p.id,p]))
  const meshes = [...document.meshes], ownedNodes = nodes.map(node => ({...node})), roots = [...document.scenes[0].nodes]
  let bytes = parsed.scene.decodedGeometryBytes
  for (const {node,index} of draws) {
    signal?.throwIfAborted()
    const slot = skin.joints.indexOf(index)
    if (slot < 0 || slot > 65535 || nodes.filter(n=>n.mesh===node.mesh).length !== 1)
      throw new TypeError('mixed M3 rigid draw must belong to one existing joint without instances')
    const bind = ibm ? invertMaterialFrame(Array.from(ibm.values.slice(slot*16,slot*16+16))) : IDENTITY_MATERIAL_FRAME
    const mesh = meshes[node.mesh]
    replacements.set(node.mesh, {...mesh, primitives:mesh.primitives.map((p, pi) => {
      if ((p.mode ?? 4)!==4 || Object.keys(p).some(k=>!['attributes','indices','material','mode'].includes(k)) ||
          Object.keys(p.attributes).some(k=>!['POSITION','NORMAL','TANGENT','COLOR_0','TEXCOORD_0','TEXCOORD_1','TEXCOORD_2','TEXCOORD_3'].includes(k)))
        throw new TypeError('mixed M3 cannot lower morphs, influences or unknown rigid attributes')
      const primitive = primitives.get(`mesh-${node.mesh}-primitive-${pi}`)
      if (!primitive?.indices) throw new TypeError('mixed M3 requires indexed triangles')
      const geometry = transformUvmPrimitiveGeometry(primitive, bind), attrs = {...p.attributes}
      const add = (type,values) => {const n=inputs.length; inputs.push({type,values}); return n}
      const count = geometry.positions.length/3
      bytes += count*64 + geometry.indices.length*4
      if (bytes > budget.maxScalarBytes || count > 65535) throw new RangeError('mixed M3 geometry exceeds budget')
      const positions=add('VEC3',Float32Array.from(geometry.positions))
      const indices=add('SCALAR',Uint16Array.from(geometry.indices))
      const normals=geometry.normals?add('VEC3',Float32Array.from(geometry.normals)):undefined
      const tangents=geometry.tangents?add('VEC4',Float32Array.from(geometry.tangents)):undefined
      const joints=new Uint16Array(count*4),weights=new Float32Array(count*4)
      for(let v=0;v<count;v++){joints[v*4]=slot;weights[v*4]=1}
      const ji=add('VEC4',joints),wi=add('VEC4',weights)
      return {p,attrs,positions,indices,normals,tangents,ji,wi}
    })})
    delete ownedNodes[index].mesh
    ownedNodes[index].children=[...(node.children ?? []),ownedNodes.length]
    ownedNodes.push({name:`${node.name ?? index} geometry`,mesh:node.mesh,skin:0})
  }
  if (ownedNodes.length > budget.maxNodes) throw new RangeError('mixed M3 nodes exceed budget')
  const appended=appendUvmAccessors(source,inputs,{maxInputBytes:Number(budget.maxInputBytes>0xffffffffn?0xffffffffn:budget.maxInputBytes),maxJsonBytes:budget.maxScalarBytes,maxScalarBytes:budget.maxScalarBytes,maxDepth:budget.maxDepth,maxNodes:budget.maxNodes},signal)
  for (const [mi,mesh] of replacements) meshes[mi]={...mesh,primitives:mesh.primitives.map(({p,attrs,positions,indices,normals,tangents,ji,wi})=>({
    ...p,indices:appended.accessors[indices],attributes:{...attrs,POSITION:appended.accessors[positions],
      ...(normals===undefined?{}:{NORMAL:appended.accessors[normals]}),...(tangents===undefined?{}:{TANGENT:appended.accessors[tangents]}),
      JOINTS_0:appended.accessors[ji],WEIGHTS_0:appended.accessors[wi]}}))}
  return {...appended.container,document:{...appended.container.document,nodes:ownedNodes,meshes,scenes:[{...document.scenes[0],nodes:roots}]}}
}
