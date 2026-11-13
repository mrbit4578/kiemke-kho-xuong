export const PLANTS = [
  { id: 'HOA_MAU', name: 'Hóa mẫu', short: 'HM', color: 'violet' },
  { id: 'LAF', name: 'Nhà máy LAF', short: 'LAF', color: 'blue' },
  { id: 'LVF', name: 'Nhà máy LVF', short: 'LVF', color: 'green' },
];

export const money = (value, digits = 0) => new Intl.NumberFormat('vi-VN', {
  minimumFractionDigits: digits,
  maximumFractionDigits: digits,
}).format(Number(value) || 0);

export const productKey = (model, color) => `${String(model || '').trim()}_${String(color || '').trim()}`;
export const inventoryKey = (plant, catalogNo) => `${plant}|${catalogNo}`;
export const orderKey = (order) => `${order.orderNo}|${order.model}|${order.color}`;

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
