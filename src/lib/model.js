export const PLANTS = [
  { id: 'HOA_MAU', name: 'Hóa mẫu', short: 'HM', color: 'violet' },
  { id: 'LAF', name: 'Nhà máy LAF', short: 'LAF', color: 'blue' },
  { id: 'LVF', name: 'Nhà máy LVF', short: 'LVF', color: 'green' },
];

export const WAREHOUSES = [
  { id: 'HOA_MAU_LAF', name: 'Kho Hóa mẫu LAF', kind: 'chemical', color: 'violet' },
  { id: 'HOA_MAU_LVF', name: 'Kho Hóa mẫu LVF', kind: 'chemical', color: 'violet' },
  { id: 'LAF', name: 'Kho xưởng LAF', kind: 'factory', color: 'blue' },
  { id: 'LVF', name: 'Kho xưởng LVF', kind: 'factory', color: 'green' },
];

export const money = (value, digits = 0) => new Intl.NumberFormat('vi-VN', {
  minimumFractionDigits: digits,
  maximumFractionDigits: digits,
}).format(Number(value) || 0);

export const productKey = (model, color) => `${String(model || '').trim()}_${String(color || '').trim()}`;
export const productMappingKey = (row) => normalizeJoinKey(row.sourceProductCode)
  ? `CODE|${normalizeJoinKey(row.sourceProductCode)}`
  : `PAIR|${normalizeJoinKey(row.sourceModel)}|${normalizeJoinKey(row.sourceColor)}`;
export const inventoryKey = (plant, catalogNo) => `${plant}|${catalogNo}`;
export const orderKey = (order) => `${order.orderNo}|${order.model}|${order.color}`;
export const normalizeJoinKey = (value) => String(value ?? '')
  .replace(/\u00a0/g, ' ')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .replace(/[đĐ]/g, 'D')
  .replace(/\s+/g, ' ')
  .trim()
  .toUpperCase();

export function getWarehouseName(id) {
  return WAREHOUSES.find((warehouse) => warehouse.id === id)?.name || id;
}

function activeRows(rows, importMeta, taskId) {
  const batchId = importMeta?.[taskId]?.batchId;
  return batchId ? (rows || []).filter((row) => row.batchId === batchId) : (rows || []);
}

function productionOrderQuantity(order) {
  if (order.productionQty !== undefined && order.productionQty !== null && order.productionQty !== '') {
    return Number(order.productionQty) || 0;
  }
  return Number(order.plannedQty) || 0;
}

function warehouseFromPlant(plant) {
  if (plant === 'LAF' || plant === 'LVF') return plant;
  if (plant === 'HOA_MAU_LAF' || plant === 'HOA_MAU_LVF') return plant;
  return '';
}

function stageQuantity(order, operation) {
  const normalized = normalizeJoinKey(operation);
  const stages = order.stageQuantities || {};
  const releaseQty = productionOrderQuantity(order);
  if (normalized.includes('CHAT') || normalized.includes('CUT')) return Math.max(0, releaseQty - (Number(stages.LAF_CUT) || 0));
  if (normalized.includes('MAY') || normalized.includes('SEW')) return Math.max(0, releaseQty - (Number(stages.LVF_SEW) || 0));
  if (normalized.includes('GO') || normalized.includes('ASSEMB')) return Math.max(0, releaseQty - (Number(stages.LVF_GO) || 0));
  return releaseQty;
}

/**
 * Canonical theoretical demand by target warehouse.
 * Chemical norms use the source's calculated chemical quantity (R) divided by source order quantity (G),
 * then scale by the released production quantity (TIEN-DO column T). Direct BOM rows use rate × released quantity.
 */
export function getTheoreticalRequirements(data, warehouseId) {
  const warehouse = WAREHOUSES.find((item) => item.id === warehouseId);
  if (!warehouse) return { rows: [], unmapped: [], hasSource: false };
  const taskId = 'chemical-norms:' + warehouseId;
  const chemicalRows = warehouse.kind === 'chemical'
    ? activeRows(data.chemicalNorms, data.importMeta, taskId).filter((row) => row.warehouseId === warehouseId)
    : WAREHOUSES.filter((item) => item.kind === 'chemical')
      .flatMap((item) => activeRows(data.chemicalNorms, data.importMeta, 'chemical-norms:' + item.id));
  const productionOrders = activeRows(data.productionOrders, data.importMeta, 'production-orders');
  const orders = productionOrders.length ? productionOrders : (data.orders || []);
  const orderByJoinKey = new Map(orders.map((order) => [
    [order.orderNo, order.model, order.color].map(normalizeJoinKey).join('|'), order,
  ]));
  const result = [];
  const unmapped = [];

  if (warehouse.kind === 'chemical') {
    for (const norm of chemicalRows) {
      const order = orderByJoinKey.get([norm.productionOrder, norm.model, norm.color].map(normalizeJoinKey).join('|'));
      if (!order) {
        unmapped.push({ ...norm, reason: 'Không ghép được chỉ lệnh, mã hàng và màu với tiến độ sản xuất.' });
        continue;
      }
      const sourceQty = Number(norm.sourceOrderQty) || 0;
      const releasedQty = productionOrderQuantity(order);
      if (!(sourceQty > 0)) {
        unmapped.push({ ...norm, reason: 'Số lượng đơn hàng nguồn bằng 0 nên không thể quy đổi định mức.' });
        continue;
      }
      const rate = (Number(norm.sourceQuantity) || 0) / sourceQty;
      result.push({
        warehouseId,
        sourceType: 'chemical',
        orderNo: order.orderNo,
        purchaseOrder: order.purchaseOrder || norm.purchaseOrder || '',
        model: order.model,
        color: order.color,
        component: norm.component || '',
        formulaName: norm.formulaName || '',
        materialCode: norm.materialCode || '',
        materialName: norm.materialName || '',
        unit: norm.unit || '',
        specification: norm.specification || '',
        rate,
        basisQty: releasedQty,
        quantity: rate * releasedQty,
        sourceOrderQty: sourceQty,
        source: norm.sourceFile || 'DM-NPL-DH',
        sourceRow: norm.sourceRow,
      });
    }
    return { rows: result.filter((row) => row.quantity > 0), unmapped, hasSource: chemicalRows.length > 0 };
  }

  const chemicalCodes = new Set(chemicalRows.map((row) => normalizeJoinKey(row.materialCode)).filter(Boolean));
  const colorCodesByOrder = new Map();
  for (const row of chemicalRows) {
    if (!row.colorCode) continue;
    const orderColorKey = [row.productionOrder, row.model, row.color].map(normalizeJoinKey).join('|');
    if (!colorCodesByOrder.has(orderColorKey)) colorCodesByOrder.set(orderColorKey, new Set());
    colorCodesByOrder.get(orderColorKey).add(row.colorCode);
  }
  const productMappingsBySource = new Map();
  for (const mapping of data.productMappings || []) {
    const key = [mapping.sourceModel, mapping.sourceColor].map(normalizeJoinKey).join('|');
    if (!productMappingsBySource.has(key)) productMappingsBySource.set(key, []);
    productMappingsBySource.get(key).push(mapping);
  }
  const productMappingsByCode = new Map();
  for (const mapping of data.productMappings || []) {
    if (!mapping.sourceProductCode) continue;
    const key = normalizeJoinKey(mapping.sourceProductCode);
    if (!productMappingsByCode.has(key)) productMappingsByCode.set(key, []);
    productMappingsByCode.get(key).push(mapping);
  }
  const materialsByNo = new Map((data.materials || []).map((item) => [String(item.catalogNo), item]));
  const bomByProduct = new Map();
  const mappedSourceLocations = new Set();
  for (const line of data.bom || []) {
    const key = [line.model, line.color].map(normalizeJoinKey).join('|');
    if (!bomByProduct.has(key)) bomByProduct.set(key, []);
    bomByProduct.get(key).push(line);
    const material = materialsByNo.get(String(line.catalogNo)) || {};
    const explicit = warehouseFromPlant(line.warehouseId) || warehouseFromPlant(line.plant);
    const choices = (material.plants || []).filter((id) => id === 'LAF' || id === 'LVF');
    if (explicit) mappedSourceLocations.add(explicit);
    else choices.forEach((id) => mappedSourceLocations.add(id));
  }
  for (const order of orders) {
    const releaseQty = productionOrderQuantity(order);
    if (releaseQty <= 0) continue;
    const sourceKey = [order.model, order.color].map(normalizeJoinKey).join('|');
    const pairMappings = productMappingsBySource.get(sourceKey) || [];
    const codeMappings = productMappingsByCode.get(normalizeJoinKey(order.productCode)) || [];
    const manualPairMappings = pairMappings.filter((mapping) => mapping.sourceType === 'manual');
    const manualCodeMappings = codeMappings.filter((mapping) => mapping.sourceType === 'manual');
    const explicitMappings = manualPairMappings.length ? manualPairMappings
      : manualCodeMappings.length ? manualCodeMappings
        : pairMappings.length ? pairMappings : codeMappings;
    const productKeys = new Set();
    if (explicitMappings.length) {
      for (const mapping of explicitMappings) {
        if (mapping.bomModel && mapping.bomColor) productKeys.add([mapping.bomModel, mapping.bomColor].map(normalizeJoinKey).join('|'));
      }
    } else {
      productKeys.add(sourceKey);
      const orderCodes = colorCodesByOrder.get([order.orderNo, order.model, order.color].map(normalizeJoinKey).join('|')) || new Set();
      if (orderCodes.size === 1) productKeys.add([order.model, [...orderCodes][0]].map(normalizeJoinKey).join('|'));
    }
    const bomLines = new Map();
    for (const key of productKeys) {
      for (const line of bomByProduct.get(key) || []) {
        const identity = [line.catalogNo, line.warehouseId, line.productKey, line.rate, line.plant, line.operation, line.supplyRoute, line.size, line.process].join('|');
        bomLines.set(identity, line);
      }
    }
    if (!bomLines.size && (data.bom || []).length) {
      unmapped.push({
        orderNo: order.orderNo,
        model: order.model,
        color: order.color,
        reason: 'Không tìm thấy cặp mã hàng-màu trong định mức BOM trực tiếp.',
      });
      continue;
    }
    for (const line of bomLines.values()) {
      const material = materialsByNo.get(String(line.catalogNo)) || {};
      const code = String(line.materialCode || material.materialCode || '').trim();
      const route = normalizeJoinKey(line.supplyRoute || '');
      const materialPlants = (material.plants || []).filter((id) => id === 'LAF' || id === 'LVF');
      const isKnownChemical = (material.plants || []).includes('HOA_MAU') || chemicalCodes.has(normalizeJoinKey(code));
      if (route.includes('HOA MAU') || route.includes('CHEMICAL') || (!route.includes('TRUC TIEP') && isKnownChemical)) continue;
      let target = warehouseFromPlant(line.warehouseId) || warehouseFromPlant(line.plant);
      if (!target && materialPlants.length === 1) target = materialPlants[0];
      if (!target && (order.plant === 'LAF' || order.plant === 'LVF') && (!materialPlants.length || materialPlants.includes(order.plant))) target = order.plant;
      if (!target) {
        unmapped.push({
          orderNo: order.orderNo,
          model: order.model,
          color: order.color,
          materialCode: code,
          materialName: material.name || '',
          reason: materialPlants.length > 1 ? 'Vật tư dùng nhiều nhà máy; cần khai báo kho nhận trong BOM.' : 'Chưa xác định được kho nhận LAF/LVF cho dòng BOM.',
        });
        continue;
      }
      if (target !== warehouseId) continue;
      const basisQty = stageQuantity(order, line.operation);
      if (basisQty <= 0) continue;
      result.push({
        warehouseId,
        sourceType: 'direct',
        orderNo: order.orderNo,
        purchaseOrder: order.purchaseOrder || '',
        model: order.model,
        color: order.color,
        component: line.operation || 'Theo định mức BOM',
        formulaName: '',
        materialCode: code || String(line.catalogNo || ''),
        materialName: material.name || line.materialName || '',
        unit: material.unit || '',
        specification: material.colorScope || '',
        rate: Number(line.rate) || 0,
        basisQty,
        basisType: line.operation ? 'Còn lại tại công đoạn' : 'Số lượng lệnh sản xuất',
        quantity: (Number(line.rate) || 0) * basisQty,
        sourceOrderQty: Number(order.plannedQty) || 0,
        source: line.sourceFile || 'Ma trận BOM',
        sourceRow: line.sourceRow,
      });
    }
  }
  return { rows: result.filter((row) => row.quantity > 0), unmapped, hasSource: mappedSourceLocations.has(warehouseId) };
}

export function summarizeTheoreticalRequirements(rows) {
  const grouped = new Map();
  for (const row of rows || []) {
    const key = [row.materialCode, row.materialName, row.unit, row.component].map(normalizeJoinKey).join('|');
    if (!grouped.has(key)) grouped.set(key, {
      materialCode: row.materialCode,
      materialName: row.materialName,
      unit: row.unit,
      component: row.component,
      quantity: 0,
      orders: new Set(),
      details: [],
    });
    const item = grouped.get(key);
    item.quantity += Number(row.quantity) || 0;
    item.orders.add(row.orderNo);
    item.details.push(row);
  }
  return [...grouped.values()]
    .map((item) => ({ ...item, orderCount: item.orders.size, orders: undefined }))
    .sort((a, b) => String(a.materialCode).localeCompare(String(b.materialCode), 'vi') || String(a.component).localeCompare(String(b.component), 'vi'));
}

export function mergeWipProgress(orders, incomingRows) {
  const byOrderAndPlant = new Map((incomingRows || []).map((row) => [orderKey(row) + '|' + row.plant, row]));
  const matched = new Set();
  const updated = (orders || []).map((order) => {
    let changed = false;
    const progress = { ...(order.progress || {}) };
    for (const plant of PLANTS) {
      const key = orderKey(order) + '|' + plant.id;
      const row = byOrderAndPlant.get(key);
      if (!row) continue;
      progress[plant.id] = Number(row.wipQty) || 0;
      matched.add(key);
      changed = true;
    }
    return changed ? { ...order, progress } : order;
  });
  return { orders: updated, matched: matched.size, unmatched: [...byOrderAndPlant.keys()].filter((key) => !matched.has(key)).length };
}

export function getPlantName(id) {
  return PLANTS.find((plant) => plant.id === id)?.name || id;
}

export function getMaterialNeed(data, material, plantId) {
  const materialsBOM = (data.bom || []).filter((line) => (
    Number(line.catalogNo) === Number(material.catalogNo)
    && (!line.plant || line.plant === plantId)
  ));
  let planned = 0;
  let wip = 0;
  for (const order of data.orders || []) {
    const key = productKey(order.model, order.color);
    for (const line of materialsBOM) {
      if (line.productKey !== key) continue;
      if (!order.plant || order.plant === plantId) {
        planned += Number(line.rate || 0) * Number(order.plannedQty || 0);
      }
      wip += Number(line.rate || 0) * Number(order.progress?.[plantId] || 0);
    }
  }
  return { planned, wip };
}

export function getInventoryRows(data, plantId) {
  return (data.materials || [])
    .filter((material) => (material.plants || []).includes(plantId))
    .map((material) => {
      const stock = data.inventory?.[inventoryKey(plantId, material.catalogNo)] || {};
      const need = getMaterialNeed(data, material, plantId);
      const received = Number(stock.received || 0);
      const actual = stock.actual === '' || stock.actual === null || stock.actual === undefined ? null : Number(stock.actual || 0);
      const theoretical = received - need.wip;
      const variance = actual === null ? null : actual - theoretical;
      const hasActivity = received !== 0 || need.planned !== 0 || need.wip !== 0 || actual !== null;
      const status = !hasActivity ? 'Chưa phát sinh' : actual === null ? 'Chưa kiểm kê' : Math.round((variance || 0) * 100) / 100 === 0 ? 'Đủ' : (variance || 0) > 0 ? 'Dư' : 'Thiếu';
      return { ...material, plant: plantId, received, actual, plannedNeed: need.planned, wipNeed: need.wip, theoretical, variance, status };
    });
}

export function getPlantSummary(data, plantId) {
  const rows = getInventoryRows(data, plantId);
  return rows.reduce((summary, row) => {
    summary.count += 1;
    if (row.status !== 'Chưa phát sinh') summary.active += 1;
    if (row.status === 'Đủ') summary.enough += 1;
    if (row.status === 'Dư') summary.surplus += 1;
    if (row.status === 'Thiếu') summary.shortage += 1;
    summary.received += row.received;
    summary.wip += row.wipNeed;
    summary.need += Math.max(0, row.plannedNeed - row.wipNeed);
    summary.actual += row.actual || 0;
    summary.variance += row.variance || 0;
    return summary;
  }, { plant: plantId, count: 0, active: 0, enough: 0, surplus: 0, shortage: 0, received: 0, wip: 0, need: 0, actual: 0, variance: 0 });
}

export function statusTone(status) {
  return ({
    Đủ: 'success',
    Dư: 'warning',
    Thiếu: 'danger',
    'Chưa phát sinh': 'muted',
    'Chưa kiểm kê': 'info',
    'Đang sản xuất': 'info',
    'Chờ sản xuất': 'muted',
  })[status] || 'muted';
}
