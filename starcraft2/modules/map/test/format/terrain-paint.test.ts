import{describe,it,expect}from'vitest'
import{authorTerrainPaint,terrainPaintCoverage,alignTerrainPaletteChannels}from'../../shared/format/terrain-paint.js'
import{setTextureMaskWindow,writeTextureMasks,readTextureMasks,textureMaskWeight}from'../../shared/format/formats/texture-masks.js'
describe('portable ordered layers to native terrain paint',()=>{
  it('uses shared material at both sides of a palette seam and reports the moved coverage',()=>{
    const materials=Array.from({length:9},(_,i)=>({id:`M${i}`,color:[i*20,0,0] as const}))
    const samples=Array.from({length:9},()=>Array.from({length:17},(_,x)=>({layers:[{
      materialId:`M${x===0||x===9?0:x<8?Math.min(4,x):Math.min(8,x-3)}`,
    }]})))
    const input={columns:17,rows:9,cellsX:16,cellsY:8,materials,samples,paletteSeams:'shared-materials' as const}
    expect(()=>authorTerrainPaint(input)).toThrow(/explicit coverage/)
    const p=authorTerrainPaint({...input,approximation:'nearest-color'})
    expect(p.seamMovedCoverage).toBeGreaterThan(0);expect(p.replacedCoverage).toBeGreaterThan(0)
    const channel=p.sets[0]!.indexOf('M0')
    for(const x of[63,64])expect(p.weights[channel]![32*p.width+x]).toBe(15)
    for(let i=0;i<p.width*p.height;i++)expect(p.weights.reduce((n,w)=>n+w[i]!,0)).toBe(15)
  })
  it('does not select locally valid palettes requiring nine shared channels',()=>{
    const materials=Array.from({length:9},(_,i)=>({id:`M${i}`,color:[i*20,0,0] as const}))
    const samples=Array.from({length:9},()=>Array.from({length:25},(_,x)=>{
      const block=Math.min(2,Math.floor(x/8)),ids=materials.filter((_,i)=>i!==block)
      return {layers:[{materialId:ids[x%8]!.id}]}
    }))
    const input={columns:25,rows:9,cellsX:24,cellsY:8,materials,samples}
    expect(()=>authorTerrainPaint(input)).toThrow(/capacity/)
    const p=authorTerrainPaint({...input,approximation:'nearest-color'})
    expect(p.replacedCoverage).toBeGreaterThan(0)
    const slots=new Map<string,number>()
    for(const set of p.sets)set.forEach((id,slot)=>{if(!id)return;if(slots.has(id))expect(slot).toBe(slots.get(id));slots.set(id,slot)})
  })
  it('keeps shared materials in one channel even when local palette orders differ',()=>{
    const input=[['A','B','C'],['D','B'],['E','A','D']]
    const sets=alignTerrainPaletteChannels(input),slots=new Map<string,number>()
    for(const set of sets)set.forEach((id,slot)=>{if(!id)return;if(slots.has(id))expect(slot).toBe(slots.get(id));slots.set(id,slot)})
    for(let i=0;i<sets.length;i++)expect(sets[i]!.filter(Boolean).sort()).toEqual(input[i]!.slice().sort())
    expect(alignTerrainPaletteChannels(input)).toEqual(sets)
    // Three overlapping eight-member cliques require nine global colors.
    const nine=Array.from({length:9},(_,i)=>`M${i}`)
    expect(()=>alignTerrainPaletteChannels([nine.slice(1),nine.filter((_,i)=>i!==1),nine.filter((_,i)=>i!==2)])).toThrow(/coherent/)
  })
  it('rejects malformed RGB, truncated rows and empty painted cells',()=>{
    const base={columns:9,rows:9,cellsX:8,cellsY:8,materials:[{id:'M',color:[1,2,3] as const}],samples:Array.from({length:9},()=>Array.from({length:9},()=>({layers:[{materialId:'M'}]})))}
    expect(()=>authorTerrainPaint({...base,materials:[{id:'M',color:[1,2] as never}]})).toThrow(/palette/)
    expect(()=>authorTerrainPaint({...base,samples:base.samples.map(row=>row.slice(0,8))})).toThrow(/grid/)
    expect(()=>authorTerrainPaint({...base,samples:base.samples.map(row=>row.map(()=>({layers:[]})))})).toThrow(/layers/)
  })
  it('links north-first coverage to south-first palette blocks after native MASK serialization',()=>{
    const materials=Array.from({length:8},(_,i)=>({id:`M${i}`,color:[i*20,0,0] as const}))
    const samples=Array.from({length:17},(_,y)=>Array.from({length:17},(_,x)=>({layers:[{materialId:`M${Math.min(3,Math.floor(x/4))+(y>=8?4:0)}`}]})))
    const p=authorTerrainPaint({columns:17,rows:17,samples,cellsX:16,cellsY:16,materials})
    let mask={sizeX:128,sizeY:128,version:102,unk:0,tilesX:2,tilesY:2,blocksPerLayer:4,layers:8,body:new Uint8Array(4*2048*8),_raw:{zero:new Uint8Array(44),trailing:new Uint8Array(0)}}
    for(let i=0;i<8;i++)mask=setTextureMaskWindow(mask,i,{x:0,y:0,width:128,height:128,values:Array.from(p.weights[i]!)})
    const reopened=readTextureMasks(writeTextureMasks(mask))
    for(const nativeY of[10,100])for(const x of[10,50,100]){
      const set=p.sets[p.assignments[Math.floor(nativeY/64)*2+Math.floor(x/64)]!]!
      const slot=Array.from({length:8},(_,i)=>textureMaskWeight(reopened,i,x,nativeY)).indexOf(15)
      const northY=127-nativeY,expected=`M${Math.floor(x/32)+(northY>=64?4:0)}`
      expect(set[slot]).toBe(expected)
    }
  })
  it('composes corner coverage independently of source image opacity',()=>{
    const layers=[{materialId:'sand'},{materialId:'grass',cornerAlpha:[0,1,1,0]}]
    expect([...terrainPaintCoverage(layers,.25,.8)]).toEqual([['sand',.75],['grass',.25]])
  })
  it('keeps local y coverage continuous between adjoining rows and ignores base coverage',()=>{
    const base={materialId:'base',cornerAlpha:[0,0,0,0]}
    const north=[base,{materialId:'overlay',cornerAlpha:[0,0,1,1]}]
    const south=[base,{materialId:'overlay',cornerAlpha:[1,1,0,0]}]
    expect(terrainPaintCoverage(north,.3,0).get('base')).toBe(1)
    expect(terrainPaintCoverage(north,.3,1).get('overlay')).toBe(1)
    expect(terrainPaintCoverage(south,.3,0).get('overlay')).toBe(1)
    expect(terrainPaintCoverage(north,.3,.2).get('overlay')).toBeCloseTo(.2)
    expect(terrainPaintCoverage(south,.3,.8).get('overlay')).toBeCloseTo(.2)
  })
  it('assigns different block palettes without replacing source materials',()=>{
    const materials=Array.from({length:9},(_,i)=>({id:`M${i}`,color:[i*20,0,0] as const}))
    const samples=Array.from({length:9},()=>Array.from({length:17},(_,x)=>({layers:[{materialId:`M${Math.min(8,Math.floor(x/2))}`}]})))
    const p=authorTerrainPaint({columns:17,rows:9,samples,cellsX:16,cellsY:8,materials})
    expect(p.replacedCoverage).toBe(0);expect(p.sets.length).toBeGreaterThan(1)
    expect(p.assignments[0]).not.toBe(p.assignments[1])
    for(let y=0;y<p.height;y++)for(let x=0;x<p.width;x++){
      const set=p.sets[p.assignments[Math.floor(x/64)]!]!,id=`M${Math.floor(x/16)}`
      expect(p.weights[set.indexOf(id)]![y*p.width+x]).toBe(15)
    }
  })
  it('refuses overflowing blocks unless approximation is explicit and records coverage loss',()=>{
    const materials=Array.from({length:9},(_,i)=>({id:`M${i}`,color:[i*20,0,0] as const}))
    const samples=Array.from({length:9},(_,y)=>Array.from({length:9},(_,x)=>({layers:[{materialId:`M${(x+y)%9}`}]})))
    const input={columns:9,rows:9,samples,cellsX:8,cellsY:8,materials}
    expect(()=>authorTerrainPaint(input)).toThrow(/capacity/)
    const p=authorTerrainPaint({...input,approximation:'nearest-color'})
    expect(p.replacedCoverage).toBeGreaterThan(0);expect(p.substitutions.length).toBeGreaterThan(0)
    for(let i=0;i<p.width*p.height;i++)expect(p.weights.reduce((n,w)=>n+w[i]!,0)).toBe(15)
  })
})
