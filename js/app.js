// ============================================================
//  Controlador principal de la app  (offline-first + tiempo real eficiente)
//
//  ARQUITECTURA DE SINCRONIZACIÓN:
//  ─────────────────────────────────────────────────────────
//  1. Persistencia offline (IndexedDB de Firestore): los documentos
//     se guardan en el dispositivo. Las lecturas sirven desde caché
//     local cuando los datos no cambiaron → 0 lecturas de red.
//
//  2. Listener de señal (1 documento): en lugar de escuchar toda la
//     colección de productos (N lecturas por evento), escuchamos un
//     único doc "meta/signal" que solo tiene un timestamp.
//     Cuando cambia → fetchAll() trae los productos frescos.
//     Costo: 1 lectura de señal por evento, luego fetchAll desde caché.
//
//  3. Escrituras con touchSignal: cada save/delete/adjustStock actualiza
//     la señal, notificando a otros dispositivos automáticamente.
//
//  4. Outbox con debounce (800ms): las escrituras se agrupan antes de
//     subir, y el semáforo evita uploads paralelos.
//
//  Resultado: tiempo real automático sin botones, con consumo mínimo
//  del plan gratuito de Firebase.
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
let todaySales = []; // caché local de ventas del día (caja)
let cart = []; // ticket en curso: { codigo, nombre, precio, cantidad }
let posMethod = null; // método de pago elegido
let pendingProduct = null; // producto seleccionado para operación rápida
let editingCode = null; // código en edición en el formulario
let syncing = false;
let flushing = false;       // semáforo: evita dos flush simultáneos
let flushTimer = null;      // debounce: agrupa escrituras ráfaga en un solo flush

const PAYMENT_METHODS = [
  { id: "efectivo", label: "Efectivo" },
  { id: "debito", label: "Débito" },
  { id: "credito", label: "Crédito" },
  { id: "transferencia", label: "Transferencia" },
  { id: "qr", label: "QR / Billetera" },
];

const scanner = new BarcodeScanner({ onScan: (code) => handleScannedCode(code) });

// Se cargan dinámicamente solo si Firebase está configurado
let authApi, usersApi, productsApi, movementsApi, salesApi, isQuotaError;
let unsubscribeProducts = null; // cancela el listener de tiempo real al cerrar sesión

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
  salesApi = fb.salesApi;
  isQuotaError = fb.isQuotaError;

  bindEvents();

  // Si vuelve la conexión, intenta subir lo que quedó pendiente (debounce por si
  // el evento online dispara varias veces seguido al reconectar)
  window.addEventListener("online", () => {
    if (currentUser) scheduleFlush();
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
  // Cancela el listener en tiempo real al cerrar sesión
  if (unsubscribeProducts) { unsubscribeProducts(); unsubscribeProducts = null; }
  products = [];
  todayMovements = [];
  $("#app-view").classList.add("hidden");
  const v = $("#login-view");
  v.classList.remove("hidden");
  v.classList.add("flex");
}

// Banner persistente de cuota agotada — se queda visible hasta que el
// usuario lo cierre o recargue. No usa showToast porque no debe desaparecer.
function showQuotaBanner() {
  let banner = $("#quota-banner");
  if (banner) { banner.classList.remove("hidden"); return; }
  banner = document.createElement("div");
  banner.id = "quota-banner";
  banner.className =
    "fixed inset-x-0 top-0 z-50 flex items-start gap-3 bg-red-600 px-4 py-3 text-white shadow-lg";
  banner.innerHTML = `
    <svg class="mt-0.5 h-5 w-5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><path d="M12 9v4M12 17h.01"/><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/></svg>
    <div class="flex-1 text-sm">
      <p class="font-bold">Cuota de Firebase agotada</p>
      <p class="mt-0.5 opacity-90">Se alcanzó el límite del plan gratuito. Los cambios se guardan en el teléfono y se subirán cuando se renueve la cuota (generalmente a medianoche).</p>
    </div>
    <button onclick="this.closest('#quota-banner').classList.add('hidden')" class="shrink-0 rounded p-1 opacity-80 hover:opacity-100" aria-label="Cerrar">
      <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
    </button>`;
  document.body.prepend(banner);
}

async function showApp() {
  const v = $("#login-view");
  v.classList.add("hidden");
  v.classList.remove("flex");
  $("#app-view").classList.remove("hidden");

  // Perfil del usuario (no bloqueante)
  usersApi
    .ensureProfile(currentUser.uid, currentUser.email)
    .catch((e) => console.log("[v0] Perfil no actualizado:", e?.message || e));

  // Descarga movimientos y ventas del día (una sola vez al iniciar)
  await ensureDailySync();
  renderReports();
  renderHistory(todayMovements);
  renderPosMethods();
  renderCart();
  switchTab("tab-inventory");
  scanner.start();

  // Listener en tiempo real sobre productos — se mantiene activo
  // mientras el usuario esté logueado. Cualquier cambio en Firestore
  // (desde este u otro dispositivo) se refleja automáticamente.
  startProductsListener();
}

function startProductsListener() {
  if (unsubscribeProducts) unsubscribeProducts();

  unsubscribeProducts = productsApi.listenProducts(
    currentUser.uid,
    async (list) => {
      products = list;
      await localDB.replaceProducts(list);
      await localDB.setMeta({ uid: currentUser.uid, fecha: todayStr(), ts: Date.now() });
      renderInventory();
      renderReports();
      refreshSyncUI();
    },
    (err) => {
      console.error("[v0] Listener de productos falló:", err);
      if (isQuotaError(err)) showQuotaBanner();
    }
  );
}

// ============================================================
//  Sincronización (descarga una vez al día)
// ============================================================
function todayStr() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

// Los productos ya no se descargan aquí: el listener onSnapshot los maneja
// en tiempo real. Esta función solo descarga movimientos y ventas del día,
// que no necesitan tiempo real en una tienda pequeña.
async function ensureDailySync() {
  syncing = true;
  refreshSyncUI();

  await flushOutbox();

  // Carga local inmediata para no bloquear la UI
  products = await localDB.getAllProducts();
  todayMovements = await localDB.getTodayMovements();
  todaySales = await localDB.getTodaySales();

  // Descarga movimientos y ventas solo si es un día nuevo
  const meta = await localDB.getMeta();
  const sameDay = meta && meta.uid === currentUser.uid && meta.fecha === todayStr();

  if (!sameDay) {
    try {
      const movs = await movementsApi.fetchToday(currentUser.uid);
      const sales = await salesApi.fetchToday(currentUser.uid);
      await localDB.replaceMovements(movs);
      await localDB.replaceSales(sales);
      todayMovements = movs;
      todaySales = sales;
    } catch (e) {
      if (isQuotaError && isQuotaError(e)) showQuotaBanner();
      else console.log("[v0] Descarga fallida, uso datos locales:", e?.message || e);
    }
  }

  syncing = false;
  refreshSyncUI();
}

// Sube a Firebase los cambios encolados. Devuelve true si quedó vacía.
// Semáforo: si ya hay un flush corriendo, espera a que termine y sale.
async function flushOutbox() {
  if (flushing) return false; // ya hay uno en curso; el outbox se procesa solo
  flushing = true;
  try {
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
        } else if (op.type === "sale") {
          await salesApi.commit(op.uid, op.payload.sale);
        }
        await localDB.deleteFromOutbox(op.id);
      } catch (e) {
        if (isQuotaError && isQuotaError(e)) {
          showQuotaBanner();
          return false; // no reintenta: cuota agotada hasta medianoche
        }
        console.log("[v0] No se pudo subir (sin conexión):", e?.message || e);
        return false; // corta para conservar el orden; se reintenta luego
      }
    }
    return true;
  } finally {
    flushing = false;
  }
}

// Versión con debounce: agrupa operaciones ráfaga (ej: cobrar varios items)
// en un solo flush 800 ms después de la última escritura.
function scheduleFlush() {
  clearTimeout(flushTimer);
  flushTimer = setTimeout(async () => {
    await flushOutbox();
    refreshSyncUI();
  }, 800);
}

async function refreshSyncUI() {
  const status = $("#sync-status");
  const dot = $("#sync-dot");
  if (!status) return;
  const pending = await localDB.outboxCount().catch(() => 0);
  const meta = await localDB.getMeta().catch(() => null);

  // Punto de color: amarillo=pendiente, verde=ok, gris=sin datos
  const dotClass = syncing || pending > 0
    ? "bg-yellow-400"
    : meta?.ts ? "bg-green-500" : "bg-ink/30";
  if (dot) dot.className = `h-2 w-2 shrink-0 rounded-full ${dotClass}`;

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
        ? `Actualizado ${hora}`
        : `Última sync: ${meta.fecha}`;
  } else {
    status.textContent = "Sin sincronizar";
  }
}

// ============================================================
//  Tabs
// ============================================================
const TAB_TITLES = {
  "tab-pos": "Caja",
  "tab-scan": "Escanear",
  "tab-inventory": "Inventario",
  "tab-reports": "Reportes",
  "tab-history": "Historial",
};

function isTabActive(tabId) {
  const el = $(`#${tabId}`);
  return el && !el.classList.contains("hidden");
}

function switchTab(tabId) {
  $$(".tab-panel").forEach((p) => p.classList.toggle("hidden", p.id !== tabId));
  $$(".nav-btn").forEach((b) => {
    const active = b.dataset.tab === tabId;
    b.classList.toggle("text-brand", active);
    b.classList.toggle("text-ink/40", !active);
    b.classList.toggle("nav-active", active);
  });
  $("#header-title").textContent = TAB_TITLES[tabId] || "Inventario";

  if (tabId === "tab-reports") renderReports();
  if (tabId === "tab-scan") focusScanInput();
  if (tabId === "tab-pos") focusPosInput();
}

// ============================================================
//  Lectura del código (lector USB tipo teclado)
// ============================================================
function focusScanInput() {
  const el = $("#scan-input");
  if (el && !anyModalOpen()) {
    el.value = "";
    el.focus();
  }
}

function focusPosInput() {
  const el = $("#pos-scan-input");
  if (el && !anyModalOpen()) el.focus();
}

function anyModalOpen() {
  return !!document.querySelector(".modal:not(.hidden)");
}

let lastScan = { code: null, time: 0 };
function handleScannedCode(code) {
  if (!code) return;
  if (anyModalOpen()) return;
  // En la Caja, cada escaneo suma al ticket (sin anti-rebote, para poder
  // escanear varias unidades iguales seguidas).
  if (isTabActive("tab-pos")) {
    posAddByCode(code);
    return;
  }
  // Anti-rebote: ignora el mismo código repetido en menos de 1.2 s
  const now = Date.now();
  if (code === lastScan.code && now - lastScan.time < 1200) return;
  lastScan = { code, time: now };
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
//  Caja (POS)
// ============================================================
function stockOf(codigo) {
  const p = products.find((x) => x.codigo === codigo);
  return p ? (p.cantidad ?? 0) : 0;
}

function cartTotal() {
  // Para pesables, c.precio ya es el precio final (precioKilo * gramos / 1000).
  // Para normales, c.precio * c.cantidad.
  return cart.reduce((s, c) => s + (c.pesable ? c.precio : c.precio * c.cantidad), 0);
}

function posAddByCode(code) {
  const prod = products.find((p) => p.codigo === code);
  if (!prod) {
    showToast(`Código ${code} no está en el inventario`, "error");
    return;
  }
  if (prod.pesable) {
    openWeighModal(prod);
    return;
  }
  const linea = cart.find((c) => c.codigo === prod.codigo);
  const enCarrito = linea ? linea.cantidad : 0;
  if (enCarrito + 1 > (prod.cantidad ?? 0)) {
    showToast(`Sin stock suficiente de ${prod.nombre}`, "error");
    return;
  }
  if (linea) linea.cantidad += 1;
  else
    cart.push({
      codigo: prod.codigo,
      nombre: prod.nombre,
      precio: Number(prod.precioVenta) || 0,
      cantidad: 1,
      pesable: false,
    });
  renderCart();
}

// ── Búsqueda por nombre en la caja ──────────────────────────
let posSearchTimeout = null;
function posPendingSearch(term) {
  clearTimeout(posSearchTimeout);
  const results = $("#pos-search-results");
  if (!term || term.length < 2) { results.classList.add("hidden"); return; }
  posSearchTimeout = setTimeout(() => {
    const t = term.toLowerCase();
    const matches = products
      .filter((p) => (p.nombre || "").toLowerCase().includes(t))
      .slice(0, 8);
    if (!matches.length) { results.classList.add("hidden"); return; }
    results.innerHTML = matches.map((p) => `
      <li data-code="${escapeAttr(p.codigo)}"
        class="flex cursor-pointer items-center gap-3 px-4 py-3.5 hover:bg-brand/5 active:bg-brand/10 border-b border-ink/5 last:border-0">
        <div class="min-w-0 flex-1">
          <p class="text-base font-semibold text-ink leading-tight">${escapeHtml(p.nombre)}</p>
          <p class="mt-0.5 font-mono text-xs text-ink/30">${escapeHtml(p.codigo)}</p>
        </div>
        <span class="shrink-0 rounded-lg px-2.5 py-1 text-sm font-bold ${p.pesable ? "bg-brand/10 text-brand" : "bg-ink/5 text-ink/70"}">
          ${p.pesable ? `$${formatPrice(p.precioKilo)}/kg` : `$${formatPrice(p.precioVenta)}`}
        </span>
      </li>`).join("");
    results.classList.remove("hidden");
    results.querySelectorAll("li[data-code]").forEach((el) =>
      el.addEventListener("click", () => {
        results.classList.add("hidden");
        $("#pos-scan-input").value = "";
        posAddByCode(el.dataset.code);
      })
    );
  }, 200);
}

// ── Modal de pesable: ingresar gramos ───────────────────────
let pendingWeighProduct = null;
function openWeighModal(prod) {
  pendingWeighProduct = prod;
  $("#weigh-product-name").textContent = prod.nombre;
  $("#weigh-price-ref").textContent = `$${formatPrice(prod.precioKilo)} por kilo`;
  $("#weigh-grams").value = "";
  $("#weigh-preview").classList.add("hidden");
  openModal("weigh-modal");
  setTimeout(() => $("#weigh-grams").focus(), 120);
}

function confirmWeigh() {
  const prod = pendingWeighProduct;
  if (!prod) return;
  const gramos = parseFloat($("#weigh-grams").value) || 0;
  if (gramos <= 0) { showToast("Ingresá los gramos", "error"); return; }
  const precio = (prod.precioKilo * gramos) / 1000;
  // Cada pesada es una línea separada en el carrito (identificador único por timestamp)
  const uid = `${prod.codigo}-${Date.now()}`;
  cart.push({
    codigo: uid,
    nombre: `${prod.nombre} (${gramos}g)`,
    precio,        // precio final ya calculado
    cantidad: 1,
    pesable: true,
    codigoBase: prod.codigo,
  });
  closeModal("weigh-modal");
  pendingWeighProduct = null;
  renderCart();
  showToast(`${prod.nombre} — ${gramos}g → $${formatPrice(precio)}`, "success");
}

function posChangeQty(codigo, delta) {
  const linea = cart.find((c) => c.codigo === codigo);
  if (!linea) return;
  const nueva = linea.cantidad + delta;
  if (nueva <= 0) {
    cart = cart.filter((c) => c.codigo !== codigo);
  } else if (nueva > stockOf(codigo)) {
    showToast("No hay más stock de este producto", "error");
    return;
  } else {
    linea.cantidad = nueva;
  }
  renderCart();
}

function posRemove(codigo) {
  cart = cart.filter((c) => c.codigo !== codigo);
  renderCart();
}

function renderCart() {
  const list = $("#pos-cart");
  if (!list) return;
  $("#pos-empty").classList.toggle("hidden", cart.length > 0);
  list.innerHTML = cart.map(renderCartRow).join("");

  list.querySelectorAll("[data-inc]").forEach((el) =>
    el.addEventListener("click", () => posChangeQty(el.dataset.inc, 1))
  );
  list.querySelectorAll("[data-dec]").forEach((el) =>
    el.addEventListener("click", () => posChangeQty(el.dataset.dec, -1))
  );
  list.querySelectorAll("[data-del]").forEach((el) =>
    el.addEventListener("click", () => posRemove(el.dataset.del))
  );

  const count = cart.reduce((s, c) => s + c.cantidad, 0);
  $("#pos-count").textContent = count;
  $("#pos-total").textContent = "$" + formatPrice(cartTotal());
  posUpdateCash();
  updateChargeButton();
}

function renderCartRow(c) {
  if (c.pesable) {
    return `
      <li class="flex items-center gap-2 rounded-xl border border-brand/20 bg-brand/5 p-2.5">
        <div class="min-w-0 flex-1">
          <p class="truncate text-sm font-semibold text-ink">${escapeHtml(c.nombre)}</p>
          <p class="text-xs text-ink/40">Precio calculado por peso</p>
        </div>
        <span class="w-20 text-right text-sm font-bold text-brand">$${formatPrice(c.precio)}</span>
        <button data-del="${escapeAttr(c.codigo)}" aria-label="Quitar" class="flex h-8 w-8 items-center justify-center rounded-lg text-ink/40 transition hover:bg-ink/5 hover:text-ink">
          <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </li>`;
  }
  const sub = c.precio * c.cantidad;
  return `
    <li class="flex items-center gap-2 rounded-xl border border-ink/10 bg-paper p-2.5">
      <div class="min-w-0 flex-1">
        <p class="truncate text-sm font-semibold text-ink">${escapeHtml(c.nombre)}</p>
        <p class="text-xs text-ink/40">$${formatPrice(c.precio)} c/u</p>
      </div>
      <div class="flex items-center gap-1.5">
        <button data-dec="${escapeAttr(c.codigo)}" class="flex h-8 w-8 items-center justify-center rounded-lg bg-ink/10 text-lg font-bold text-ink active:scale-95">−</button>
        <span class="w-6 text-center text-sm font-bold text-ink">${c.cantidad}</span>
        <button data-inc="${escapeAttr(c.codigo)}" class="flex h-8 w-8 items-center justify-center rounded-lg bg-ink/10 text-lg font-bold text-ink active:scale-95">+</button>
      </div>
      <span class="w-20 text-right text-sm font-bold text-ink">$${formatPrice(sub)}</span>
      <button data-del="${escapeAttr(c.codigo)}" aria-label="Quitar" class="flex h-8 w-8 items-center justify-center rounded-lg text-ink/40 transition hover:bg-ink/5 hover:text-ink">
        <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </li>`;
}

function renderPosMethods() {
  const wrap = $("#pos-methods");
  if (!wrap) return;
  wrap.innerHTML = PAYMENT_METHODS.map((m) => {
    const active = posMethod === m.id;
    const cls = active
      ? "border-brand bg-brand text-white"
      : "border-ink/15 bg-white text-ink/80 hover:bg-paper";
    return `<button data-method="${m.id}" class="rounded-xl border px-3 py-2.5 text-sm font-semibold transition active:scale-[0.98] ${cls}">${m.label}</button>`;
  }).join("");
  wrap.querySelectorAll("[data-method]").forEach((el) =>
    el.addEventListener("click", () => posSetMethod(el.dataset.method))
  );
}

function posSetMethod(id) {
  posMethod = id;
  renderPosMethods();
  $("#pos-cash").classList.toggle("hidden", id !== "efectivo");
  posUpdateCash();
  updateChargeButton();
}

function posUpdateCash() {
  if (posMethod !== "efectivo") return;
  const given = parseFloat($("#pos-cash-given").value) || 0;
  const vuelto = given - cartTotal();
  $("#pos-change").textContent = "$" + formatPrice(vuelto > 0 ? vuelto : 0);
  updateChargeButton();
}

// Atajo de efectivo: "exact" pone el total justo; un número pone ese billete.
function posSetCash(kind) {
  const input = $("#pos-cash-given");
  if (!input) return;
  input.value = kind === "exact" ? Math.round(cartTotal()) : parseInt(kind, 10) || 0;
  posUpdateCash();
}

function updateChargeButton() {
  const btn = $("#pos-charge-btn");
  if (!btn) return;
  const total = cartTotal();
  const cashOk = posMethod !== "efectivo" ||
    (parseFloat($("#pos-cash-given").value) || 0) >= total;
  btn.disabled = !(cart.length > 0 && !!posMethod && cashOk);
  btn.textContent = cart.length > 0 ? `Cobrar $${formatPrice(total)}` : "Cobrar";
}

function posClear() {
  cart = [];
  posMethod = null;
  const cash = $("#pos-cash-given");
  if (cash) cash.value = "";
  $("#pos-cash").classList.add("hidden");
  renderPosMethods();
  renderCart();
}

async function posCharge() {
  if (cart.length === 0) {
    showToast("El ticket está vacío", "error");
    return;
  }
  if (!posMethod) {
    showToast("Elegí un método de pago", "error");
    return;
  }
  for (const c of cart) {
    if (c.cantidad > stockOf(c.codigo)) {
      showToast(`Sin stock suficiente de ${c.nombre}`, "error");
      return;
    }
  }

  const items = cart.map((c) => ({
    codigo: c.codigo,
    nombre: c.nombre,
    precio: c.precio,
    cantidad: c.cantidad,
  }));
  const total = cartTotal();
  const sale = { items, total, metodoPago: posMethod, ts: Date.now() };
  const metodoLabel = PAYMENT_METHODS.find((m) => m.id === posMethod)?.label || posMethod;

  // 1) Actualiza el dispositivo al instante: stock, movimientos y venta.
  for (const it of items) {
    const idx = products.findIndex((p) => p.codigo === it.codigo);
    if (idx >= 0) {
      products[idx] = {
        ...products[idx],
        cantidad: (products[idx].cantidad ?? 0) - it.cantidad,
      };
      await localDB.putProduct(products[idx]);
    }
    const mov = {
      codigo: it.codigo,
      nombre: it.nombre,
      accion: "salida",
      cantidad: it.cantidad,
      ts: sale.ts,
    };
    todayMovements.unshift(mov);
    await localDB.addMovement(mov);
  }
  todaySales.unshift(sale);
  await localDB.addSale(sale);

  posClear();
  renderInventory();
  renderReports();
  renderHistory(todayMovements);
  focusPosInput();

  // 2) Encola la venta completa y programa la subida (debounce).
  await localDB.addToOutbox({ uid: currentUser.uid, type: "sale", payload: { sale } });
  scheduleFlush();

  showToast(
    `Venta cobrada · ${metodoLabel} · $${formatPrice(total)}`,
    "success"
  );
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

  // 2) Encola y programa la subida a Firebase (debounce).
  await localDB.addToOutbox({
    uid: currentUser.uid,
    type: "adjust",
    payload: { producto: { codigo: producto.codigo, nombre: producto.nombre }, accion, cantidad },
  });
  scheduleFlush();

  showToast(
    `${verbo} ${cantidad} u. de ${producto.nombre}`,
    "success"
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

  // Estado por defecto: producto normal
  $("#pf-precio-kilo-wrap").classList.add("hidden");
  $("#pf-minimo-wrap").classList.remove("hidden");
  $("#pf-venta-wrap").classList.remove("hidden");
  $("#pf-cantidad-label").textContent = "Cantidad actual";
  $("#pf-minimo").required = true;
  $("#pf-pesable").checked = false;

  if (product) {
    editingCode = product.codigo;
    $("#product-modal-title").textContent = "Editar producto";
    $("#pf-codigo").value = product.codigo;
    $("#pf-codigo").readOnly = true;
    $("#pf-codigo").classList.add("bg-paper");
    $("#pf-nombre").value = product.nombre || "";
    $("#pf-cantidad").value = product.cantidad ?? 0;
    $("#pf-costo").value = product.precioCosto ?? 0;
    if (product.pesable) {
      $("#pf-pesable").checked = true;
      $("#pf-precio-kilo-wrap").classList.remove("hidden");
      $("#pf-precio-kilo").value = product.precioKilo ?? 0;
      $("#pf-minimo-wrap").classList.add("hidden");
      $("#pf-venta-wrap").classList.add("hidden");
      $("#pf-cantidad-label").textContent = "Kilos disponibles";
      $("#pf-minimo").required = false;
    } else {
      $("#pf-minimo").value = product.stockMinimo ?? 0;
      $("#pf-venta").value = product.precioVenta ?? 0;
    }
    $("#product-delete-btn").classList.remove("hidden");
  } else {
    editingCode = null;
    $("#product-modal-title").textContent = "Nuevo producto";
    // ID de 13 dígitos generado automáticamente — no editable
    $("#pf-codigo").value = generateUID();
    $("#pf-codigo").readOnly = true;
    $("#pf-codigo").classList.add("bg-paper");
    $("#product-delete-btn").classList.add("hidden");
  }
  openModal("product-modal");
}

function openProductFormWithCode(code) {
  openProductForm();
  // Viene de un escaneo real: reemplaza el ID generado con el código leído
  // y lo deja editable por si el operario necesita corregirlo.
  $("#pf-codigo").value = code;
  $("#pf-codigo").readOnly = false;
  $("#pf-codigo").classList.remove("bg-paper");
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
  const pesable = $("#pf-pesable").checked;
  const data = {
    codigo,
    nombre,
    cantidad: parseFloat($("#pf-cantidad").value) || 0,
    precioCosto: parseFloat($("#pf-costo").value) || 0,
    pesable,
    ...(pesable
      ? { precioKilo: parseFloat($("#pf-precio-kilo").value) || 0,
          stockMinimo: 0,
          precioVenta: 0 }
      : { stockMinimo: parseInt($("#pf-minimo").value, 10) || 0,
          precioVenta: parseFloat($("#pf-venta").value) || 0,
          precioKilo: 0 }),
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

  // 2) Encola + programa subida
  await localDB.addToOutbox({ uid: currentUser.uid, type: "save", payload: { data } });
  scheduleFlush();
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
  scheduleFlush();
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
  const agotado = cantidad === 0;
  const bajo = !agotado && cantidad <= minimo;
  const ok = !agotado && !bajo;

  const cardClasses = agotado
    ? "border-red-200 bg-red-50"
    : bajo
    ? "border-orange-200 bg-orange-50"
    : "border-green-200 bg-green-50";

  const cantColor = agotado
    ? "text-red-600"
    : bajo
    ? "text-orange-500"
    : "text-green-600";

  const badge = agotado
    ? `<span class="inline-flex items-center gap-1 rounded-full bg-red-500 px-2 py-0.5 text-xs font-semibold text-white">
         <svg class="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><path d="M12 9v4M12 17h.01" stroke-linecap="round"/></svg>
         Sin stock
       </span>`
    : bajo
    ? `<span class="inline-flex items-center gap-1 rounded-full bg-orange-400 px-2 py-0.5 text-xs font-semibold text-white">
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
        <p class="text-2xl font-bold leading-none ${cantColor}">${cantidad}</p>
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
  // --- Ventas de hoy (caja) ---
  const salesTotal = todaySales.reduce((s, v) => s + (v.total || 0), 0);
  const salesCount = todaySales.length;
  setText("rep-sales-total", "$" + formatPrice(salesTotal));
  setText("rep-sales-count", salesCount);
  setText("rep-sales-avg", "$" + formatPrice(salesCount ? salesTotal / salesCount : 0));

  const byMethod = {};
  for (const v of todaySales) {
    const k = v.metodoPago || "otro";
    if (!byMethod[k]) byMethod[k] = { count: 0, total: 0 };
    byMethod[k].count++;
    byMethod[k].total += v.total || 0;
  }
  const methodsList = $("#rep-methods");
  $("#rep-methods-empty").classList.toggle("hidden", salesCount > 0);
  methodsList.innerHTML = PAYMENT_METHODS.filter((m) => byMethod[m.id])
    .map((m) => {
      const d = byMethod[m.id];
      return `
      <li class="flex items-center justify-between rounded-2xl bg-white p-3 shadow-sm ring-1 ring-ink/10">
        <div>
          <p class="font-medium text-ink">${m.label}</p>
          <p class="text-xs text-ink/40">${d.count} ${d.count === 1 ? "venta" : "ventas"}</p>
        </div>
        <span class="text-lg font-bold text-ink">$${formatPrice(d.total)}</span>
      </li>`;
    })
    .join("");

  // --- Valor del inventario ---
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
  const agotado = cantidad === 0;
  return `
    <li class="flex items-center gap-3 rounded-2xl border ${agotado ? "border-red-300 bg-red-50" : "border-orange-200 bg-orange-50"} p-3 shadow-sm">
      <span class="flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${agotado ? "bg-red-500" : "bg-orange-400"} text-white">
        <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><path d="M12 9v4M12 17h.01" stroke-linecap="round"/><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/></svg>
      </span>
      <div class="min-w-0 flex-1">
        <p class="truncate font-semibold ${agotado ? "text-red-700" : "text-orange-700"}">${escapeHtml(p.nombre || p.codigo)}</p>
        <p class="text-xs ${agotado ? "text-red-400" : "text-orange-400"}">Mínimo: ${minimo} · ${agotado ? "¡Sin stock!" : "Quedan pocos"}</p>
      </div>
      <span class="text-lg font-bold ${agotado ? "text-red-600" : "text-orange-500"}">${cantidad}</span>
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

// ============================================================
//  Exportar a Excel (.xlsx) — usa SheetJS (window.XLSX)
// ============================================================
function methodLabel(id) {
  return PAYMENT_METHODS.find((m) => m.id === id)?.label || id || "Otro";
}

function excelReady() {
  if (typeof XLSX === "undefined") {
    showToast("No se pudo cargar Excel. Revisá tu conexión.", "error");
    return false;
  }
  return true;
}

// Inventario actual → planilla con stock y valorización.
function exportInventoryXlsx() {
  if (!excelReady()) return;
  if (!products.length) {
    showToast("No hay productos para exportar", "error");
    return;
  }
  const rows = products.map((p) => {
    const cant = p.cantidad ?? 0;
    const costo = Number(p.precioCosto) || 0;
    const venta = Number(p.precioVenta) || 0;
    return {
      "Código": p.codigo,
      "Nombre": p.nombre || "",
      "Cantidad": cant,
      "Stock mínimo": p.stockMinimo ?? 0,
      "Precio costo": costo,
      "Precio venta": venta,
      "Valor costo": cant * costo,
      "Valor venta": cant * venta,
    };
  });
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Inventario");
  XLSX.writeFile(wb, `inventario-${new Date().toISOString().slice(0, 10)}.xlsx`);
  showToast("Inventario exportado", "success");
}

// Ventas de caja del mes → detalle + resumen por método. Filtra por método.
async function exportSalesXlsx() {
  if (!excelReady()) return;
  const monthVal = $("#report-month").value; // "YYYY-MM"
  if (!monthVal) {
    showToast("Elegí un mes", "error");
    return;
  }
  const [y, m] = monthVal.split("-").map(Number);
  const start = new Date(y, m - 1, 1, 0, 0, 0, 0);
  const end = new Date(y, m, 1, 0, 0, 0, 0);
  const methodFilter = $("#report-method").value; // "" = todos

  const btn = $("#export-sales-xlsx");
  btn.disabled = true;
  try {
    let sales = await salesApi.fetchRange(currentUser.uid, start, end);
    if (methodFilter) sales = sales.filter((s) => s.metodoPago === methodFilter);
    if (!sales.length) {
      showToast("No hay ventas en ese período", "info");
      return;
    }

    // Hoja "Ventas" (detalle)
    const detail = sales.map((s) => {
      const d = new Date(s.ts);
      const arts = (s.items || []).reduce((a, it) => a + (it.cantidad || 0), 0);
      return {
        "Fecha": d.toLocaleDateString("es"),
        "Hora": d.toLocaleTimeString("es", { hour: "2-digit", minute: "2-digit" }),
        "Método de pago": methodLabel(s.metodoPago),
        "Artículos": arts,
        "Total": s.total || 0,
      };
    });
    const wsDetail = XLSX.utils.json_to_sheet(detail);

    // Hoja "Resumen" (por método + total del mes)
    const byMethod = {};
    for (const s of sales) {
      const k = s.metodoPago || "otro";
      if (!byMethod[k]) byMethod[k] = { count: 0, total: 0 };
      byMethod[k].count++;
      byMethod[k].total += s.total || 0;
    }
    const grand = sales.reduce((a, s) => a + (s.total || 0), 0);
    const resumen = Object.keys(byMethod).map((k) => ({
      "Método de pago": methodLabel(k),
      "Ventas": byMethod[k].count,
      "Total": byMethod[k].total,
    }));
    resumen.push({ "Método de pago": "TOTAL DEL MES", "Ventas": sales.length, "Total": grand });
    const wsResumen = XLSX.utils.json_to_sheet(resumen);

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, wsResumen, "Resumen");
    XLSX.utils.book_append_sheet(wb, wsDetail, "Ventas");
    const sufijo = methodFilter ? `-${methodFilter}` : "";
    XLSX.writeFile(wb, `ventas-${monthVal}${sufijo}.xlsx`);
    showToast(`Ventas exportadas · $${formatPrice(grand)}`, "success");
  } catch (e) {
    console.log("[v0] Error al exportar ventas:", e?.message || e);
    showToast("No se pudo descargar (¿sin conexión?)", "error");
  } finally {
    btn.disabled = false;
  }
}

// Prepara el selector de método y el mes por defecto del reporte.
function initReportControls() {
  const sel = $("#report-method");
  if (sel && sel.options.length <= 1) {
    for (const mth of PAYMENT_METHODS) {
      const o = document.createElement("option");
      o.value = mth.id;
      o.textContent = mth.label;
      sel.appendChild(o);
    }
  }
  const month = $("#report-month");
  if (month && !month.value) {
    const d = new Date();
    month.value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  }
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
  maybeRefocusScan();
}
function closeAllModals() {
  $$(".modal").forEach((m) => m.classList.add("hidden"));
  document.body.style.overflow = "";
  maybeRefocusScan();
}

// Si quedamos en la pestaña Escanear, vuelve a enfocar el campo para
// poder disparar el lector enseguida.
function maybeRefocusScan() {
  const scanPanel = $("#tab-scan");
  if (scanPanel && !scanPanel.classList.contains("hidden")) {
    setTimeout(focusScanInput, 50);
  }
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

// Genera un ID de 13 dígitos aleatorios para productos sin código de barras.
function generateUID() {
  let id = "";
  while (id.length < 13) id += Math.floor(Math.random() * 10);
  return id;
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

  // Campo de escaneo (lector USB o tipeo manual)
  const scanInput = $("#scan-input");
  const submitScan = () => {
    const code = scanInput.value.trim();
    scanInput.value = "";
    if (code) handleScannedCode(code);
  };
  scanInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      submitScan();
    }
  });
  $("#scan-go-btn").addEventListener("click", submitScan);

  // Caja (POS)
  const posInput = $("#pos-scan-input");
  const posAdd = () => {
    const val = posInput.value.trim();
    posInput.value = "";
    $("#pos-search-results").classList.add("hidden");
    if (val) posAddByCode(val);
    posInput.focus();
  };
  posInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); posAdd(); }
    if (e.key === "Escape") { $("#pos-search-results").classList.add("hidden"); }
  });
  posInput.addEventListener("input", () => posPendingSearch(posInput.value.trim()));
  posInput.addEventListener("blur", () =>
    setTimeout(() => $("#pos-search-results").classList.add("hidden"), 150)
  );
  $("#pos-add-btn").addEventListener("click", posAdd);
  $("#pos-cash-given").addEventListener("input", posUpdateCash);
  $("#pos-cash-quick").addEventListener("click", (e) => {
    const b = e.target.closest("[data-cash]");
    if (b) posSetCash(b.dataset.cash);
  });
  $("#pos-charge-btn").addEventListener("click", posCharge);
  $("#pos-clear-btn").addEventListener("click", posClear);

  // Modal de pesable: confirmar gramos
  $("#weigh-grams").addEventListener("input", () => {
    const prod = pendingWeighProduct;
    if (!prod) return;
    const g = parseFloat($("#weigh-grams").value) || 0;
    const precio = (prod.precioKilo * g) / 1000;
    const preview = $("#weigh-preview");
    if (g > 0) {
      $("#weigh-preview-price").textContent = "$" + formatPrice(precio);
      preview.classList.remove("hidden");
    } else {
      preview.classList.add("hidden");
    }
  });
  $("#weigh-grams").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); confirmWeigh(); }
  });
  $("#weigh-confirm-btn").addEventListener("click", confirmWeigh);

  // Toggle pesable: ajusta campos visibles según el tipo de producto
  $("#pf-pesable").addEventListener("change", () => {
    const isPesable = $("#pf-pesable").checked;
    $("#pf-precio-kilo-wrap").classList.toggle("hidden", !isPesable);
    $("#pf-minimo-wrap").classList.toggle("hidden", isPesable);
    $("#pf-venta-wrap").classList.toggle("hidden", isPesable);
    $("#pf-cantidad-label").textContent = isPesable ? "Kilos disponibles" : "Cantidad actual";
    $("#pf-minimo").required = !isPesable;
    if (isPesable) {
      $("#pf-minimo").value = 0;
      $("#pf-venta").value = 0;
      setTimeout(() => $("#pf-precio-kilo").focus(), 50);
    }
  });

  // Exportar a Excel
  initReportControls();
  $("#export-inventory-xlsx").addEventListener("click", exportInventoryXlsx);
  $("#export-sales-xlsx").addEventListener("click", exportSalesXlsx);

  $("#add-product-btn").addEventListener("click", () => openProductForm());
  $("#inventory-search").addEventListener("input", renderInventory);

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