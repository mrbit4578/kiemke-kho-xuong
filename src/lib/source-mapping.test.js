import test from 'node:test';
import assert from 'node:assert/strict';
import { getTheoreticalRequirements, resolveOrderCommand, summarizeTheoreticalRequirements } from './model.js';
import { importTaskWorkbook } from './task-workbooks.js';

function asFile(bytes, name = 'source.xlsx') {
  const buffer = Buffer.from(bytes);
  return { name, arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) };
}

test('TIEN-DO-SX-DONHANG source maps production order, released quantity, and each stage separately', async () => {
  const { default: ExcelJS } = await import('exceljs');
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('New');
  sheet.addRow(['Số SO#/WI#', 'Số PO', 'Chỉ lệnh ĐH', 'Khách hàng', 'Mã hàng', 'Màu', 'SL đơn hàng', 'Số lượng lệnh sản xuất', 'Chặt', 'May', 'Gò', 'Nhập kho', 'Đóng thùng', 'Giao hàng', 'Ngày giao hàng', 'Trạng thái']);
  sheet.addRow(['SO1', 'PO1', 'LSX1', 'Khách A', 'M1', 'BLACK', 600, 400, 300, 250, 100, 30, 20, 10, '2026/12/01', 'Approved']);
  const imported = await importTaskWorkbook('production-orders', asFile(await workbook.xlsx.writeBuffer()));
  assert.equal(imported.productionOrders.length, 1);
  assert.equal(imported.productionOrders[0].orderNo, 'LSX1');
  assert.equal(imported.productionOrders[0].purchaseOrder, 'PO1');
  assert.equal(imported.productionOrders[0].plannedQty, 600);
  assert.equal(imported.productionOrders[0].productionQty, 400);
  assert.deepEqual(imported.productionOrders[0].stageQuantities, { LAF_CUT: 300, LVF_SEW: 250, LVF_GO: 100, RECEIVED: 30, PACKED: 20, SHIPPED: 10 });
  assert.equal(imported.productionOrders[0].plant, '');
});

test('progress import preserves rows with PO/SO and product keys when the command column is blank', async () => {
  const { default: ExcelJS } = await import('exceljs');
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('New');
  sheet.addRow(['Số SO#/WI#', 'Số PO', 'Chỉ lệnh ĐH', 'Khách hàng', 'Mã hàng', 'Màu', 'Mã sản phẩm', 'SL đơn hàng', 'Số lượng lệnh sản xuất']);
  sheet.addRow(['SO-01', 'JLO_01', '', 'Jileon', 'EXTRA WIDE CALF RAIN BOOTS', 'RASPBERRY', 'SKU-01', 600, 600]);
  const imported = await importTaskWorkbook('production-orders', asFile(await workbook.xlsx.writeBuffer()));
  assert.equal(imported.productionOrders.length, 1);
  assert.equal(imported.productionOrders[0].orderNo, '');
  assert.equal(imported.productionOrders[0].purchaseOrder, 'JLO_01');
  assert.equal(imported.productionOrders[0].salesOrder, 'SO-01');
});

test('the order mapping task imports a reviewed source-to-command crosswalk', async () => {
  const { default: ExcelJS } = await import('exceljs');
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Mapping_Chi_Lenh');
  sheet.addRow(['Số SO/WI nguồn', 'Số PO nguồn', 'Chỉ lệnh nguồn', 'Mã hàng nguồn', 'Màu nguồn', 'Mã sản phẩm nguồn', 'Chỉ lệnh đích', 'Trạng thái gợi ý', 'Các chỉ lệnh ứng viên', 'Ghi chú']);
  sheet.addRow(['SO-01', 'JLO_01', '', 'EXTRA WIDE CALF RAIN BOOTS', 'RASPBERRY', 'SKU-01', 'jileo2607-0004', 'Rà soát tay', '', 'Đối chiếu DM-NPL-DH']);
  const imported = await importTaskWorkbook('order-mapping', asFile(await workbook.xlsx.writeBuffer(), 'mapping-chi-lenh.xlsx'));
  assert.equal(imported.orderMappings.length, 1);
  assert.equal(imported.orderMappings[0].sourcePurchaseOrder, 'JLO_01');
  assert.equal(imported.orderMappings[0].targetOrderNo, 'jileo2607-0004');
});

test('DM-NPL-DH maps chemical quantities to the selected Hóa mẫu warehouse and scales by released quantity', async () => {
  const { default: ExcelJS } = await import('exceljs');
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('DM-NPL-DH');
  sheet.addRow(['Số PO', 'Dòng sản phẩm', 'Mã hàng', 'Mã màu', 'Màu', 'Chỉ lệnh ĐH', 'SL đơn hàng', 'Loại', 'Tên công thức', 'Tổng trọng lượng', 'Nhóm vừa', 'Mã vật tư', 'Tên vật tư', 'Đơn vị', 'Đặc điểm kỹ thuật', 'Trọng lượng', 'TL công thức', 'Số lượng hóa chất']);
  sheet.addRow(['PO1', 'M1', 'M1', 'BLK', 'BLACK', 'LSX1', 200, 'Đế', 'CTCS ĐẾ', 80, 'CAO SU', '003370', 'CAO SU 3L', 'KÍ', '', 0.3, 25, 40]);
  const imported = await importTaskWorkbook('chemical-norms:HOA_MAU_LAF', asFile(await workbook.xlsx.writeBuffer(), 'dm-laf.xlsx'));
  assert.equal(imported.chemicalNorms.length, 1);
  assert.equal(imported.chemicalNorms[0].materialCode, '003370');
  assert.equal(imported.chemicalNorms[0].sourceQuantity, 40);
  assert.equal(imported.chemicalNorms[0].warehouseId, 'HOA_MAU_LAF');

  const data = {
    productionOrders: [{ orderNo: 'LSX1', purchaseOrder: 'PO1', model: 'M1', color: 'BLACK', plannedQty: 600, productionQty: 100, batchId: 'orders-v1' }],
    chemicalNorms: [{ ...imported.chemicalNorms[0], batchId: 'norms-v1' }],
    importMeta: {
      'production-orders': { batchId: 'orders-v1' },
      'chemical-norms:HOA_MAU_LAF': { batchId: 'norms-v1' },
    },
    materials: [],
    bom: [],
  };
  const laf = getTheoreticalRequirements(data, 'HOA_MAU_LAF');
  assert.equal(laf.rows.length, 1);
  assert.equal(laf.rows[0].rate, 0.2);
  assert.equal(laf.rows[0].quantity, 20);
  assert.equal(getTheoreticalRequirements(data, 'HOA_MAU_LVF').rows.length, 0);
  assert.equal(summarizeTheoreticalRequirements(laf.rows)[0].quantity, 20);
});

test('a unique PO + model + color match resolves a blank command to the chemical command and calculates demand', () => {
  const order = { orderNo: '', purchaseOrder: 'JLO_01', salesOrder: 'SO-01', model: 'EXTRA WIDE CALF RAIN BOOTS', color: 'RASPBERRY', productionQty: 600, batchId: 'orders-v1' };
  const norm = { warehouseId: 'HOA_MAU_LAF', purchaseOrder: 'JLO_01', productionOrder: 'jileo2607-0004', model: 'EXTRA WIDE CALF RAIN BOOTS', color: 'RASPBERRY', sourceOrderQty: 600, sourceQuantity: 60, materialCode: '003370', materialName: 'BỘT KÉM OXIT', unit: 'KG', batchId: 'norms-v1' };
  const data = {
    productionOrders: [order],
    chemicalNorms: [norm],
    orderMappings: [],
    importMeta: { 'production-orders': { batchId: 'orders-v1' }, 'chemical-norms:HOA_MAU_LAF': { batchId: 'norms-v1' } },
    materials: [],
    bom: [],
  };
  assert.deepEqual(resolveOrderCommand(order, [norm], []), { orderNo: 'jileo2607-0004', resolution: 'automatic', candidates: ['jileo2607-0004'] });
  const result = getTheoreticalRequirements(data, 'HOA_MAU_LAF');
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].orderNo, 'jileo2607-0004');
  assert.equal(result.rows[0].quantity, 60);
});

test('multiple chemical commands for the same PO, model, and color stay unmapped until a manual crosswalk is entered', () => {
  const order = { orderNo: '', purchaseOrder: 'PO-2', model: 'M-2', color: 'RED', productionQty: 100, batchId: 'orders-v1' };
  const chemicalNorms = ['CMD-1', 'CMD-2'].map((productionOrder) => ({ warehouseId: 'HOA_MAU_LAF', purchaseOrder: 'PO-2', productionOrder, model: 'M-2', color: 'RED', sourceOrderQty: 100, sourceQuantity: 20, materialCode: productionOrder, batchId: 'norms-v1' }));
  const base = {
    productionOrders: [order],
    chemicalNorms,
    importMeta: { 'production-orders': { batchId: 'orders-v1' }, 'chemical-norms:HOA_MAU_LAF': { batchId: 'norms-v1' } },
    materials: [],
    bom: [],
  };
  const unresolved = getTheoreticalRequirements(base, 'HOA_MAU_LAF');
  assert.equal(unresolved.rows.length, 0);
  assert.equal(unresolved.unmapped.length, 2);
  assert.match(unresolved.unmapped[0].reason, /nhiều chỉ lệnh/);

  const mapped = getTheoreticalRequirements({
    ...base,
    orderMappings: [{ sourcePurchaseOrder: 'PO-2', sourceModel: 'M-2', sourceColor: 'RED', targetOrderNo: 'CMD-1' }],
  }, 'HOA_MAU_LAF');
  assert.equal(mapped.rows.length, 1);
  assert.equal(mapped.rows[0].orderNo, 'CMD-1');
  assert.equal(mapped.rows[0].quantity, 20);
});

test('direct factory BOM routes by explicit plant and uses mapped operation quantity when supplied', () => {
  const data = {
    productionOrders: [{ orderNo: 'LSX2', model: 'M2', color: 'RED', plannedQty: 500, productionQty: 400, plant: 'LAF', stageQuantities: { LAF_CUT: 120 }, batchId: 'orders-v1' }],
    importMeta: { 'production-orders': { batchId: 'orders-v1' } },
    chemicalNorms: [],
    materials: [{ catalogNo: 9, materialCode: 'MAT9', name: 'Vải', unit: 'm', plants: ['LAF'] }],
    bom: [{ catalogNo: 9, model: 'M2', color: 'RED', productKey: 'M2_RED', rate: 0.5, plant: 'LAF', operation: 'Chặt' }],
  };
  const rows = getTheoreticalRequirements(data, 'LAF').rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].basisQty, 280);
  assert.equal(rows[0].quantity, 140);
  assert.equal(getTheoreticalRequirements(data, 'LVF').rows.length, 0);
});

test('the chemical source color code links named order colors to the coded factory BOM key', () => {
  const data = {
    productionOrders: [{ orderNo: 'LSX-COLOR', model: 'NVQ89', color: 'BLACK/WHITE', plannedQty: 200, productionQty: 100, plant: 'LAF', batchId: 'orders-v1' }],
    chemicalNorms: [{ warehouseId: 'HOA_MAU_LAF', productionOrder: 'LSX-COLOR', model: 'NVQ89', color: 'BLACK/WHITE', colorCode: 'LC1783', materialCode: 'CHEM1', sourceOrderQty: 200, sourceQuantity: 10, batchId: 'norms-v1' }],
    importMeta: { 'production-orders': { batchId: 'orders-v1' }, 'chemical-norms:HOA_MAU_LAF': { batchId: 'norms-v1' } },
    materials: [{ catalogNo: 21, materialCode: 'DIRECT21', name: 'Vật tư trực tiếp', unit: 'm', plants: ['LAF'] }],
    bom: [{ catalogNo: 21, model: 'NVQ89', color: 'LC1783', productKey: 'NVQ89_LC1783', rate: 0.3, plant: 'LAF' }],
  };
  const rows = getTheoreticalRequirements(data, 'LAF').rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].materialCode, 'DIRECT21');
  assert.equal(rows[0].quantity, 30);
});

test('a standalone model-color mapping can cover orders without a chemical color code', async () => {
  const { default: ExcelJS } = await import('exceljs');
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Mapping_Ma_Hang_Mau');
  sheet.addRow(['Mã sản phẩm nguồn', 'Mã hàng nguồn', 'Tên màu nguồn', 'Mã hàng BOM', 'Mã màu BOM', 'Ghi chú']);
  sheet.addRow(['SKU-1', 'MODEL-NAME', 'FULL COLOR NAME', 'MODEL-BOM', 'COLOR-CODE', 'Mapping ERP']);
  const imported = await importTaskWorkbook('product-mapping', asFile(await workbook.xlsx.writeBuffer(), 'mapping.xlsx'));
  assert.equal(imported.productMappings.length, 1);
  assert.equal(imported.productMappings[0].bomColor, 'COLOR-CODE');
  const data = {
    productionOrders: [{ orderNo: 'LSX-MAP', productCode: 'SKU-1', model: 'MODEL-NAME', color: 'FULL COLOR NAME', plannedQty: 120, productionQty: 100, plant: 'LAF', batchId: 'orders-v1' }],
    productMappings: imported.productMappings,
    importMeta: { 'production-orders': { batchId: 'orders-v1' } },
    chemicalNorms: [],
    materials: [{ catalogNo: 25, materialCode: 'MAT25', name: 'Vật tư', unit: 'cái', plants: ['LAF'] }],
    bom: [{ catalogNo: 25, model: 'MODEL-BOM', color: 'COLOR-CODE', productKey: 'MODEL-BOM_COLOR-CODE', rate: 0.4, plant: 'LAF' }],
  };
  const rows = getTheoreticalRequirements(data, 'LAF').rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].quantity, 40);
});

test('manual product mapping takes precedence over an inferred color and the source color key', () => {
  const data = {
    productionOrders: [{ orderNo: 'LSX-OVERRIDE', productCode: 'SKU-X', model: 'MODEL-X', color: 'FULL COLOR', plannedQty: 100, productionQty: 100, plant: 'LAF', batchId: 'orders-v1' }],
    productMappings: [
      { sourceModel: 'MODEL-X', sourceColor: 'FULL COLOR', bomModel: 'MODEL-X', bomColor: 'INFERRED', sourceType: 'derived' },
      { sourceModel: 'MODEL-X', sourceColor: 'FULL COLOR', bomModel: 'MODEL-X', bomColor: 'APPROVED', sourceType: 'manual' },
    ],
    importMeta: { 'production-orders': { batchId: 'orders-v1' } },
    chemicalNorms: [],
    materials: [
      { catalogNo: 31, materialCode: 'RAW', name: 'Khóa nguồn', unit: 'm', plants: ['LAF'] },
      { catalogNo: 32, materialCode: 'INFERRED', name: 'Màu suy ra', unit: 'm', plants: ['LAF'] },
      { catalogNo: 33, materialCode: 'APPROVED', name: 'Màu đã xác nhận', unit: 'm', plants: ['LAF'] },
    ],
    bom: [
      { catalogNo: 31, model: 'MODEL-X', color: 'FULL COLOR', productKey: 'MODEL-X_FULL COLOR', rate: 1, plant: 'LAF' },
      { catalogNo: 32, model: 'MODEL-X', color: 'INFERRED', productKey: 'MODEL-X_INFERRED', rate: 2, plant: 'LAF' },
      { catalogNo: 33, model: 'MODEL-X', color: 'APPROVED', productKey: 'MODEL-X_APPROVED', rate: 3, plant: 'LAF' },
    ],
  };
  const rows = getTheoreticalRequirements(data, 'LAF').rows;
  assert.deepEqual(rows.map((row) => row.materialCode), ['APPROVED']);
  assert.equal(rows[0].quantity, 300);
});

test('BOM import keeps separate material lines for different warehouse operations', async () => {
  const { default: ExcelJS } = await import('exceljs');
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Dinh_Muc_BOM');
  sheet.addRow(['STT danh mục', 'Mã vật tư', 'Tên vật tư', 'Mã hàng', 'Mã màu', 'Nhà máy', 'Định mức / đôi', 'Kho nhận', 'Công đoạn sử dụng', 'Luồng cấp phát']);
  sheet.addRow([12, 'MAT-12', 'Vải', 'M1', 'BLUE', 'LAF', 0.1, 'LAF', 'Chặt', 'Trực tiếp']);
  sheet.addRow([12, 'MAT-12', 'Vải', 'M1', 'BLUE', 'LAF', 0.2, 'LAF', 'May', 'Trực tiếp']);
  const imported = await importTaskWorkbook('bom', asFile(await workbook.xlsx.writeBuffer(), 'bom.xlsx'));
  assert.equal(imported.bom.length, 2);
  assert.deepEqual(imported.bom.map((row) => row.operation).sort(), ['Chặt', 'May']);
});

test('a shared material without a selected warehouse is flagged instead of duplicated', () => {
  const data = {
    productionOrders: [{ orderNo: 'LSX3', model: 'M3', color: 'BLUE', plannedQty: 100, productionQty: 100, batchId: 'orders-v1' }],
    importMeta: { 'production-orders': { batchId: 'orders-v1' } },
    chemicalNorms: [],
    materials: [{ catalogNo: 11, materialCode: 'SHARED11', name: 'Vật tư dùng chung', unit: 'kg', plants: ['LAF', 'LVF'] }],
    bom: [{ catalogNo: 11, model: 'M3', color: 'BLUE', productKey: 'M3_BLUE', rate: 1, plant: null }],
  };
  const result = getTheoreticalRequirements(data, 'LAF');
  assert.equal(result.rows.length, 0);
  assert.equal(result.unmapped.length, 1);
  assert.match(result.unmapped[0].reason, /nhiều nhà máy/);
});
