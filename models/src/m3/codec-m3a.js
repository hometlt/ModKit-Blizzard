import { createM3FamilyCodec } from './codec.js'

export const abiVersion = 1
export const createCodec = context => createM3FamilyCodec(context, 'm3a')
