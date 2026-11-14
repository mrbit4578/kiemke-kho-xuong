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
export const orderKey = (order) => {
  const command = normalizeJoinKey(order.orderNo);
  const source = command || [order.purchaseOrder, order.salesOrder, order.productCode].map(normalizeJoinKey).join('|');
  return `${source}|${normalizeJoinKey(order.model)}|${normalizeJoinKey(order.color)}`;
};
export const normalizeJoinKey = (value) => String(value ?? '')
  .replace(/\u00a0/g, ' ')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .replace(/[đĐ]/g, 'D')
  .replace(/\s+/g, ' ')
  .trim()
  .toUpperCase();

export const orderMappingKey = (row) => [
  row.sourceOrderNo, row.sourcePurchaseOrder, row.sourceSalesOrder,
  row.sourceModel, row.sourceColor, row.sourceProductCode,
].map((value) => normalizeJoinKey(value)).join('|');

function mappingMatchesOrder(order, mapping) {
  if (!mapping.targetOrderNo || !mapping.sourceModel || !mapping.sourceColor) return false;
  if (normalizeJoinKey(mapping.sourceModel) !== normalizeJoinKey(order.model)
    || normalizeJoinKey(mapping.sourceColor) !== normalizeJoinKey(order.color)) return false;
  const fields = [
    ['sourceOrderNo', 'orderNo'],
    ['sourcePurchaseOrder', 'purchaseOrder'],
    ['sourceSalesOrder', 'salesOrder'],
    ['sourceProductCode', 'productCode'],
  ];
  const hasIdentifier = fields.some(([source]) => normalizeJoinKey(mapping[source]));
  return hasIdentifier && fields.every(([source, target]) => (
    !normalizeJoinKey(mapping[source]) || normalizeJoinKey(mapping[source]) === normalizeJoinKey(order[target])
  ));
}

const chemicalIndexCache = new WeakMap();

function sourceProductKey(sourceId, row) {
  return [sourceId, row.model, row.color].map(normalizeJoinKey).join('|');
}

function commandProductKey(command, row) {
  return [command, row.model, row.color].map(normalizeJoinKey).join('|');
}

function chemicalCommandIndex(rows) {
  if (chemicalIndexCache.has(rows)) return chemicalIndexCache.get(rows);
  const bySourceProduct = new Map();
  const byCommandProduct = new Set();
  for (const row of rows || []) {
    const command = normalizeJoinKey(row.productionOrder);
    if (!command) continue;
    byCommandProduct.add(commandProductKey(command, row));
    for (const sourceId of [row.purchaseOrder, row.salesOrder].map(normalizeJoinKey).filter(Boolean)) {
      const key = sourceProductKey(sourceId, row);
      if (!bySourceProduct.has(key)) bySourceProduct.set(key, new Map());
      bySourceProduct.get(key).set(command, String(row.productionOrder).trim());
    }
  }
  const index = { bySourceProduct, byCommandProduct };
  if (rows && typeof rows === 'object') chemicalIndexCache.set(rows, index);
  return index;
}

function commandsForOrder(order, index) {
  const commands = new Map();
  for (const sourceId of [order.purchaseOrder, order.salesOrder].map(normalizeJoinKey).filter(Boolean)) {
    for (const [normalized, command] of index.bySourceProduct.get(sourceProductKey(sourceId, order)) || []) commands.set(normalized, command);
  }
  return [...commands.values()];
}

function indexRowsBySourceProduct(rows) {
  const index = new Map();
  for (const row of rows) {
    for (const sourceId of [row.purchaseOrder, row.salesOrder].map(normalizeJoinKey).filter(Boolean)) {
      const key = sourceProductKey(sourceId, row);
      if (!index.has(key)) index.set(key, []);
      index.get(key).push(row);
    }
  }
  return index;
}

function sourceCandidates(index, row) {
  const candidates = new Map();
  for (const sourceId of [row.purchaseOrder, row.salesOrder].map(normalizeJoinKey).filter(Boolean)) {
    for (const candidate of index.get(sourceProductKey(sourceId, row)) || []) candidates.set(candidate, candidate);
  }
  return [...candidates.values()];
}

/** Resolve a progress row to the canonical chemical production command without guessing on conflicts. */
export function resolveOrderCommand(order, chemicalRows = [], orderMappings = []) {
  const manual = (orderMappings || []).filter((mapping) => mappingMatchesOrder(order, mapping));
  const manualTargets = [...new Set(manual.map((mapping) => String(mapping.targetOrderNo).trim()).filter(Boolean))];
  if (manualTargets.length === 1) return { orderNo: manualTargets[0], resolution: 'manual', candidates: manualTargets };
  if (manualTargets.length > 1) return { orderNo: '', resolution: 'ambiguous', candidates: manualTargets };

  const index = chemicalCommandIndex(chemicalRows);
  const sourceCommand = String(order.orderNo || '').trim();
  if (sourceCommand && index.byCommandProduct.has(commandProductKey(sourceCommand, order))) {
    return { orderNo: sourceCommand, resolution: 'source', candidates: [sourceCommand] };
  }

  const candidates = [...commandsForOrder(order, index)];
  if (candidates.length === 1) return { orderNo: candidates[0], resolution: 'automatic', candidates };
  if (candidates.length > 1) return { orderNo: '', resolution: 'ambiguous', candidates };
  if (sourceCommand) return { orderNo: sourceCommand, resolution: 'source', candidates: [sourceCommand] };
  return { orderNo: '', resolution: 'unmapped', candidates: [] };
}

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

function orderBasisQuantity(order) {
  const plannedQty = Number(order.plannedQty) || 0;
  return plannedQty > 0 ? plannedQty : productionOrderQuantity(order);
}

function warehouseFromPlant(plant) {
  if (plant === 'LAF' || plant === 'LVF') return plant;
  if (plant === 'HOA_MAU_LAF' || plant === 'HOA_MAU_LVF') return plant;
  return '';
}

function stageQuantity(order, operation) {
  const normalized = normalizeJoinKey(operation);
  const stages = order.stageQuantities || {};
  const openStages = order.openStageQuantities || {};
  const orderQty = orderBasisQuantity(order);
  let key = '';
  if (normalized.includes('CHAT') || normalized.includes('CUT')) key = 'LAF_CUT';
  else if (normalized.includes('MAY') || normalized.includes('SEW')) key = 'LVF_SEW';
  else if (normalized.includes('GO') || normalized.includes('ASSEMB')) key = 'LVF_GO';
  if (!key) return orderQty;
  if (openStages[key] !== undefined && openStages[key] !== null && openStages[key] !== '') {
    return Math.max(0, Number(openStages[key]) || 0);
  }
  if (Object.prototype.hasOwnProperty.call(stages, key)) {
    return Math.max(0, orderQty - (Number(stages[key]) || 0));
  }
  return productionOrderQuantity(order);
}

function chemicalStageOperation(norm, warehouseId) {
  const explicit = norm.operation || norm.process || norm.stage || '';
  if (explicit) return explicit;
  // In the source progress workbook, Chặt is assigned to the LAF / Hóa mẫu LAF route.
  if (warehouseId === 'HOA_MAU_LAF') return 'Chặt';
  return '';
}

/**
 * Canonical theoretical demand by target warehouse.
 * Chemical norms use the source's calculated quantity divided by its source order quantity. LAF chemical
 * demand follows the remaining Chặt quantity; operation-specific direct BOM lines use remaining process quantity.
 * Generic BOM lines and unreleased production use the released quantity from TIEN-DO column T.
 */
export function getTheoreticalRequirements(data, warehouseId) {
  const warehouse = WAREHOUSES.find((item) => item.id === warehouseId);
  if (!warehouse) return { rows: [], unmapped: [], hasSource: false };
  const taskId = 'chemical-norms:' + warehouseId;
  const chemicalRows = warehouse.kind === 'chemical'
    ? activeRows(data.chemicalNorms, data.importMeta, taskId).filter((row) => row.warehouseId === warehouseId)
    : WAREHOUSES.filter((item) => item.kind === 'chemical')
      .flatMap((item) => activeRows(data.chemicalNorms, data.importMeta, 'chemical-norms:' + item.id));
  const allChemicalRows = WAREHOUSES.filter((item) => item.kind === 'chemical')
    .flatMap((item) => activeRows(data.chemicalNorms, data.importMeta, 'chemical-norms:' + item.id));
  const productionOrders = activeRows(data.productionOrders, data.importMeta, 'production-orders');
  const orders = productionOrders.length ? productionOrders : (data.orders || []);
  const ordersByCommandProduct = new Map();
  const ordersByCommand = new Map();
  for (const order of orders) {
    const key = commandProductKey(order.orderNo, order);
    if (!ordersByCommandProduct.has(key)) ordersByCommandProduct.set(key, []);
    ordersByCommandProduct.get(key).push(order);
    const commandKey = normalizeJoinKey(order.orderNo);
    if (commandKey) {
      if (!ordersByCommand.has(commandKey)) ordersByCommand.set(commandKey, []);
      ordersByCommand.get(commandKey).push(order);
    }
  }
  const ordersBySourceProduct = indexRowsBySourceProduct(orders);
  const automaticCommandIndex = chemicalCommandIndex(allChemicalRows);
  const result = [];
  const unmapped = [];

  if (warehouse.kind === 'chemical') {
    for (const norm of chemicalRows) {
      let ambiguityReason = '';
      let candidates = ordersByCommandProduct.get(commandProductKey(norm.productionOrder, norm)) || [];
      let matchType = 'Chỉ lệnh nguồn';
      const commandCandidates = ordersByCommand.get(normalizeJoinKey(norm.productionOrder)) || [];
      if (!candidates.length && commandCandidates.length === 1) {
        candidates = commandCandidates;
      }
      if (!candidates.length && (data.orderMappings || []).length) {
        const mappingResults = orders.map((order) => ({ order, result: resolveOrderCommand(order, [], data.orderMappings || []) }));
        const conflictingMappings = mappingResults.filter(({ result }) => result.resolution === 'ambiguous');
        candidates = mappingResults.filter(({ result }) => (
          result.resolution === 'manual' && normalizeJoinKey(result.orderNo) === normalizeJoinKey(norm.productionOrder)
        )).map(({ order }) => order);
        matchType = 'Bảng mapping';
        if (!candidates.length && conflictingMappings.length) {
          ambiguityReason = 'Bảng Mapping_Chi_Lenh có nhiều chỉ lệnh đích cho cùng một khóa nguồn; cần sửa còn một chỉ lệnh.';
        }
      }
      if (!candidates.length && !ambiguityReason) {
        const potentialOrders = sourceCandidates(ordersBySourceProduct, norm);
        const possibleCommands = new Set(potentialOrders.flatMap((order) => commandsForOrder(order, automaticCommandIndex).map(normalizeJoinKey)));
        if (possibleCommands.size === 1 && possibleCommands.has(normalizeJoinKey(norm.productionOrder))) {
          candidates = potentialOrders;
        } else if (possibleCommands.size > 1) {
          ambiguityReason = 'PO + mã hàng + màu khớp nhiều chỉ lệnh trong DM-NPL-DH; cần nhập bảng Mapping_Chi_Lenh.';
        }
        matchType = 'PO + mã hàng + màu';
      }
      if (candidates.length !== 1) {
        const reason = ambiguityReason || (candidates.length > 1
          ? `Có ${candidates.length} dòng tiến độ cùng khớp theo ${matchType}; bổ sung khóa hoặc mapping chỉ lệnh.`
          : 'Không khớp được PO + mã hàng + màu với tiến độ; nhập bảng Mapping_Chi_Lenh để nối thủ công.');
        unmapped.push({ ...norm, reason });
        continue;
      }
      const order = candidates[0];
      const releasedQty = productionOrderQuantity(order);
      if (releasedQty <= 0) continue;
      const sourceQty = Number(norm.sourceOrderQty) || 0;
      if (!(sourceQty > 0)) {
        unmapped.push({ ...norm, reason: 'Số lượng đơn hàng nguồn bằng 0 nên không thể quy đổi định mức.' });
        continue;
      }
      const operation = chemicalStageOperation(norm, warehouseId);
      const basisQty = operation ? stageQuantity(order, operation) : releasedQty;
      if (basisQty <= 0) continue;
      const rate = (Number(norm.sourceQuantity) || 0) / sourceQty;
      result.push({
        warehouseId,
        sourceType: 'chemical',
        orderNo: order.orderNo || norm.productionOrder,
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
        basisQty,
        basisType: operation ? 'Còn lại tại công đoạn ' + operation : 'Số lượng lệnh sản xuất',
        quantity: rate * basisQty,
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
      const basisQty = line.operation ? stageQuantity(order, line.operation) : releaseQty;
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

