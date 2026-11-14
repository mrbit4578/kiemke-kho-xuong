import test from 'node:test';
import assert from 'node:assert/strict';
import { getInventoryRows, getMaterialNeed, inventoryKey, mergeWipProgress, productKey } from './model.js';
import { createTaskWorkbook, importTaskWorkbook } from './task-workbooks.js';

const baseData = () => ({
  materials: [{ catalogNo: 12, materialCode: 'VT-12', name: 'Vải thử', unit: 'mét', issueUnit: 'cuộn', packQty: 10, packagingWeight: 0.5, colorScope: 'Dùng chung theo BOM', plants: ['LAF', 'LVF'] }],
  bom: [{ catalogNo: 12, model: 'NVQ89', color: 'LC1783', productKey: productKey('NVQ89', 'LC1783'), rate: 0.2, plant: null }],
  orders: [{ orderNo: 'PO-01', model: 'NVQ89', color: 'LC1783', colorName: 'Đen', plannedQty: 100, plant: 'LAF', progress: { HOA_MAU: 0, LAF: 5, LVF: 2 }, status: 'Đang chạy', sourceSheet: 'ADIDAS' }],
  inventory: { [inventoryKey('LAF', 12)]: { catalogNo: 12, plant: 'LAF', received: 10, actual: 9 } },
  norms: [{ catalogNo: 12, materialCode: 'VT-12', materialName: 'Vải thử', productKey: productKey('NVQ89', 'LC1783'), size: '7', process: 'Lót', btpCode: 'BTP-01', btpName: 'Lót trước', rate: 0.15, plannedQty: 20, wipQty: 4 }],
});

function asFile(bytes, name) {
  const buffer = Buffer.from(bytes);
  return {
    name,
    arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
  };
}

async function roundTrip(taskId, data = baseData()) {
  const bytes = await createTaskWorkbook(taskId, data);
  return { bytes, imported: await importTaskWorkbook(taskId, asFile(bytes, taskId + '.xlsx')) };
}

test('application calculations compute BOM demand and inventory variance without workbook formulas', () => {
  const data = baseData();
  const need = getMaterialNeed(data, data.materials[0], 'LAF');
  assert.equal(need.planned, 20);
  assert.equal(need.wip, 1);
  const row = getInventoryRows(data, 'LAF')[0];
  assert.equal(row.theoretical, 9);
  assert.equal(row.variance, 0);
  assert.equal(row.status, 'Đủ');
});

test('orders export and import preserve the three factory groups and never add a BTP sheet', async () => {
  const data = baseData();
  data.orders.push({ orderNo: 'PO-02', model: 'NVQ90', color: 'LC2', colorName: 'Nâu', plannedQty: 50, plant: 'HOA_MAU', progress: {}, status: 'Chờ sản xuất' });
  data.orders.push({ orderNo: 'PO-03', model: 'NVQ91', color: 'LC3', colorName: '', plannedQty: 40, plant: 'LVF', progress: {}, status: 'Chờ sản xuất' });
  const { bytes, imported } = await roundTrip('orders', data);
  const { default: ExcelJS } = await import('exceljs');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Buffer.from(bytes));
  assert.deepEqual(workbook.worksheets.map((sheet) => sheet.name), ['ADIDAS', 'LƯU HÓA', 'LVF']);
  assert.equal(imported.orders.length, 3);
  assert.equal(imported.orders.find((row) => row.orderNo === 'PO-02').plant, 'HOA_MAU');
  const ignoredSheet = workbook.addWorksheet('BTP');
  ['Mã đơn hàng', 'Mã hàng', 'Mã màu', 'Tên màu', 'Số lượng kế hoạch', 'Nhà máy'].forEach((label, index) => { ignoredSheet.getCell(3, index + 1).value = label; });
  ignoredSheet.addRow([]); ignoredSheet.addRow(['PO-BTP', 'NO-IMPORT', 'NO-IMPORT', '', 999, 'LAF']);
  const mixedFile = asFile(await workbook.xlsx.writeBuffer(), 'orders_with_btp.xlsx');
  const mixedImport = await importTaskWorkbook('orders', mixedFile);
  assert.equal(mixedImport.orders.length, 3);
  assert.equal(mixedImport.orders.some((row) => row.orderNo === 'PO-BTP'), false);
});

test('WIP input is a separate task and round-trips by order and factory', async () => {
  const { imported } = await roundTrip('wip');
  assert.equal(imported.wip.length, 3);
  assert.equal(imported.wip.find((row) => row.plant === 'LAF').wipQty, 5);
  assert.equal(imported.wip.find((row) => row.plant === 'LVF').wipQty, 2);
  const merged = mergeWipProgress(baseData().orders, imported.wip);
  assert.equal(merged.matched, 3);
  assert.equal(merged.orders[0].progress.HOA_MAU, 0);
  assert.equal(merged.orders[0].progress.LAF, 5);
  assert.equal(merged.orders[0].progress.LVF, 2);
});

test('material, normalized BOM, and BTP-size tasks round-trip their own columns', async () => {
  const materials = await roundTrip('materials');
  assert.equal(materials.imported.materials.length, 1);
  assert.deepEqual(materials.imported.materials[0].plants, ['LAF', 'LVF']);

  const bom = await roundTrip('bom');
  assert.equal(bom.imported.bom.length, 1);
  assert.equal(bom.imported.bom[0].productKey, 'NVQ89_LC1783');
  assert.equal(bom.imported.bom[0].rate, 0.2);

  const norms = await roundTrip('norms');
  assert.equal(norms.imported.norms.length, 1);
  assert.equal(norms.imported.norms[0].size, '7');
  assert.equal(norms.imported.norms[0].plannedQty, 20);
});

test('BOM import accepts a wide source matrix with more than five mã hàng-màu columns', async () => {
  const { default: ExcelJS } = await import('exceljs');
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('1_Danh_Muc_Va_Ma_Tran_BOM');
  const headers = ['STT danh mục', 'Khu vực nhà máy', 'Mã vật tư', 'Tên vật tư', 'Mã màu - Tên màu VT', 'ĐVT ERP', 'ĐVT cấp phát', 'Quy cách 1 kiện', 'Vỏ bì 1 kiện'];
  headers.forEach((value, index) => { sheet.getCell(5, index + 1).value = value; });
  sheet.getCell(6, 1).value = 86;
  sheet.getCell(6, 3).value = '9910';
  sheet.getCell(6, 4).value = 'GIẤY ROKI';
  for (let index = 0; index < 9; index += 1) {
    const col = 10 + index;
    sheet.getCell(5, col).value = 'NVQ' + (80 + index) + '_LC' + (1780 + index);
    sheet.getCell(6, col).value = 0.1 + index / 100;
  }
  const bytes = await workbook.xlsx.writeBuffer();
  const imported = await importTaskWorkbook('bom', asFile(bytes, 'matrix.xlsx'));
  assert.equal(imported.bom.length, 9);
  assert.equal(imported.bom[8].rate, 0.18);
});

test('inventory exports only source fields and imports the selected factory records', async () => {
  const { bytes, imported } = await roundTrip('inventory:LAF');
  assert.equal(Object.keys(imported.inventory).length, 1);
  assert.equal(imported.inventory[inventoryKey('LAF', 12)].received, 10);
  assert.equal(imported.inventory[inventoryKey('LAF', 12)].actual, 9);

  const { default: ExcelJS } = await import('exceljs');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Buffer.from(bytes));
  const values = [];
  workbook.worksheets[0].eachRow((row) => row.eachCell((cell) => values.push(cell.value)));
  assert.equal(values.some((value) => value && typeof value === 'object' && value.formula), false);
});

test('every exported task workbook contains values only and provides a blank template row', async () => {
  const { default: ExcelJS } = await import('exceljs');
  for (const taskId of ['orders', 'production-orders', 'order-mapping', 'product-mapping', 'chemical-norms:HOA_MAU_LAF', 'chemical-norms:HOA_MAU_LVF', 'requirements:HOA_MAU_LAF', 'requirements:HOA_MAU_LVF', 'requirements:LAF', 'requirements:LVF', 'wip', 'materials', 'bom', 'inventory:HOA_MAU', 'inventory:LAF', 'inventory:LVF', 'norms']) {
    const bytes = await createTaskWorkbook(taskId, baseData());
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(Buffer.from(bytes));
    let formulaCount = 0;
    for (const sheet of workbook.worksheets) sheet.eachRow((row) => row.eachCell((cell) => {
      if (cell.value && typeof cell.value === 'object' && cell.value.formula) formulaCount += 1;
    }));
    assert.equal(formulaCount, 0, taskId + ' export must not contain Excel formulas');
  }
  const blank = new ExcelJS.Workbook();
  await blank.xlsx.load(Buffer.from(await createTaskWorkbook('bom', { materials: [], bom: [], orders: [], inventory: {}, norms: [] })));
  assert.equal(blank.getWorksheet('Dinh_Muc_BOM').getCell(6, 1).value, null);
  const inventoryTemplate = new ExcelJS.Workbook();
  await inventoryTemplate.xlsx.load(Buffer.from(await createTaskWorkbook('inventory:LAF', { ...baseData(), inventory: {} })));
  assert.equal(inventoryTemplate.getWorksheet('Kho_LAF').getCell(17, 5).value, '');
  assert.equal(inventoryTemplate.getWorksheet('Kho_LAF').getCell(17, 6).value, '');
});
