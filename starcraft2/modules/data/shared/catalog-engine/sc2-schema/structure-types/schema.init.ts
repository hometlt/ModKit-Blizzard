import { TUpgradeEffectValue, CTokenType, CConstType, CNamespaceClassLink, TEditorCategories, CTokenValues, CTokenDefinitions, SEditorCategoriesFields, STokenFields, STokenValueFields } from './schema.complex.js'
import { SUpgradeEffect, SConst } from './schema.struct.js'
import { DATA_CLASS_SCHEMA } from './schema.classes.js'

// Prototype patch: these assignments require types from struct/classes (circular dep guard)
;(TUpgradeEffectValue as any).prototype.dynamic = (data: SUpgradeEffect) => (data as any).Reference?.value
;(CTokenType as any).prototype.dynamic = (data: any, mod: any) => mod.getTokenType(data.id)
;(CConstType as any).prototype.dynamic = (data: SConst) => (DATA_CLASS_SCHEMA as any)[data.type as string]
;(CNamespaceClassLink as any).prototype.dynamic = (data: any) => (DATA_CLASS_SCHEMA as any)[data.class]?.namespace
;(TEditorCategories as any).prototype.schema = SEditorCategoriesFields
;(CTokenValues as any).prototype.value = STokenFields
;(CTokenDefinitions as any).prototype.value = STokenValueFields
