// ============================================================
//  Controlador principal de la app  (modo offline-first)
//
//  - Al iniciar el día descarga el inventario UNA vez a IndexedDB.
//  - El resto del tiempo lee desde la memoria del teléfono.
//  - Solo se conecta a Firebase al registrar una entrada/salida o
//    al crear/editar/eliminar un producto.
//  - Si en ese momento no hay señal, el cambio queda en una cola y
//    se sube solo cuando vuelve la conexión.
//  (No necesitas editar este archivo)
// ============================================================

import { isConfigured } from "./config.js";
import { BarcodeScanner } from "./scanner.js";
import { localDB } from "./store.js";

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// ---------- Estado ----------
let currentUser = null;
let products = []; // caché local de productos (IndexedDB)
let todayMovements = []; // caché local de movimientos del día
let pendingProduct = null; // producto seleccionado para operación rápida
let editingCode = null; // código en edición en el formulario
let syncing = false;

const scanner = new BarcodeScanner("scanner-container");

// Se cargan dinámicamente solo si Firebase está configurado
let authApi, usersApi, productsApi, movementsApi;

// ============================================================
//  Arranque
// ============================================================
async function init() {
  if (!isConfigured) {
    $("#splash").classList.add("hidden");
    const w = $("#config-warning");
    w.classList.remove("hidden");
    w.classList.add("flex");
    return;
  }

  const fb = await import("./firebase.js");
  authApi = fb.authApi;
  usersApi = fb.usersApi;
  productsApi = fb.productsApi;
  movementsApi = fb.movementsApi;

  bindEvents();

  // Si vuelve la conexión, intenta subir lo que quedó pendiente
  window.addEventListener("online", () => {
    if (currentUser) flushOutbox().then(refreshSyncUI);
  });

  authApi.onChange((user) => {
    $("#splash").classList.add("hidden");
    if (user) {
      currentUser = user;
      showApp();
    } else {
      currentUser = null;
      showLogin();
    }
  });
}

// ============================================================
//  Navegación de vistas
// ============================================================
function showLogin() {
  scanner.stop();
  products = [];
  todayMovements = [];
  $("#app-view").classList.add("hidden");
  const v = $("#login-view");
  v.classList.remove("hidden");
  v.classList.add("flex");
}

async function showApp() {
  const v = $("#login-view");
  v.classList.add("hidden");
  v.classList.remove("flex");
  $("#app-view").classList.remove("hidden");

  // Perfil del usuario (solo si hay conexión; no es bloqueante)
  usersApi
    .ensureProfile(currentUser.uid, currentUser.email)
    .catch((e) => console.log("[v0] Perfil no actualizado:", e?.message || e));

  await ensureDailySync(); // carga local o descarga del día
  renderInventory();
  renderReports();
  renderHistory(todayMovements);
  switchTab("tab-inventory");
}

// ============================================================
//  Sincronización (descarga una vez al día)
// ============================================================
function todayStr() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

async function ensureDailySync(force = false) {
  syncing = true;
  refreshSyncUI();

  // 1) Intenta subir cambios pendientes antes de tocar el caché.
  await flushOutbox();
  const pending = await localDB.outboxCount();

  const meta = await localDB.getMeta();
  const sameDay = meta && meta.uid === currentUser.uid && meta.fecha === todayStr();
  const wantDownload = force || !sameDay;

  // Solo descargamos (y reemplazamos el caché) si NO quedan cambios
  // pendientes; así nunca pisamos algo que todavía no se subió.
  if (wantDownload && pending === 0) {
    try {
      const prods = await productsApi.fetchAll(currentUser.uid);
      const movs = await movementsApi.fetchToday(currentUser.uid);
      await localDB.replaceProducts(prods);
      await localDB.replaceMovements(movs);
      await localDB.setMeta({ uid: currentUser.uid, fecha: todayStr(), ts: Date.now() });
      products = prods;
      todayMovements = movs;
    } catch (e) {
      console.log("[v0] Descarga fallida, uso datos locales:", e?.message || e);
      products = await localDB.getAllProducts();
      todayMovements = await localDB.getTodayMovements();
      showToast("Sin conexión: usando datos guardados", "info");
    }
  } else {
    products = await localDB.getAllProducts();
    todayMovements = await localDB.getTodayMovements();
  }

  syncing = false;
  refreshSyncUI();
}

// Sube a Firebase los cambios encolados. Devuelve true si quedó vacía.
async function flushOutbox() {
  const ops = await localDB.getOutbox();
  for (const op of ops) {
    if (op.uid !== currentUser.uid) continue; // ops de otro usuario: se respetan
    try {
      if (op.type === "adjust") {
        await productsApi.adjustStock(
          op.uid,
          op.payload.producto,
          op.payload.accion,
          op.payload.cantidad
        );
      } else if (op.type === "save") {
        await productsApi.save(op.uid, op.payload.data);
      } else if (op.type === "delete") {
        await productsApi.delete(op.uid, op.payload.codigo);
      }
      await localDB.deleteFromOutbox(op.id);
    } catch (e) {
      console.log("[v0] No se pudo subir (sin conexión):", e?.message || e);
      return false; // corta para conservar el orden; se reintenta luego
    }
  }
  return true;
}

async function refreshSyncUI() {
  const status = $("#sync-status");
  const btn = $("#sync-btn");
  if (!status) return;
  const pending = await localDB.outboxCount().catch(() => 0);
  const meta = await localDB.getMeta().catch(() => null);

  if (syncing) {
    status.textContent = "Sincronizando…";
  } else if (pending > 0) {
    status.textContent = `${pending} cambio${pending === 1 ? "" : "s"} por subir`;
  } else if (meta?.ts) {
    const hora = new Date(meta.ts).toLocaleTimeString("es", {
      hour: "2-digit",
      minute: "2-digit",
    });
    status.textContent =
      meta.fecha === todayStr()
        ? `Sincronizado hoy ${hora}`
        : `Última descarga: ${meta.fecha}`;
  } else {
    status.textContent = "Sin descargar todavía";
  }
  if (btn) btn.disabled = syncing;
}

// ============================================================
//  Tabs
// ============================================================
const TAB_TITLES = {
  "tab-scan": "Escanear",
  "tab-inventory": "Inventario",
  "tab-reports": "Reportes",
  "tab-history": "Historial",
};

function switchTab(tabId) {
  $$(".tab-panel").forEach((p) => p.classList.toggle("hidden", p.id !== tabId));
  $$(".nav-btn").forEach((b) => {
    const active = b.dataset.tab === tabId;
    b.classList.toggle("text-brand", active);
    b.classList.toggle("text-ink/40", !active);
  });
  $("#header-title").textContent = TAB_TITLES[tabId] || "Inventario";

  if (tabId === "tab-reports") renderReports();
  if (tabId !== "tab-scan") stopScanner();
}

// ============================================================
//  Escáner
// ============================================================
async function startScanner() {
  $("#scanner-placeholder").classList.add("hidden");
  $("#scan-start-btn").classList.add("hidden");
  const stopBtn = $("#scan-stop-btn");
  stopBtn.classList.remove("hidden");
  stopBtn.classList.add("flex");

  await scanner.start(
    (code) => handleScannedCode(code),
    (errMsg) => {
      showToast(errMsg, "error");
      resetScannerUI();
    }
  );
}

async function stopScanner() {
  await scanner.stop();
  resetScannerUI();
}

function resetScannerUI() {
  $("#scanner-placeholder").classList.remove("hidden");
  $("#scan-start-btn").classList.remove("hidden");
  const stopBtn = $("#scan-stop-btn");
  stopBtn.classList.add("hidden");
  stopBtn.classList.remove("flex");
}

let lastScan = { code: null, time: 0 };
async function handleScannedCode(code) {
  const now = Date.now();
  if (code === lastScan.code && now - lastScan.time < 2500) return;
  lastScan = { code, time: now };

  if (navigator.vibrate) navigator.vibrate(120);

  await stopScanner();
  lookupCode(code);
}

// Búsqueda LOCAL: no toca la red al escanear.
function lookupCode(code) {
  const found = products.find((p) => p.codigo === code);
  if (found) {
    openOperationModal(found);
  } else {
    openNotFoundModal(code);
  }
}

// ============================================================
//  Modal de operación rápida (sumar / restar)
// ============================================================
function openOperationModal(product) {
  pendingProduct = product;
  $("#op-product-name").textContent = product.nombre;
  $("#op-product-code").textContent = product.codigo;
  $("#op-product-stock").textContent = product.cantidad ?? 0;
  $("#op-quantity").value = 1;
  openModal("operation-modal");
}

async function applyOperation(accion) {
  const cantidad = parseInt($("#op-quantity").value, 10);
  if (!cantidad || cantidad < 1) {
    showToast("Ingresa una cantidad válida", "error");
    return;
  }
  if (accion === "salida" && cantidad > (pendingProduct.cantidad ?? 0)) {
    showToast("No hay suficiente stock para esa salida", "error");
    return;
  }

  const producto = pendingProduct;
  const delta = accion === "entrada" ? cantidad : -cantidad;

  // 1) Actualiza el teléfono al instante (optimista).
  const idx = products.findIndex((p) => p.codigo === producto.codigo);
  if (idx >= 0) {
    products[idx] = { ...products[idx], cantidad: (products[idx].cantidad ?? 0) + delta };
    await localDB.putProduct(products[idx]);
  }
  const mov = {
    codigo: producto.codigo,
    nombre: producto.nombre,
    accion,
    cantidad,
    ts: Date.now(),
  };
  todayMovements.unshift(mov);
  await localDB.addMovement(mov);

  closeModal("operation-modal");
  renderInventory();
  renderReports();
  renderHistory(todayMovements);
  const verbo = accion === "entrada" ? "Sumadas" : "Restadas";

  // 2) Encola y trata de subir a Firebase ahora mismo.
  await localDB.addToOutbox({
    uid: currentUser.uid,
    type: "adjust",
    payload: { producto: { codigo: producto.codigo, nombre: producto.nombre }, accion, cantidad },
  });
  const subido = await flushOutbox();
  refreshSyncUI();

  showToast(
    subido
      ? `${verbo} ${cantidad} u. de ${producto.nombre}`
      : `Guardado en el teléfono (se subirá al reconectar)`,
    subido ? "success" : "info"
  );
  pendingProduct = null;
}

// ============================================================
//  Modal producto no encontrado
// ============================================================
function openNotFoundModal(code) {
  $("#notfound-code").textContent = code;
  $("#notfound-create-btn").dataset.code = code;
  openModal("notfound-modal");
}

// ============================================================
//  Formulario de producto (crear / editar)
// ============================================================
function openProductForm(product = null) {
  const form = $("#product-form");
  form.reset();
  $("#product-error").classList.add("hidden");

  if (product) {
    editingCode = product.codigo;
    $("#product-modal-title").textContent = "Editar producto";
    $("#pf-codigo").value = product.codigo;
    $("#pf-codigo").readOnly = true;
    $("#pf-codigo").classList.add("bg-paper");
    $("#pf-nombre").value = product.nombre || "";
    $("#pf-cantidad").value = product.cantidad ?? 0;
    $("#pf-minimo").value = product.stockMinimo ?? 0;
    $("#pf-costo").value = product.precioCosto ?? 0;
    $("#pf-venta").value = product.precioVenta ?? 0;
    $("#product-delete-btn").classList.remove("hidden");
  } else {
    editingCode = null;
    $("#product-modal-title").textContent = "Nuevo producto";
    $("#pf-codigo").readOnly = false;
    $("#pf-codigo").classList.remove("bg-paper");
    $("#product-delete-btn").classList.add("hidden");
  }
  openModal("product-modal");
}

function openProductFormWithCode(code) {
  openProductForm();
  $("#pf-codigo").value = code;
  $("#pf-nombre").focus();
}

async function saveProduct(e) {
  e.preventDefault();
  const codigo = $("#pf-codigo").value.trim();
  const nombre = $("#pf-nombre").value.trim();
  if (!codigo || !nombre) {
    showError("product-error", "El código y el nombre son obligatorios.");
    return;
  }
  const data = {
    codigo,
    nombre,
    cantidad: parseInt($("#pf-cantidad").value, 10) || 0,
    stockMinimo: parseInt($("#pf-minimo").value, 10) || 0,
    precioCosto: parseFloat($("#pf-costo").value) || 0,
    precioVenta: parseFloat($("#pf-venta").value) || 0,
  };

  // 1) Caché local
  const idx = products.findIndex((p) => p.codigo === codigo);
  if (idx >= 0) products[idx] = { ...products[idx], ...data };
  else products.push(data);
  products.sort((a, b) => (a.nombre || "").localeCompare(b.nombre || ""));
  await localDB.putProduct(data);

  closeModal("product-modal");
  renderInventory();
  renderReports();
  showToast(editingCode ? "Producto actualizado" : "Producto creado", "success");

  // 2) Encola + sube
  await localDB.addToOutbox({ uid: currentUser.uid, type: "save", payload: { data } });
  await flushOutbox();
  refreshSyncUI();
}

async function deleteProduct() {
  if (!editingCode) return;
  if (!confirm("¿Eliminar este producto del inventario?")) return;

  const codigo = editingCode;
  products = products.filter((p) => p.codigo !== codigo);
  await localDB.deleteProduct(codigo);

  closeModal("product-modal");
  renderInventory();
  renderReports();
  showToast("Producto eliminado", "success");

  await localDB.addToOutbox({ uid: currentUser.uid, type: "delete", payload: { codigo } });
  await flushOutbox();
  refreshSyncUI();
}

// ============================================================
//  Render: Inventario
// ============================================================
function renderInventory() {
  const term = $("#inventory-search").value.trim().toLowerCase();
  const list = $("#inventory-list");
  const filtered = products.filter(
    (p) =>
      !term ||
      (p.nombre || "").toLowerCase().includes(term) ||
      (p.codigo || "").includes(term)
  );

  const lowStock = products.filter((p) => (p.cantidad ?? 0) <= (p.stockMinimo ?? 0));
  const banner = $("#low-stock-banner");
  if (lowStock.length > 0) {
    $("#low-stock-text").textContent =
      lowStock.length === 1
        ? "1 producto en o bajo el stock mínimo"
        : `${lowStock.length} productos en o bajo el stock mínimo`;
    banner.classList.remove("hidden");
    banner.classList.add("flex");
  } else {
    banner.classList.add("hidden");
    banner.classList.remove("flex");
  }

  renderInventorySummary();
  $("#inventory-empty").classList.toggle("hidden", products.length > 0);
  list.innerHTML = filtered.map(renderProductCard).join("");

  list.querySelectorAll("[data-edit]").forEach((el) => {
    el.addEventListener("click", () => {
      const p = products.find((x) => x.codigo === el.dataset.edit);
      if (p) openProductForm(p);
    });
  });
  list.querySelectorAll("[data-op]").forEach((el) => {
    el.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const p = products.find((x) => x.codigo === el.dataset.op);
      if (p) openOperationModal(p);
    });
  });
}

function renderInventorySummary() {
  const summary = $("#inventory-summary");
  if (products.length === 0) {
    summary.classList.add("hidden");
    summary.classList.remove("grid");
    return;
  }
  let totalCosto = 0;
  let totalVenta = 0;
  for (const p of products) {
    const cant = p.cantidad ?? 0;
    totalCosto += cant * (Number(p.precioCosto) || 0);
    totalVenta += cant * (Number(p.precioVenta) || 0);
  }
  $("#summary-cost").textContent = "$" + formatPrice(totalCosto);
  $("#summary-sale").textContent = "$" + formatPrice(totalVenta);
  $("#summary-profit").textContent = "$" + formatPrice(totalVenta - totalCosto);
  summary.classList.remove("hidden");
  summary.classList.add("grid");
}

function renderProductCard(p) {
  const cantidad = p.cantidad ?? 0;
  const minimo = p.stockMinimo ?? 0;
  const low = cantidad <= minimo;
  const cardClasses = low ? "border-ink/40 bg-ink/[0.04]" : "border-ink/10 bg-white";
  const badge = low
    ? `<span class="inline-flex items-center gap-1 rounded-full bg-ink px-2 py-0.5 text-xs font-semibold text-paper">
         <svg class="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><path d="M12 9v4M12 17h.01" stroke-linecap="round"/></svg>
         Bajo
       </span>`
    : "";

  return `
    <li data-edit="${escapeAttr(p.codigo)}"
        class="flex cursor-pointer items-center gap-3 rounded-2xl border p-3 shadow-sm transition active:scale-[0.99] ${cardClasses}">
      <div class="min-w-0 flex-1">
        <div class="flex items-center gap-2">
          <p class="truncate font-semibold text-ink">${escapeHtml(p.nombre || "Sin nombre")}</p>
          ${badge}
        </div>
        <p class="truncate font-mono text-xs text-ink/40">${escapeHtml(p.codigo)}</p>
        <p class="mt-0.5 text-xs text-ink/50">Mín: ${minimo} · Venta: $${formatPrice(p.precioVenta)}</p>
      </div>
      <div class="text-right">
        <p class="text-2xl font-bold leading-none text-ink">${cantidad}</p>
        <p class="text-[11px] uppercase tracking-wide text-ink/40">unid.</p>
      </div>
      <button data-op="${escapeAttr(p.codigo)}" aria-label="Operación rápida"
        class="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-brand text-white transition active:scale-95 hover:bg-brand-dark">
        <svg class="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 10v12"/><path d="M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z"/></svg>
      </button>
    </li>`;
}

// ============================================================
//  Render: Reportes
// ============================================================
function renderReports() {
  let totalUnits = 0, totalCosto = 0, totalVenta = 0;
  for (const p of products) {
    const c = p.cantidad ?? 0;
    totalUnits += c;
    totalCosto += c * (Number(p.precioCosto) || 0);
    totalVenta += c * (Number(p.precioVenta) || 0);
  }
  setText("rep-total-products", products.length);
  setText("rep-total-units", totalUnits);
  setText("rep-cost", "$" + formatPrice(totalCosto));
  setText("rep-sale", "$" + formatPrice(totalVenta));
  setText("rep-profit", "$" + formatPrice(totalVenta - totalCosto));

  let inUnits = 0, inOps = 0, outUnits = 0, outOps = 0;
  for (const m of todayMovements) {
    if (m.accion === "entrada") { inUnits += m.cantidad || 0; inOps++; }
    else { outUnits += m.cantidad || 0; outOps++; }
  }
  setText("rep-in-units", inUnits);
  setText("rep-in-ops", `${inOps} ${inOps === 1 ? "operación" : "operaciones"}`);
  setText("rep-out-units", outUnits);
  setText("rep-out-ops", `${outOps} ${outOps === 1 ? "operación" : "operaciones"}`);

  const low = products.filter((p) => (p.cantidad ?? 0) <= (p.stockMinimo ?? 0));
  const list = $("#rep-low-list");
  $("#rep-low-empty").classList.toggle("hidden", low.length > 0);
  list.innerHTML = low.map(renderLowStockRow).join("");
}

function renderLowStockRow(p) {
  const cantidad = p.cantidad ?? 0;
  const minimo = p.stockMinimo ?? 0;
  return `
    <li class="flex items-center gap-3 rounded-2xl bg-white p-3 shadow-sm ring-1 ring-ink/10">
      <span class="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-ink text-paper">
        <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><path d="M12 9v4M12 17h.01" stroke-linecap="round"/></svg>
      </span>
      <div class="min-w-0 flex-1">
        <p class="truncate font-medium text-ink">${escapeHtml(p.nombre || p.codigo)}</p>
        <p class="text-xs text-ink/40">Mínimo: ${minimo}</p>
      </div>
      <span class="text-lg font-bold text-ink">${cantidad}</span>
    </li>`;
}

// ============================================================
//  Render: Historial
// ============================================================
function renderHistory(movements) {
  todayMovements = movements;
  const list = $("#history-list");
  $("#history-date").textContent = new Date().toLocaleDateString("es", {
    weekday: "long",
    day: "numeric",
    month: "long",
  });
  $("#history-empty").classList.toggle("hidden", movements.length > 0);
  $("#export-csv-btn").disabled = movements.length === 0;
  list.innerHTML = movements.map(renderMovementRow).join("");
}

function exportHistoryCsv() {
  if (todayMovements.length === 0) return;
  const headers = ["Fecha", "Hora", "Codigo", "Producto", "Accion", "Cantidad"];
  const rows = todayMovements.map((m) => {
    const d = new Date(m.ts || Date.now());
    return [
      d.toLocaleDateString("es"),
      d.toLocaleTimeString("es", { hour: "2-digit", minute: "2-digit" }),
      m.codigo || "",
      m.nombre || "",
      m.accion === "entrada" ? "Entrada" : "Salida",
      m.cantidad ?? 0,
    ];
  });
  const csv = [headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n");
  const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const stamp = new Date().toISOString().slice(0, 10);
  a.href = url;
  a.download = `movimientos-${stamp}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  showToast("Historial exportado a CSV", "success");
}

function csvCell(value) {
  const s = String(value ?? "");
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function renderMovementRow(m) {
  const entrada = m.accion === "entrada";
  const hora = new Date(m.ts || Date.now()).toLocaleTimeString("es", {
    hour: "2-digit",
    minute: "2-digit",
  });
  const color = entrada ? "text-brand bg-brand-sky/25" : "text-brand-mid bg-brand-mid/10";
  const signo = entrada ? "+" : "−";
  const icon = entrada
    ? `<svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`
    : `<svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><line x1="5" y1="12" x2="19" y2="12"/></svg>`;

  return `
    <li class="flex items-center gap-3 rounded-2xl border border-ink/10 bg-white p-3 shadow-sm">
      <span class="flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${color}">${icon}</span>
      <div class="min-w-0 flex-1">
        <p class="truncate font-medium text-ink">${escapeHtml(m.nombre || m.codigo)}</p>
        <p class="text-xs text-ink/40">${hora} · ${entrada ? "Entrada" : "Salida"}</p>
      </div>
      <span class="text-lg font-bold ${entrada ? "text-brand" : "text-brand-mid"}">${signo}${m.cantidad}</span>
    </li>`;
}

// ============================================================
//  Modales / Toast / Helpers
// ============================================================
function openModal(id) {
  $(`#${id}`).classList.remove("hidden");
  document.body.style.overflow = "hidden";
}
function closeModal(id) {
  $(`#${id}`).classList.add("hidden");
  document.body.style.overflow = "";
}
function closeAllModals() {
  $$(".modal").forEach((m) => m.classList.add("hidden"));
  document.body.style.overflow = "";
}

let toastTimer = null;
function showToast(msg, type = "info") {
  const t = $("#toast");
  t.textContent = msg;
  t.className =
    "pointer-events-none fixed bottom-28 left-1/2 z-50 -translate-x-1/2 rounded-full px-5 py-2.5 text-sm font-medium text-white shadow-lg " +
    (type === "error" ? "bg-ink" : type === "success" ? "bg-brand" : "bg-brand-mid");
  t.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("hidden"), 2600);
}

function showError(id, msg) {
  const el = $(`#${id}`);
  el.textContent = msg;
  el.classList.remove("hidden");
}

function setText(id, value) {
  const el = $(`#${id}`);
  if (el) el.textContent = value;
}
function escapeHtml(str = "") {
  return String(str).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}
function escapeAttr(str = "") {
  return escapeHtml(str);
}
function formatPrice(n) {
  const num = Number(n) || 0;
  return num.toLocaleString("es", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

// ============================================================
//  Wiring de eventos
// ============================================================
function bindEvents() {
  $("#login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    $("#login-error").classList.add("hidden");
    try {
      await authApi.login($("#login-email").value.trim(), $("#login-password").value);
    } catch (err) {
      showError("login-error", authErrorMessage(err));
    }
  });

  $("#logout-btn").addEventListener("click", () => authApi.logout());

  $$(".nav-btn").forEach((b) =>
    b.addEventListener("click", () => switchTab(b.dataset.tab))
  );

  $("#scan-start-btn").addEventListener("click", startScanner);
  $("#scan-stop-btn").addEventListener("click", stopScanner);
  $("#manual-entry-btn").addEventListener("click", () => {
    const code = prompt("Ingresa el número del código de barras:");
    if (code && code.trim()) lookupCode(code.trim());
  });

  $("#add-product-btn").addEventListener("click", () => openProductForm());
  $("#inventory-search").addEventListener("input", renderInventory);
  $("#sync-btn").addEventListener("click", async () => {
    await ensureDailySync(true); // fuerza una descarga manual
    renderInventory();
    renderReports();
    renderHistory(todayMovements);
  });

  $("#export-csv-btn").addEventListener("click", exportHistoryCsv);

  $("#op-plus").addEventListener("click", () => stepQty(1));
  $("#op-minus").addEventListener("click", () => stepQty(-1));
  $("#op-entrada-btn").addEventListener("click", () => applyOperation("entrada"));
  $("#op-salida-btn").addEventListener("click", () => applyOperation("salida"));

  $("#notfound-create-btn").addEventListener("click", (e) => {
    const code = e.currentTarget.dataset.code;
    closeModal("notfound-modal");
    openProductFormWithCode(code);
  });

  $("#product-form").addEventListener("submit", saveProduct);
  $("#product-delete-btn").addEventListener("click", deleteProduct);

  $$("[data-close]").forEach((el) => el.addEventListener("click", closeAllModals));
}

function stepQty(delta) {
  const input = $("#op-quantity");
  const val = Math.max(1, (parseInt(input.value, 10) || 1) + delta);
  input.value = val;
}

function authErrorMessage(err) {
  const code = err?.code || "";
  const map = {
    "auth/invalid-email": "Correo inválido.",
    "auth/user-not-found": "No existe una cuenta con ese correo.",
    "auth/wrong-password": "Contraseña incorrecta.",
    "auth/invalid-credential": "Correo o contraseña incorrectos.",
    "auth/too-many-requests": "Demasiados intentos. Espera un momento.",
    "auth/network-request-failed": "Sin conexión. Revisa tu internet para iniciar sesión.",
  };
  return map[code] || "No se pudo iniciar sesión. Revisa tus datos e intenta de nuevo.";
}

// Arranca
init();
