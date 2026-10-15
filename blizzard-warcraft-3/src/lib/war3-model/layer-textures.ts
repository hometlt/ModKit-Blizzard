// Copied verbatim from war3-model renderer/util.ts so the parsers do not drag in its WebGL layer
// (and its gl-matrix dependency). Slot order is the Reforged HD layer texture order.
export const LAYER_TEXTURE_NAME_MAP = {
    'TextureID': 0,
    'NormalTextureID': 1,
    'ORMTextureID': 2,
    'EmissiveTextureID': 3,
    'TeamColorTextureID': 4,
    'ReflectionsTextureID': 5
};

export const LAYER_TEXTURE_ID_MAP = [
    'TextureID',
    'NormalTextureID',
    'ORMTextureID',
    'EmissiveTextureID',
    'TeamColorTextureID',
    'ReflectionsTextureID'
];
