/** SC2 Maps owner: rasterize an ordered, format-neutral terrain layer grid into native
 * block-local MASK slots. No source-game discovery, image decoding or package writes.
 * Eight palettes/slots are native limits. Approximation is opt-in and reports replaced
 * coverage; default refuses materials that cannot fit. RGB means only rank replacements.
 * Optional shared-material seam bands report additional moved coverage and refuse empty
 * intersections; they do not infer source UVs or bake textures.
 * Input rows and output windows are north-first; native block assignments are south-first.
 */
export interface PaintLayer { materialId: string; cornerAlpha?: readonly number[] }
export interface PaintMaterial { id: string; color: readonly [number, number, number] }
export interface TerrainPaintInput {
  columns: number; rows: number; samples: readonly (readonly { layers?: readonly PaintLayer[] }[])[]
  cellsX: number; cellsY: number; materials: readonly PaintMaterial[]
  approximation?: 'nearest-color'
  /** Reproject a one-cell boundary band onto materials shared by adjacent palettes.
   * Additional coverage changes require explicit approximation and are reported. */
  paletteSeams?: 'shared-materials'
}

/** Bounded deterministic eight-channel coloring of co-occurring terrain materials.
 * The same native texture must keep its channel across every set (Editor invariant).
 * Empty positions remain explicit; callers must never compact a returned palette. */
export function alignTerrainPaletteChannels(palettes: readonly (readonly string[])[]): string[][] {
  const graph=new Map<string,Set<string>>()
  for(const palette of palettes){
    const ids=palette.filter(Boolean)
    if(palette.length>8||ids.length<1||new Set(ids).size!==ids.length)throw new RangeError('Invalid channel palette')
    for(const id of ids){const adjacent=graph.get(id)??new Set<string>();for(const other of ids)if(id!==other)adjacent.add(other);graph.set(id,adjacent)}
  }
  if(palettes.length<1||palettes.length>8||graph.size>64)throw new RangeError('Channel palette exceeds native limits')
  const assigned=new Map<string,number>(),ids=[...graph.keys()].sort();let visited=0
  const solve=():boolean=>{
    if(++visited>200000)throw new RangeError('Terrain channel reconciliation exceeded bounded search budget')
    if(assigned.size===ids.length)return true
    let selected='',saturation=-1,degree=-1
    for(const id of ids){if(assigned.has(id))continue;const neighbors=graph.get(id)!,sat=new Set([...neighbors].flatMap(n=>assigned.has(n)?[assigned.get(n)!]:[])).size
      if(sat>saturation||sat===saturation&&neighbors.size>degree){selected=id;saturation=sat;degree=neighbors.size}}
    const forbidden=new Set([...graph.get(selected)!].flatMap(n=>assigned.has(n)?[assigned.get(n)!]:[]))
    const maxUsed=Math.max(-1,...assigned.values())
    for(let channel=0;channel<Math.min(8,maxUsed+2);channel++){
      if(forbidden.has(channel))continue;assigned.set(selected,channel)
      if(solve())return true;assigned.delete(selected)
    }
    return false
  }
  if(!solve())throw new RangeError('Terrain palettes cannot share eight coherent native channels')
  return palettes.map(p=>{const result=Array<string>(8).fill('');for(const id of p.filter(Boolean))result[assigned.get(id)!]=id;return result})
}

/** Ordered source-over coverage at one point, independent of image alpha. */
export function terrainPaintCoverage(layers: readonly PaintLayer[], x: number, y: number): Map<string, number> {
  const weights = new Map<string, number>()
  for (const [index, layer] of layers.entries()) {
    const a = layer.cornerAlpha
    if (a && (a.length !== 4 || !a.every(v => Number.isFinite(v) && v >= 0 && v <= 1))) throw new RangeError('Invalid corner coverage')
    // UVW corners are local (0,0), (1,0), (1,1), (0,1). The sample row's
    // local y already grows with the row; reversing it breaks adjoining cells.
    // The first layer is opaque even when its inactive source coverage is retained.
    const alpha = a && index > 0 ? a[0]! * (1-x) * (1-y) + a[1]! * x * (1-y) + a[2]! * x * y + a[3]! * (1-x) * y : 1
    for (const [id, value] of weights) weights.set(id, value * (1-alpha))
    weights.set(layer.materialId, (weights.get(layer.materialId) ?? 0) + alpha)
  }
  return weights
}

/** Deterministic palette selection and eight-texel-per-cell painting with explicit loss. */
export function authorTerrainPaint(input: TerrainPaintInput) {
  const { cellsX, cellsY, columns, rows } = input
  if (![cellsX,cellsY].every(v=>Number.isSafeInteger(v)&&v>=8&&v<=256&&v%8===0) ||
      ![columns,rows].every(v=>Number.isSafeInteger(v)&&v>=2&&v<=4097) || input.samples.length!==rows ||
      input.samples.some(row=>row.length!==columns))
    throw new RangeError('Invalid bounded terrain paint grid')
  const colors=new Map(input.materials.map(m=>[m.id,m.color]))
  if(input.paletteSeams!==undefined&&input.paletteSeams!=='shared-materials')throw new RangeError('Invalid palette seam policy')
  if (colors.size!==input.materials.length || colors.size<1 || colors.size>64 ||
      input.materials.some(m=>!Array.isArray(m.color)||m.color.length!==3||!m.color.every(v=>Number.isFinite(v)&&v>=0&&v<=255))) throw new RangeError('Invalid material palette')
  const bx=cellsX/8,by=cellsY/8,width=cellsX*8,height=cellsY*8
  const demand=Array.from({length:bx*by},()=>new Map<string,number>())
  const sample=(x:number,y:number) => {
    const sx=x/width*(columns-1),sy=y/height*(rows-1),ix=Math.floor(sx),iy=Math.floor(sy)
    const cell=input.samples[iy]?.[ix]
    if(!cell?.layers?.length)throw new RangeError('Missing source paint sample layers')
    const coverage=terrainPaintCoverage(cell.layers,sx-ix,sy-iy)
    if([...coverage.values()].reduce((a,b)=>a+b,0)<=0)throw new RangeError('Empty source paint coverage')
    return coverage
  }
  // Demand uses the exact texel locations that are subsequently painted.
  for(let y=0;y<height;y++)for(let x=0;x<width;x++)for(const[id,w]of sample(x+.5,y+.5)){
    if(!colors.has(id))throw new RangeError(`Undeclared terrain material ${id}`)
    const d=demand[Math.floor(y/64)*bx+Math.floor(x/64)]!;d.set(id,(d.get(id)??0)+w)
  }
  const candidates=[...new Map(demand.map(d=>{
    const ids=[...d].filter(([,w])=>w>1e-10).sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0])).slice(0,8).map(([id])=>id).sort()
    return [ids.join('\0'),ids] as const
  })).values()].filter(s=>s.length)
  const score=(d:Map<string,number>,p:readonly string[])=>p.reduce((n,id)=>n+(d.get(id)??0),0)
  const sets:string[][]=[]
  while(sets.length<8&&candidates.length){
    let best=-1,gain=-1
    for(let i=0;i<candidates.length;i++){
      const g=demand.reduce((n,d)=>n+Math.max(0,score(d,candidates[i]!)-Math.max(0,...sets.map(p=>score(d,p)))),0)
      if(g>gain){
        // Reject an otherwise useful palette if it makes shared native channels impossible.
        try { alignTerrainPaletteChannels([...sets,candidates[i]!]) }
        catch(error) {
          if(error instanceof RangeError && /coherent native channels|search budget/u.test(error.message))continue
          throw error
        }
        gain=g;best=i
      }
    }
    if(best<0||gain<=1e-10&&sets.length)break
    sets.push(candidates.splice(best,1)[0]!)
  }
  if(!sets.length)sets.push([input.materials[0]!.id])
  // Reconcile before painting; membership/demand scoring is independent of slot positions.
  const channelSets=alignTerrainPaletteChannels(sets)
  const northAssignments=demand.map(d=>sets.reduce((best,p,i)=>score(d,p)>score(d,sets[best]!)+1e-10?i:best,0))
  const substitutions=new Map<string,string>()
  for(let bi=0;bi<demand.length;bi++)for(const[id,w]of demand[bi]!){
    if(w<=1e-10)continue
    const pi=northAssignments[bi]!,p=sets[pi]!
    if(p.includes(id))continue
    if(input.approximation!=='nearest-color')throw new RangeError('Source materials exceed native block palette capacity; explicit approximation required')
    const c=colors.get(id)!,distance=(target:string)=>colors.get(target)!.reduce((s,v,k)=>s+(v-c[k]!)**2,0)
    substitutions.set(`${pi}\0${id}`,p.reduce((a,b)=>distance(b)<distance(a)?b:a))
  }
  // Nine regions per block: interior, four edge bands and four corners. Intersections
  // are shared on both sides; no foreign channel is sampled across a native set boundary.
  const seams=input.paletteSeams?Array.from({length:bx*by},(_,bi)=>Array.from({length:9},(_,region)=>{
    const xx=bi%bx,yy=Math.floor(bi/bx),dx=region%3-1,dy=Math.floor(region/3)-1
    const neighbors=[bi]
    if(dx&&xx+dx>=0&&xx+dx<bx)neighbors.push(bi+dx)
    if(dy&&yy+dy>=0&&yy+dy<by){neighbors.push(bi+dy*bx);if(neighbors.length===3)neighbors.push(bi+dy*bx+dx)}
    const palettes=[...new Set(neighbors.map(i=>northAssignments[i]!))]
    return {key:palettes.slice().sort().join(','),materials:sets[palettes[0]!]!.filter(id=>palettes.every(i=>sets[i]!.includes(id))),active:palettes.length>1}
  })):undefined
  const nearest=(id:string,p:readonly string[])=>{const c=colors.get(id)!,distance=(target:string)=>colors.get(target)!.reduce((s,v,k)=>s+(v-c[k]!)**2,0)
    return p.reduce((a,b)=>distance(b)<distance(a)?b:a)}
  const weights=Array.from({length:8},()=>new Uint8Array(width*height));let replacedCoverage=0,totalCoverage=0,seamMovedCoverage=0
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    const bi=Math.floor(y/64)*bx+Math.floor(x/64),pi=northAssignments[bi]!,p=channelSets[pi]!,values=Array<number>(8).fill(0)
    const lx=x%64,ly=y%64,rx=lx<8?0:lx>=56?2:1,ry=ly<8?0:ly>=56?2:1,seam=seams?.[bi]?.[ry*3+rx]
    const edgeX=rx!==1&&(rx===0?x>=64:x<width-64),edgeY=ry!==1&&(ry===0?y>=64:y<height-64)
    const boundaryDistance=Math.min(edgeX?Math.min(lx,63-lx):8,edgeY?Math.min(ly,63-ly):8)
    const blend=seam?.active?1-boundaryDistance/8:0
    for(const[id,w]of sample(x+.5,y+.5)){
      if(w<=0)continue
      totalCoverage+=w;const primary=substitutions.get(`${pi}\0${id}`)??id
      let shared=primary
      if(blend>0){
        if(!seam!.materials.length)throw new RangeError('Native palette seam has no shared material; palette reallocation or local fallback required')
        shared=seam!.materials.includes(id)?id:nearest(id,seam!.materials)
        if(shared!==id&&input.approximation!=='nearest-color')throw new RangeError('Native palette seam requires explicit coverage approximation')
        if(shared!==id)substitutions.set(`seam:${seam!.key}\0${id}`,shared)
        if(shared!==primary)seamMovedCoverage+=w*blend
      }
      replacedCoverage+=w*((primary!==id?1-blend:0)+(shared!==id?blend:0))
      const slot=p.indexOf(primary),sharedSlot=p.indexOf(shared)
      if(slot>=0)values[slot]!+=w*(1-blend)
      if(sharedSlot>=0)values[sharedSlot]!+=w*blend
    }
    // Largest remainder keeps the quantized weight sum exactly fifteen.
    const sum=values.reduce((a,b)=>a+b,0),raw=values.map(v=>sum>0?v/sum*15:0),q=raw.map(Math.floor)
    const order=raw.map((v,i)=>({i,f:v-q[i]!})).sort((a,b)=>b.f-a.f||a.i-b.i)
    const missing=15-q.reduce((a,b)=>a+b,0)
    for(let r=0;r<missing&&sum>0;r++)q[order[r]!.i]!++
    for(let i=0;i<8;i++)weights[i]![y*width+x]=q[i]!
  }
  const assignments=Array.from({length:bx*by},(_,i)=>northAssignments[(by-1-Math.floor(i/bx))*bx+i%bx]!)
  return {width,height,sets:channelSets,assignments,weights,replacedCoverage,totalCoverage,seamMovedCoverage,substitutions:[...substitutions].map(([key,target])=>({key,target}))}
}
