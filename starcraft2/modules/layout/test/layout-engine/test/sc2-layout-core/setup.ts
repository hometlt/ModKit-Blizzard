import { createRegistry } from '../../../../shared/layout-engine/sc2-layout-core/schema/registry.js';
import schemaData from '../../bundled-schema.js';

(<any>global)._cachedSchemaGen = () => {
    if (typeof (<any>global)._cachedSchema !== 'undefined') {
        return (<any>global)._cachedSchema;
    }
    return ((<any>global)._cachedSchema = createRegistry(schemaData));
};




