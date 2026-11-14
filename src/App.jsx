import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity, ArrowDownToLine, ArrowLeftRight, Boxes, Check, ChevronDown,
  CircleAlert, ClipboardCheck, ClipboardList, Cloud, CloudOff, FileSpreadsheet, Filter,
  Gauge, Layers3, LogOut, Menu, Package, Plus, RefreshCw, Search, Settings2,
  ShieldCheck, Upload, X,
} from 'lucide-react';
import { PLANTS, WAREHOUSES, getInventoryRows, getPlantName, getPlantSummary, getTheoreticalRequirements, getWarehouseName, summarizeTheoreticalRequirements, inventoryKey, mergeWipProgress, money, orderKey, productKey, productMappingKey, statusTone } from './lib/model.js';
import { createTaskWorkbook, importTaskWorkbook, taskFilename } from './lib/task-workbooks.js';
import { loadLocalState, saveLocalState } from './lib/local-db.js';
import { supabase, cloudMode } from './lib/supabase.js';
import { ensureWorkspace, loadWorkspaceRecords, saveWorkspaceRecords } from './lib/cloud.js';

const emptyData = () => ({ materials: [], bom: [], orders: [], productionOrders: [], productMappings: [], chemicalNorms: [], importMeta: {}, inventory: {}, norms: [] });
const navItems = [
  { id: 'overview', label: 'Tổng quan', icon: Gauge },
  { id: 'orders', label: 'Đơn hàng', icon: Layers3 },
  { id: 'requirements', label: 'Nhu cầu lý thuyết', icon: ArrowLeftRight },
  { id: 'inventory', label: 'Kiểm kê vật tư', icon: ClipboardCheck },
  { id: 'catalog', label: 'Danh mục & BOM', icon: Boxes },
  { id: 'norms', label: 'Định mức BTP LAF', icon: Settings2 },
  { id: 'data-entry', label: 'Tác vụ nhập liệu', icon: ClipboardList },
];

function mergeRows(existing, incoming, keyOf) {
  const merged = new Map((existing || []).map((item) => [keyOf(item), item]));
  for (const item of incoming || []) merged.set(keyOf(item), item);
  return [...merged.values()];
}

function materialKey(row) { return String(row.catalogNo); }
function bomKey(row) { return `${row.catalogNo}|${row.plant || 'ALL'}|${row.warehouseId || ''}|${row.productKey}|${row.operation || ''}|${row.supplyRoute || ''}|${row.size || ''}|${row.process || ''}`; }
function normKey(row) { return `${row.catalogNo}|${row.productKey}|${row.size}|${row.process}|${row.btpCode || ''}`; }

function currentImportedRows(rows, importMeta, taskId) {
  const batchId = importMeta?.[taskId]?.batchId;
  return batchId ? (rows || []).filter((row) => row.batchId === batchId) : (rows || []);
}

function currentOrderRows(data) {
  const productionOrders = currentImportedRows(data.productionOrders, data.importMeta, 'production-orders');
  if (!productionOrders.length) return data.orders || [];
  const keys = new Set(productionOrders.map(orderKey));
  return [...productionOrders, ...(data.orders || []).filter((order) => !keys.has(orderKey(order)))];
}

function App() {
  const [data, setData] = useState(() => emptyData());
  const [localLoading, setLocalLoading] = useState(!cloudMode);
  const [page, setPage] = useState('overview');
  const [selectedPlant, setSelectedPlant] = useState('LAF');
  const [selectedWarehouse, setSelectedWarehouse] = useState('HOA_MAU_LAF');
  const [session, setSession] = useState(null);
  const [workspaceId, setWorkspaceId] = useState(null);
  const [cloudLoading, setCloudLoading] = useState(cloudMode);
  const [saving, setSaving] = useState(false);
  const [loginError, setLoginError] = useState('');
  const [toast, setToast] = useState('');
  const [modal, setModal] = useState('');
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [catalogTab, setCatalogTab] = useState('materials');
  const [busyTask, setBusyTask] = useState('');
  const [taskErrors, setTaskErrors] = useState({});

  useEffect(() => {
    if (cloudMode) return undefined;
    let alive = true;
    loadLocalState(emptyData).then((saved) => { if (alive) setData(saved); }).finally(() => { if (alive) setLocalLoading(false); });
    return () => { alive = false; };
  }, []);

  const notify = useCallback((message) => {
    setToast(message);
    window.clearTimeout(notify.timer);
    notify.timer = window.setTimeout(() => setToast(''), 3200);
  }, []);

  const hydrateCloud = useCallback(async (user) => {
    if (!user || !supabase) return;
    setCloudLoading(true);
    try {
      const workspace = await ensureWorkspace(supabase);
      const cloudData = await loadWorkspaceRecords(supabase, workspace);
      setWorkspaceId(workspace);
      setData({ ...emptyData(), ...cloudData });
      setLoginError('');
    } catch (error) {
      setLoginError(error.message || 'Không tải được dữ liệu dùng chung.');
    } finally {
      setCloudLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!supabase) return undefined;
    let alive = true;
    supabase.auth.getSession().then(({ data: result }) => {
      if (!alive) return;
      setSession(result.session);
      if (result.session?.user) hydrateCloud(result.session.user);
      else setCloudLoading(false);
    }).catch(() => setCloudLoading(false));
    const { data: authData } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession);
      if (newSession?.user) window.setTimeout(() => hydrateCloud(newSession.user), 0);
      else {
        setWorkspaceId(null);
        setData(emptyData());
        setCloudLoading(false);
      }
    });
    return () => {
      alive = false;
      authData.subscription.unsubscribe();
    };
  }, [hydrateCloud]);

  useEffect(() => {
    const openImport = () => setPage('data-entry');
    window.addEventListener('open-import', openImport);
    return () => window.removeEventListener('open-import', openImport);
  }, []);

  const commit = useCallback(async (next, changedTypes = []) => {
    setData(next);
    if (!cloudMode) {
      try {
        await saveLocalState(next);
        return true;
      } catch (error) {
        notify(`Không lưu được dữ liệu trên thiết bị: ${error.message || 'lỗi bộ nhớ'}`);
        return false;
      }
    }
    if (!session?.user || !workspaceId) return false;
    setSaving(true);
    try {
      await saveWorkspaceRecords(supabase, workspaceId, session.user.id, next, changedTypes);
      return true;
    } catch (error) {
      notify(`Chưa đồng bộ được: ${error.message || 'lỗi kết nối'}`);
      return false;
    } finally {
      setSaving(false);
    }
  }, [notify, session, workspaceId]);

  const signIn = async (event) => {
    event.preventDefault();
    setLoginError('');
    const form = new FormData(event.currentTarget);
    const { error } = await supabase.auth.signInWithPassword({
      email: String(form.get('email') || '').trim(),
      password: String(form.get('password') || ''),
    });
    if (error) setLoginError('Email hoặc mật khẩu không đúng.');
  };

  const importTask = async (taskId, file) => {
    setBusyTask(taskId);
    setTaskErrors((current) => ({ ...current, [taskId]: '' }));
    try {
      const imported = await importTaskWorkbook(taskId, file);
      let next = data;
      let changed = [];
      let count = 0;
      if (taskId === 'orders') {
        count = imported.orders.length;
        next = { ...data, orders: mergeRows(data.orders, imported.orders, orderKey) };
        changed = ['order'];
      } else if (taskId === 'wip') {
        const result = mergeWipProgress(data.orders, imported.wip);
        count = result.matched;
        next = { ...data, orders: result.orders };
        changed = ['order'];
        if (result.unmatched) notify(`Đã cập nhật ${result.matched} dòng WIP; bỏ qua ${result.unmatched} dòng không khớp đơn hàng và nhà máy.`);
      } else if (taskId === 'materials') {
        count = imported.materials.length;
        next = { ...data, materials: mergeRows(data.materials, imported.materials, materialKey) };
        changed = ['material'];
      } else if (taskId === 'bom') {
        count = imported.bom.length;
        next = { ...data, bom: mergeRows(data.bom, imported.bom, bomKey) };
        changed = ['bom'];
      } else if (taskId === 'norms') {
        count = imported.norms.length;
        next = { ...data, norms: mergeRows(data.norms, imported.norms, normKey) };
        changed = ['norm'];
      } else if (taskId.startsWith('inventory:')) {
        count = Object.keys(imported.inventory).length;
        next = { ...data, inventory: { ...data.inventory, ...imported.inventory } };
        changed = ['inventory'];
      } else if (taskId === 'production-orders') {
        const batchId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const productionOrders = imported.productionOrders.map((order) => ({ ...order, batchId }));
        count = productionOrders.length;
        const importMeta = { ...data.importMeta, [taskId]: { taskId, batchId, sourceFile: file.name, importedAt: new Date().toISOString(), rowCount: count } };
        next = { ...data, productionOrders, importMeta };
        changed = ['production_order', 'import_meta'];
      } else if (taskId === 'product-mapping') {
        count = imported.productMappings.length;
        const manualMappings = imported.productMappings.map((row) => ({ ...row, sourceType: 'manual' }));
        next = { ...data, productMappings: mergeRows(data.productMappings, manualMappings, productMappingKey) };
        changed = ['product_mapping'];
      } else if (taskId.startsWith('chemical-norms:')) {
        const batchId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const chemicalNorms = [
          ...(data.chemicalNorms || []).filter((row) => row.warehouseId !== imported.warehouseId),
          ...imported.chemicalNorms.map((row) => ({ ...row, batchId })),
        ];
        count = imported.chemicalNorms.length;
        const importMeta = { ...data.importMeta, [taskId]: { taskId, batchId, sourceFile: file.name, importedAt: new Date().toISOString(), rowCount: count } };
        next = { ...data, chemicalNorms, importMeta };
        changed = ['chemical_norm', 'import_meta'];
      }
      const saved = await commit(next, changed);
      if (!saved && cloudMode) notify('Đã đọc file nhưng chưa đồng bộ được. Hãy kiểm tra kết nối Supabase.');
      else if (taskId.startsWith('chemical-norms:')) notify(`Đã chuẩn hóa ${count} dòng định mức hóa chất cho ${getWarehouseName(imported.warehouseId)}.`);
      else if (!(taskId === 'wip' && count < imported.wip.length)) notify(`Đã nhập ${count} dòng vào tác vụ ${taskId}.`);
    } catch (error) {
      setTaskErrors((current) => ({ ...current, [taskId]: error.message || 'Không nhập được file.' }));
    } finally {
      setBusyTask('');
    }
  };

  const exportTask = async (taskId, template = false) => {
    try {
      let exportData = data;
      if (template) exportData = emptyData();
      const bytes = await createTaskWorkbook(taskId, exportData);
      const blob = new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = taskFilename(taskId);
      link.click();
      URL.revokeObjectURL(url);
      notify(template ? 'Đã tải file mẫu cho tác vụ.' : 'Đã xuất dữ liệu tác vụ ra Excel.');
    } catch (error) {
      notify(error.message || 'Không tạo được file Excel.');
    }
  };

  const saveMaterial = async (form) => {
    const catalogNo = Number(form.catalogNo) || Math.max(0, ...data.materials.map((item) => Number(item.catalogNo) || 0)) + 1;
    const material = {
      catalogNo,
      materialCode: form.materialCode.trim(),
      name: form.name.trim(),
      unit: form.unit.trim(),
      issueUnit: form.issueUnit.trim(),
      packQty: Number(form.packQty) || 0,
      packagingWeight: 0,
      colorScope: form.colorScope.trim() || 'Dùng chung theo BOM',
      plants: form.plants,
    };
    if (!material.materialCode || !material.name || !material.plants.length) {
      notify('Hãy nhập mã, tên vật tư và chọn ít nhất một nhà máy.');
      return;
    }
    const next = { ...data, materials: mergeRows(data.materials, [material], materialKey) };
    await commit(next, ['material']);
    setModal('');
    notify(`Đã lưu vật tư ${material.materialCode} cho ${material.plants.length} nhà máy.`);
  };

  const saveBom = async (form) => {
    const line = {
      catalogNo: Number(form.catalogNo),
      model: form.model.trim(),
      color: form.color.trim(),
      productKey: productKey(form.model, form.color),
      rate: Number(form.rate),
      plant: form.plant || null,
    };
    if (!line.catalogNo || !line.model || !line.color || !(line.rate > 0)) {
      notify('Hãy nhập đủ vật tư, mã hàng, màu và định mức lớn hơn 0.');
      return;
    }
    const next = { ...data, bom: mergeRows(data.bom, [line], bomKey) };
    await commit(next, ['bom']);
    setModal('');
    notify('Đã lưu định mức BOM.');
  };

  const saveNorm = async (form) => {
    const material = data.materials.find((item) => Number(item.catalogNo) === Number(form.catalogNo));
    const norm = {
      catalogNo: Number(form.catalogNo),
      materialCode: material?.materialCode || '',
      materialName: material?.name || '',
      productKey: productKey(form.model, form.color),
      size: form.size.trim(),
      process: form.process.trim(),
      btpCode: form.btpCode.trim(),
      btpName: form.btpName.trim(),
      rate: Number(form.rate),
      plannedQty: Number(form.plannedQty) || 0,
      wipQty: Number(form.wipQty) || 0,
    };
    if (!norm.catalogNo || !form.model.trim() || !form.color.trim() || !norm.size || !(norm.rate > 0)) {
      notify('Hãy nhập vật tư, mã hàng-màu, size và định mức lớn hơn 0.');
      return;
    }
    const next = { ...data, norms: mergeRows(data.norms, [norm], normKey) };
    await commit(next, ['norm']);
    setModal('');
    notify('Đã lưu định mức BTP theo size.');
  };

  const saveOrder = async (form) => {
    const order = {
      orderNo: form.orderNo.trim(),
      model: form.model.trim(),
      color: form.color.trim(),
      colorName: form.colorName.trim(),
      plannedQty: Number(form.plannedQty) || 0,
      plant: form.plant || 'LAF',
      progress: { HOA_MAU: 0, LAF: 0, LVF: 0 },
      status: 'Chờ sản xuất',
      sourceSheet: 'Nhập trực tiếp',
    };
    if (!order.orderNo || !order.model || !order.color || order.plannedQty <= 0) {
      notify('Hãy nhập mã đơn, mã hàng, màu sắc và số lượng kế hoạch.');
      return;
    }
    const next = { ...data, orders: mergeRows(data.orders, [order], orderKey) };
    await commit(next, ['order']);
    setModal('');
    notify('Đã thêm đơn hàng.');
  };

  const updateInventory = async (row, field, value) => {
    const key = inventoryKey(row.plant, row.catalogNo);
    const previous = data.inventory[key] || { catalogNo: row.catalogNo, plant: row.plant, received: 0, actual: null };
    const nextEntry = { ...previous, catalogNo: row.catalogNo, plant: row.plant, [field]: value === '' ? null : Number(value) };
    const next = { ...data, inventory: { ...data.inventory, [key]: nextEntry } };
    await commit(next, ['inventory']);
  };

  const updateOrderProgress = async (order, plant, value) => {
    const progress = { ...(order.progress || {}), [plant]: Number(value) || 0 };
    const nextOrders = data.orders.map((item) => orderKey(item) === orderKey(order) ? { ...item, progress } : item);
    await commit({ ...data, orders: nextOrders }, ['order']);
  };

  const refreshCloud = async () => {
    if (!supabase || !workspaceId) return;
    setCloudLoading(true);
    try {
      setData(await loadWorkspaceRecords(supabase, workspaceId));
      notify('Đã tải lại dữ liệu dùng chung.');
    } catch (error) {
      notify(error.message || 'Không tải được dữ liệu.');
    } finally {
      setCloudLoading(false);
    }
  };

  const signOut = async () => { if (supabase) await supabase.auth.signOut(); };

  if (!cloudMode && localLoading) return <LoadingScreen label="Đang tải dữ liệu kho xưởng" />;
  if (cloudMode && cloudLoading) return <LoadingScreen label="Đang đồng bộ dữ liệu xưởng" />;
  if (cloudMode && !session) return <LoginScreen onSubmit={signIn} error={loginError} />;
  if (cloudMode && session && !workspaceId && loginError) return <CloudAccessScreen error={loginError} onSignOut={signOut} />;

  const currentNav = navItems.find((item) => item.id === page) || navItems[0];
  const currentRows = getInventoryRows(data, selectedPlant);

  const setPageSafe = (id) => {
    setPage(id);
    setMobileNavOpen(false);
  };

  return (
    <div className="app-shell">
      <Sidebar page={page} setPage={setPageSafe} mobileOpen={mobileNavOpen} onClose={() => setMobileNavOpen(false)} />
      <main className="main-shell">
        <header className="topbar">
          <button className="icon-button mobile-menu" aria-label="Mở menu" onClick={() => setMobileNavOpen(true)}><Menu size={19} /></button>
          <div className="breadcrumbs"><span>Kho xưởng</span><i>/</i><strong>{currentNav.label}</strong></div>
          <div className="topbar-actions">
            <span className={`connection-pill ${cloudMode ? 'is-cloud' : 'is-local'}`}>
              {cloudMode ? <Cloud size={14} /> : <CloudOff size={14} />}
              {cloudMode ? (saving ? 'Đang lưu' : 'Dữ liệu dùng chung') : 'Chế độ thiết bị'}
            </span>
            {cloudMode && <button className="icon-button" title="Tải lại dữ liệu" onClick={refreshCloud}><RefreshCw size={17} /></button>}
            <button className="button button-primary button-small" onClick={() => setPage('data-entry')}><Upload size={15} /> Tác vụ nhập liệu</button>
            {cloudMode && <button className="icon-button" title="Đăng xuất" onClick={signOut}><LogOut size={17} /></button>}
          </div>
        </header>

        <div className="page-content">
          {!cloudMode && <div className="local-notice"><ShieldCheck size={17} /><span><strong>Chưa kết nối cơ sở dữ liệu dùng chung.</strong> Dữ liệu đang lưu trên trình duyệt này. Kết nối Supabase để các nhà máy cùng xem và cập nhật.</span><button onClick={() => setModal('setup')}>Cách kết nối</button></div>}
          {page === 'overview' && <Dashboard data={data} setPage={setPageSafe} />}
          {page === 'orders' && <OrdersPage data={data} onAdd={() => setModal('order')} onProgress={updateOrderProgress} />}
          {page === 'requirements' && <RequirementsPage data={data} selectedWarehouse={selectedWarehouse} setWarehouse={setSelectedWarehouse} onExport={exportTask} onImport={importTask} busyTask={busyTask} />}
          {page === 'inventory' && <InventoryPage data={data} rows={currentRows} selectedPlant={selectedPlant} setPlant={setSelectedPlant} onUpdate={updateInventory} />}
          {page === 'catalog' && <CatalogPage data={data} tab={catalogTab} setTab={setCatalogTab} onAddMaterial={() => setModal('material')} onAddBom={() => setModal('bom')} />}
          {page === 'norms' && <NormsPage data={data} onAdd={() => setModal('norm')} />}
          {page === 'data-entry' && <DataTasksPage data={data} onImport={importTask} onExport={exportTask} busyTask={busyTask} taskErrors={taskErrors} onOpen={(taskId) => {
            if (taskId === 'orders' || taskId === 'wip' || taskId === 'production-orders') setPageSafe('orders');
            else if (taskId === 'product-mapping') { setSelectedWarehouse('LAF'); setPageSafe('requirements'); }
            else if (taskId === 'materials' || taskId === 'bom') { setCatalogTab(taskId); setPageSafe('catalog'); }
            else if (taskId === 'norms') { setPageSafe('norms'); setModal('norm'); }
            else if (taskId.startsWith('inventory:')) { setSelectedPlant(taskId.slice('inventory:'.length)); setPageSafe('inventory'); }
            else if (taskId.startsWith('chemical-norms:')) { setSelectedWarehouse(taskId.slice('chemical-norms:'.length)); setPageSafe('requirements'); }
          }} />}
        </div>
      </main>

      {modal === 'material' && <MaterialModal onClose={() => setModal('')} onSave={saveMaterial} />}
      {modal === 'bom' && <BomModal materials={data.materials} onClose={() => setModal('')} onSave={saveBom} />}
      {modal === 'norm' && <NormModal materials={data.materials} onClose={() => setModal('')} onSave={saveNorm} />}
      {modal === 'order' && <OrderModal onClose={() => setModal('')} onSave={saveOrder} />}
      {modal === 'setup' && <SetupModal onClose={() => setModal('')} />}
      {toast && <div className="toast"><Check size={16} />{toast}</div>}
    </div>
  );
}

function Sidebar({ page, setPage, mobileOpen, onClose }) {
  return (
    <>
      <div className={`sidebar-backdrop ${mobileOpen ? 'visible' : ''}`} onClick={onClose} />
      <aside className={`sidebar ${mobileOpen ? 'open' : ''}`}>
        <div className="brand-lockup">
          <div className="brand-mark"><Package size={21} strokeWidth={2.2} /></div>
          <div><div className="brand-name">kho<span>xưởng</span></div><div className="brand-caption">WORKSHOP CONTROL</div></div>
          <button className="icon-button close-sidebar" aria-label="Đóng menu" onClick={onClose}><X size={18} /></button>
        </div>
        <div className="workspace-selector"><div className="workspace-avatar">K</div><div className="workspace-copy"><strong>Kho tổng hợp</strong><span>4 kho · 2 nhà máy</span></div><ChevronDown size={15} /></div>
        <div className="nav-label">KHÔNG GIAN LÀM VIỆC</div>
        <nav className="main-nav">
          {navItems.map(({ id, label, icon: Icon }) => (
            <button key={id} className={`nav-item ${page === id ? 'active' : ''}`} onClick={() => setPage(id)}>
              <Icon size={18} strokeWidth={1.9} /><span>{label}</span>{id === 'inventory' && <span className="nav-dot" />}
            </button>
          ))}
        </nav>
        <div className="sidebar-section">
          <div className="nav-label">NHÀ MÁY</div>
          {WAREHOUSES.map((warehouse) => <div className="plant-link" key={warehouse.id}><span className={`plant-dot ${warehouse.color}`} />{warehouse.name}</div>)}
        </div>
        <div className="sidebar-bottom">
          <div className="help-card"><div className="help-icon"><Activity size={17} /></div><strong>Quản lý kho rõ ràng</strong><p>Đồng bộ tiến độ và kiểm kê trên một màn hình.</p><button onClick={() => setPage('catalog')}>Xem danh mục <span>→</span></button></div>
          <div className="user-mini"><div className="user-avatar">K</div><div><strong>Người vận hành</strong><span>Quản lý kho</span></div><ChevronDown size={15} /></div>
        </div>
      </aside>
    </>
  );
}

function Dashboard({ data, setPage }) {
  const orders = currentOrderRows(data);
  const summaries = PLANTS.map((plant) => getPlantSummary(data, plant.id));
  const allSummary = summaries.reduce((acc, item) => {
    for (const key of ['count', 'active', 'enough', 'surplus', 'shortage', 'received', 'wip', 'need', 'actual', 'variance']) acc[key] += item[key];
    return acc;
  }, { count: 0, active: 0, enough: 0, surplus: 0, shortage: 0, received: 0, wip: 0, need: 0, actual: 0, variance: 0 });
  const ordersRunning = orders.filter((order) => order.productionQty !== undefined ? Number(order.productionQty) > 0 : Object.values(order.progress || {}).some((value) => Number(value) > 0)).length;
  const runningPairs = orders.reduce((sum, order) => sum + (order.productionQty !== undefined ? (Number(order.productionQty) || 0) : Object.values(order.progress || {}).reduce((inner, value) => inner + (Number(value) || 0), 0)), 0);
  const max = Math.max(1, ...summaries.map((item) => item.count));
  const alerts = summaries.flatMap((summary) => getInventoryRows(data, summary.plant).filter((row) => row.status === 'Thiếu').map((row) => ({ ...row, plantName: getPlantName(summary.plant) }))).slice(0, 5);
  return (
    <>
      <div className="page-heading">
        <div><div className="eyebrow">{new Intl.DateTimeFormat('vi-VN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date()).toUpperCase()} <span>•</span> TỔNG HỢP 3 KHU VỰC</div><h1>Tổng quan kho xưởng</h1><p>Theo dõi đơn hàng, định mức và tình trạng vật tư trên cùng một hệ thống.</p></div>
        <button className="button button-secondary" onClick={() => setPage('inventory')}><ClipboardCheck size={16} /> Mở kiểm kê</button>
      </div>
      <div className="summary-grid">
        <MetricCard label="MÃ VẬT TƯ" value={money(allSummary.count)} detail={`${money(data.materials.length)} mã trên danh mục chung`} icon={Boxes} tint="teal" />
        <MetricCard label="ĐƠN HÀNG ĐANG CHẠY" value={money(ordersRunning)} detail={`${money(runningPairs)} đôi đã ghi nhận WIP`} icon={Layers3} tint="blue" />
        <MetricCard label="NHU CẦU BOM CÒN LẠI" value={money(allSummary.need, 1)} detail="Quy đổi theo đơn hàng và tiến độ" icon={ArrowLeftRight} tint="amber" />
        <MetricCard label="MÃ VẬT TƯ CẦN XỬ LÝ" value={money(allSummary.shortage)} detail={`${money(allSummary.surplus)} mã đang dư tại xưởng`} icon={CircleAlert} tint="rose" />
      </div>

      <div className="dashboard-grid">
        <section className="panel plant-panel">
          <div className="panel-heading"><div><h2>Tình hình theo nhà máy</h2><p>Số mã đang phát sinh và mức độ kiểm kê</p></div><button className="text-button" onClick={() => setPage('inventory')}>Chi tiết <span>→</span></button></div>
          <div className="plant-chart">
            {summaries.map((item) => {
              const plant = PLANTS.find((entry) => entry.id === item.plant);
              const activeWidth = item.count ? (item.active / item.count) * 100 : 0;
              const shortageWidth = item.count ? (item.shortage / item.count) * 100 : 0;
              return <div className="chart-row" key={item.plant}>
                <div className="chart-row-label"><span className={`plant-dot ${plant.color}`} />{plant.name}<strong>{money(item.count)} mã</strong></div>
                <div className="bar-track"><span className={`bar-fill ${plant.color}`} style={{ width: `${(item.count / max) * 100}%` }}><i style={{ width: `${activeWidth}%` }} /></span></div>
                <div className="chart-row-foot"><span>{money(item.active)} phát sinh</span><span className={item.shortage ? 'text-danger' : ''}>{money(item.shortage)} thiếu <span className="mini-meter"><i style={{ width: `${Math.min(100, shortageWidth * 8)}%` }} /></span></span></div>
              </div>;
            })}
            {!data.materials.length && <EmptyInline text="Chưa có danh mục vật tư. Nhập workbook để bắt đầu." />}
          </div>
          <div className="chart-legend"><span><i className="legend-dot active" /> Có phát sinh</span><span><i className="legend-dot" /> Danh mục</span><span><i className="legend-dot shortage" /> Cần xử lý</span></div>
        </section>

        <section className="panel reconciliation-panel">
          <div className="panel-heading"><div><h2>Đối chiếu tồn kho</h2><p>So sánh số lý thuyết với kiểm đếm thực tế</p></div><span className="period-badge">KỲ HIỆN TẠI</span></div>
          <div className="reconcile-total"><div><span>Chênh lệch thuần</span><strong className={allSummary.variance < 0 ? 'text-danger' : ''}>{money(allSummary.variance, 1)}</strong></div><div className={`delta-badge ${allSummary.variance < 0 ? 'negative' : 'positive'}`}>{allSummary.variance < 0 ? 'Thiếu' : 'Cân đối'} <ArrowDownToLine size={13} /></div></div>
          <div className="reconcile-rows">
            <ReconcileLine label="Lĩnh về từ kho tổng" value={allSummary.received} icon="receipt" />
            <ReconcileLine label="Sản xuất quy đổi WIP" value={allSummary.wip} icon="wip" />
            <ReconcileLine label="Tồn kiểm đếm thực tế" value={allSummary.actual} icon="count" />
          </div>
          <button className="button button-ghost full-width" onClick={() => setPage('inventory')}>Xem bảng đối chiếu <span>→</span></button>
        </section>
      </div>

      <div className="bottom-grid">
        <section className="panel table-panel">
          <div className="panel-heading"><div><h2>Đơn hàng gần đây</h2><p>Tiến độ theo mã hàng và màu sắc</p></div><button className="text-button" onClick={() => setPage('orders')}>Tất cả đơn hàng <span>→</span></button></div>
          {orders.length ? <div className="table-scroll"><table><thead><tr><th>MÃ ĐƠN HÀNG</th><th>MÃ HÀNG / MÀU</th><th>KẾ HOẠCH</th><th>TIẾN ĐỘ</th><th>TRẠNG THÁI</th></tr></thead><tbody>{orders.slice(0, 5).map((order) => {
            const done = Object.values(order.progress || {}).reduce((sum, value) => sum + (Number(value) || 0), 0);
            const production = order.productionQty !== undefined ? Number(order.productionQty) || 0 : done;
            const percent = order.plannedQty ? Math.min(100, (production / order.plannedQty) * 100) : 0;
            return <tr key={orderKey(order)}><td><strong>{order.orderNo}</strong></td><td><span className="product-code">{order.model}</span><small>{order.color} · {order.colorName || 'Chưa ghi tên màu'}</small></td><td className="numeric">{money(order.plannedQty)}</td><td><div className="progress-cell"><div className="progress-track"><i style={{ width: `${percent}%` }} /></div><span>{Math.round(percent)}%</span></div></td><td><StatusBadge status={production > 0 ? 'Đang sản xuất' : order.status || 'Chờ sản xuất'} /></td></tr>;
          })}</tbody></table></div> : <EmptyState title="Chưa có đơn hàng" text="Nhập file DON HANG.xlsx hoặc thêm đơn thủ công." action="Nhập đơn hàng" onAction={() => setPage('orders')} />}
        </section>
        <section className="panel alerts-panel">
          <div className="panel-heading"><div><h2>Cần chú ý</h2><p>Các mã vật tư đang thiếu theo kiểm kê</p></div><span className="alert-count">{alerts.length}</span></div>
          {alerts.length ? <div className="alert-list">{alerts.map((row) => <div className="alert-row" key={`${row.plant}|${row.catalogNo}`}><div className="alert-symbol"><CircleAlert size={16} /></div><div className="alert-copy"><strong>{row.materialCode} · {row.name}</strong><span>{row.plantName} <i>·</i> Lệch {money(row.variance, 1)} {row.unit}</span></div><StatusBadge status="Thiếu" /></div>)}</div> : <div className="all-clear"><div><Check size={20} /></div><strong>Chưa có cảnh báo thiếu</strong><span>{data.materials.length ? 'Kiểm kê vật tư đang trong ngưỡng.' : 'Nhập dữ liệu để bắt đầu theo dõi.'}</span></div>}
          <button className="text-button alert-footer" onClick={() => setPage('inventory')}>Mở kiểm kê <span>→</span></button>
        </section>
      </div>
    </>
  );
}

function MetricCard({ label, value, detail, icon: Icon, tint }) {
  return <div className="metric-card"><div className={`metric-icon ${tint}`}><Icon size={19} /></div><div className="metric-label">{label}</div><div className="metric-value">{value}</div><div className="metric-detail">{detail}</div><div className={`metric-line ${tint}`} /></div>;
}

function ReconcileLine({ label, value, icon }) {
  return <div className="reconcile-line"><span className={`reconcile-icon ${icon}`}>{icon === 'receipt' ? '↓' : icon === 'wip' ? '↗' : '◉'}</span><span>{label}</span><strong>{money(value, 1)}</strong></div>;
}

function DataTasksPage({ data, onImport, onExport, busyTask, taskErrors, onOpen }) {
  const latestProductionBatch = data.importMeta?.['production-orders']?.batchId;
  const currentProductionOrders = latestProductionBatch
    ? data.productionOrders.filter((row) => row.batchId === latestProductionBatch)
    : data.productionOrders;
  const chemicalCount = (warehouseId) => {
    const taskId = 'chemical-norms:' + warehouseId;
    const batchId = data.importMeta?.[taskId]?.batchId;
    return data.chemicalNorms.filter((row) => row.warehouseId === warehouseId && (!batchId || row.batchId === batchId)).length;
  };
  const tasks = [
    { id: 'orders', title: 'Kế hoạch đơn hàng', description: 'Nhập mã đơn, mã hàng-màu, nhà máy và số lượng kế hoạch.', source: 'DON HANG.xlsx · ADIDAS / LƯU HÓA', count: data.orders.length, unit: 'đơn', icon: Layers3, color: 'blue', action: 'Mở nhập đơn hàng' },
    { id: 'production-orders', title: 'Tiến độ & lệnh sản xuất', description: 'Nhập khóa chỉ lệnh, mã hàng-màu, số lượng đã phát lệnh và sản lượng theo từng công đoạn.', source: 'TIEN-DO-SX-DONHANG.xlsx · sheet New', count: currentProductionOrders.length, unit: 'chỉ lệnh', icon: Activity, color: 'teal', action: 'Mở tiến độ sản xuất' },
    { id: 'product-mapping', title: 'Mapping mã hàng - màu BOM', description: 'Nối tên mã hàng/màu ở tiến độ với mã hàng và mã màu nội bộ trong BOM; dùng cho đơn chưa có mã màu từ định mức Hóa mẫu.', source: 'File riêng · Mapping_Ma_Hang_Mau', count: data.productMappings.length, unit: 'mapping', icon: ArrowLeftRight, color: 'amber', action: 'Mở nhu cầu theo kho' },
    { id: 'wip', title: 'Tiến độ WIP', description: 'Cập nhật sản lượng theo từng đơn và từng nhà máy.', source: 'File riêng · TienDo_WIP', count: data.orders.length, unit: 'đơn có thể cập nhật', icon: Activity, color: 'teal', action: 'Mở nhập tiến độ' },
    { id: 'materials', title: 'Danh mục vật tư', description: 'Quản lý một mã vật tư dùng cho một hoặc nhiều nhà máy.', source: 'Workbook · 1_Danh_Muc_Va_Ma_Tran_BOM', count: data.materials.length, unit: 'mã', icon: Boxes, color: 'green', action: 'Mở nhập vật tư' },
    { id: 'bom', title: 'Định mức BOM trực tiếp', description: 'Nhập định mức và khai báo kho nhận, công đoạn, luồng cấp phát khi vật tư dùng nhiều nhà máy.', source: 'Workbook · ma trận mã hàng-màu hoặc Dinh_Muc_BOM', count: data.bom.length, unit: 'dòng', icon: ArrowLeftRight, color: 'amber', action: 'Mở nhập BOM' },
    ...['HOA_MAU_LAF', 'HOA_MAU_LVF'].map((warehouseId) => ({
      id: 'chemical-norms:' + warehouseId,
      title: 'Định mức Hóa mẫu · ' + (warehouseId.endsWith('LAF') ? 'LAF' : 'LVF'),
      description: 'Đọc DM-NPL-DH và ghép từng hóa chất với chỉ lệnh, mã hàng, màu và số lượng lệnh sản xuất.',
      source: warehouseId.endsWith('LAF') ? 'DM-MATHANG-HOAMAU LAF-CANLUYEN' : 'Nguồn định mức Hóa mẫu LVF',
      count: chemicalCount(warehouseId),
      unit: 'dòng định mức',
      icon: FileSpreadsheet,
      color: 'violet',
      action: 'Mở nhu cầu theo kho',
    })),
    ...PLANTS.map((plant) => ({
      id: 'inventory:' + plant.id,
      title: 'Lĩnh về & kiểm kê · ' + plant.name,
      description: 'Nhập số lượng lĩnh về và kết quả đếm thực tế cho khu vực này.',
      source: 'Workbook · ' + (plant.id === 'HOA_MAU' ? '2_Kho_Hoa_Mau' : plant.id === 'LAF' ? '3_Kho_Xuong_LAF' : '4_Kho_Xuong_LVF'),
      count: data.materials.filter((material) => (material.plants || []).includes(plant.id)).length,
      unit: 'mã vật tư',
      icon: ClipboardCheck,
      color: plant.color,
      action: 'Mở nhập kiểm kê',
    })),
    { id: 'norms', title: 'Định mức BTP theo size · LAF', description: 'Nhập vật tư, mã hàng-màu, size, công đoạn, định mức, kế hoạch và WIP theo size.', source: 'Workbook · DM_BTP_Size_LAF', count: data.norms.length, unit: 'dòng', icon: Settings2, color: 'violet', action: 'Mở nhập định mức' },
  ];

  return <>
    <div className="page-heading"><div><div className="eyebrow">TRUNG TÂM DỮ LIỆU <span>•</span> TÁCH RIÊNG THEO TỪNG TÁC VỤ</div><h1>Tác vụ nhập liệu</h1><p>Mỗi phần dữ liệu có file import, export và biểu mẫu riêng theo cấu trúc workbook.</p></div></div>
    <div className="task-guidance"><FileSpreadsheet size={18} /><span><strong>Không phụ thuộc công thức Excel.</strong> Chỉ nhập các cột đầu vào. Nhu cầu BOM, tồn lý thuyết, chênh lệch và số còn lại do ứng dụng tự tính.</span></div>
    <div className="task-grid">
      {tasks.map((task) => {
        const Icon = task.icon;
        return <article className="task-card" key={task.id}>
          <div className="task-card-top"><div className={`task-icon ${task.color}`}><Icon size={19} /></div><span className="task-count"><strong>{money(task.count)}</strong> {task.unit}</span></div>
          <h2>{task.title}</h2>
          <p className="task-description">{task.description}</p>
          <div className="task-source"><FileSpreadsheet size={13} /><span>{task.source}</span></div>
          <div className="task-actions">
            <label className="button button-primary button-small upload-control"><Upload size={14} />{busyTask === task.id ? 'Đang nhập...' : 'Import file'}
              <input type="file" accept=".xlsx,.xlsm" disabled={Boolean(busyTask)} onChange={(event) => { const file = event.target.files?.[0]; if (file) onImport(task.id, file); event.target.value = ''; }} />
            </label>
            <button className="button button-secondary button-small" onClick={() => onExport(task.id)}><ArrowDownToLine size={14} /> Export dữ liệu</button>
            <button className="task-template-button" onClick={() => onExport(task.id, true)}>Tải mẫu trống</button>
          </div>
          {taskErrors[task.id] && <div className="task-error"><CircleAlert size={14} />{taskErrors[task.id]}</div>}
          <button className="task-manual-button" onClick={() => onOpen(task.id)}>{task.action}<span>→</span></button>
        </article>;
      })}
    </div>
  </>;
}

function OrdersPage({ data, onAdd, onProgress }) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('Tất cả');
  const allOrders = currentOrderRows(data);
  const hasSourceProgress = allOrders.some((order) => order.stageQuantities);
  const orders = allOrders.filter((order) => {
    const q = query.toLowerCase();
    const matches = !q || `${order.orderNo} ${order.purchaseOrder || ''} ${order.model} ${order.color} ${order.colorName || ''} ${order.customer || ''}`.toLowerCase().includes(q);
    const running = Number(order.productionQty) > 0 || Object.values(order.stageQuantities || {}).some((value) => Number(value) > 0) || Object.values(order.progress || {}).some((value) => Number(value) > 0);
    return matches && (filter === 'Tất cả' || (filter === 'Đang chạy' ? running : !running));
  });
  const plannedTotal = allOrders.reduce((sum, item) => sum + (Number(item.plannedQty) || 0), 0);
  const releasedTotal = allOrders.reduce((sum, item) => sum + (Number(item.productionQty ?? item.plannedQty) || 0), 0);
  return <>
    <div className="page-heading"><div><div className="eyebrow">BẢNG A <span>•</span> TIẾN ĐỘ THEO MÃ HÀNG & MÀU SẮC</div><h1>Đơn hàng sản xuất</h1><p>Mỗi dòng là một chỉ lệnh và khóa mã hàng-màu; lệnh sản xuất cùng tiến độ từng công đoạn được giữ theo nguồn.</p></div><button className="button button-primary" onClick={onAdd}><Plus size={16} /> Thêm đơn hàng</button></div>
    <div className="metric-strip"><MetricInline label="TỔNG CHỈ LỆNH" value={money(allOrders.length)} /><MetricInline label="SL ĐƠN HÀNG" value={money(plannedTotal)} /><MetricInline label="SL ĐÃ PHÁT LỆNH SX" value={money(releasedTotal)} /><MetricInline label="MÃ HÀNG - MÀU" value={money(new Set(allOrders.map((order) => productKey(order.model, order.color))).size)} /></div>
    <section className="panel table-panel page-table-panel"><div className="table-toolbar"><div className="search-input"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Tìm mã đơn, mã hàng, màu..." /></div><div className="toolbar-right"><div className="filter-pills">{['Tất cả', 'Đang chạy', 'Chờ sản xuất'].map((label) => <button key={label} className={filter === label ? 'selected' : ''} onClick={() => setFilter(label)}>{label}</button>)}</div><button className="icon-button"><Filter size={17} /></button></div></div>
      {orders.length ? <div className="table-scroll"><table className="orders-table">{hasSourceProgress ? <><thead><tr><th>CHỈ LỆNH / PO</th><th>MÃ HÀNG & MÀU</th><th>KHÁCH HÀNG</th><th className="numeric">SL ĐƠN</th><th className="numeric">SL LỆNH SX</th><th className="numeric">CHẶT · LAF/HM</th><th className="numeric">MAY · LVF/HM</th><th className="numeric">GÒ · LVF/HM</th><th className="numeric">NHẬP KHO</th><th className="numeric">GIAO HÀNG</th><th>TRẠNG THÁI</th></tr></thead><tbody>{orders.map((order) => <tr key={orderKey(order)}><td><strong>{order.orderNo}</strong><small>{order.purchaseOrder || order.sourceSheet || '—'}</small></td><td><span className="product-code">{order.model}</span><small>{order.color}</small></td><td>{order.customer || '—'}</td><td className="numeric">{money(order.plannedQty)}</td><td className="numeric strong-cell">{money(order.productionQty)}</td><td className="numeric">{money(order.stageQuantities?.LAF_CUT || 0)}</td><td className="numeric">{money(order.stageQuantities?.LVF_SEW || 0)}</td><td className="numeric">{money(order.stageQuantities?.LVF_GO || 0)}</td><td className="numeric">{money(order.stageQuantities?.RECEIVED || 0)}</td><td className="numeric">{money(order.stageQuantities?.SHIPPED || 0)}</td><td><StatusBadge status={order.productionQty > 0 ? 'Đang sản xuất' : order.status || 'Chờ sản xuất'} /></td></tr>)}</tbody></> : <><thead><tr><th>CHỈ LỆNH / PO</th><th>MÃ HÀNG & MÀU SẮC</th><th>NHÀ MÁY</th><th className="numeric">SL KẾ HOẠCH</th>{PLANTS.map((plant) => <th className="numeric" key={plant.id}>WIP {plant.short}</th>)}<th className="numeric">CÒN LẠI</th><th>TRẠNG THÁI</th></tr></thead><tbody>{orders.map((order) => {
        const done = Object.values(order.progress || {}).reduce((sum, value) => sum + (Number(value) || 0), 0);
        const remaining = Math.max(0, (Number(order.plannedQty) || 0) - done);
        return <tr key={orderKey(order)}><td><strong>{order.orderNo}</strong><small>{order.sourceSheet || 'Nhập trực tiếp'}</small></td><td><span className="product-code">{order.model}</span><small>{order.color} · {order.colorName || '—'}</small></td><td>{order.plant ? <PlantTag plantId={order.plant} /> : '—'}</td><td className="numeric">{money(order.plannedQty)}</td>{PLANTS.map((plant) => <td className="numeric" key={plant.id}><NumberInput className="cell-input numeric-input" value={order.progress?.[plant.id] ?? 0} onSave={(value) => onProgress(order, plant.id, value)} /></td>)}<td className="numeric strong-cell">{money(remaining)}</td><td><StatusBadge status={done ? 'Đang sản xuất' : order.status || 'Chờ sản xuất'} /></td></tr>;
      })}</tbody></>}</table></div> : <EmptyState title="Chưa có đơn hàng phù hợp" text="Nhập TIEN-DO-SX-DONHANG hoặc tạo đơn hàng mới để bắt đầu theo dõi." action="Thêm đơn hàng" onAction={onAdd} />}
      <div className="table-footnote"><span>{hasSourceProgress ? 'Tiến độ U:Z được giữ riêng từng công đoạn, không cộng dồn giữa các nhà máy.' : 'Tiến độ WIP theo từng nhà máy'}</span><span>{money(orders.length)} dòng hiển thị</span></div>
    </section>
  </>;
}

function MetricInline({ label, value }) { return <div><span>{label}</span><strong>{value}</strong></div>; }

function NumberInput({ value, onSave, className, placeholder = '', min = '0' }) {
  const [draft, setDraft] = useState(value ?? '');
  useEffect(() => setDraft(value ?? ''), [value]);
  return <input
    className={className}
    type="number"
    min={min}
    placeholder={placeholder}
    value={draft}
    onChange={(event) => setDraft(event.target.value)}
    onBlur={() => { if (String(draft) !== String(value ?? '')) onSave(draft); }}
    onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); }}
  />;
}

function InventoryPage({ data, rows, selectedPlant, setPlant, onUpdate }) {
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('Tất cả');
  const summary = getPlantSummary(data, selectedPlant);
  const filtered = rows.filter((row) => {
    const q = query.toLowerCase();
    const matchesQuery = !q || `${row.catalogNo} ${row.materialCode} ${row.name} ${row.colorScope}`.toLowerCase().includes(q);
    return matchesQuery && (statusFilter === 'Tất cả' || row.status === statusFilter);
  });
  const exportCsv = () => {
    const header = ['STT danh mục', 'Mã vật tư', 'Tên vật tư', 'ĐVT', 'Nhu cầu BOM', 'Lĩnh về', 'Sản xuất WIP', 'Tồn lý thuyết', 'Kiểm kê thực tế', 'Chênh lệch', 'Trạng thái'];
    const lines = filtered.map((row) => [row.catalogNo, row.materialCode, row.name, row.unit, row.plannedNeed, row.received, row.wipNeed, row.theoretical, row.actual ?? '', row.variance ?? '', row.status]);
    const csv = [header, ...lines].map((line) => line.map((value) => `"${String(value).replaceAll('"', '""')}"`).join(',')).join('\r\n');
    const url = URL.createObjectURL(new Blob(['\ufeff', csv], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = `kiem-ke-${selectedPlant.toLowerCase()}.csv`; link.click(); URL.revokeObjectURL(url);
  };
  return <>
    <div className="page-heading"><div><div className="eyebrow">BẢNG B <span>•</span> NHU CẦU BOM & ĐỐI CHIẾU THỰC TẾ</div><h1>Kiểm kê vật tư</h1><p>Ghi nhận lĩnh về và số đếm thực tế; hệ thống tự tính tồn lý thuyết, chênh lệch và trạng thái.</p></div><button className="button button-secondary" onClick={exportCsv}><ArrowDownToLine size={16} /> Xuất CSV</button></div>
    <div className="plant-tabs">{PLANTS.map((plant) => <button key={plant.id} className={selectedPlant === plant.id ? 'active' : ''} onClick={() => setPlant(plant.id)}><span className={`plant-dot ${plant.color}`} />{plant.name}<b>{data.materials.filter((material) => material.plants?.includes(plant.id)).length}</b></button>)}</div>
    <div className="metric-strip inventory-metrics"><MetricInline label="Mã danh mục" value={money(summary.count)} /><MetricInline label="Có phát sinh" value={money(summary.active)} /><MetricInline label="Nhu cầu BOM còn lại" value={money(summary.need, 1)} /><MetricInline label="Lĩnh về" value={money(summary.received, 1)} /><MetricInline label="Chênh lệch thuần" value={money(summary.variance, 1)} /></div>
    <section className="panel table-panel page-table-panel"><div className="table-toolbar"><div className="search-input"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Tìm mã hoặc tên vật tư..." /></div><div className="toolbar-right"><select className="select-compact" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}><option>Tất cả</option><option>Đủ</option><option>Dư</option><option>Thiếu</option><option>Chưa kiểm kê</option><option>Chưa phát sinh</option></select><button className="icon-button"><Filter size={17} /></button></div></div>
      {filtered.length ? <div className="table-scroll"><table className="inventory-table"><thead><tr><th>STT</th><th>MÃ VẬT TƯ / TÊN VẬT TƯ</th><th>PHẠM VI</th><th>ĐVT</th><th className="numeric">NHU CẦU BOM</th><th className="numeric">LĨNH VỀ</th><th className="numeric">SX WIP</th><th className="numeric">TỒN LÝ THUYẾT</th><th className="numeric">KIỂM KÊ THỰC TẾ</th><th className="numeric">CHÊNH LỆCH</th><th>TRẠNG THÁI</th></tr></thead><tbody>{filtered.map((row) => <tr key={`${row.plant}|${row.catalogNo}`}><td className="muted-cell">{row.catalogNo}</td><td><strong>{row.materialCode}</strong><small>{row.name}</small></td><td>{row.colorScope || '—'}</td><td>{row.unit || '—'}</td><td className="numeric">{money(Math.max(0, row.plannedNeed - row.wipNeed), 2)}</td><td className="numeric"><NumberInput className="cell-input numeric-input" value={row.received} onSave={(value) => onUpdate(row, 'received', value)} /></td><td className="numeric">{money(row.wipNeed, 2)}</td><td className="numeric strong-cell">{money(row.theoretical, 2)}</td><td className="numeric"><NumberInput className="cell-input numeric-input count-input" placeholder="Nhập số đếm" value={row.actual ?? ''} onSave={(value) => onUpdate(row, 'actual', value)} /></td><td className={`numeric ${row.variance < 0 ? 'text-danger' : row.variance > 0 ? 'text-warning' : ''}`}>{row.variance === null ? '—' : money(row.variance, 2)}</td><td><StatusBadge status={row.status} /></td></tr>)}</tbody></table></div> : <EmptyState title="Chưa có vật tư cho khu vực này" text="Nhập danh mục từ file thống kê kho để tự chia mã theo nhà máy." action="Nhập Excel" onAction={() => window.dispatchEvent(new CustomEvent('open-import'))} />}
      <div className="table-footnote"><span>Tồn lý thuyết = Lĩnh về − Sản xuất quy đổi WIP</span><span>{money(filtered.length)} / {money(rows.length)} mã</span></div>
    </section>
  </>;
}

function RequirementsPage({ data, selectedWarehouse, setWarehouse, onExport, onImport, busyTask }) {
  const [query, setQuery] = useState('');
  const [selectedMaterial, setSelectedMaterial] = useState(null);
  const allRequirements = useMemo(() => new Map(WAREHOUSES.map((warehouse) => [warehouse.id, getTheoreticalRequirements(data, warehouse.id)])), [data]);
  const current = allRequirements.get(selectedWarehouse) || { rows: [], unmapped: [], hasSource: false };
  const searchable = useMemo(() => current.rows.filter((row) => !query || `${row.orderNo} ${row.purchaseOrder} ${row.model} ${row.color} ${row.component} ${row.formulaName} ${row.materialCode} ${row.materialName}`.toLowerCase().includes(query.toLowerCase())), [current, query]);
  const summaries = useMemo(() => summarizeTheoreticalRequirements(searchable), [searchable]);
  const selected = WAREHOUSES.find((item) => item.id === selectedWarehouse);
  const importTask = selected?.kind === 'chemical' ? `chemical-norms:${selectedWarehouse}` : 'bom';
  const importInfo = data.importMeta?.[importTask];
  const orderCount = new Set(searchable.map((row) => row.orderNo)).size;
  const missingSource = !current.hasSource;
  return <>
    <div className="page-heading"><div><div className="eyebrow">BẢNG NHU CẦU <span>•</span> DỮ LIỆU ĐÃ CHUẨN HÓA THEO KHO</div><h1>Nhu cầu vật tư lý thuyết</h1><p>Nhu cầu hóa chất lấy theo định mức chi tiết từng chỉ lệnh; vật tư trực tiếp lấy theo BOM và kho nhận đã khai báo.</p></div><button className="button button-secondary" onClick={() => onExport(`requirements:${selectedWarehouse}`)}><ArrowDownToLine size={16} /> Xuất chi tiết</button></div>
    <div className="plant-tabs warehouse-tabs">{WAREHOUSES.map((warehouse) => {
      const calc = allRequirements.get(warehouse.id) || { rows: [] };
      const count = summarizeTheoreticalRequirements(calc.rows).length;
      return <button key={warehouse.id} className={selectedWarehouse === warehouse.id ? 'active' : ''} onClick={() => setWarehouse(warehouse.id)}><span className={`plant-dot ${warehouse.color}`} />{warehouse.name}<b>{count}</b></button>;
    })}</div>
    <div className="task-guidance"><FileSpreadsheet size={18} /><span><strong>Cơ sở tính:</strong> định mức hóa chất / đôi = Số lượng hóa chất ÷ SL đơn hàng nguồn; nhu cầu theo lệnh = định mức / đôi × SL lệnh SX. Với BOM trực tiếp có công đoạn, nhu cầu còn lại = định mức × max(0, SL lệnh SX − SL đã qua công đoạn).</span></div>
    <div className="metric-strip inventory-metrics"><MetricInline label="MÃ VẬT TƯ CÓ NHU CẦU" value={money(summaries.length)} /><MetricInline label="CHỈ LỆNH CÓ NHU CẦU" value={money(orderCount)} /><MetricInline label="DÒNG ĐỊNH MỨC ĐÃ GHÉP" value={money(searchable.length)} /><MetricInline label="DÒNG CHƯA GHÉP / THIẾU KHO" value={money(current.unmapped.length)} /><MetricInline label="NGUỒN" value={current.hasSource ? 'Đã nạp' : 'Chưa có'} /></div>
    {current.unmapped.length > 0 && <div className="mapping-warning"><CircleAlert size={16} /><span><strong>{money(current.unmapped.length)} dòng cần xử lý mapping.</strong> Vật tư đa nhà máy phải có kho nhận cụ thể; dòng định mức cũng cần khớp đúng chỉ lệnh, mã hàng và màu. Xuất file chi tiết để rà soát.</span></div>}
    <section className="panel table-panel page-table-panel"><div className="table-toolbar"><div className="search-input"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Tìm mã vật tư, công đoạn, chỉ lệnh..." /></div><div className="toolbar-right"><span className="helper-label">{selected?.name}</span></div></div>
      {missingSource ? <div className="requirements-empty"><div className="empty-icon"><Boxes size={20} /></div><strong>Chưa có nguồn định mức cho {selected?.name}</strong><span>{selected?.kind === 'chemical' ? 'Nguồn DM Hóa mẫu của khu vực này chưa được nhập. Hệ thống để trống kết quả, không lấy định mức của LAF thay thế.' : 'Chưa có BOM trực tiếp hoặc chưa khai báo kho nhận LAF/LVF trong danh mục.'}</span><label className="button button-primary button-small upload-control"><Upload size={14} />{busyTask === importTask ? 'Đang nhập...' : selected?.kind === 'chemical' ? 'Import định mức Hóa mẫu' : 'Import BOM trực tiếp'}<input type="file" accept=".xlsx,.xlsm" disabled={Boolean(busyTask)} onChange={(event) => { const file = event.target.files?.[0]; if (file) onImport(importTask, file); event.target.value = ''; }} /></label></div>
        : summaries.length ? <div className="table-scroll"><table className="requirements-table"><thead><tr><th>CÔNG ĐOẠN / CỤM</th><th>MÃ VẬT TƯ / TÊN</th><th className="numeric">SỐ CHỈ LỆNH</th><th className="numeric">NHU CẦU LÝ THUYẾT</th><th>ĐVT</th><th>CHI TIẾT</th></tr></thead><tbody>{summaries.map((row, index) => <tr key={`${row.materialCode}|${row.component}|${index}`}><td>{row.component || '—'}</td><td><strong>{row.materialCode}</strong><small>{row.materialName}</small></td><td className="numeric">{money(row.orderCount)}</td><td className="numeric strong-cell">{money(row.quantity, 3)}</td><td>{row.unit || '—'}</td><td><button className="text-button" onClick={() => setSelectedMaterial(row)}>Theo đơn hàng →</button></td></tr>)}</tbody></table></div>
        : <div className="requirements-empty"><div className="empty-icon"><Search size={20} /></div><strong>Chưa có dòng nhu cầu khớp</strong><span>{current.hasSource ? 'Kiểm tra mã hàng, màu, chỉ lệnh hoặc số lượng lệnh sản xuất bằng 0.' : 'Nhập nguồn định mức và tiến độ sản xuất ở Tác vụ nhập liệu.'}</span></div>}
      <div className="table-footnote"><span>{importInfo ? `Nguồn: ${importInfo.sourceFile} · nạp ${new Intl.DateTimeFormat('vi-VN', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(importInfo.importedAt))}` : selected?.kind === 'factory' ? 'Nguồn: ma trận BOM + khai báo nhà máy/kho nhận' : 'Chưa nạp định mức nguồn cho kho này'}</span><span>{money(summaries.length)} mã vật tư</span></div>
    </section>
    {selectedMaterial && <RequirementsDetailModal row={selectedMaterial} warehouseName={selected?.name} onClose={() => setSelectedMaterial(null)} />}
  </>;
}

function RequirementsDetailModal({ row, warehouseName, onClose }) {
  const details = [...row.details].sort((a, b) => String(a.orderNo).localeCompare(String(b.orderNo), 'vi'));
  return <ModalShell title={`${row.materialCode} · ${row.materialName}`} subtitle={`${warehouseName} · ${row.component} · ${money(row.quantity, 3)} ${row.unit || ''}`} onClose={onClose}>
    <div className="table-scroll requirement-detail-scroll"><table><thead><tr><th>CHỈ LỆNH</th><th>PO</th><th>MÃ HÀNG / MÀU</th><th>CÔNG THỨC / CÔNG ĐOẠN</th><th className="numeric">ĐỊNH MỨC / ĐÔI</th><th>CƠ SỞ SỐ LƯỢNG</th><th className="numeric">SL QUY ĐỔI</th><th className="numeric">NHU CẦU</th></tr></thead><tbody>{details.map((line, index) => <tr key={`${line.orderNo}|${line.formulaName}|${line.sourceRow}|${index}`}><td>{line.orderNo}</td><td>{line.purchaseOrder || '—'}</td><td>{line.model}<small>{line.color}</small></td><td>{line.formulaName || line.component || '—'}</td><td className="numeric">{money(line.rate, 6)}</td><td>{line.basisType || 'Số lượng lệnh sản xuất'}</td><td className="numeric">{money(line.basisQty)}</td><td className="numeric strong-cell">{money(line.quantity, 3)} {line.unit}</td></tr>)}</tbody></table></div>
  </ModalShell>;
}

function CatalogPage({ data, tab, setTab, onAddMaterial, onAddBom }) {
  const [query, setQuery] = useState('');
  const materials = data.materials.filter((row) => `${row.catalogNo} ${row.materialCode} ${row.name} ${row.colorScope}`.toLowerCase().includes(query.toLowerCase()));
  const bom = data.bom.filter((row) => {
    const material = data.materials.find((item) => Number(item.catalogNo) === Number(row.catalogNo));
    return `${row.model} ${row.color} ${row.productKey} ${material?.materialCode} ${material?.name}`.toLowerCase().includes(query.toLowerCase());
  });
  return <>
    <div className="page-heading"><div><div className="eyebrow">DANH MỤC CHUNG <span>•</span> DÙNG CHO NHIỀU NHÀ MÁY</div><h1>Danh mục & định mức BOM</h1><p>Một vật tư có thể gắn nhiều nhà máy; mã ghép hàng-màu được lưu thành các dòng định mức.</p></div><button className="button button-primary" onClick={tab === 'materials' ? onAddMaterial : onAddBom}><Plus size={16} />{tab === 'materials' ? 'Thêm vật tư' : 'Thêm định mức'}</button></div>
    <div className="catalog-summary"><div><Boxes size={18} /><strong>{money(data.materials.length)}</strong><span>mã vật tư</span></div><div><ArrowLeftRight size={18} /><strong>{money(data.bom.length)}</strong><span>dòng BOM</span></div><div><Package size={18} /><strong>{money(new Set(data.bom.map((row) => row.productKey)).size)}</strong><span>mã hàng - màu</span></div><div><Layers3 size={18} /><strong>{money(data.materials.filter((row) => row.plants?.length > 1).length)}</strong><span>vật tư đa nhà máy</span></div></div>
    <section className="panel table-panel page-table-panel"><div className="catalog-toolbar"><div className="subtabs"><button className={tab === 'materials' ? 'active' : ''} onClick={() => setTab('materials')}>Vật tư <span>{money(data.materials.length)}</span></button><button className={tab === 'bom' ? 'active' : ''} onClick={() => setTab('bom')}>Ma trận BOM <span>{money(data.bom.length)}</span></button></div><div className="search-input"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Tìm trong danh mục..." /></div></div>
      {tab === 'materials' ? (materials.length ? <div className="table-scroll"><table><thead><tr><th>STT</th><th>MÃ VẬT TƯ</th><th>TÊN VẬT TƯ</th><th>NHÀ MÁY SỬ DỤNG</th><th>MÀU / PHẠM VI</th><th>ĐVT ERP</th><th>ĐVT CẤP PHÁT</th></tr></thead><tbody>{materials.map((row) => <tr key={row.catalogNo}><td>{row.catalogNo}</td><td><strong>{row.materialCode}</strong></td><td>{row.name}</td><td><div className="plant-tags">{(row.plants || []).map((plantId) => <PlantTag key={plantId} plantId={plantId} />)}</div></td><td>{row.colorScope || '—'}</td><td>{row.unit || '—'}</td><td>{row.issueUnit || '—'}</td></tr>)}</tbody></table></div> : <EmptyState title="Danh mục đang trống" text="Nhập file thống kê hoặc thêm vật tư mới. Dữ liệu mẫu không được nạp sẵn." action="Thêm vật tư" onAction={onAddMaterial} />) : (bom.length ? <div className="table-scroll"><table><thead><tr><th>MÃ HÀNG - MÀU</th><th>MÃ VẬT TƯ</th><th>TÊN VẬT TƯ</th><th>NHÀ MÁY</th><th className="numeric">ĐỊNH MỨC</th><th>ĐVT</th></tr></thead><tbody>{bom.map((line, index) => { const material = data.materials.find((item) => Number(item.catalogNo) === Number(line.catalogNo)); return <tr key={bomKey(line) + index}><td><strong>{line.productKey}</strong></td><td>{material?.materialCode || line.catalogNo}</td><td>{material?.name || '—'}</td><td>{line.plant ? getPlantName(line.plant) : 'Theo BOM chung'}</td><td className="numeric">{money(line.rate, 4)}</td><td>{material?.unit || '—'}</td></tr>; })}</tbody></table></div> : <EmptyState title="Ma trận BOM đang trống" text="Nhập workbook để nạp định mức theo từng cặp mã hàng - màu sắc." action="Nhập file" onAction={() => window.dispatchEvent(new CustomEvent('open-import'))} />)}
      <div className="table-footnote"><span>Vật tư dùng chung được gắn đồng thời với từng nhà máy được chọn.</span><span>{tab === 'materials' ? `${materials.length} mã` : `${bom.length} dòng`}</span></div>
    </section>
  </>;
}

function NormsPage({ data, onAdd }) {
  const [query, setQuery] = useState('');
  const norms = data.norms.filter((row) => `${row.catalogNo} ${row.productKey} ${row.size} ${row.process} ${row.btpCode} ${row.btpName}`.toLowerCase().includes(query.toLowerCase()));
  return <>
    <div className="page-heading"><div><div className="eyebrow">BẢNG PHỤ <span>•</span> NHÀ MÁY LAF</div><h1>Định mức BTP theo size</h1><p>Chi tiết vật tư, mã hàng-màu, size, công đoạn và định mức cho từng dòng bán thành phẩm.</p></div><button className="button button-primary" onClick={onAdd}><Plus size={16} />Thêm định mức size</button></div>
    <div className="metric-strip"><MetricInline label="Dòng định mức" value={money(data.norms.length)} /><MetricInline label="Vật tư liên quan" value={money(new Set(data.norms.map((row) => row.catalogNo)).size)} /><MetricInline label="Mã hàng - màu" value={money(new Set(data.norms.map((row) => row.productKey)).size)} /><MetricInline label="Công đoạn" value={money(new Set(data.norms.map((row) => row.process).filter(Boolean)).size)} /></div>
    <section className="panel table-panel page-table-panel"><div className="table-toolbar"><div className="search-input"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Tìm vật tư, mã hàng, size, công đoạn..." /></div><span className="helper-label">Từ sheet DM_BTP_Size_LAF</span></div>
      {norms.length ? <div className="table-scroll"><table><thead><tr><th>STT DM</th><th>MÃ VẬT TƯ / TÊN</th><th>MÃ HÀNG - MÀU</th><th>SIZE</th><th>CÔNG ĐOẠN</th><th>MÃ BTP</th><th>TÊN BTP</th><th className="numeric">ĐỊNH MỨC / ĐÔI</th><th className="numeric">SL KẾ HOẠCH</th><th className="numeric">NHU CẦU</th></tr></thead><tbody>{norms.map((row, index) => { const material = data.materials.find((item) => Number(item.catalogNo) === Number(row.catalogNo)); return <tr key={`${normKey(row)}|${index}`}><td>{row.catalogNo}</td><td><strong>{material?.materialCode || row.materialCode || '—'}</strong><small>{material?.name || row.materialName || '—'}</small></td><td>{row.productKey}</td><td>{row.size || '—'}</td><td>{row.process || '—'}</td><td>{row.btpCode || '—'}</td><td>{row.btpName || '—'}</td><td className="numeric">{money(row.rate, 4)}</td><td className="numeric">{money(row.plannedQty)}</td><td className="numeric">{money(row.rate * row.plannedQty, 2)}</td></tr>; })}</tbody></table></div> : <EmptyState title="Chưa có định mức size" text="Nhập file thống kê .xlsm/.xlsx. Sheet DM_BTP_Size_LAF sẽ được đọc riêng; sheet BTP trong DON HANG không được sử dụng." action="Nhập workbook" onAction={() => window.dispatchEvent(new CustomEvent('open-import'))} />}
      <div className="table-footnote"><span>Không lấy sheet BTP trong DON HANG.xlsx.</span><span>{money(norms.length)} dòng</span></div>
    </section>
  </>;
}

function PlantTag({ plantId }) {
  const plant = PLANTS.find((item) => item.id === plantId);
  return <span className={`plant-tag ${plant?.color || ''}`}><i />{plant?.name || plantId}</span>;
}

function StatusBadge({ status }) { return <span className={`status-badge ${statusTone(status)}`}><i />{status}</span>; }

function EmptyInline({ text }) { return <div className="empty-inline"><Package size={18} />{text}</div>; }
function EmptyState({ title, text, action, onAction }) { return <div className="empty-state"><div className="empty-illustration"><FileSpreadsheet size={25} /></div><strong>{title}</strong><p>{text}</p>{action && <button className="button button-secondary button-small" onClick={onAction}><Plus size={14} />{action}</button>}</div>; }

function LoginScreen({ onSubmit, error }) {
  return <div className="login-screen"><div className="login-card"><div className="brand-mark large"><Package size={25} /></div><div className="eyebrow">KHO XƯỞNG · HỆ THỐNG NỘI BỘ</div><h1>Đăng nhập</h1><p>Truy cập dữ liệu dùng chung của Hóa mẫu, LAF và LVF.</p><form onSubmit={onSubmit}><label>Email<input name="email" type="email" autoComplete="username" required placeholder="ten@congty.com" /></label><label>Mật khẩu<input name="password" type="password" autoComplete="current-password" required placeholder="••••••••••" /></label>{error && <div className="login-error">{error}</div>}<button className="button button-primary full-width" type="submit">Đăng nhập hệ thống</button></form><div className="login-note"><ShieldCheck size={15} /> Tài khoản được tạo bởi quản trị Supabase.</div></div></div>;
}

function CloudAccessScreen({ error, onSignOut }) {
  return <div className="login-screen"><div className="login-card"><div className="brand-mark large"><ShieldCheck size={25} /></div><div className="eyebrow">KHO XƯỞNG · QUYỀN TRUY CẬP</div><h1>Chưa có workspace</h1><p>{error}</p><p>Hãy nhờ quản trị viên thêm email của bạn vào <code>workspace_members</code>, rồi đăng nhập lại.</p><button className="button button-primary full-width" onClick={onSignOut}>Đăng xuất</button></div></div>;
}

function LoadingScreen({ label }) { return <div className="loading-screen"><div className="loader" /><strong>{label}</strong><span>Đang kết nối không gian dữ liệu</span></div>; }

function MaterialModal({ onClose, onSave }) {
  const [plants, setPlants] = useState(['LAF']);
  const toggle = (id) => setPlants((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  const submit = (event) => { event.preventDefault(); const form = Object.fromEntries(new FormData(event.currentTarget)); onSave({ ...form, plants }); };
  return <ModalShell title="Thêm vật tư" subtitle="Một mã vật tư có thể cùng lúc thuộc nhiều nhà máy." onClose={onClose}><form className="form-grid" onSubmit={submit}><label>STT danh mục<input name="catalogNo" type="number" min="1" placeholder="Tự tăng tiếp theo" /></label><label>Mã vật tư *<input name="materialCode" required placeholder="VD: VT-013" /></label><label className="field-span">Tên vật tư *<input name="name" required placeholder="Tên vật tư / quy cách" /></label><label>ĐVT ERP<input name="unit" placeholder="mét, kg, cái..." /></label><label>ĐVT cấp phát<input name="issueUnit" placeholder="cuộn, kiện..." /></label><label>Quy cách / kiện<input name="packQty" type="number" min="0" step="any" placeholder="0" /></label><label className="field-span">Phạm vi mã màu<input name="colorScope" placeholder="Dùng chung theo BOM hoặc mã màu" /></label><div className="field-span"><div className="form-label">Nhà máy sử dụng *</div><div className="plant-checks">{PLANTS.map((plant) => <label key={plant.id} className={`plant-check ${plants.includes(plant.id) ? 'checked' : ''}`}><input type="checkbox" checked={plants.includes(plant.id)} onChange={() => toggle(plant.id)} /><span className={`plant-dot ${plant.color}`} />{plant.name}</label>)}</div></div><div className="modal-actions field-span"><button type="button" className="button button-ghost" onClick={onClose}>Hủy</button><button type="submit" className="button button-primary"><Check size={15} /> Lưu vật tư</button></div></form></ModalShell>;
}

function BomModal({ materials, onClose, onSave }) {
  const [plant, setPlant] = useState('LAF');
  const submit = (event) => { event.preventDefault(); onSave({ ...Object.fromEntries(new FormData(event.currentTarget)), plant }); };
  return <ModalShell title="Thêm định mức BOM" subtitle="Nhập một dòng định mức cho cặp mã hàng - màu sắc." onClose={onClose}><form className="form-grid" onSubmit={submit}><label className="field-span">Vật tư<select name="catalogNo" required defaultValue=""><option value="" disabled>Chọn vật tư</option>{materials.map((item) => <option key={item.catalogNo} value={item.catalogNo}>{item.catalogNo} · {item.materialCode} · {item.name}</option>)}</select></label><label>Mã hàng<input name="model" required placeholder="VD: SP001" /></label><label>Mã màu<input name="color" required placeholder="VD: BLACK-001" /></label><label>Định mức / đôi<input name="rate" required type="number" min="0" step="0.0001" /></label><label>Nhà máy<select value={plant} onChange={(event) => setPlant(event.target.value)}><option value="LAF">LAF</option><option value="LVF">LVF</option><option value="HOA_MAU">Hóa mẫu</option></select></label><div className="modal-actions field-span"><button type="button" className="button button-ghost" onClick={onClose}>Hủy</button><button className="button button-primary" type="submit"><Check size={15} /> Lưu định mức</button></div></form></ModalShell>;
}

function OrderModal({ onClose, onSave }) {
  const submit = (event) => { event.preventDefault(); onSave(Object.fromEntries(new FormData(event.currentTarget))); };
  return <ModalShell title="Thêm đơn hàng" subtitle="Nhập một dòng theo chỉ lệnh / mã hàng / màu sắc." onClose={onClose}><form className="form-grid" onSubmit={submit}><label>Mã đơn hàng / LSX *<input name="orderNo" required placeholder="VD: LSX-2609-001" /></label><label>Mã hàng *<input name="model" required /></label><label>Mã màu *<input name="color" required /></label><label>Tên màu<input name="colorName" /></label><label>Nhà máy chính<select name="plant" defaultValue="LAF"><option value="HOA_MAU">Hóa mẫu</option><option value="LAF">LAF</option><option value="LVF">LVF</option></select></label><label>Số lượng kế hoạch (đôi) *<input name="plannedQty" required type="number" min="1" /></label><div className="modal-actions field-span"><button type="button" className="button button-ghost" onClick={onClose}>Hủy</button><button type="submit" className="button button-primary"><Check size={15} /> Lưu đơn hàng</button></div></form></ModalShell>;
}

function NormModal({ materials, onClose, onSave }) {
  const submit = (event) => { event.preventDefault(); onSave(Object.fromEntries(new FormData(event.currentTarget))); };
  return <ModalShell title="Thêm định mức BTP theo size" subtitle="Mỗi dòng là một vật tư cho mã hàng-màu, size và công đoạn LAF." onClose={onClose}>
    <form className="form-grid" onSubmit={submit}>
      <label className="field-span">Vật tư *<select name="catalogNo" required defaultValue=""><option value="" disabled>Chọn vật tư trong danh mục</option>{materials.map((item) => <option key={item.catalogNo} value={item.catalogNo}>{item.catalogNo} · {item.materialCode} · {item.name}</option>)}</select></label>
      <label>Mã hàng *<input name="model" required placeholder="VD: NVQ89" /></label><label>Mã màu *<input name="color" required placeholder="VD: LC1783" /></label>
      <label>Size *<input name="size" required placeholder="VD: 7" /></label><label>Công đoạn LAF<input name="process" placeholder="VD: Lót / Tẩy" /></label>
      <label>Mã BTP<input name="btpCode" /></label><label>Tên BTP<input name="btpName" /></label>
      <label>Định mức / 1 đôi *<input name="rate" type="number" min="0.000001" step="any" required /></label><label>SL kế hoạch theo size<input name="plannedQty" type="number" min="0" step="any" defaultValue="0" /></label>
      <label>SL WIP LAF theo size<input name="wipQty" type="number" min="0" step="any" defaultValue="0" /></label>
      <div className="modal-actions field-span"><button type="button" className="button button-ghost" onClick={onClose}>Hủy</button><button className="button button-primary" type="submit"><Check size={15} />Lưu định mức</button></div>
    </form>
  </ModalShell>;
}

function SetupModal({ onClose }) {
  return <ModalShell title="Kết nối dữ liệu dùng chung" subtitle="Cần một dự án Supabase để nhiều người và nhà máy dùng chung dữ liệu." onClose={onClose}><div className="setup-steps"><div><b>1</b><span>Tạo project Supabase và chạy file <code>supabase/schema.sql</code> trong SQL Editor.</span></div><div><b>2</b><span>Tạo tài khoản người dùng trong Supabase Auth.</span></div><div><b>3</b><span>Thêm biến <code>VITE_SUPABASE_URL</code> và <code>VITE_SUPABASE_ANON_KEY</code> trong Vercel Project Settings.</span></div><div><b>4</b><span>Redeploy. Người đăng nhập đầu tiên sẽ có workspace riêng; dữ liệu được giới hạn bằng RLS.</span></div></div><p className="setup-footnote">Bản đang chạy lưu dữ liệu trong trình duyệt. Chưa nhập dữ liệu thật vào dịch vụ bên thứ ba.</p><div className="modal-actions"><button className="button button-primary" onClick={onClose}>Đã hiểu</button></div></ModalShell>;
}

function ModalShell({ title, subtitle, onClose, children }) {
  useEffect(() => {
    const keyHandler = (event) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', keyHandler);
    return () => window.removeEventListener('keydown', keyHandler);
  }, [onClose]);
  return <div className="modal-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><div className="modal-card"><div className="modal-heading"><div><h2>{title}</h2><p>{subtitle}</p></div><button className="icon-button" aria-label="Đóng" onClick={onClose}><X size={18} /></button></div>{children}</div></div>;
}

export default App;
