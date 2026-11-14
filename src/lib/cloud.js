import { inventoryKey, orderKey, productMappingKey } from './model.js';

const TYPES = ['material', 'bom', 'order', 'inventory', 'norm', 'production_order', 'product_mapping', 'chemical_norm', 'import_meta'];

export async function ensureWorkspace(client) {
  const { data: memberships, error } = await client
    .from('workspace_members')
    .select('workspace_id, role')
    .order('created_at', { ascending: true })
    .limit(1);
  if (error) throw error;
  if (memberships?.length) return memberships[0].workspace_id;
  const { data, error: createError } = await client.rpc('create_default_workspace', { workspace_name: 'Kho xưởng 3 nhà máy' });
  if (createError) throw createError;
  return data;
}

export async function loadWorkspaceRecords(client, workspaceId) {
  const all = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await client
      .from('workspace_records')
      .select('entity_type, entity_key, payload')
      .eq('workspace_id', workspaceId)
      .order('entity_type')
      .range(from, from + 999);
    if (error) throw error;
    all.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  const state = { materials: [], bom: [], orders: [], productionOrders: [], productMappings: [], chemicalNorms: [], importMeta: {}, inventory: {}, norms: [] };
  for (const row of all) {
    if (row.entity_type === 'material') state.materials.push(row.payload);
    if (row.entity_type === 'bom') state.bom.push(row.payload);
    if (row.entity_type === 'order') state.orders.push(row.payload);
    if (row.entity_type === 'norm') state.norms.push(row.payload);
    if (row.entity_type === 'production_order') state.productionOrders.push(row.payload);
    if (row.entity_type === 'product_mapping') state.productMappings.push(row.payload);
    if (row.entity_type === 'chemical_norm') state.chemicalNorms.push(row.payload);
    if (row.entity_type === 'import_meta') state.importMeta[row.payload.taskId] = row.payload;
    if (row.entity_type === 'inventory') {
      const item = row.payload;
      state.inventory[inventoryKey(item.plant, item.catalogNo)] = item;
    }
  }
  return state;
}

function keyFor(type, item) {
  if (type === 'material') return String(item.catalogNo);
  if (type === 'bom') return `${item.catalogNo}|${item.plant || 'ALL'}|${item.productKey}|${item.size || ''}|${item.process || ''}`;
  if (type === 'order') return orderKey(item);
  if (type === 'inventory') return inventoryKey(item.plant, item.catalogNo);
  if (type === 'norm') return `${item.catalogNo}|${item.productKey}|${item.size}|${item.process}|${item.btpCode || ''}`;
  if (type === 'production_order') return `${item.batchId || 'legacy'}|${item.orderNo}|${item.model}|${item.color}`;
  if (type === 'product_mapping') return productMappingKey(item);
  if (type === 'chemical_norm') return `${item.warehouseId}|${item.batchId || 'legacy'}|${item.sourceRow || crypto.randomUUID()}`;
  if (type === 'import_meta') return item.taskId;
  return crypto.randomUUID();
}

export async function saveWorkspaceRecords(client, workspaceId, userId, payload, changedTypes = TYPES) {
  for (const type of TYPES) {
    if (!changedTypes.includes(type)) continue;
    let items = payload[type] || [];
    if (type === 'inventory') items = Object.values(payload.inventory || {});
    if (type === 'production_order') items = payload.productionOrders || [];
    if (type === 'product_mapping') items = payload.productMappings || [];
    if (type === 'chemical_norm') items = payload.chemicalNorms || [];
    if (type === 'import_meta') items = Object.values(payload.importMeta || {});
    if (!items.length) continue;
    const rows = items.map((item) => ({
      workspace_id: workspaceId,
      entity_type: type,
      entity_key: keyFor(type, item),
      payload: item,
      updated_by: userId,
      updated_at: new Date().toISOString(),
    }));
    for (let index = 0; index < rows.length; index += 500) {
      const { error } = await client.from('workspace_records').upsert(rows.slice(index, index + 500), {
        onConflict: 'workspace_id,entity_type,entity_key',
      });
      if (error) throw error;
    }
  }
}
