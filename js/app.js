// ============================================================
//  Controlador principal de la app
//  (No necesitas editar este archivo)
// ============================================================

import { isConfigured } from "./config.js";
import { BarcodeScanner } from "./scanner.js";

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// ---------- Estado ----------
let currentUser = null;
let products = []; // cache local de productos
let todayMovements = []; // cache de movimientos del día (para exportar CSV)
let unsubscribeProducts = null;
let unsubscribeMovements = null;
let pendingProduct = null; // producto seleccionado para operación rápida
let editingCode = null; // código en edición en el formulario

const scanner = new BarcodeScanner("scanner-container");

// Estos se cargan dinámicamente solo si Firebase está configurado
let authApi, productsApi, movementsApi;

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

  // Importa Firebase solo cuando hay credenciales válidas
  const fb = await import("./firebase.js");
  authApi = fb.authApi;
  productsApi = fb.productsApi;
  movementsApi = fb.movementsApi;

  bindEvents();

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
  cleanupSubscriptions();
  $("#app-view").classList.add("hidden");
  const v = $("#login-view");
  v.classList.remove("hidden");
  v.classList.add("flex");
}

function showApp() {
  const v = $("#login-view");
  v.classList.add("hidden");
  v.classList.remove("flex");
  $("#app-view").classList.remove("hidden");

  // Suscripciones en tiempo real
  unsubscribeProducts = productsApi.subscribe(currentUser.uid, (items) => {
    products = items;
    renderInventory();
  });
  unsubscribeMovements = movementsApi.subscribeToday(currentUser.uid, renderHistory);

  switchTab("tab-inventory");
}

function cleanupSubscriptions() {
  unsubscribeProducts?.();
  unsubscribeMovements?.();
  unsubscribeProducts = unsubscribeMovements = null;
  products = [];
  todayMovements = [];
  scanner.stop();
}

// ============================================================
//  Tabs
// ============================================================
const TAB_TITLES = {
  "tab-scan": "Escanear",
  "tab-inventory": "Inventario",
  "tab-history": "Historial",
};

function switchTab(tabId) {
  $$(".tab-panel").forEach((p) => p.classList.toggle("hidden", p.id !== tabId));
  $$(".nav-btn").forEach((b) => {
    const active = b.dataset.tab === tabId;
    b.classList.toggle("text-brand", active);
    b.classList.toggle("text-slate-400", !active);
  });
  $("#header-title").textContent = TAB_TITLES[tabId] || "Inventario";

  // Apaga la cámara al salir del escáner
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
  // Evita lecturas duplicadas en ráfaga del mismo código
  const now = Date.now();
  if (code === lastScan.code && now - lastScan.time < 2500) return;
  lastScan = { code, time: now };

  // Vibración de confirmación si el dispositivo lo soporta
  if (navigator.vibrate) navigator.vibrate(120);

  await stopScanner();
  lookupCode(code);
}

async function lookupCode(code) {
  const found = await productsApi.getByCode(currentUser.uid, code);
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
  try {
    await productsApi.adjustStock(currentUser.uid, pendingProduct, accion, cantidad);
    closeModal("operation-modal");
    const verbo = accion === "entrada" ? "Sumadas" : "Restadas";
    showToast(`${verbo} ${cantidad} u. de ${pendingProduct.nombre}`, "success");
    pendingProduct = null;
  } catch (e) {
    console.log("[v0] Error al ajustar stock:", e?.message || e);
    showToast("Error al guardar el movimiento", "error");
  }
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
    $("#pf-codigo").classList.add("bg-slate-100");
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
    $("#pf-codigo").classList.remove("bg-slate-100");
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
  try {
    await productsApi.save(currentUser.uid, data);
    closeModal("product-modal");
    showToast(editingCode ? "Producto actualizado" : "Producto creado", "success");
  } catch (err) {
    console.log("[v0] Error al guardar producto:", err?.message || err);
    showError("product-error", "No se pudo guardar. Intenta de nuevo.");
  }
}

async function deleteProduct() {
  if (!editingCode) return;
  if (!confirm("¿Eliminar este producto del inventario?")) return;
  try {
    await productsApi.delete(currentUser.uid, editingCode);
    closeModal("product-modal");
    showToast("Producto eliminado", "success");
  } catch (err) {
    console.log("[v0] Error al eliminar:", err?.message || err);
    showToast("No se pudo eliminar", "error");
  }
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

  // Banner de alertas (sobre el total, no sobre el filtro)
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

  // Resumen de valor de inventario (sobre todos los productos)
  renderInventorySummary();

  $("#inventory-empty").classList.toggle("hidden", products.length > 0);

  list.innerHTML = filtered.map(renderProductCard).join("");

  // Listeners de cada tarjeta
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
  const cardClasses = low
    ? "border-red-300 bg-red-50"
    : "border-slate-200 bg-white";
  const stockClasses = low ? "text-red-600" : "text-slate-900";
  const badge = low
    ? `<span class="inline-flex items-center gap-1 rounded-full bg-red-100 px-2 py-0.5 text-xs font-semibold text-red-700">
         <svg class="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><path d="M12 9v4M12 17h.01" stroke-linecap="round"/></svg>
         Bajo
       </span>`
    : "";

  return `
    <li data-edit="${escapeAttr(p.codigo)}"
        class="flex cursor-pointer items-center gap-3 rounded-2xl border p-3 shadow-sm transition active:scale-[0.99] ${cardClasses}">
      <div class="min-w-0 flex-1">
        <div class="flex items-center gap-2">
          <p class="truncate font-semibold text-slate-900">${escapeHtml(p.nombre || "Sin nombre")}</p>
          ${badge}
        </div>
        <p class="truncate font-mono text-xs text-slate-400">${escapeHtml(p.codigo)}</p>
        <p class="mt-0.5 text-xs text-slate-500">Mín: ${minimo} · Venta: $${formatPrice(p.precioVenta)}</p>
      </div>
      <div class="text-right">
        <p class="text-2xl font-bold leading-none ${stockClasses}">${cantidad}</p>
        <p class="text-[11px] uppercase tracking-wide text-slate-400">unid.</p>
      </div>
      <button data-op="${escapeAttr(p.codigo)}" aria-label="Operación rápida"
        class="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-brand text-white transition active:scale-95 hover:bg-brand-dark">
        <svg class="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 10v12"/><path d="M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z"/></svg>
      </button>
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

// Exporta los movimientos del día a un archivo CSV descargable
function exportHistoryCsv() {
  if (todayMovements.length === 0) return;
  const headers = ["Fecha", "Hora", "Codigo", "Producto", "Accion", "Cantidad"];
  const rows = todayMovements.map((m) => {
    const d = m.fecha?.toDate ? m.fecha.toDate() : new Date();
    return [
      d.toLocaleDateString("es"),
      d.toLocaleTimeString("es", { hour: "2-digit", minute: "2-digit" }),
      m.codigo || "",
      m.nombre || "",
      m.accion === "entrada" ? "Entrada" : "Salida",
      m.cantidad ?? 0,
    ];
  });
  const csv = [headers, ...rows]
    .map((row) => row.map(csvCell).join(","))
    .join("\r\n");

  // BOM para que Excel reconozca acentos en UTF-8
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
  // Encierra entre comillas si contiene caracteres especiales
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function renderMovementRow(m) {
  const entrada = m.accion === "entrada";
  const hora = m.fecha?.toDate
    ? m.fecha.toDate().toLocaleTimeString("es", { hour: "2-digit", minute: "2-digit" })
    : "—";
  const color = entrada ? "text-emerald-600 bg-emerald-50" : "text-orange-600 bg-orange-50";
  const signo = entrada ? "+" : "−";
  const icon = entrada
    ? `<svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`
    : `<svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><line x1="5" y1="12" x2="19" y2="12"/></svg>`;

  return `
    <li class="flex items-center gap-3 rounded-2xl border border-slate-200 bg-white p-3 shadow-sm">
      <span class="flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${color}">${icon}</span>
      <div class="min-w-0 flex-1">
        <p class="truncate font-medium text-slate-900">${escapeHtml(m.nombre || m.codigo)}</p>
        <p class="text-xs text-slate-400">${hora} · ${entrada ? "Entrada" : "Salida"}</p>
      </div>
      <span class="text-lg font-bold ${entrada ? "text-emerald-600" : "text-orange-600"}">${signo}${m.cantidad}</span>
    </li>`;
}

// ============================================================
//  Modales: utilidades
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

// ============================================================
//  Toast
// ============================================================
let toastTimer = null;
function showToast(msg, type = "info") {
  const t = $("#toast");
  t.textContent = msg;
  t.className =
    "pointer-events-none fixed bottom-28 left-1/2 z-50 -translate-x-1/2 rounded-full px-5 py-2.5 text-sm font-medium text-white shadow-lg " +
    (type === "error" ? "bg-red-600" : type === "success" ? "bg-emerald-600" : "bg-slate-800");
  t.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("hidden"), 2600);
}

function showError(id, msg) {
  const el = $(`#${id}`);
  el.textContent = msg;
  el.classList.remove("hidden");
}

// ============================================================
//  Helpers
// ============================================================
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
  // Login
  $("#login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    $("#login-error").classList.add("hidden");
    try {
      await authApi.login($("#login-email").value.trim(), $("#login-password").value);
    } catch (err) {
      showError("login-error", authErrorMessage(err));
    }
  });

  $("#login-register-btn").addEventListener("click", async () => {
    $("#login-error").classList.add("hidden");
    const email = $("#login-email").value.trim();
    const pass = $("#login-password").value;
    if (!email || pass.length < 6) {
      showError("login-error", "Ingresa un correo y una contraseña de al menos 6 caracteres.");
      return;
    }
    try {
      await authApi.register(email, pass);
      showToast("Cuenta creada", "success");
    } catch (err) {
      showError("login-error", authErrorMessage(err));
    }
  });

  $("#logout-btn").addEventListener("click", () => authApi.logout());

  // Tabs
  $$(".nav-btn").forEach((b) =>
    b.addEventListener("click", () => switchTab(b.dataset.tab))
  );

  // Escáner
  $("#scan-start-btn").addEventListener("click", startScanner);
  $("#scan-stop-btn").addEventListener("click", stopScanner);
  $("#manual-entry-btn").addEventListener("click", () => {
    const code = prompt("Ingresa el número del código de barras:");
    if (code && code.trim()) lookupCode(code.trim());
  });

  // Inventario
  $("#add-product-btn").addEventListener("click", () => openProductForm());
  $("#inventory-search").addEventListener("input", renderInventory);

  // Historial → exportar CSV
  $("#export-csv-btn").addEventListener("click", exportHistoryCsv);

  // Operación rápida
  $("#op-plus").addEventListener("click", () => stepQty(1));
  $("#op-minus").addEventListener("click", () => stepQty(-1));
  $("#op-entrada-btn").addEventListener("click", () => applyOperation("entrada"));
  $("#op-salida-btn").addEventListener("click", () => applyOperation("salida"));

  // Producto no encontrado → crear
  $("#notfound-create-btn").addEventListener("click", (e) => {
    const code = e.currentTarget.dataset.code;
    closeModal("notfound-modal");
    openProductFormWithCode(code);
  });

  // Formulario de producto
  $("#product-form").addEventListener("submit", saveProduct);
  $("#product-delete-btn").addEventListener("click", deleteProduct);

  // Cerrar modales (backdrop y botones data-close)
  $$("[data-close]").forEach((el) =>
    el.addEventListener("click", closeAllModals)
  );
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
    "auth/email-already-in-use": "Ese correo ya tiene una cuenta.",
    "auth/weak-password": "La contraseña debe tener al menos 6 caracteres.",
    "auth/too-many-requests": "Demasiados intentos. Espera un momento.",
  };
  return map[code] || "No se pudo completar. Revisa tus datos e intenta de nuevo.";
}

// Arranca
init();
