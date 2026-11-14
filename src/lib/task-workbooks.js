import { getInventoryRows, getPlantName, getTheoreticalRequirements, inventoryKey, orderKey, orderMappingKey, productKey, resolveOrderCommand, WAREHOUSES } from './model.js';

const PLANT_SHEETS = {
  HOA_MAU: ['2_Kho_Hoa_Mau', 'Kho_Hoa_Mau', 'Hoa_Mau'],
  LAF: ['3_Kho_Xuong_LAF', 'Kho_LAF', 'LAF'],
  LVF: ['4_Kho_Xuong_LVF', 'Kho_LVF', 'LVF'],
};

const INVENTORY_TASK_PREFIX = 'inventory:';

const text = (value) => {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') {
    if (Array.isArray(value.richText)) return value.richText.map((part) => part.text).join('').trim();
    if (value.result !== undefined) return text(value.result);
    if (value.text !== undefined) return String(value.text).trim();
    if (value.hyperlink) return String(value.hyperlink).trim();
  }
  return String(value).trim();
};

const normalize = (value) => text(value)
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .replace(/[đĐ]/g, 'D')
  .replace(/\s+/g, ' ')
  .trim()
  .toUpperCase();

const compact = (value) => normalize(value).replace(/[^A-Z0-9]/g, '');

function number(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const raw = text(value).replace(/\s/g, '');
  if (!raw) return 0;
  const vietnamese = raw.replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.');
  const parsed = Number(vietnamese);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parsePlantIds(value) {
  const source = normalize(value);
  const result = [];
  if (source.includes('HOA MAU') || source.includes('HOAMAU')) result.push('HOA_MAU');
  if (source.includes('LAF')) result.push('LAF');
  if (source.includes('LVF')) result.push('LVF');
  return [...new Set(result)];
}

function worksheet(workbook, names) {
  const aliases = (Array.isArray(names) ? names : [names]).map(compact);
  return workbook.worksheets.find((sheet) => aliases.includes(compact(sheet.name)));
}

function rowValues(sheet, rowNumber) {
  const values = new Map();
  sheet.getRow(rowNumber).eachCell({ includeEmpty: false }, (cell, col) => {
    const label = compact(cell.value);
    if (label) values.set(col, label);
  });
  return values;
}

function findHeader(sheet, groups, maxRows = 40) {
  for (let row = 1; row <= Math.min(sheet.rowCount, maxRows); row += 1) {
    const columns = rowValues(sheet, row);
    const labels = [...columns.values()];
    if (groups.every((group) => group.some((alias) => {
      const wanted = compact(alias);
      return labels.some((label) => label === wanted || label.includes(wanted));
    }))) return { row, columns };
  }
  return null;
}

function findColumn(columns, aliases) {
  const candidates = aliases.map(compact);
  for (const candidate of candidates) {
    for (const [col, label] of columns) if (label === candidate) return col;
  }
  for (const candidate of candidates) {
    for (const [col, label] of columns) if (label.includes(candidate)) return col;
  }
  return null;
}

function findStageColumns(columns, stageName) {
  const prefix = compact(stageName);
  return [...columns]
    .filter(([, label]) => label.startsWith(prefix))
    .map(([col]) => col);
}

function findExactColumn(columns, aliases) {
  const candidates = aliases.map(compact);
  for (const candidate of candidates) {
    for (const [col, label] of columns) if (label === candidate) return col;
  }
  return null;
}

function cellText(sheet, row, col) {
  if (!col) return '';
  const cell = sheet.getCell(row, col);
  return typeof cell.value === 'number' && cell.text ? String(cell.text).trim() : text(cell.value);
}

function cellNumber(sheet, row, col) {
  return col ? number(sheet.getCell(row, col).value) : 0;
}

function cellNumberOrNull(sheet, row, col) {
  if (!col) return null;
  const value = sheet.getCell(row, col).value;
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'object' && value.result === undefined) return null;
  return number(value);
}

function getModelColor(value) {
  const key = text(value);
  const divider = key.lastIndexOf('_');
  if (divider <= 0) return { model: key, color: '' };
  return { model: key.slice(0, divider), color: key.slice(divider + 1) };
}

function currentImportedRows(rows, importMeta, taskId) {
  const batchId = importMeta?.[taskId]?.batchId;
  return batchId ? (rows || []).filter((row) => row.batchId === batchId) : (rows || []);
}

function parseWarehouseId(value) {
  const label = compact(value);
  if (!label) return '';
  if (label.includes('HOAMAU') && label.includes('LAF')) return 'HOA_MAU_LAF';
  if (label.includes('HOAMAU') && label.includes('LVF')) return 'HOA_MAU_LVF';
  if (label.includes('LAF')) return 'LAF';
  if (label.includes('LVF')) return 'LVF';
  return WAREHOUSES.some((item) => item.id === label) ? label : '';
}

function uniqueBy(rows, keyOf) {
  const map = new Map();
  for (const row of rows) map.set(keyOf(row), row);
  return [...map.values()];
}

function readMaterials(workbook) {
  const sheet = worksheet(workbook, ['1_Danh_Muc_Va_Ma_Tran_BOM', 'DanhMuc_VatTu', 'DM_Vat_Tu']);
  if (!sheet) throw new Error('Không thấy sheet danh mục vật tư theo cấu trúc workbook.');
  const header = findHeader(sheet, [['Mã vật tư'], ['Tên vật tư']]);
  if (!header) throw new Error('Sheet danh mục cần có cột Mã vật tư và Tên vật tư.');
  const col = {
    catalogNo: findColumn(header.columns, ['STT danh mục', 'STT vật tư LAF', 'STT']),
    code: findColumn(header.columns, ['Mã vật tư']),
    name: findColumn(header.columns, ['Tên vật tư', 'Tên vật tư / hóa chất']),
    plants: findColumn(header.columns, ['Khu vực nhà máy', 'Khu vực', 'Nhà máy sử dụng']),
    colorScope: findColumn(header.columns, ['Mã màu - tên màu VT', 'Mã màu tên màu vật tư', 'Phạm vi mã màu', 'Phạm vi']),
    unit: findColumn(header.columns, ['ĐVT ERP', 'ĐVT']),
    issueUnit: findColumn(header.columns, ['ĐVT cấp phát', 'ĐVT kiện', 'Kho phát']),
    packQty: findColumn(header.columns, ['Quy cách 1 kiện', 'Quy cách / kiện', 'Quy cách 1']),
    packagingWeight: findColumn(header.columns, ['Vỏ bị 1 kiện', 'Vỏ bì 1 kiện', 'Khối lượng vỏ']),
  };
  const materials = [];
  for (let row = header.row + 1; row <= sheet.rowCount; row += 1) {
    const code = cellText(sheet, row, col.code);
    const name = cellText(sheet, row, col.name);
    const catalogNo = cellNumber(sheet, row, col.catalogNo);
    if (!code || !name || !catalogNo) continue;
    const plants = parsePlantIds(cellText(sheet, row, col.plants));
    if (!plants.length) continue;
    materials.push({
      catalogNo,
      materialCode: code,
      name,
      colorScope: cellText(sheet, row, col.colorScope),
      unit: cellText(sheet, row, col.unit),
      issueUnit: cellText(sheet, row, col.issueUnit),
      packQty: cellNumber(sheet, row, col.packQty),
      packagingWeight: cellNumber(sheet, row, col.packagingWeight),
      plants,
    });
  }
  if (!materials.length) throw new Error('Không tìm thấy dòng vật tư hợp lệ trong sheet danh mục.');
  return uniqueBy(materials, (item) => String(item.catalogNo));
}

function readBom(workbook) {
  const sheet = worksheet(workbook, ['Dinh_Muc_BOM', 'MaTran_BOM', '1_Danh_Muc_Va_Ma_Tran_BOM']);
  if (!sheet) throw new Error('Không thấy sheet ma trận BOM.');
  const normalizedHeader = findHeader(sheet, [['Mã vật tư', 'STT danh mục'], ['Mã hàng'], ['Mã màu'], ['Định mức']]);
  if (normalizedHeader) {
    const col = {
      catalogNo: findColumn(normalizedHeader.columns, ['STT danh mục', 'Mã vật tư']),
      model: findExactColumn(normalizedHeader.columns, ['Mã hàng', 'Model']),
      color: findExactColumn(normalizedHeader.columns, ['Mã màu', 'Màu sắc']),
      productKey: findColumn(normalizedHeader.columns, ['Mã hàng - màu', 'Mã ghép']),
      rate: findColumn(normalizedHeader.columns, ['Định mức / đôi', 'Định mức', 'Định mức tiêu hao']),
      plant: findColumn(normalizedHeader.columns, ['Nhà máy', 'Khu vực nhà máy']),
      warehouse: findColumn(normalizedHeader.columns, ['Kho nhận', 'Kho mục tiêu', 'Đơn vị nhận']),
      operation: findColumn(normalizedHeader.columns, ['Công đoạn sử dụng', 'Công đoạn']),
      supplyRoute: findColumn(normalizedHeader.columns, ['Luồng cấp phát', 'Nguồn cấp phát']),
    };
    const bom = [];
    for (let row = normalizedHeader.row + 1; row <= sheet.rowCount; row += 1) {
      const catalogNo = cellNumber(sheet, row, col.catalogNo);
      const pair = col.productKey ? getModelColor(cellText(sheet, row, col.productKey)) : {};
      const model = cellText(sheet, row, col.model) || pair.model || '';
      const color = cellText(sheet, row, col.color) || pair.color || '';
      const rate = cellNumber(sheet, row, col.rate);
      if (!catalogNo || !model || !color || rate <= 0) continue;
      const plants = parsePlantIds(cellText(sheet, row, col.plant));
      bom.push({
        catalogNo,
        model,
        color,
        productKey: productKey(model, color),
        rate,
        plant: plants.length === 1 ? plants[0] : null,
        warehouseId: parseWarehouseId(cellText(sheet, row, col.warehouse)),
        operation: cellText(sheet, row, col.operation),
        supplyRoute: cellText(sheet, row, col.supplyRoute),
      });
    }
    if (bom.length) return uniqueBy(bom, (line) => [line.catalogNo, line.plant || 'ALL', line.warehouseId || '', line.productKey, line.operation || '', line.supplyRoute || '', line.size || '', line.process || ''].join('|'));
  }

  const matrixHeader = findHeader(sheet, [['Mã vật tư'], ['Tên vật tư']]);
  if (!matrixHeader) throw new Error('Sheet BOM cần có cột Mã vật tư và mã ghép hàng-màu.');
  const colCatalog = findColumn(matrixHeader.columns, ['STT danh mục', 'STT']);
  const colPlant = findColumn(matrixHeader.columns, ['Khu vực nhà máy', 'Khu vực', 'Nhà máy sử dụng']);
  const modelColumns = [...matrixHeader.columns.entries()]
    .map(([col]) => ({ col, key: text(sheet.getCell(matrixHeader.row, col).value) }))
    .filter((entry) => entry.key.includes('_'));
  if (!modelColumns.length) throw new Error('Không có cột mã hàng-màu trong ma trận BOM.');
  const bom = [];
  for (let row = matrixHeader.row + 1; row <= sheet.rowCount; row += 1) {
    const catalogNo = cellNumber(sheet, row, colCatalog);
    if (!catalogNo) continue;
    const plants = parsePlantIds(cellText(sheet, row, colPlant)).filter((plant) => plant === 'LAF' || plant === 'LVF');
    for (const entry of modelColumns) {
      const rate = cellNumber(sheet, row, entry.col);
      if (rate <= 0) continue;
      const pair = getModelColor(entry.key);
      if (!pair.model || !pair.color) continue;
      bom.push({ catalogNo, model: pair.model, color: pair.color, productKey: productKey(pair.model, pair.color), rate, plant: plants.length === 1 ? plants[0] : null, warehouseId: '', operation: '', supplyRoute: '' });
    }
  }
  if (!bom.length) throw new Error('Không tìm thấy định mức BOM khác 0 trong workbook.');
  return uniqueBy(bom, (line) => [line.catalogNo, line.plant || 'ALL', line.warehouseId || '', line.productKey, line.operation || '', line.supplyRoute || '', line.size || '', line.process || ''].join('|'));
}

function readInventory(workbook, plantId) {
  const names = PLANT_SHEETS[plantId];
  const sheet = worksheet(workbook, names);
  if (!sheet) throw new Error('File không có sheet kiểm kê ' + getPlantName(plantId) + '.');
  const header = findHeader(sheet, [['STT danh mục', 'STT', 'Mã vật tư'], ['Lĩnh về', 'Kiểm kê thực tế']]);
  if (!header) throw new Error('Sheet kiểm kê cần có mã vật tư, cột Lĩnh về và/hoặc Kiểm kê thực tế.');
  const col = {
    catalogNo: findColumn(header.columns, ['STT danh mục', 'STT']),
    materialCode: findColumn(header.columns, ['Mã vật tư']),
    received: findColumn(header.columns, ['Lĩnh về']),
    actual: findColumn(header.columns, ['Kiểm kê thực tế', 'Số đếm thực tế']),
  };
  if (!col.catalogNo) throw new Error('Không xác định được cột STT danh mục ở sheet kiểm kê.');
  const inventory = {};
  let count = 0;
  for (let row = header.row + 1; row <= sheet.rowCount; row += 1) {
    const catalogNo = cellNumber(sheet, row, col.catalogNo);
    if (!catalogNo) continue;
    const actualRaw = cellText(sheet, row, col.actual);
    inventory[inventoryKey(plantId, catalogNo)] = {
      catalogNo,
      plant: plantId,
      received: cellNumber(sheet, row, col.received),
      actual: actualRaw === '' ? null : cellNumber(sheet, row, col.actual),
    };
    count += 1;
  }
  if (!count) throw new Error('Không tìm thấy dòng kiểm kê có STT danh mục.');
  return inventory;
}

function readNorms(workbook) {
  const sheet = worksheet(workbook, ['DM_BTP_Size_LAF', 'DM_BTP_Size']);
  if (!sheet) throw new Error('Không thấy sheet DM_BTP_Size_LAF.');
  const header = findHeader(sheet, [['STT vật tư LAF', 'STT danh mục', 'Mã vật tư'], ['Mã hàng - màu', 'Mã ghép'], ['Size'], ['Định mức']]);
  if (!header) throw new Error('Sheet định mức size cần có mã vật tư, mã hàng-màu, size và định mức.');
  const col = {
    catalogNo: findColumn(header.columns, ['STT vật tư LAF', 'STT danh mục', 'STT']),
    materialCode: findColumn(header.columns, ['Mã vật tư']),
    materialName: findColumn(header.columns, ['Tên vật tư']),
    productKey: findColumn(header.columns, ['Mã hàng - màu', 'Mã ghép']),
    model: findExactColumn(header.columns, ['Mã hàng', 'Model']),
    color: findExactColumn(header.columns, ['Mã màu', 'Màu sắc']),
    size: findColumn(header.columns, ['Size', 'Cỡ']),
    process: findColumn(header.columns, ['Công đoạn LAF', 'Công đoạn']),
    btpCode: findColumn(header.columns, ['Mã BTP', 'Mã bán thành phẩm']),
    btpName: findColumn(header.columns, ['Tên BTP', 'Tên bán thành phẩm']),
    rate: findColumn(header.columns, ['Định mức / 1 đôi', 'Định mức / đôi', 'Định mức']),
    plannedQty: findColumn(header.columns, ['SL kế hoạch theo size', 'SL kế hoạch']),
    wipQty: findColumn(header.columns, ['SL WIP LAF theo size', 'SL WIP theo size']),
  };
  const norms = [];
  for (let row = header.row + 1; row <= sheet.rowCount; row += 1) {
    const catalogNo = cellNumber(sheet, row, col.catalogNo);
    const product = col.productKey ? getModelColor(cellText(sheet, row, col.productKey)) : {};
    const model = cellText(sheet, row, col.model) || product.model || '';
    const color = cellText(sheet, row, col.color) || product.color || '';
    const rate = cellNumber(sheet, row, col.rate);
    const size = cellText(sheet, row, col.size);
    if (!catalogNo || !model || !color || !size || rate <= 0) continue;
    norms.push({
      catalogNo,
      materialCode: cellText(sheet, row, col.materialCode),
      materialName: cellText(sheet, row, col.materialName),
      productKey: productKey(model, color),
      size,
      process: cellText(sheet, row, col.process),
      btpCode: cellText(sheet, row, col.btpCode),
      btpName: cellText(sheet, row, col.btpName),
      rate,
      plannedQty: cellNumber(sheet, row, col.plannedQty),
      wipQty: cellNumber(sheet, row, col.wipQty),
    });
  }
  if (!norms.length) throw new Error('Không tìm thấy dòng định mức theo size trong sheet.');
  return uniqueBy(norms, (line) => [line.catalogNo, line.productKey, line.size, line.process, line.btpCode].join('|'));
}

function findOrderHeader(sheet) {
  for (let row = 1; row <= Math.min(sheet.rowCount, 20); row += 1) {
    const columns = rowValues(sheet, row);
    const labels = [...columns.values()];
    const hasQty = labels.some((label) => label.includes('SOLUONG'));
    const hasColor = labels.some((label) => label.includes('MAMAU') || label.includes('MAUSAC'));
    const hasModel = labels.some((label) => ['MAHANG', 'DONHANG', 'LOTNO', 'MODEL'].includes(label));
    if (hasQty && hasColor && hasModel) return { row, columns };
  }
  return null;
}

function readOrders(workbook) {
  const allowed = new Set(['ADIDAS', 'LUUHOA', 'LVF', 'DONHANG']);
  const rows = new Map();
  for (const sheet of workbook.worksheets) {
    const sheetName = compact(sheet.name);
    if (!allowed.has(sheetName)) continue;
    const header = findOrderHeader(sheet);
    if (!header) continue;
    const col = {
      model: findColumn(header.columns, ['Mã hàng', 'Đơn hàng', 'Lót No', 'Model']),
      color: findColumn(header.columns, ['Mã màu', 'Màu sắc']),
      qty: findColumn(header.columns, ['Số lượng kế hoạch', 'Số lượng', 'SL kế hoạch']),
      order: findColumn(header.columns, ['Chỉ lệnh', 'Mã đơn hàng', 'Mã SO', 'Mã PO', 'PO#']),
      colorName: findColumn(header.columns, ['Tên màu', 'Tên mã']),
      plant: findColumn(header.columns, ['Nhà máy', 'Khu vực nhà máy']),
    };
    for (let row = header.row + 1; row <= sheet.rowCount; row += 1) {
      const model = cellText(sheet, row, col.model);
      const color = cellText(sheet, row, col.color);
      const plannedQty = cellNumber(sheet, row, col.qty);
      if (!model || !color || plannedQty <= 0) continue;
      let defaultPlant = sheetName === 'ADIDAS' ? 'LAF' : sheetName === 'LUUHOA' ? 'HOA_MAU' : sheetName === 'LVF' ? 'LVF' : '';
      const importedPlant = parsePlantIds(cellText(sheet, row, col.plant))[0];
      const item = {
        orderNo: cellText(sheet, row, col.order) || sheet.name + '-' + row,
        model,
        color,
        colorName: cellText(sheet, row, col.colorName),
        plannedQty,
        plant: importedPlant || defaultPlant || 'LAF',
        progress: { HOA_MAU: 0, LAF: 0, LVF: 0 },
        status: 'Chờ sản xuất',
        sourceSheet: sheet.name,
      };
      const key = orderKey(item);
      const previous = rows.get(key);
      rows.set(key, previous ? { ...previous, plannedQty: previous.plannedQty + plannedQty } : item);
    }
  }
  if (!rows.size) throw new Error('Không tìm thấy đơn hàng trong các sheet ADIDAS/LƯU HÓA. Sheet BTP không được đọc.');
  return [...rows.values()];
}

function readProductionOrders(workbook) {
  let selected = null;
  for (const sheet of workbook.worksheets) {
    const header = findHeader(sheet, [['Mã hàng'], ['Màu'], ['Số lượng lệnh sản xuất', 'SL lệnh sản xuất']]);
    if (header) { selected = { sheet, header }; break; }
  }
  if (!selected) throw new Error('Không tìm thấy bảng tiến độ có Mã hàng, Màu và Số lượng lệnh sản xuất.');
  const { sheet, header } = selected;
  const stageColumns = {
    LAF_CUT: findStageColumns(header.columns, 'Chặt'),
    LVF_SEW: findStageColumns(header.columns, 'May'),
    LVF_GO: findStageColumns(header.columns, 'Gò'),
  };
  const col = {
    so: findColumn(header.columns, ['Số SO#/WI#', 'Số SO', 'SO/WI']),
    purchaseOrder: findColumn(header.columns, ['Số PO', 'PO']),
    orderNo: findColumn(header.columns, ['Chỉ lệnh ĐH', 'Số chỉ lệnh', 'Chỉ lệnh', 'Mã chỉ lệnh']),
    model: findExactColumn(header.columns, ['Mã hàng']),
    color: findExactColumn(header.columns, ['Màu', 'Màu sắc']),
    productCode: findExactColumn(header.columns, ['Mã sản phẩm']),
    customer: findExactColumn(header.columns, ['Khách hàng']),
    orderQty: findColumn(header.columns, ['Số lượng đơn hàng', 'SL đơn hàng']),
    productionQty: findColumn(header.columns, ['Số lượng lệnh sản xuất', 'SL lệnh sản xuất']),
    dueDate: findExactColumn(header.columns, ['Ngày giao hàng']),
    cut: stageColumns.LAF_CUT[0],
    cutOpen: stageColumns.LAF_CUT[1],
    sew: stageColumns.LVF_SEW[0],
    sewOpen: stageColumns.LVF_SEW[1],
    assembly: stageColumns.LVF_GO[0],
    assemblyOpen: stageColumns.LVF_GO[1],
    received: findColumn(header.columns, ['Nhập kho']),
    packed: findColumn(header.columns, ['Đóng thùng']),
    shipped: findColumn(header.columns, ['Giao hàng']),
    status: findExactColumn(header.columns, ['Trạng thái']),
  };
  const orders = [];
  for (let row = header.row + 1; row <= sheet.rowCount; row += 1) {
    const orderNo = cellText(sheet, row, col.orderNo);
    const model = cellText(sheet, row, col.model);
    const color = cellText(sheet, row, col.color);
    const purchaseOrder = cellText(sheet, row, col.purchaseOrder);
    const salesOrder = cellText(sheet, row, col.so);
    const productCode = cellText(sheet, row, col.productCode);
    if ((!orderNo && !purchaseOrder && !salesOrder && !productCode) || !model || !color) continue;
    const productionQty = cellNumber(sheet, row, col.productionQty);
    const plannedQty = cellNumber(sheet, row, col.orderQty);
    const stageQuantities = {
      LAF_CUT: cellNumber(sheet, row, col.cut),
      LVF_SEW: cellNumber(sheet, row, col.sew),
      LVF_GO: cellNumber(sheet, row, col.assembly),
      RECEIVED: cellNumber(sheet, row, col.received),
      PACKED: cellNumber(sheet, row, col.packed),
      SHIPPED: cellNumber(sheet, row, col.shipped),
    };
    const stageBaseQty = plannedQty > 0 ? plannedQty : productionQty;
    const openStageQuantities = {};
    const sourceStageBalances = {};
    for (const [key, openCol] of Object.entries({ LAF_CUT: col.cutOpen, LVF_SEW: col.sewOpen, LVF_GO: col.assemblyOpen })) {
      const balance = cellNumberOrNull(sheet, row, openCol);
      sourceStageBalances[key] = balance;
      // Recalculate from the source quantity and completed output; cached Excel formula
      // results can be stale or missing for shared formulas.
      openStageQuantities[key] = Math.max(0, stageBaseQty - stageQuantities[key]);
    }
    const hasLaf = stageQuantities.LAF_CUT > 0;
    const hasLvf = stageQuantities.LVF_SEW > 0 || stageQuantities.LVF_GO > 0;
    const plant = hasLaf === hasLvf ? '' : hasLaf ? 'LAF' : 'LVF';
    orders.push({
      orderNo,
      sourceOrderNo: orderNo,
      purchaseOrder,
      salesOrder,
      customer: cellText(sheet, row, col.customer),
      model,
      color,
      productCode,
      colorName: color,
      plannedQty,
      productionQty,
      plant,
      stageQuantities,
      openStageQuantities,
      sourceStageBalances,
      progress: { HOA_MAU: 0, LAF: 0, LVF: 0 },
      dueDate: cellText(sheet, row, col.dueDate),
      status: cellText(sheet, row, col.status) || (productionQty > 0 ? 'Đang sản xuất' : 'Chờ sản xuất'),
      sourceSystem: 'TIEN-DO-SX-DONHANG',
      sourceSheet: sheet.name,
      sourceRow: row,
    });
  }
  if (!orders.length) throw new Error('Không tìm thấy dòng tiến độ có PO/SO, mã hàng và màu hợp lệ trong workbook.');
  return orders;
}

function readOrderMappings(workbook) {
  let selected = null;
  for (const sheet of workbook.worksheets) {
    const header = findHeader(sheet, [['Mã hàng nguồn'], ['Màu nguồn'], ['Chỉ lệnh đích']]);
    if (header) { selected = { sheet, header }; break; }
  }
  if (!selected) throw new Error('Bảng Mapping_Chi_Lenh cần các cột Mã hàng nguồn, Màu nguồn và Chỉ lệnh đích.');
  const { sheet, header } = selected;
  const col = {
    sourceSalesOrder: findColumn(header.columns, ['Số SO/WI nguồn', 'Số SO nguồn', 'SO/WI nguồn']),
    sourcePurchaseOrder: findColumn(header.columns, ['Số PO nguồn', 'PO nguồn']),
    sourceOrderNo: findColumn(header.columns, ['Chỉ lệnh nguồn']),
    sourceModel: findColumn(header.columns, ['Mã hàng nguồn']),
    sourceColor: findColumn(header.columns, ['Màu nguồn']),
    sourceProductCode: findColumn(header.columns, ['Mã sản phẩm nguồn']),
    targetOrderNo: findColumn(header.columns, ['Chỉ lệnh đích', 'Chỉ lệnh Hóa mẫu', 'Chỉ lệnh chuẩn']),
    note: findColumn(header.columns, ['Ghi chú']),
  };
  const rows = [];
  for (let row = header.row + 1; row <= sheet.rowCount; row += 1) {
    const mapping = {
      sourceSalesOrder: cellText(sheet, row, col.sourceSalesOrder),
      sourcePurchaseOrder: cellText(sheet, row, col.sourcePurchaseOrder),
      sourceOrderNo: cellText(sheet, row, col.sourceOrderNo),
      sourceModel: cellText(sheet, row, col.sourceModel),
      sourceColor: cellText(sheet, row, col.sourceColor),
      sourceProductCode: cellText(sheet, row, col.sourceProductCode),
      targetOrderNo: cellText(sheet, row, col.targetOrderNo),
      note: cellText(sheet, row, col.note),
      sourceRow: row,
    };
    const hasSourceKey = mapping.sourceOrderNo || mapping.sourcePurchaseOrder || mapping.sourceSalesOrder || mapping.sourceProductCode;
    if (!hasSourceKey || !mapping.sourceModel || !mapping.sourceColor || !mapping.targetOrderNo) continue;
    rows.push(mapping);
  }
  if (!rows.length) throw new Error('Chưa có mapping hợp lệ. Hãy giữ khóa PO/SO + mã hàng + màu và điền Chỉ lệnh đích.');
  const mappings = new Map();
  for (const mapping of rows) {
    const key = orderMappingKey(mapping);
    const previous = mappings.get(key);
    if (previous && normalize(previous.targetOrderNo) !== normalize(mapping.targetOrderNo)) {
      throw new Error(`Khóa nguồn ở dòng ${mapping.sourceRow} có nhiều Chỉ lệnh đích. Hãy để lại một chỉ lệnh cho mỗi khóa.`);
    }
    mappings.set(key, mapping);
  }
  return [...mappings.values()];
}

function readProductMappings(workbook) {
  let selected = null;
  for (const sheet of workbook.worksheets) {
    const header = findHeader(sheet, [['Mã hàng nguồn', 'Mã hàng tiến độ', 'Mã sản phẩm nguồn'], ['Màu nguồn', 'Màu tiến độ', 'Tên màu nguồn'], ['Mã hàng BOM', 'Mã hàng chuẩn'], ['Mã màu BOM', 'Mã màu nội bộ']]);
    if (header) { selected = { sheet, header }; break; }
  }
  if (!selected) throw new Error('Bảng mapping cần có mã hàng/màu nguồn và mã hàng/màu BOM.');
  const { sheet, header } = selected;
  const col = {
    sourceProductCode: findColumn(header.columns, ['Mã sản phẩm nguồn', 'Mã sản phẩm']),
    sourceModel: findColumn(header.columns, ['Mã hàng nguồn', 'Mã hàng tiến độ', 'Mã hàng đơn hàng']),
    sourceColor: findColumn(header.columns, ['Màu nguồn', 'Màu tiến độ', 'Tên màu nguồn', 'Màu sắc nguồn']),
    bomModel: findColumn(header.columns, ['Mã hàng BOM', 'Mã hàng chuẩn', 'Mã hàng đích']),
    bomColor: findColumn(header.columns, ['Mã màu BOM', 'Mã màu nội bộ', 'Màu BOM', 'Mã màu đích']),
    note: findColumn(header.columns, ['Ghi chú']),
  };
  const rows = [];
  for (let row = header.row + 1; row <= sheet.rowCount; row += 1) {
    const mapping = {
      sourceProductCode: cellText(sheet, row, col.sourceProductCode),
      sourceModel: cellText(sheet, row, col.sourceModel),
      sourceColor: cellText(sheet, row, col.sourceColor),
      bomModel: cellText(sheet, row, col.bomModel),
      bomColor: cellText(sheet, row, col.bomColor),
      note: cellText(sheet, row, col.note),
      sourceRow: row,
    };
    if ((!mapping.sourceProductCode && (!mapping.sourceModel || !mapping.sourceColor)) || !mapping.bomModel || !mapping.bomColor) continue;
    rows.push(mapping);
  }
  if (!rows.length) throw new Error('Không tìm thấy dòng mapping hợp lệ. Cần điền khóa nguồn và mã hàng-màu BOM.');
  return uniqueBy(rows, (item) => item.sourceProductCode || `${item.sourceModel}|${item.sourceColor}`);
}

function readChemicalNorms(workbook, warehouseId, sourceFile) {
  const sheet = worksheet(workbook, ['DM-NPL-DH']);
  if (!sheet) throw new Error('Không thấy sheet DM-NPL-DH trong file định mức Hóa mẫu.');
  const header = findHeader(sheet, [['Số PO'], ['Chỉ lệnh ĐH'], ['Mã hàng'], ['Mã vật tư'], ['Số lượng hóa chất']]);
  if (!header) throw new Error('DM-NPL-DH cần có số PO, chỉ lệnh, mã hàng, mã vật tư và số lượng hóa chất.');
  const col = {
    purchaseOrder: findExactColumn(header.columns, ['Số PO']),
    model: findExactColumn(header.columns, ['Mã hàng']),
    colorCode: findExactColumn(header.columns, ['Mã màu']),
    color: findExactColumn(header.columns, ['Màu']),
    productionOrder: findExactColumn(header.columns, ['Chỉ lệnh ĐH']),
    sourceOrderQty: findColumn(header.columns, ['SL đơn hàng', 'Số lượng đơn hàng']),
    component: findExactColumn(header.columns, ['Loại']),
    operation: findColumn(header.columns, ['Công đoạn sử dụng', 'Công đoạn', 'Công đoạn SX']),
    formulaName: findExactColumn(header.columns, ['Tên công thức']),
    batchWeight: findExactColumn(header.columns, ['Tổng trọng lượng']),
    materialGroup: findColumn(header.columns, ['Nhóm vừa', 'Nhóm vật tư']),
    materialCode: findExactColumn(header.columns, ['Mã vật tư']),
    materialName: findExactColumn(header.columns, ['Tên vật tư']),
    unit: findExactColumn(header.columns, ['Đơn vị']),
    specification: findExactColumn(header.columns, ['Đặc điểm kỹ thuật']),
    materialWeight: findExactColumn(header.columns, ['Trọng lượng']),
    ratio: findColumn(header.columns, ['TL công thức']),
    sourceQuantity: findExactColumn(header.columns, ['Số lượng hóa chất']),
  };
  const rows = [];
  for (let row = header.row + 1; row <= sheet.rowCount; row += 1) {
    const productionOrder = cellText(sheet, row, col.productionOrder);
    const materialCode = cellText(sheet, row, col.materialCode);
    if (!productionOrder || !materialCode) continue;
    rows.push({
      warehouseId,
      purchaseOrder: cellText(sheet, row, col.purchaseOrder),
      model: cellText(sheet, row, col.model),
      colorCode: cellText(sheet, row, col.colorCode),
      color: cellText(sheet, row, col.color),
      productionOrder,
      sourceOrderQty: cellNumber(sheet, row, col.sourceOrderQty),
      component: cellText(sheet, row, col.component),
      operation: cellText(sheet, row, col.operation),
      formulaName: cellText(sheet, row, col.formulaName),
      batchWeight: cellNumber(sheet, row, col.batchWeight),
      materialGroup: cellText(sheet, row, col.materialGroup),
      materialCode,
      materialName: cellText(sheet, row, col.materialName),
      unit: cellText(sheet, row, col.unit),
      specification: cellText(sheet, row, col.specification),
      materialWeight: cellNumber(sheet, row, col.materialWeight),
      ratio: cellNumber(sheet, row, col.ratio),
      sourceQuantity: cellNumber(sheet, row, col.sourceQuantity),
      sourceFile,
      sourceRow: row,
    });
  }
  if (!rows.length) throw new Error('Không tìm thấy dòng định mức hóa chất trong sheet DM-NPL-DH.');
  return rows;
}

function readWip(workbook) {
  const sheet = worksheet(workbook, ['TienDo_WIP', 'WIP']);
  if (!sheet) throw new Error('Không thấy sheet Tiendo_WIP. Hãy dùng file mẫu của tác vụ WIP.');
  const header = findHeader(sheet, [['Mã đơn hàng'], ['Mã hàng'], ['Mã màu'], ['Nhà máy'], ['SL WIP']]);
  if (!header) throw new Error('Sheet WIP cần có mã đơn, mã hàng, mã màu, nhà máy và SL WIP.');
  const col = {
    orderNo: findColumn(header.columns, ['Mã đơn hàng']),
    model: findColumn(header.columns, ['Mã hàng']),
    color: findColumn(header.columns, ['Mã màu']),
    plant: findColumn(header.columns, ['Nhà máy']),
    qty: findColumn(header.columns, ['SL WIP']),
  };
  const rows = [];
  for (let row = header.row + 1; row <= sheet.rowCount; row += 1) {
    const orderNo = cellText(sheet, row, col.orderNo);
    const model = cellText(sheet, row, col.model);
    const color = cellText(sheet, row, col.color);
    const plant = parsePlantIds(cellText(sheet, row, col.plant))[0];
    const qty = cellText(sheet, row, col.qty);
    if (!orderNo || !model || !color || !plant || qty === '') continue;
    rows.push({ orderNo, model, color, plant, wipQty: number(qty) });
  }
  if (!rows.length) throw new Error('Không tìm thấy dòng tiến độ WIP hợp lệ.');
  return rows;
}

async function loadWorkbook(file) {
  if (!file || typeof file.arrayBuffer !== 'function') throw new Error('Hãy chọn file Excel .xlsx hoặc .xlsm.');
  const { default: ExcelJS } = await import('exceljs');
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(await file.arrayBuffer());
  } catch {
    throw new Error('Không đọc được ' + (file.name || 'file Excel') + '. Hãy dùng file .xlsx hoặc .xlsm hợp lệ.');
  }
  return workbook;
}

export async function importTaskWorkbook(taskId, file) {
  const workbook = await loadWorkbook(file);
  if (taskId === 'orders') return { orders: readOrders(workbook) };
  if (taskId === 'production-orders') return { productionOrders: readProductionOrders(workbook) };
  if (taskId === 'order-mapping') return { orderMappings: readOrderMappings(workbook) };
  if (taskId === 'product-mapping') return { productMappings: readProductMappings(workbook) };
  if (taskId.startsWith('chemical-norms:')) {
    const warehouseId = taskId.slice('chemical-norms:'.length);
    if (!['HOA_MAU_LAF', 'HOA_MAU_LVF'].includes(warehouseId)) throw new Error('Kho Hóa mẫu không hợp lệ cho tác vụ định mức hóa chất.');
    const chemicalNorms = readChemicalNorms(workbook, warehouseId, file.name || 'DM-NPL-DH');
    return { chemicalNorms, warehouseId };
  }
  if (taskId === 'wip') return { wip: readWip(workbook) };
  if (taskId === 'materials') return { materials: readMaterials(workbook) };
  if (taskId === 'bom') return { bom: readBom(workbook) };
  if (taskId === 'norms') return { norms: readNorms(workbook) };
  if (taskId.startsWith(INVENTORY_TASK_PREFIX)) {
    const plantId = taskId.slice(INVENTORY_TASK_PREFIX.length);
    if (!PLANT_SHEETS[plantId]) throw new Error('Nhà máy không hợp lệ cho tác vụ kiểm kê.');
    return { inventory: readInventory(workbook, plantId), plantId };
  }
  throw new Error('Tác vụ nhập liệu không hợp lệ: ' + taskId);
}

function addTitle(sheet, title, subtitle, columns) {
  sheet.mergeCells(1, 1, 1, Math.max(1, columns));
  const titleCell = sheet.getCell(1, 1);
  titleCell.value = title;
  titleCell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 14 };
  titleCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF205D62' } };
  sheet.getRow(1).height = 27;
  sheet.mergeCells(2, 1, 2, Math.max(1, columns));
  const subtitleCell = sheet.getCell(2, 1);
  subtitleCell.value = subtitle;
  subtitleCell.font = { italic: true, color: { argb: 'FF5B716F' }, size: 10 };
  sheet.getRow(2).height = 22;
}

function addTable(sheet, headers, rows, headerRow = 5, title = 'TÁC VỤ NHẬP LIỆU', subtitle = 'Nhập giá trị vào các cột dữ liệu. Không cần công thức Excel.') {
  addTitle(sheet, title, subtitle, headers.length);
  const head = sheet.getRow(headerRow);
  headers.forEach((label, index) => {
    const cell = head.getCell(index + 1);
    cell.value = label;
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF24577C' } };
    cell.alignment = { vertical: 'middle', wrapText: true };
    cell.border = { bottom: { style: 'thin', color: { argb: 'FFB7C8D4' } } };
  });
  head.height = 34;
  rows.forEach((values) => sheet.addRow(values));
  sheet.autoFilter = { from: { row: headerRow, column: 1 }, to: { row: headerRow + rows.length, column: headers.length } };
  sheet.views = [{ state: 'frozen', ySplit: headerRow }];
  headers.forEach((header, index) => {
    sheet.getColumn(index + 1).width = Math.max(14, Math.min(34, header.length + 4));
  });
  sheet.getRow(headerRow).eachCell((cell) => { cell.alignment = { vertical: 'middle', wrapText: true }; });
}

function getInventoryRowsForExport(data, plantId) {
  return getInventoryRows(data, plantId).map((row) => {
    const stock = data.inventory?.[inventoryKey(plantId, row.catalogNo)];
    return [
      row.catalogNo,
      row.materialCode,
      row.name,
      row.unit,
      stock ? stock.received ?? 0 : '',
      stock?.actual ?? '',
    ];
  });
}

function getBomRowsForExport(data) {
  return (data.bom || []).map((line) => {
    const material = (data.materials || []).find((item) => Number(item.catalogNo) === Number(line.catalogNo)) || {};
    return [line.catalogNo, material.materialCode || '', material.name || '', line.model || '', line.color || '', line.plant ? getPlantName(line.plant) : 'Theo BOM chung', line.rate, line.warehouseId || '', line.operation || '', line.supplyRoute || ''];
  });
}

export async function createTaskWorkbook(taskId, data, plantId) {
  const { default: ExcelJS } = await import('exceljs');
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Kho Xưởng';
  workbook.subject = 'Tệp nhập và xuất dữ liệu theo từng tác vụ';
  workbook.created = new Date();
  workbook.calcProperties.fullCalcOnLoad = false;

  if (taskId === 'orders') {
    const headers = ['Mã đơn hàng / Chỉ lệnh', 'Mã hàng', 'Mã màu', 'Tên màu', 'Số lượng kế hoạch', 'Nhà máy'];
    const groups = [
      ['ADIDAS', 'LAF'],
      ['LƯU HÓA', 'HOA_MAU'],
      ['LVF', 'LVF'],
    ];
    for (const [name, plant] of groups) {
      const sheet = workbook.addWorksheet(name);
      const rows = (data.orders || []).filter((order) => (order.plant || 'LAF') === plant).map((order) => [order.orderNo, order.model, order.color, order.colorName || '', order.plannedQty, getPlantName(plant)]);
      addTable(sheet, headers, rows, 3, 'ĐƠN HÀNG · ' + getPlantName(plant), 'Chỉ nhập dòng đơn hàng. Sheet BTP trong DON HANG.xlsx không được sử dụng.');
    }
  } else if (taskId === 'production-orders') {
    const sheet = workbook.addWorksheet('New');
    const headers = ['Số SO#/WI#', 'Số PO', 'Chỉ lệnh ĐH', 'Khách hàng', 'Mã hàng', 'Màu', 'Mã sản phẩm', 'SL đơn hàng', 'Số lượng lệnh sản xuất', 'Chặt', 'May', 'Gò', 'Nhập kho', 'Đóng thùng', 'Giao hàng', 'Ngày giao hàng', 'Trạng thái'];
    const orders = currentImportedRows(data.productionOrders, data.importMeta, 'production-orders');
    const rows = orders.map((order) => [order.salesOrder || '', order.purchaseOrder || '', order.orderNo, order.customer || '', order.model, order.color, order.productCode || '', order.plannedQty || 0, order.productionQty || 0, order.stageQuantities?.LAF_CUT || 0, order.stageQuantities?.LVF_SEW || 0, order.stageQuantities?.LVF_GO || 0, order.stageQuantities?.RECEIVED || 0, order.stageQuantities?.PACKED || 0, order.stageQuantities?.SHIPPED || 0, order.dueDate || '', order.status || '']);
    addTable(sheet, headers, rows, 5, 'TIẾN ĐỘ ĐƠN HÀNG SẢN XUẤT', 'Khóa nối là Chỉ lệnh ĐH + Mã hàng + Màu. Số lượng lệnh sản xuất là cơ sở tính nhu cầu hiện hành.');
  } else if (taskId === 'order-mapping') {
    const sheet = workbook.addWorksheet('Mapping_Chi_Lenh');
    const headers = ['Số SO/WI nguồn', 'Số PO nguồn', 'Chỉ lệnh nguồn', 'Mã hàng nguồn', 'Màu nguồn', 'Mã sản phẩm nguồn', 'Chỉ lệnh đích', 'Trạng thái gợi ý', 'Các chỉ lệnh ứng viên', 'Ghi chú'];
    const orders = currentImportedRows(data.productionOrders, data.importMeta, 'production-orders');
    const sourceOrders = orders.length ? orders : (data.orders || []);
    const mappings = currentImportedRows(data.orderMappings, data.importMeta, 'order-mapping');
    const chemicalRows = WAREHOUSES.filter((item) => item.kind === 'chemical')
      .flatMap((item) => currentImportedRows(data.chemicalNorms, data.importMeta, 'chemical-norms:' + item.id));
    const rows = sourceOrders.map((order) => {
      const resolved = resolveOrderCommand(order, chemicalRows, mappings);
      const status = resolved.resolution === 'manual' ? 'Đã mapping thủ công'
        : resolved.resolution === 'automatic' ? 'Tự ghép duy nhất theo PO + mã hàng + màu'
          : resolved.resolution === 'ambiguous' ? 'Nhiều chỉ lệnh; cần rà soát'
            : resolved.resolution === 'source' ? 'Có chỉ lệnh nguồn'
              : 'Chưa tìm thấy; điền tay';
      return [order.salesOrder || '', order.purchaseOrder || '', order.sourceOrderNo || order.orderNo || '', order.model || '', order.color || '', order.productCode || '', resolved.orderNo || '', status, resolved.candidates.join(' · '), ''];
    });
    addTable(sheet, headers, rows, 5, 'BẢNG PHỤ MAPPING CHỈ LỆNH', 'Đối chiếu PO/SO + mã hàng + màu với DM-NPL-DH. Chỉ tự ghép khi tìm được duy nhất một chỉ lệnh; trường hợp còn lại hãy điền Chỉ lệnh đích rồi import lại.');
  } else if (taskId === 'product-mapping') {
    const sheet = workbook.addWorksheet('Mapping_Ma_Hang_Mau');
    const headers = ['Mã sản phẩm nguồn', 'Mã hàng nguồn', 'Tên màu nguồn', 'Mã hàng BOM', 'Mã màu BOM', 'Ghi chú', 'Nguồn mapping'];
    const rows = (data.productMappings || []).map((row) => [row.sourceProductCode || '', row.sourceModel || '', row.sourceColor || '', row.bomModel || '', row.bomColor || '', row.note || '', row.sourceType || 'Thủ công']);
    addTable(sheet, headers, rows, 5, 'BẢNG MAPPING MÃ HÀNG - MÀU', 'Nối mã hàng/màu ở file tiến độ với mã hàng/màu của ma trận BOM. Có thể ghép theo mã sản phẩm hoặc cặp tên hàng-màu nguồn.');
  } else if (taskId.startsWith('chemical-norms:')) {
    const warehouseId = taskId.slice('chemical-norms:'.length);
    if (!['HOA_MAU_LAF', 'HOA_MAU_LVF'].includes(warehouseId)) throw new Error('Kho Hóa mẫu không hợp lệ cho tác vụ định mức hóa chất.');
    const sheet = workbook.addWorksheet('DM-NPL-DH');
    const headers = ['Số PO', 'Mã hàng', 'Mã màu', 'Màu', 'Chỉ lệnh ĐH', 'SL đơn hàng', 'Loại', 'Tên công thức', 'Tổng trọng lượng', 'Nhóm vừa', 'Mã vật tư', 'Tên vật tư', 'Đơn vị', 'Đặc điểm kỹ thuật', 'Trọng lượng', 'TL công thức', 'Số lượng hóa chất'];
    const task = 'chemical-norms:' + warehouseId;
    const rows = currentImportedRows(data.chemicalNorms, data.importMeta, task).map((line) => [line.purchaseOrder || '', line.model || '', line.colorCode || '', line.color || '', line.productionOrder || '', line.sourceOrderQty || 0, line.component || '', line.formulaName || '', line.batchWeight || 0, line.materialGroup || '', line.materialCode || '', line.materialName || '', line.unit || '', line.specification || '', line.materialWeight || 0, line.ratio || 0, line.sourceQuantity || 0]);
    addTable(sheet, headers, rows, 5, 'ĐỊNH MỨC HÓA CHẤT · ' + warehouseId.replaceAll('_', ' '), 'Số lượng hóa chất là dữ liệu nguồn. Ứng dụng tính định mức/đôi và nhân với số lượng lệnh sản xuất.');
  } else if (taskId.startsWith('requirements:')) {
    const warehouseId = taskId.slice('requirements:'.length);
    const warehouse = WAREHOUSES.find((item) => item.id === warehouseId);
    if (!warehouse) throw new Error('Kho nhận không hợp lệ cho file nhu cầu lý thuyết.');
    const calculated = getTheoreticalRequirements(data, warehouseId);
    const sheet = workbook.addWorksheet('NhuCauLyThuyet');
    const headers = ['Kho nhận', 'Chỉ lệnh', 'Số PO', 'Mã hàng', 'Màu', 'Công đoạn / Cụm', 'Mã vật tư', 'Tên vật tư', 'ĐVT', 'Định mức / đôi', 'Cơ sở số lượng', 'SL quy đổi', 'Nhu cầu lý thuyết', 'Nguồn', 'Dòng nguồn'];
    const rows = calculated.rows.map((line) => [warehouse.name, line.orderNo, line.purchaseOrder, line.model, line.color, line.component, line.materialCode, line.materialName, line.unit, line.rate, line.basisType || 'Số lượng lệnh sản xuất', line.basisQty, line.quantity, line.source, line.sourceRow || '']);
    addTable(sheet, headers, rows, 5, 'NHU CẦU VẬT TƯ LÝ THUYẾT · ' + warehouse.name, 'Dữ liệu tính trong ứng dụng; không chứa công thức Excel.');
    if (calculated.unmapped.length) {
      const gaps = workbook.addWorksheet('ChuaGhepDuoc');
      const gapHeaders = ['Chỉ lệnh', 'Mã hàng', 'Màu', 'Mã vật tư', 'Tên vật tư', 'Lý do chưa ghép'];
      addTable(gaps, gapHeaders, calculated.unmapped.map((line) => [line.productionOrder || line.orderNo || '', line.model || '', line.color || '', line.materialCode || '', line.materialName || '', line.reason || '']), 5, 'DÒNG CHƯA GHÉP ĐƯỢC', 'Cần bổ sung khóa đơn hàng hoặc khai báo kho nhận cho dòng BOM.');
    }
  } else if (taskId === 'wip') {
    const sheet = workbook.addWorksheet('TienDo_WIP');
    const headers = ['Mã đơn hàng', 'Mã hàng', 'Mã màu', 'Nhà máy', 'SL WIP'];
    const rows = (data.orders || []).flatMap((order) => ['HOA_MAU', 'LAF', 'LVF'].map((plant) => [order.orderNo, order.model, order.color, getPlantName(plant), Number(order.progress?.[plant] || 0)]));
    addTable(sheet, headers, rows, 5, 'TIẾN ĐỘ WIP THEO NHÀ MÁY', 'Mỗi dòng là một đơn hàng tại một nhà máy. Nhập WIP; hệ thống tự tính số lượng còn lại.');
  } else if (taskId === 'materials') {
    const sheet = workbook.addWorksheet('DanhMuc_VatTu');
    const headers = ['STT danh mục', 'Khu vực nhà máy', 'Mã vật tư', 'Tên vật tư', 'Phạm vi mã màu', 'ĐVT ERP', 'ĐVT cấp phát', 'Quy cách / kiện', 'Vỏ bì 1 kiện (kg)'];
    const rows = (data.materials || []).map((item) => [item.catalogNo, (item.plants || []).map(getPlantName).join(', '), item.materialCode, item.name, item.colorScope || '', item.unit || '', item.issueUnit || '', item.packQty || 0, item.packagingWeight || 0]);
    addTable(sheet, headers, rows, 5, 'DANH MỤC VẬT TƯ', 'Một vật tư có thể gắn với nhiều nhà máy. Mỗi dòng là một STT danh mục.');
  } else if (taskId === 'bom') {
    const sheet = workbook.addWorksheet('Dinh_Muc_BOM');
    const headers = ['STT danh mục', 'Mã vật tư', 'Tên vật tư', 'Mã hàng', 'Mã màu', 'Nhà máy', 'Định mức / đôi', 'Kho nhận', 'Công đoạn sử dụng', 'Luồng cấp phát'];
    addTable(sheet, headers, getBomRowsForExport(data), 5, 'ĐỊNH MỨC BOM THEO MÃ HÀNG - MÀU', 'Dạng danh sách dọc: mỗi dòng là một vật tư cho một mã hàng-màu. Thêm bao nhiêu mã hàng-màu cũng được.');
  } else if (taskId.startsWith(INVENTORY_TASK_PREFIX)) {
    const selectedPlant = taskId.slice(INVENTORY_TASK_PREFIX.length);
    if (!PLANT_SHEETS[selectedPlant]) throw new Error('Nhà máy không hợp lệ cho tác vụ kiểm kê.');
    const name = selectedPlant === 'HOA_MAU' ? 'Kho_Hoa_Mau' : 'Kho_' + selectedPlant;
    const sheet = workbook.addWorksheet(name);
    const headers = ['STT danh mục', 'Mã vật tư', 'Tên vật tư', 'ĐVT', 'Lĩnh về', 'Kiểm kê thực tế'];
    const rows = getInventoryRowsForExport(data, selectedPlant);
    addTable(sheet, headers, rows, 16, 'KIỂM KÊ KHO · ' + getPlantName(selectedPlant), 'Chỉ nhập Lĩnh về và Kiểm kê thực tế. Tồn lý thuyết/chênh lệch được hệ thống tính tự động.');
  } else if (taskId === 'norms') {
    const sheet = workbook.addWorksheet('DM_BTP_Size_LAF');
    const headers = ['STT vật tư LAF', 'Mã vật tư', 'Tên vật tư', 'Mã hàng', 'Mã màu', 'Mã hàng - màu', 'Size', 'Công đoạn LAF', 'Mã BTP', 'Tên BTP', 'Định mức / 1 đôi', 'SL kế hoạch theo size', 'SL WIP LAF theo size'];
    const rows = (data.norms || []).map((line) => {
      const material = (data.materials || []).find((item) => Number(item.catalogNo) === Number(line.catalogNo)) || {};
      const pair = getModelColor(line.productKey);
      return [line.catalogNo, line.materialCode || material.materialCode || '', line.materialName || material.name || '', pair.model, pair.color, line.productKey, line.size, line.process || '', line.btpCode || '', line.btpName || '', line.rate, line.plannedQty || 0, line.wipQty || 0];
    });
    addTable(sheet, headers, rows, 5, 'ĐỊNH MỨC BTP THEO SIZE & CÔNG ĐOẠN · LAF', 'Mỗi dòng là một tổ hợp vật tư, mã hàng-màu, size và công đoạn. Nhu cầu được tính trong ứng dụng.');
  } else {
    throw new Error('Tác vụ xuất dữ liệu không hợp lệ: ' + taskId);
  }
  return workbook.xlsx.writeBuffer();
}

export function taskFilename(taskId) {
  return 'Kho_Xuong_' + taskId.replace(/[:]/g, '_') + '.xlsx';
}

