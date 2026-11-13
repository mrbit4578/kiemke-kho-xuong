import { inventoryKey, orderKey, productKey } from './model.js';

const text = (value) => {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') {
    if (Array.isArray(value.richText)) return value.richText.map((part) => part.text).join('').trim();
    if (value.text) return String(value.text).trim();
    if (value.result !== undefined) return String(value.result).trim();
    if (value.hyperlink) return String(value.text || value.hyperlink).trim();
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

const number = (value) => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const cleaned = text(value).replace(/\s/g, '').replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.');
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : 0;
};

function plantIds(value) {
  const source = normalize(value);
  const result = [];
  if (source.includes('HOA MAU') || source.includes('HOA MAU')) result.push('HOA_MAU');
  if (source.includes('LAF')) result.push('LAF');
  if (source.includes('LVF')) result.push('LVF');
  return [...new Set(result)];
}

function getSheet(workbook, expected) {
  const wanted = normalize(expected);
  return workbook.worksheets.find((sheet) => normalize(sheet.name) === wanted);
}

function readInventory(workbook, target) {
  const sheetMap = [
    ['2_Kho_Hoa_Mau', 'HOA_MAU'],
    ['3_Kho_Xuong_LAF', 'LAF'],
    ['4_Kho_Xuong_LVF', 'LVF'],
  ];
  for (const [name, plant] of sheetMap) {
    const sheet = getSheet(workbook, name);
    if (!sheet) continue;
    for (let row = 17; row <= sheet.rowCount; row += 1) {
      const catalogNo = number(sheet.getCell(row, 2).value);
      if (!catalogNo) continue;
      const received = number(sheet.getCell(row, 9).value);
      const actualValue = sheet.getCell(row, 13).value;
      const actual = actualValue === null || actualValue === undefined || text(actualValue) === '' ? null : number(actualValue);
      const key = inventoryKey(plant, catalogNo);
      target[key] = { catalogNo, plant, received, actual };
    }
  }
}

function readMaterialWorkbook(workbook) {
  const sheet = getSheet(workbook, '1_Danh_Muc_Va_Ma_Tran_BOM');
  if (!sheet) throw new Error('Không tìm thấy sheet 1_Danh_Muc_Va_Ma_Tran_BOM.');
  const headerRow = 5;
  const bomColumns = [];
  for (let col = 10; col <= sheet.columnCount; col += 1) {
    const key = text(sheet.getCell(headerRow, col).value);
    if (key.includes('_')) bomColumns.push({ col, key });
  }

  const materials = [];
  const bomMap = new Map();
  for (let row = 6; row <= sheet.rowCount; row += 1) {
    const catalogNo = number(sheet.getCell(row, 1).value);
    if (!catalogNo) continue;
    const plants = plantIds(sheet.getCell(row, 2).value);
    if (!plants.length) continue;
    const material = {
      catalogNo,
      materialCode: text(sheet.getCell(row, 3).value),
      name: text(sheet.getCell(row, 4).value),
      colorScope: text(sheet.getCell(row, 5).value),
      unit: text(sheet.getCell(row, 6).value),
      issueUnit: text(sheet.getCell(row, 7).value),
      packQty: number(sheet.getCell(row, 8).value),
      packagingWeight: number(sheet.getCell(row, 9).value),
      plants,
    };
    materials.push(material);
    for (const entry of bomColumns) {
      const rate = number(sheet.getCell(row, entry.col).value);
      if (!rate) continue;
      const splitAt = entry.key.lastIndexOf('_');
      const model = splitAt > 0 ? entry.key.slice(0, splitAt) : entry.key;
      const color = splitAt > 0 ? entry.key.slice(splitAt + 1) : '';
      const key = `${catalogNo}|${entry.key}`;
      bomMap.set(key, { catalogNo, productKey: productKey(model, color), model, color, rate, plant: null });
    }
  }

  const norms = [];
  const detail = getSheet(workbook, 'DM_BTP_Size_LAF');
  if (detail) {
    for (let row = 6; row <= detail.rowCount; row += 1) {
      const catalogNo = number(detail.getCell(row, 1).value);
      const rate = number(detail.getCell(row, 10).value);
      if (!catalogNo || !rate) continue;
      const key = text(detail.getCell(row, 5).value);
      const splitAt = key.lastIndexOf('_');
      const model = splitAt > 0 ? key.slice(0, splitAt) : key;
      const color = splitAt > 0 ? key.slice(splitAt + 1) : '';
      norms.push({
        catalogNo,
        productKey: productKey(model, color),
        size: text(detail.getCell(row, 6).value),
        process: text(detail.getCell(row, 7).value),
        btpCode: text(detail.getCell(row, 8).value),
        btpName: text(detail.getCell(row, 9).value),
        rate,
        plannedQty: number(detail.getCell(row, 11).value),
        wipQty: number(detail.getCell(row, 12).value),
        plannedNeed: number(detail.getCell(row, 13).value),
        wipNeed: number(detail.getCell(row, 14).value),
      });
    }
  }

  const inventory = {};
  readInventory(workbook, inventory);
  return { materials, bom: [...bomMap.values()], norms, inventory };
}

function findOrderHeader(sheet) {
  for (let row = 1; row <= Math.min(sheet.rowCount, 12); row += 1) {
    const columns = new Map();
    for (let col = 1; col <= sheet.columnCount; col += 1) {
      const label = normalize(sheet.getCell(row, col).value);
      if (label) columns.set(label, col);
    }
    const hasQty = [...columns.keys()].some((key) => key.includes('SO LUONG'));
    const hasColor = [...columns.keys()].some((key) => key.includes('MA MAU'));
    const hasModel = [...columns.keys()].some((key) => key === 'MA HANG' || key === 'DON HANG' || key === 'LOT NO');
    if (hasQty && hasColor && hasModel) return { row, columns };
  }
  return null;
}

function pickColumn(columns, candidates) {
  for (const candidate of candidates) {
    for (const [label, col] of columns) {
      if (label === candidate || label.includes(candidate)) return col;
    }
  }
  return null;
}

function readOrdersWorkbook(workbook) {
  const allowedNames = new Set(['ADIDAS', 'LUU HOA']);
  const rows = new Map();
  for (const sheet of workbook.worksheets) {
    const name = normalize(sheet.name);
    if (!allowedNames.has(name)) continue;
    const header = findOrderHeader(sheet);
    if (!header) continue;
    const modelCol = pickColumn(header.columns, ['MA HANG', 'DON HANG', 'LOT NO']);
    const colorCol = pickColumn(header.columns, ['MA MAU']);
    const qtyCol = pickColumn(header.columns, ['SO LUONG']);
    const orderCol = pickColumn(header.columns, ['CHI LENH', 'MA SO', 'PO#']);
    const colorNameCol = pickColumn(header.columns, ['TEN MAU', 'TEN MA']);
    for (let row = header.row + 1; row <= sheet.rowCount; row += 1) {
      const model = text(sheet.getCell(row, modelCol).value);
      const color = text(sheet.getCell(row, colorCol).value);
      const plannedQty = number(sheet.getCell(row, qtyCol).value);
      if (!model || !color || plannedQty <= 0) continue;
      const orderNo = text(orderCol ? sheet.getCell(row, orderCol).value : '') || `${sheet.name}-${row}`;
      const item = {
        orderNo,
        model,
        color,
        colorName: colorNameCol ? text(sheet.getCell(row, colorNameCol).value) : '',
        plannedQty,
        plant: name === 'ADIDAS' ? 'LAF' : 'HOA_MAU',
        progress: { HOA_MAU: 0, LAF: 0, LVF: 0 },
        status: 'Chờ sản xuất',
        sourceSheet: sheet.name,
      };
      const key = orderKey(item);
      const previous = rows.get(key);
      rows.set(key, previous ? { ...previous, plannedQty: previous.plannedQty + plannedQty } : item);
    }
  }
  return [...rows.values()];
}

async function loadWorkbook(file) {
  const { default: ExcelJS } = await import('exceljs');
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(await file.arrayBuffer());
  } catch (error) {
    throw new Error(`Không đọc được ${file.name}. Hãy dùng file .xlsx hoặc .xlsm hợp lệ.`);
  }
  return workbook;
}

export async function importCatalogFile(file) {
  const workbook = await loadWorkbook(file);
  return readMaterialWorkbook(workbook);
}

export async function importOrderFile(file) {
  const workbook = await loadWorkbook(file);
  return readOrdersWorkbook(workbook);
}
