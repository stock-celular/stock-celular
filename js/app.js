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
  { id: "fiado", label: "Fiado" },
];

const scanner = new BarcodeScanner({ onScan: (code) => handleScannedCode(code) });

// Se cargan dinámicamente solo si Firebase está configurado
let authApi, usersApi, productsApi, movementsApi, salesApi, fiadoresApi, abonosApi, isQuotaError;
let todayAbonos = []; // abonos (pagos de fiados) del día
let fiadores = [];    // personas registradas para fiar
let posFiado = null;  // { id, nombre } elegido para el ticket actual
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
  fiadoresApi = fb.fiadoresApi;
  abonosApi = fb.abonosApi;
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
    "fixed inset-x-0 top-0 z-50 flex items-start gap-3 bg-black px-4 py-3 text-white shadow-lg";
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
  fiadores = await localDB.getFiadores();
  todayAbonos = await localDB.getTodayAbonos();

  // Descarga movimientos y ventas solo si es un día nuevo
  const meta = await localDB.getMeta();
  const sameDay = meta && meta.uid === currentUser.uid && meta.fecha === todayStr();

  if (!sameDay) {
    try {
      const movs = await movementsApi.fetchToday(currentUser.uid);
      const sales = await salesApi.fetchToday(currentUser.uid);
      const people = await fiadoresApi.fetchAll(currentUser.uid);
      const abonos = await abonosApi.fetchToday(currentUser.uid);
      await localDB.replaceMovements(movs);
      await localDB.replaceSales(sales);
      await localDB.replaceFiadores(people);
      await localDB.replaceAbonos(abonos);
      todayMovements = movs;
      todaySales = sales;
      fiadores = people;
      todayAbonos = abonos;
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
  const uid = currentUser?.uid;
  if (!uid) return false; // sesión cerrada mientras corría el debounce (logout)
  flushing = true;
  try {
    const ops = await localDB.getOutbox();
    for (const op of ops) {
      if (op.uid !== uid) continue; // ops de otro usuario: se respetan
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
        } else if (op.type === "revertSale") {
          await salesApi.revert(op.uid, op.payload.sale);
        } else if (op.type === "updateSale") {
          await salesApi.update(op.uid, op.payload.sale, op.payload.deltas || [], op.payload.fiadoDelta || null);
        } else if (op.type === "fiador") {
          await fiadoresApi.save(op.uid, op.payload.fiador);
        } else if (op.type === "abono") {
          await abonosApi.commit(op.uid, op.payload.abono);
        } else if (op.type === "abonoRevert") {
          await abonosApi.revert(op.uid, op.payload.abono);
        } else if (op.type === "fiadorSaldo") {
          await fiadoresApi.setSaldo(op.uid, op.payload.id, op.payload.saldo, op.payload.ts);
        } else if (op.type === "fiadorCupo") {
          await fiadoresApi.setCupo(op.uid, op.payload.id, op.payload.cupo);
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
    : meta?.ts ? "bg-ink" : "bg-ink/30";
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
  "tab-stats": "Estadísticas",
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
  if (tabId === "tab-sales") renderSales();
  if (tabId === "tab-fiados") renderFiadosPeople();
  if (tabId === "tab-scan") focusScanInput();
  if (tabId === "tab-pos") focusPosInput();
  if (tabId === "tab-stats") renderStats();
}

// ============================================================
//  Lectura del código (lector USB tipo teclado)
// ============================================================
function focusScanInput() {
  // El campo de escaneo es de solo lectura (display), no hay input que enfocar.
  // El lector USB opera a nivel de documento y funciona en cualquier pantalla.
}

function focusPosInput() {
  const el = $("#pos-scan-input");
  if (el && !anyModalOpen()) el.focus();
}

function anyModalOpen() {
  return !!document.querySelector(".modal:not(.hidden)");
}

let lastScan = { code: null, time: 0 };
let scanDisplayTimer = null;

function showScanFeedback(code, found) {
  const display = $("#scan-display");
  const chip    = $("#scan-status-chip");
  if (!display) return;
  display.textContent = code;
  display.classList.remove("text-ink/30");
  display.classList.add("text-ink");
  if (chip) {
    chip.classList.remove("hidden", "bg-ink", "text-white", "bg-ink/10", "text-ink");
    if (found) {
      chip.textContent = "Encontrado";
      chip.classList.add("bg-ink", "text-white");
    } else {
      chip.textContent = "Nuevo";
      chip.classList.add("bg-ink/10", "text-ink");
    }
    chip.classList.remove("hidden");
  }
  clearTimeout(scanDisplayTimer);
  scanDisplayTimer = setTimeout(() => {
    display.textContent = "— — —";
    display.classList.add("text-ink/30");
    display.classList.remove("text-ink");
    if (chip) chip.classList.add("hidden");
  }, 2000);
}

function handleScannedCode(code) {
  if (!code) return;
  if (anyModalOpen()) return;
  // En la Caja, cada escaneo suma al ticket.
  if (isTabActive("tab-pos")) {
    posAddByCode(code);
    return;
  }
  // Anti-rebote: ignora el mismo código repetido en menos de 1.2 s
  const now = Date.now();
  if (code === lastScan.code && now - lastScan.time < 1200) return;
  lastScan = { code, time: now };
  const found = products.find((p) => p.codigo === code);
  // Feedback visual en el display del módulo de escaneo
  if (isTabActive("tab-scan")) showScanFeedback(code, !!found);
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

// Redondea a la decena más cercana (355 → 360, 352 → 350).
// Se usa para precios de pesables, que casi nunca dan cifras "cobrables".
function roundToTen(n) {
  return Math.round(n / 10) * 10;
}

// ── Modal de confirmación propio (reemplaza a confirm() nativo) ──
let confirmResolver = null;

function showConfirm({ title = "¿Estás seguro?", message = "", confirmLabel = "Confirmar", danger = false } = {}) {
  return new Promise((resolve) => {
    confirmResolver = resolve;
    $("#confirm-title").textContent = title;
    $("#confirm-message").textContent = message;
    const btn = $("#confirm-accept-btn");
    btn.textContent = confirmLabel;
    btn.classList.toggle("bg-red-600", danger);
    btn.classList.toggle("hover:bg-red-700", danger);
    btn.classList.toggle("bg-brand", !danger);
    btn.classList.toggle("hover:bg-brand-dark", !danger);
    openModal("confirm-modal");
  });
}

function resolveConfirm(value) {
  closeModal("confirm-modal");
  if (confirmResolver) {
    confirmResolver(value);
    confirmResolver = null;
  }
}


function confirmWeigh() {
  const prod = pendingWeighProduct;
  if (!prod) return;
  const gramos = parseFloat($("#weigh-grams").value) || 0;
  if (gramos <= 0) { showToast("Ingresá los gramos", "error"); return; }
  const precio = roundToTen((prod.precioKilo * gramos) / 1000);
  // Cada pesada es una línea separada en el carrito (identificador único por timestamp)
  const uid = `${prod.codigo}-${Date.now()}`;
  cart.push({
    codigo: uid,
    nombre: `${prod.nombre} (${gramos}g)`,
    precio,        // precio final ya calculado
    cantidad: 1,
    pesable: true,
    gramos,
    codigoBase: prod.codigo,
    nombreBase: prod.nombre,
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
  if (c.pesable || c.manual) {
    return `
      <li class="flex items-center gap-2 rounded-xl border border-brand/20 bg-brand/5 p-2.5">
        <div class="min-w-0 flex-1">
          <p class="truncate text-sm font-semibold text-ink">${escapeHtml(c.nombre)}</p>
          <p class="text-xs text-ink/40">${c.manual ? "Ítem manual" : "Precio calculado por peso"}</p>
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
  if (id === "fiado") {
    // Primero se elige (o crea) la persona; el método queda fijado al confirmar.
    openFiadoModal();
    return;
  }
  posMethod = id;
  posFiado = null;
  updateFiadoChip();
  renderPosMethods();
  $("#pos-cash").classList.toggle("hidden", id !== "efectivo");
  posUpdateCash();
  updateChargeButton();
}

function updateFiadoChip() {
  const chip = $("#pos-fiado-chip");
  if (!chip) return;
  if (posFiado) {
    const f = fiadores.find((x) => x.id === posFiado.id) || posFiado;
    const disp = cupoDisponible(f);
    chip.textContent =
      disp == null
        ? `Fiado a: ${posFiado.nombre}`
        : `Fiado a: ${posFiado.nombre} · cupo disp. $${formatPrice(Math.max(0, disp))}`;
    chip.classList.remove("hidden");
    chip.classList.add("flex");
  } else {
    chip.classList.add("hidden");
    chip.classList.remove("flex");
  }
}

// ── Fiado: elegir o crear persona ──
// La unicidad se garantiza normalizando el nombre a un id (minúsculas,
// sin tildes, espacios colapsados): dos nombres "iguales" generan el mismo id.
function normalizeFiadoName(nombre) {
  return nombre
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function openFiadoModal() {
  $("#fiado-search").value = "";
  renderFiadoMatches("");
  openModal("fiado-modal");
  setTimeout(() => $("#fiado-search").focus(), 50);
}

function renderFiadoMatches(term) {
  const norm = normalizeFiadoName(term || "");
  const list = $("#fiado-matches");
  const matches = fiadores
    .filter((f) => !norm || f.id.includes(norm))
    .slice(0, 20);

  list.innerHTML = matches
    .map(
      (f) => `
      <li>
        <button data-fiado-id="${f.id}" class="flex w-full items-center gap-2 rounded-xl border border-ink/10 bg-paper px-3 py-2.5 text-left text-sm font-semibold text-ink transition active:scale-[0.99] hover:border-ink/30">
          <svg class="h-4 w-4 shrink-0 text-ink/40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
          ${escapeHtml(f.nombre)}
        </button>
      </li>`
    )
    .join("");
  list.querySelectorAll("[data-fiado-id]").forEach((el) =>
    el.addEventListener("click", () => {
      const f = fiadores.find((x) => x.id === el.dataset.fiadoId);
      if (f) selectFiado(f);
    })
  );

  // Botón "crear": solo si hay texto y no existe ese nombre exacto
  const createBtn = $("#fiado-create-btn");
  const nombre = (term || "").trim().replace(/\s+/g, " ");
  const exists = norm && fiadores.some((f) => f.id === norm);
  if (nombre.length >= 2 && !exists) {
    createBtn.textContent = `+ Crear «${nombre}»`;
    createBtn.classList.remove("hidden");
    createBtn.classList.add("flex");
  } else {
    createBtn.classList.add("hidden");
    createBtn.classList.remove("flex");
  }
}

// Registra una persona nueva (nombre único). Devuelve el fiador o null.
async function registerFiador(nombreCrudo) {
  const nombre = (nombreCrudo || "").trim().replace(/\s+/g, " ");
  if (nombre.length < 2) { showToast("Ingresá un nombre válido", "error"); return null; }
  const id = normalizeFiadoName(nombre);
  if (fiadores.some((f) => f.id === id)) {
    showToast("Esa persona ya está registrada", "error");
    return null;
  }
  const fiador = { id, nombre, saldo: 0, ultimoMovimiento: null };
  fiadores.push(fiador);
  fiadores.sort((a, b) => a.nombre.localeCompare(b.nombre, "es"));
  await localDB.putFiador(fiador);
  await localDB.addToOutbox({ uid: currentUser.uid, type: "fiador", payload: { fiador } });
  scheduleFlush();
  showToast(`${nombre} registrado`, "success");
  return fiador;
}

// Crear desde la caja: registra y lo deja elegido para el ticket
async function createFiado() {
  const fiador = await registerFiador($("#fiado-search").value);
  if (fiador) selectFiado(fiador);
}

function selectFiado(fiador) {
  posFiado = fiador;
  posMethod = "fiado";
  closeModal("fiado-modal");
  updateFiadoChip();

  // Aviso inmediato de cupo (el bloqueo duro está en el cobro)
  const disp = cupoDisponible(fiador);
  if (disp != null && disp <= 0) {
    showToast(`${fiador.nombre} tiene el cupo agotado ($${formatPrice(cupoOf(fiador))}). Debe abonar antes de fiar.`, "error");
  } else if (disp != null) {
    showToast(`A ${fiador.nombre} le quedan $${formatPrice(disp)} de cupo`, "info");
  }
  renderPosMethods();
  $("#pos-cash").classList.add("hidden");
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
  posFiado = null;
  updateFiadoChip();
  const cash = $("#pos-cash-given");
  if (cash) cash.value = "";
  $("#pos-cash").classList.add("hidden");
  renderPosMethods();
  renderCart();
}

// ── Ítem manual (sin código de barras): solo nombre y precio ──
function openManualItem() {
  $("#mi-nombre").value = "";
  $("#mi-precio").value = "";
  openModal("manual-item-modal");
  setTimeout(() => $("#mi-nombre").focus(), 50);
}

function confirmManualItem() {
  const nombre = $("#mi-nombre").value.trim();
  const precio = parseFloat($("#mi-precio").value) || 0;
  if (!nombre) { showToast("Ingresá un nombre", "error"); return; }
  if (precio <= 0) { showToast("Ingresá un precio válido", "error"); return; }
  cart.push({
    codigo: `manual-${Date.now()}`,
    nombre,
    precio,
    cantidad: 1,
    manual: true,
  });
  closeModal("manual-item-modal");
  renderCart();
  showToast(`${nombre} agregado`, "success");
}

function updateUndoButton() {
  const btn = $("#pos-undo-btn");
  if (!btn) return;
  const last = todaySales[0];
  btn.disabled = !last;
  btn.title = last ? `Última: $${formatPrice(last.total || 0)}` : "";
}

function saleTracksStock(it) {
  return !it.pesable && !it.manual;
}

// Anula una venta: repone stock, registra movimientos y la quita del día.
// La usan "Deshacer última venta" y el módulo de Ventas.
async function annulSale(sale) {
  // 1) Repone stock local (pesables y manuales no llevan stock)
  for (const it of sale.items || []) {
    if (!saleTracksStock(it)) continue;
    const idx = products.findIndex((p) => p.codigo === it.codigo);
    if (idx >= 0) {
      products[idx] = {
        ...products[idx],
        cantidad: (products[idx].cantidad ?? 0) + (it.cantidad || 0),
      };
      await localDB.putProduct(products[idx]);
    }
  }

  // 2) Registra movimientos de entrada por la anulación
  const now = Date.now();
  for (const it of sale.items || []) {
    const mov = {
      codigo: it.pesable ? (it.codigoBase || it.codigo) : it.codigo,
      nombre: `Anulación: ${it.nombre}`,
      accion: "entrada",
      cantidad: it.cantidad || 0,
      ts: now,
    };
    todayMovements.unshift(mov);
    await localDB.addMovement(mov);
  }

  // 3) Quita la venta del día (caché + IndexedDB)
  todaySales = todaySales.filter((v) => v.ts !== sale.ts);
  await localDB.replaceSales(todaySales);

  // 4) Nube: si la venta aún no se subió, basta con sacarla de la cola;
  //    si ya se subió, se encola la reversión.
  const pending = await localDB.getOutbox();
  const queued = pending.find(
    (op) => op.type === "sale" && op.payload?.sale?.ts === sale.ts
  );
  if (queued) {
    await localDB.deleteFromOutbox(queued.id);
  } else {
    await localDB.addToOutbox({ uid: currentUser.uid, type: "revertSale", payload: { sale } });
    scheduleFlush();
  }

  if (sale.fiadoId) await applyFiadoDeltaLocal(sale.fiadoId, -(sale.total || 0));

  renderInventory();
  renderReports();
  renderSales();
  renderHistory(todayMovements);
}

async function undoLastSale() {
  const sale = todaySales[0];
  if (!sale) {
    showToast("No hay ventas hoy para deshacer", "error");
    return;
  }
  const metodoLabel = PAYMENT_METHODS.find((m) => m.id === sale.metodoPago)?.label || sale.metodoPago;
  const ok = await showConfirm({
    title: "Deshacer última venta",
    message: `Se anulará la venta de $${formatPrice(sale.total || 0)} (${metodoLabel}) y se repondrá el stock.`,
    confirmLabel: "Deshacer",
    danger: true,
  });
  if (!ok) return;
  await annulSale(sale);
  showToast(`Venta de $${formatPrice(sale.total || 0)} anulada`, "success");
}

// ════════════════ MÓDULO: VENTAS (editar / anular / consultar por día) ════════════════
let editingSale = null;       // { ts, metodoPago, items: [copias editables] }
let salesDate = null;         // día que se está viendo (yyyy-mm-dd); null = hoy (se fija en init)
let displayedSales = [];      // lo que se muestra en pantalla

// La llaman caja/anulaciones: refresca la pantalla solo si se está viendo hoy.
function renderSales() {
  if (!salesDate || salesDate === todayISO()) displaySales(todaySales, true);
}

function displaySales(sales, editable) {
  displayedSales = sales;
  const list = $("#sales-list");
  if (!list) return;

  $("#sales-subtitle").textContent = editable
    ? "Toca una venta para corregirla o anularla. El stock se ajusta automáticamente."
    : "Días anteriores: solo consulta. Para corregir una venta, hazlo el mismo día.";

  const total = sales.reduce((s, v) => s + (v.total || 0), 0);
  const summary = $("#sales-summary");
  summary.classList.toggle("hidden", sales.length === 0);
  summary.textContent = `${sales.length} ${sales.length === 1 ? "venta" : "ventas"} · Total $${formatPrice(total)}`;

  $("#sales-empty").textContent = editable
    ? "Todavía no hay ventas hoy."
    : "No hay ventas registradas este día.";
  $("#sales-empty").classList.toggle("hidden", sales.length > 0);

  list.innerHTML = sales
    .map((v, i) => {
      const hora = new Date(v.ts || Date.now()).toLocaleTimeString("es", { hour: "2-digit", minute: "2-digit" });
      let metodo = PAYMENT_METHODS.find((m) => m.id === v.metodoPago)?.label || v.metodoPago || "—";
      if (v.metodoPago === "fiado" && v.fiadoNombre) metodo = `Fiado (${escapeHtml(v.fiadoNombre)})`;
      const nItems = (v.items || []).reduce((s, it) => s + (it.cantidad || 1), 0);
      const detalle = (v.items || []).map((it) => it.nombre).join(", ");
      const inner = `
          <div class="min-w-0 flex-1">
            <p class="text-sm font-semibold text-ink">${hora} · ${metodo}</p>
            <p class="mt-0.5 truncate text-xs text-ink/50">${nItems} art. — ${escapeHtml(detalle)}</p>
          </div>
          <span class="text-lg font-bold text-ink">$${formatPrice(v.total || 0)}</span>`;
      if (!editable) {
        return `
      <li class="flex w-full items-center gap-3 rounded-2xl border border-ink/10 bg-paper p-3">
        ${inner}
      </li>`;
      }
      return `
      <li>
        <button data-sale-idx="${i}" class="flex w-full items-center gap-3 rounded-2xl border border-ink/10 bg-paper p-3 text-left transition active:scale-[0.99] hover:border-ink/30">
          ${inner}
          <svg class="h-4 w-4 shrink-0 text-ink/40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>
        </button>
      </li>`;
    })
    .join("");
  if (editable) {
    list.querySelectorAll("[data-sale-idx]").forEach((el) =>
      el.addEventListener("click", () => openSaleEdit(todaySales[parseInt(el.dataset.saleIdx, 10)]))
    );
  }
}

// ════════════════ MÓDULO: FIADOS (cuentas por persona) ════════════════
let selectedFiado = null;

function renderFiadosPeople() {
  const listEl = $("#fiados-people");
  if (!listEl) return;
  const raw = $("#fiados-search").value || "";
  const term = normalizeFiadoName(raw);
  const matches = fiadores.filter((f) => !term || f.id.includes(term));

  // Crear persona directamente desde el cuaderno
  const createBtn = $("#fiados-create-btn");
  const nombre = raw.trim().replace(/\s+/g, " ");
  const exists = term && fiadores.some((f) => f.id === term);
  if (nombre.length >= 2 && !exists) {
    createBtn.textContent = `+ Crear «${nombre}»`;
    createBtn.classList.remove("hidden");
    createBtn.classList.add("flex");
  } else {
    createBtn.classList.add("hidden");
    createBtn.classList.remove("flex");
  }

  $("#fiados-people-empty").classList.toggle("hidden", fiadores.length > 0 || nombre.length >= 2);
  listEl.innerHTML = matches
    .map((f) => {
      const active = selectedFiado?.id === f.id;
      let chip = "";
      if (f.saldo == null) {
        chip = `<span class="shrink-0 text-xs ${active ? "text-white/40" : "text-ink/30"}">—</span>`;
      } else if (f.saldo > 0) {
        const disp = cupoDisponible(f);
        const tope = disp != null && disp <= 0
          ? `<span class="mr-1 shrink-0 rounded-full ${active ? "bg-white text-ink" : "bg-red-600 text-white"} px-2 py-0.5 text-[10px] font-bold uppercase">Tope</span>`
          : "";
        chip = `${tope}<span class="shrink-0 text-sm font-bold ${active ? "text-white" : "text-ink"}">$${formatPrice(f.saldo)}</span>`;
      } else if (f.saldo < 0) {
        chip = `<span class="shrink-0 rounded-full ${active ? "bg-white/15 text-white" : "bg-ink/10 text-ink/70"} px-2 py-0.5 text-[11px] font-semibold">A favor $${formatPrice(Math.abs(f.saldo))}</span>`;
      } else {
        chip = `<span class="shrink-0 rounded-full ${active ? "bg-white/15 text-white" : "bg-ink/10 text-ink/60"} px-2 py-0.5 text-[11px] font-semibold">Al día ✓</span>`;
      }
      return `
      <li>
        <button data-fiados-person="${f.id}" class="flex w-full items-center gap-3 rounded-2xl border p-3 text-left transition active:scale-[0.99] ${active ? "border-ink bg-ink text-white" : "border-ink/10 bg-paper text-ink hover:border-ink/30"}">
          <svg class="h-4 w-4 shrink-0 ${active ? "text-white/70" : "text-ink/40"}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
          <span class="min-w-0 flex-1 truncate text-sm font-semibold">${escapeHtml(f.nombre)}</span>
          ${chip}
        </button>
      </li>`;
    })
    .join("");
  listEl.querySelectorAll("[data-fiados-person]").forEach((el) =>
    el.addEventListener("click", () => {
      const f = fiadores.find((x) => x.id === el.dataset.fiadosPerson);
      if (f) openFiadoDetail(f);
    })
  );
}

let selectedFiadoSaldo = 0; // deuda pendiente de la persona seleccionada

// Espejo local del increment de la nube: mantiene el saldo del fiador
// al día en este dispositivo sin releer el historial.
async function applyFiadoDeltaLocal(fiadoId, delta, ts) {
  if (!fiadoId || !delta) return;
  const f = fiadores.find((x) => x.id === fiadoId);
  if (!f) return;
  f.saldo = (f.saldo ?? 0) + delta;
  f.ultimoMovimiento = ts || Date.now();
  await localDB.putFiador(f);
  if (selectedFiado?.id === fiadoId) {
    selectedFiadoSaldo = f.saldo;
    renderSaldoBox(f.saldo);
    $("#fiados-pay-btn").disabled = f.saldo <= 0;
  }
  renderFiadosPeople();
  renderReports();
  renderCupoBox();
}

// ============================================================
//  Cupo de crédito (límite de fiado por persona)
// ============================================================
// cupo definido = número > 0. null/0/ausente = sin límite.
function cupoOf(fiador) {
  const c = fiador?.cupo;
  return typeof c === "number" && c > 0 ? c : null;
}

// Disponible = cupo − deuda actual (puede ser negativo si ya lo excedió,
// p. ej. si el cupo se fijó después de acumular deuda).
function cupoDisponible(fiador) {
  const cupo = cupoOf(fiador);
  if (cupo == null) return null;
  return cupo - Math.max(0, fiador.saldo ?? 0);
}

// Valida si se le puede fiar `monto` más. Devuelve null si pasa,
// o el mensaje de error a mostrar si no.
function cupoError(fiador, monto) {
  const disp = cupoDisponible(fiador);
  if (disp == null) return null; // sin límite
  if (monto <= disp) return null;
  if (disp <= 0) {
    return `${fiador.nombre} llegó a su cupo de $${formatPrice(cupoOf(fiador))}. Debe abonar antes de fiar de nuevo.`;
  }
  return `Supera el cupo de ${fiador.nombre}: le quedan $${formatPrice(disp)} disponibles (cupo $${formatPrice(cupoOf(fiador))}).`;
}

// Pinta la caja de cupo en el detalle del fiador seleccionado.
function renderCupoBox() {
  const f = selectedFiado ? fiadores.find((x) => x.id === selectedFiado.id) : null;
  const textEl = $("#fiados-cupo-text");
  if (!textEl || !f) return;
  const cupo = cupoOf(f);
  const barWrap = $("#fiados-cupo-bar-wrap");
  if (cupo == null) {
    textEl.textContent = "Sin límite";
    barWrap.classList.add("hidden");
    return;
  }
  const deuda = Math.max(0, f.saldo ?? 0);
  const disp = cupo - deuda;
  const pct = Math.min(100, Math.round((deuda / cupo) * 100));
  textEl.textContent = `$${formatPrice(cupo)}`;
  barWrap.classList.remove("hidden");
  const bar = $("#fiados-cupo-bar");
  bar.style.width = `${pct}%`;
  bar.className = `h-full rounded-full transition-all ${disp <= 0 ? "bg-red-600" : pct >= 80 ? "bg-yellow-500" : "bg-ink"}`;
  $("#fiados-cupo-disp").textContent =
    disp <= 0
      ? `Cupo agotado — excedido en $${formatPrice(Math.abs(disp))}`
      : `Disponible: $${formatPrice(disp)} (usado ${pct}%)`;
}

// ── Modal de edición de cupo ──
function openCupoModal() {
  if (!selectedFiado) return;
  const f = fiadores.find((x) => x.id === selectedFiado.id) || selectedFiado;
  $("#cupo-person").textContent = `Límite de fiado para ${f.nombre}`;
  const cupo = cupoOf(f);
  $("#cupo-monto").value = cupo ?? "";
  $("#cupo-remove-btn").classList.toggle("hidden", cupo == null);
  openModal("cupo-modal");
  setTimeout(() => $("#cupo-monto").focus(), 50);
}

async function saveCupo(remove = false) {
  if (!selectedFiado) return;
  const f = fiadores.find((x) => x.id === selectedFiado.id);
  if (!f) return;

  let cupo = null;
  if (!remove) {
    const val = parseFloat($("#cupo-monto").value);
    cupo = Number.isFinite(val) && val > 0 ? Math.round(val) : null;
  }

  f.cupo = cupo;
  await localDB.putFiador(f);
  await localDB.addToOutbox({
    uid: currentUser.uid,
    type: "fiadorCupo",
    payload: { id: f.id, cupo },
  });
  scheduleFlush();

  closeModal("cupo-modal");
  renderCupoBox();
  renderFiadosPeople();
  showToast(
    cupo == null
      ? `${f.nombre} quedó sin límite de fiado`
      : `Cupo de $${formatPrice(cupo)} fijado para ${f.nombre}`,
    "success"
  );
}

// Caja "Debe / A favor" del detalle (el saldo puede quedar negativo si se
// anula una compra ya pagada: eso es plata a favor del cliente).
function renderSaldoBox(saldo) {
  const label = $("#fiados-balance-label");
  const value = $("#fiados-person-balance");
  if (saldo < 0) {
    if (label) label.textContent = "A favor";
    value.textContent = "$" + formatPrice(Math.abs(saldo));
  } else {
    if (label) label.textContent = "Debe";
    value.textContent = "$" + formatPrice(saldo);
  }
}

// ── Eliminar fiador y todo su historial (requiere conexión) ──
async function deleteFiador() {
  const fiador = selectedFiado;
  if (!fiador) return;

  const saldoTxt =
    (fiador.saldo ?? 0) > 0
      ? ` OJO: todavía debe $${formatPrice(fiador.saldo)}.`
      : "";
  const ok = await showConfirm({
    title: `Eliminar a ${fiador.nombre}`,
    message:
      "Se borrará la persona y TODO su historial: compras fiadas y abonos, también de los reportes de días anteriores. " +
      "No repone stock. Esta acción no se puede deshacer." + saldoTxt,
    confirmLabel: "Eliminar todo",
    danger: true,
  });
  if (!ok) return;

  // Requiere conexión: el borrado en la nube debe completarse primero
  // para no dejar historial huérfano.
  showToast("Eliminando historial…", "success");
  try {
    await fiadoresApi.deleteWithHistory(currentUser.uid, fiador.id);
  } catch (e) {
    if (isQuotaError && isQuotaError(e)) showQuotaBanner();
    showToast("No se pudo eliminar. Revisá tu conexión e intentá de nuevo.", "error");
    return;
  }

  // Limpieza local: persona, ventas y abonos de hoy, y operaciones en cola
  fiadores = fiadores.filter((f) => f.id !== fiador.id);
  await localDB.replaceFiadores(fiadores);

  todaySales = todaySales.filter((v) => v.fiadoId !== fiador.id);
  await localDB.replaceSales(todaySales);

  todayAbonos = todayAbonos.filter((a) => a.fiadoId !== fiador.id);
  await localDB.replaceAbonos(todayAbonos);

  const pending = await localDB.getOutbox();
  for (const op of pending) {
    const opFiadoId =
      op.payload?.fiador?.id ||
      op.payload?.abono?.fiadoId ||
      op.payload?.sale?.fiadoId ||
      (op.type === "fiadorSaldo" ? op.payload?.id : null) ||
      op.payload?.fiadoDelta?.fiadoId ||
      null;
    if (opFiadoId === fiador.id) await localDB.deleteFromOutbox(op.id);
  }

  selectedFiado = null;
  selectedFiadoSaldo = 0;
  $("#fiados-detail").classList.add("hidden");
  renderFiadosPeople();
  renderReports();
  renderSales();
  showToast(`${fiador.nombre} y su historial fueron eliminados`, "success");
}

async function openFiadoDetail(fiador) {
  selectedFiado = fiador;
  renderFiadosPeople();
  const detail = $("#fiados-detail");
  detail.classList.remove("hidden");
  $("#fiados-person-name").textContent = fiador.nombre;
  $("#fiados-purchases").innerHTML = "";
  $("#fiados-purchases-empty").classList.add("hidden");
  $("#fiados-history-btn").classList.add("hidden");

  // Migración: fiadores creados antes del saldo persistido no lo tienen.
  // Una única vez se lee el historial completo, se calcula y se guarda;
  // desde ahí todo es incremental (increment atómico en cada operación).
  if (fiador.saldo == null) {
    $("#fiados-person-count").textContent = "Calculando saldo (primera vez)…";
    $("#fiados-person-total").textContent = "$…";
    $("#fiados-person-paid").textContent = "$…";
    $("#fiados-person-balance").textContent = "$…";
    $("#fiados-pay-btn").disabled = true;
    try {
      const { purchases, abonos } = await fetchFiadoHistory(fiador);
      const fiadoTotal = purchases.reduce((sum, v) => sum + (v.total || 0), 0);
      const abonadoTotal = abonos.reduce((sum, a) => sum + (a.monto || 0), 0);
      const saldo = fiadoTotal - abonadoTotal;
      const lastTs = Math.max(0, ...purchases.map((v) => v.ts || 0), ...abonos.map((a) => a.ts || 0));
      fiador.saldo = saldo;
      fiador.ultimoMovimiento = lastTs || Date.now();
      await localDB.putFiador(fiador);
      await localDB.addToOutbox({
        uid: currentUser.uid,
        type: "fiadorSaldo",
        payload: { id: fiador.id, saldo, ts: fiador.ultimoMovimiento },
      });
      scheduleFlush();
      renderFiadosPeople();
      renderReports();
      renderFiadoAccount(purchases, abonos, true);
    } catch (e) {
      if (isQuotaError && isQuotaError(e)) showQuotaBanner();
      $("#fiados-person-count").textContent = "Sin conexión: no se pudo calcular el saldo.";
    }
    return;
  }

  // Saldo persistido: render instantáneo, sin leer historial.
  selectedFiadoSaldo = fiador.saldo;
  renderSaldoBox(fiador.saldo);
  $("#fiados-person-total").textContent = "—";
  $("#fiados-person-paid").textContent = "—";
  $("#fiados-pay-btn").disabled = fiador.saldo <= 0;
  const ult = fiador.ultimoMovimiento
    ? new Date(fiador.ultimoMovimiento).toLocaleDateString("es", { day: "2-digit", month: "2-digit", year: "2-digit" })
    : "—";
  $("#fiados-person-count").textContent = `Último movimiento: ${ult}`;
  renderCupoBox();

  // Movimientos de hoy (locales, gratis); el resto se carga a pedido.
  const todayPurchases = todaySales.filter(
    (v) => v.metodoPago === "fiado" && v.fiadoId === fiador.id
  );
  const todayFiadoAbonos = todayAbonos.filter((a) => a.fiadoId === fiador.id);
  renderFiadoTimeline(todayPurchases, todayFiadoAbonos, false);
  $("#fiados-history-btn").classList.remove("hidden");
}

// Historial completo (nube + hoy local sin duplicar)
async function fetchFiadoHistory(fiador) {
  const localSalesToday = todaySales.filter(
    (v) => v.metodoPago === "fiado" && v.fiadoId === fiador.id
  );
  const localAbonosToday = todayAbonos.filter((a) => a.fiadoId === fiador.id);
  const [cloudSales, cloudAbonos] = await Promise.all([
    salesApi.fetchByFiado(currentUser.uid, fiador.id),
    abonosApi.fetchByFiado(currentUser.uid, fiador.id),
  ]);
  const salesTs = new Set(cloudSales.map((v) => v.ts));
  const abonosTs = new Set(cloudAbonos.map((a) => a.ts));
  return {
    purchases: [...localSalesToday.filter((v) => !salesTs.has(v.ts)), ...cloudSales],
    abonos: [...localAbonosToday.filter((a) => !abonosTs.has(a.ts)), ...cloudAbonos],
  };
}

async function loadFullFiadoHistory() {
  if (!selectedFiado) return;
  const btn = $("#fiados-history-btn");
  btn.disabled = true;
  btn.textContent = "Cargando historial…";
  try {
    const { purchases, abonos } = await fetchFiadoHistory(selectedFiado);
    renderFiadoAccount(purchases, abonos, true);
    btn.classList.add("hidden");
  } catch (e) {
    if (isQuotaError && isQuotaError(e)) showQuotaBanner();
    showToast("No se pudo cargar el historial. Revisá tu conexión.", "error");
  }
  btn.disabled = false;
  btn.textContent = "Ver historial completo";
}

// Render con historial completo: totales de fiado/abonado + línea de tiempo
function renderFiadoAccount(purchases, abonos, full) {
  const fiadoTotal = purchases.reduce((sum, v) => sum + (v.total || 0), 0);
  const abonadoTotal = abonos.reduce((sum, a) => sum + (a.monto || 0), 0);
  $("#fiados-person-total").textContent = "$" + formatPrice(fiadoTotal);
  $("#fiados-person-paid").textContent = "$" + formatPrice(abonadoTotal);

  const f = fiadores.find((x) => x.id === selectedFiado?.id);
  const saldo = f?.saldo ?? fiadoTotal - abonadoTotal;
  selectedFiadoSaldo = saldo;
  renderSaldoBox(saldo);
  $("#fiados-pay-btn").disabled = saldo <= 0;
  $("#fiados-person-count").textContent =
    `${purchases.length} ${purchases.length === 1 ? "compra" : "compras"} · ` +
    `${abonos.length} ${abonos.length === 1 ? "abono" : "abonos"}` +
    (saldo === 0 && fiadoTotal > 0 ? " · Al día ✓" : saldo < 0 ? " · Saldo a favor" : "");

  renderFiadoTimeline(purchases, abonos, full);
}

function renderFiadoTimeline(purchases, abonos, full) {
  const timeline = [
    ...purchases.map((v) => ({ tipo: "compra", ts: v.ts || 0, data: v })),
    ...abonos.map((a) => ({ tipo: "abono", ts: a.ts || 0, data: a })),
  ].sort((a, b) => b.ts - a.ts);

  const emptyEl = $("#fiados-purchases-empty");
  emptyEl.textContent = full
    ? "Esta persona no tiene movimientos."
    : "Sin movimientos hoy. Toca «Ver historial completo» para ver los anteriores.";
  emptyEl.classList.toggle("hidden", timeline.length > 0);

  const hoy = todayISO();
  $("#fiados-purchases").innerHTML = timeline
    .map((entry) => {
      const d = new Date(entry.ts || Date.now());
      const fecha = d.toLocaleDateString("es", { day: "2-digit", month: "2-digit", year: "2-digit" });
      const hora = d.toLocaleTimeString("es", { hour: "2-digit", minute: "2-digit" });

      if (entry.tipo === "abono") {
        const a = entry.data;
        const metodo = PAYMENT_METHODS.find((m) => m.id === a.metodoPago)?.label || a.metodoPago;
        const esDeHoy =
          `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}` === hoy;
        return `
      <li class="rounded-2xl border border-ink bg-ink p-3 text-white">
        <div class="flex items-center justify-between">
          <p class="text-sm font-semibold">
            <svg class="mr-1 inline h-3.5 w-3.5 -translate-y-px" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>
            Abono · ${fecha} · ${hora}
          </p>
          <span class="text-lg font-bold">−$${formatPrice(a.monto || 0)}</span>
        </div>
        <div class="mt-0.5 flex items-center justify-between">
          <p class="text-xs text-white/50">Pagado con ${metodo}</p>
          ${esDeHoy ? `<button data-annul-abono="${a.ts}" class="rounded-lg px-2 py-1 text-xs font-semibold text-white/60 transition hover:bg-white/10 hover:text-white">Anular</button>` : ""}
        </div>
      </li>`;
      }

      const v = entry.data;
      const lineas = (v.items || [])
        .map((it) => {
          const cant = it.cantidad > 1 ? `${it.cantidad} × ` : "";
          const sub = (it.precio || 0) * (it.cantidad || 1);
          return `<li class="flex items-baseline justify-between gap-2 text-xs text-ink/60">
                    <span class="truncate">${cant}${escapeHtml(it.nombre)}</span>
                    <span class="shrink-0 font-semibold text-ink/80">$${formatPrice(sub)}</span>
                  </li>`;
        })
        .join("");
      return `
      <li class="rounded-2xl border border-ink/10 bg-paper p-3">
        <div class="flex items-center justify-between">
          <p class="text-sm font-semibold text-ink">${fecha} · ${hora}</p>
          <span class="text-lg font-bold text-ink">$${formatPrice(v.total || 0)}</span>
        </div>
        <ul class="mt-2 space-y-1 border-t border-ink/10 pt-2">${lineas}</ul>
      </li>`;
    })
    .join("");

  $("#fiados-purchases").querySelectorAll("[data-annul-abono]").forEach((el) =>
    el.addEventListener("click", () => {
      const ts = parseInt(el.dataset.annulAbono, 10);
      const abono = todayAbonos.find((a) => a.ts === ts);
      if (abono) annulAbono(abono);
    })
  );
}

// ── Anular abono (solo del día; con confirmación) ──
async function annulAbono(abono) {
  const ok = await showConfirm({
    title: "Anular abono",
    message: `Se anulará el abono de $${formatPrice(abono.monto || 0)} de ${abono.fiadoNombre} y la deuda volverá a subir.`,
    confirmLabel: "Anular",
    danger: true,
  });
  if (!ok) return;

  // Local
  todayAbonos = todayAbonos.filter((a) => a.ts !== abono.ts);
  await localDB.replaceAbonos(todayAbonos);

  // Nube: si aún estaba en cola, basta con sacarlo; si ya subió, se revierte.
  const pending = await localDB.getOutbox();
  const queued = pending.find(
    (op) => op.type === "abono" && op.payload?.abono?.ts === abono.ts
  );
  if (queued) {
    await localDB.deleteFromOutbox(queued.id);
  } else {
    await localDB.addToOutbox({ uid: currentUser.uid, type: "abonoRevert", payload: { abono } });
    scheduleFlush();
  }

  await applyFiadoDeltaLocal(abono.fiadoId, abono.monto || 0);
  showToast("Abono anulado", "success");
  if (selectedFiado) openFiadoDetail(selectedFiado);
}

// ── Saldar deuda (abono total o parcial) ──
let abonoMethod = "efectivo";

function openAbonoModal() {
  if (!selectedFiado || selectedFiadoSaldo <= 0) return;
  abonoMethod = "efectivo";
  $("#ab-person").textContent =
    `${selectedFiado.nombre} debe $${formatPrice(selectedFiadoSaldo)}.`;
  $("#ab-monto").value = "";
  $("#ab-monto").max = selectedFiadoSaldo;
  renderAbonoMethods();
  openModal("abono-modal");
  setTimeout(() => $("#ab-monto").focus(), 50);
}

function renderAbonoMethods() {
  const wrap = $("#ab-methods");
  wrap.innerHTML = PAYMENT_METHODS.filter((m) => m.id !== "fiado")
    .map((m) => {
      const active = abonoMethod === m.id;
      const cls = active
        ? "border-brand bg-brand text-white"
        : "border-ink/15 bg-white text-ink/80 hover:bg-paper";
      return `<button data-ab-method="${m.id}" class="rounded-xl border px-3 py-2.5 text-sm font-semibold transition active:scale-[0.98] ${cls}">${m.label}</button>`;
    })
    .join("");
  wrap.querySelectorAll("[data-ab-method]").forEach((el) =>
    el.addEventListener("click", () => {
      abonoMethod = el.dataset.abMethod;
      renderAbonoMethods();
    })
  );
}

async function confirmAbono() {
  if (!selectedFiado) return;
  const monto = parseFloat($("#ab-monto").value) || 0;
  if (monto <= 0) { showToast("Ingresá un monto válido", "error"); return; }
  if (monto > selectedFiadoSaldo) {
    showToast(`El abono no puede superar la deuda ($${formatPrice(selectedFiadoSaldo)})`, "error");
    return;
  }

  const abono = {
    fiadoId: selectedFiado.id,
    fiadoNombre: selectedFiado.nombre,
    monto,
    metodoPago: abonoMethod,
    ts: Date.now(),
  };

  // Local al instante + cola a la nube
  todayAbonos.unshift(abono);
  await localDB.addAbono(abono);
  await localDB.addToOutbox({ uid: currentUser.uid, type: "abono", payload: { abono } });
  scheduleFlush();
  await applyFiadoDeltaLocal(abono.fiadoId, -monto, abono.ts);

  closeModal("abono-modal");
  renderReports();
  const saldado = monto >= selectedFiadoSaldo;
  showToast(
    saldado
      ? `${selectedFiado.nombre} saldó su deuda ✓`
      : `Abono de $${formatPrice(monto)} registrado a ${selectedFiado.nombre}`,
    "success"
  );
  openFiadoDetail(selectedFiado);
}

// ── Cuaderno: crear persona y anotar fiados manuales ──
async function createFiadoFromModule() {
  const fiador = await registerFiador($("#fiados-search").value);
  if (!fiador) return;
  $("#fiados-search").value = "";
  renderFiadosPeople();
  openFiadoDetail(fiador);
}

function openFiadoEntry() {
  if (!selectedFiado) return;
  feLines = [];
  $("#fe-person").textContent = `Cuenta de ${selectedFiado.nombre}`;
  $("#fe-search").value = "";
  $("#fe-detalle").value = "";
  $("#fe-valor").value = "";
  $("#fe-results").classList.add("hidden");
  renderFeLines();
  openModal("fiado-entry-modal");
  setTimeout(() => $("#fe-search").focus(), 50);
}

// ── Líneas de la anotación en curso ──
// Producto de inventario → descuenta stock al guardar.
// Línea libre → texto y valor sin control de stock.
let feLines = [];

function feTotal() {
  return feLines.reduce((s, l) => s + (l.precio || 0) * (l.cantidad || 0), 0);
}

function renderFeResults() {
  const box = $("#fe-results");
  const term = $("#fe-search").value.trim().toLowerCase();
  if (term.length < 2) {
    box.classList.add("hidden");
    return;
  }
  // Pesables excluidos: sus precios se calculan por gramos en la caja
  const matches = products
    .filter(
      (p) =>
        !p.pesable &&
        ((p.nombre || "").toLowerCase().includes(term) || (p.codigo || "").includes(term))
    )
    .slice(0, 8);
  if (matches.length === 0) {
    box.classList.add("hidden");
    return;
  }
  box.innerHTML = matches
    .map((p) => {
      const sinStock = (p.cantidad ?? 0) <= 0;
      return `
      <li>
        <button data-fe-add="${escapeHtml(p.codigo)}" ${sinStock ? "disabled" : ""}
          class="flex w-full items-center justify-between gap-2 px-3 py-2.5 text-left text-sm transition hover:bg-paper disabled:opacity-40">
          <span class="min-w-0 flex-1 truncate font-medium text-ink">${escapeHtml(p.nombre || p.codigo)}</span>
          <span class="shrink-0 text-xs text-ink/40">${sinStock ? "Sin stock" : `Stock: ${p.cantidad}`}</span>
          <span class="shrink-0 font-semibold text-ink">$${formatPrice(p.precioVenta)}</span>
        </button>
      </li>`;
    })
    .join("");
  box.classList.remove("hidden");
  box.querySelectorAll("[data-fe-add]").forEach((el) =>
    el.addEventListener("click", () => {
      const p = products.find((x) => x.codigo === el.dataset.feAdd);
      if (p) feAddProduct(p);
    })
  );
}

function feAddProduct(p) {
  const existing = feLines.find((l) => !l.manual && l.codigo === p.codigo);
  const enLinea = existing ? existing.cantidad : 0;
  if (enLinea + 1 > (p.cantidad ?? 0)) {
    showToast("Sin stock suficiente", "error");
    return;
  }
  if (existing) existing.cantidad++;
  else {
    feLines.push({
      codigo: p.codigo,
      nombre: p.nombre || p.codigo,
      precio: p.precioVenta || 0,
      cantidad: 1,
      manual: false,
    });
  }
  $("#fe-search").value = "";
  $("#fe-results").classList.add("hidden");
  renderFeLines();
  $("#fe-search").focus();
}

function feAddFreeLine() {
  const detalle = $("#fe-detalle").value.trim();
  const valor = parseFloat($("#fe-valor").value) || 0;
  if (!detalle) { showToast("Ingresá qué llevó", "error"); return; }
  if (valor <= 0) { showToast("Ingresá un valor válido", "error"); return; }
  feLines.push({
    codigo: `manual-${Date.now()}`,
    nombre: detalle,
    precio: valor,
    cantidad: 1,
    manual: true,
  });
  $("#fe-detalle").value = "";
  $("#fe-valor").value = "";
  renderFeLines();
}

function renderFeLines() {
  const list = $("#fe-lines");
  $("#fe-total").textContent = "$" + formatPrice(feTotal());
  list.innerHTML = feLines
    .map((l, i) => {
      const middle = l.manual
        ? `<span class="shrink-0 text-sm font-bold text-ink">$${formatPrice(l.precio)}</span>`
        : `<div class="flex shrink-0 items-center gap-1.5">
             <button data-fe-dec="${i}" class="flex h-7 w-7 items-center justify-center rounded-lg bg-ink/10 font-bold text-ink active:scale-95">−</button>
             <span class="w-5 text-center text-sm font-bold text-ink">${l.cantidad}</span>
             <button data-fe-inc="${i}" class="flex h-7 w-7 items-center justify-center rounded-lg bg-ink/10 font-bold text-ink active:scale-95">+</button>
           </div>
           <span class="w-16 shrink-0 text-right text-sm font-bold text-ink">$${formatPrice(l.precio * l.cantidad)}</span>`;
      return `
      <li class="flex items-center gap-2 rounded-xl border border-ink/10 bg-paper p-2">
        <div class="min-w-0 flex-1">
          <p class="truncate text-sm font-semibold text-ink">${escapeHtml(l.nombre)}</p>
          <p class="text-[11px] text-ink/40">${l.manual ? "Línea libre" : "Descuenta stock"}</p>
        </div>
        ${middle}
        <button data-fe-del="${i}" aria-label="Quitar" class="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-ink/40 transition hover:bg-ink/5 hover:text-ink">
          <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </li>`;
    })
    .join("");

  list.querySelectorAll("[data-fe-inc]").forEach((el) =>
    el.addEventListener("click", () => {
      const l = feLines[parseInt(el.dataset.feInc, 10)];
      if (l.cantidad + 1 > stockOf(l.codigo)) {
        showToast("Sin stock suficiente", "error");
        return;
      }
      l.cantidad++;
      renderFeLines();
    })
  );
  list.querySelectorAll("[data-fe-dec]").forEach((el) =>
    el.addEventListener("click", () => {
      const l = feLines[parseInt(el.dataset.feDec, 10)];
      if (l.cantidad > 1) { l.cantidad--; renderFeLines(); }
    })
  );
  list.querySelectorAll("[data-fe-del]").forEach((el) =>
    el.addEventListener("click", () => {
      feLines.splice(parseInt(el.dataset.feDel, 10), 1);
      renderFeLines();
    })
  );
}

async function confirmFiadoEntry() {
  if (!selectedFiado) return;

  // Si quedó texto en la línea libre sin agregar, se agrega automáticamente
  if ($("#fe-detalle").value.trim() && (parseFloat($("#fe-valor").value) || 0) > 0) {
    feAddFreeLine();
  }
  if (feLines.length === 0) {
    showToast("Agregá al menos un producto o una línea libre", "error");
    return;
  }

  // Validación final de stock (pudo cambiar mientras el modal estaba abierto)
  for (const l of feLines) {
    if (!l.manual && l.cantidad > stockOf(l.codigo)) {
      showToast(`Sin stock suficiente de ${l.nombre}`, "error");
      return;
    }
  }

  // Cupo de crédito: bloquea si la anotación deja la deuda sobre el límite
  {
    const f = fiadores.find((x) => x.id === selectedFiado.id) || selectedFiado;
    const err = cupoError(f, feTotal());
    if (err) {
      showToast(err, "error");
      return;
    }
  }

  const ts = Date.now();
  const sale = {
    items: feLines.map((l) => ({
      codigo: l.codigo,
      nombre: l.nombre,
      precio: l.precio,
      cantidad: l.cantidad,
      pesable: false,
      manual: !!l.manual,
      gramos: 0,
      codigoBase: null,
      nombreBase: null,
    })),
    total: feTotal(),
    metodoPago: "fiado",
    fiadoId: selectedFiado.id,
    fiadoNombre: selectedFiado.nombre,
    ts,
  };

  // Mismo camino que la caja: descuenta stock, movimientos, local y nube
  await persistSale(sale);

  closeModal("fiado-entry-modal");
  feLines = [];
  showToast(`Fiado de $${formatPrice(sale.total)} anotado a ${selectedFiado.nombre}`, "success");
  openFiadoDetail(selectedFiado);
}

async function onSalesDayChange() {
  const value = $("#sales-day").value || todayISO();
  salesDate = value;

  if (value === todayISO()) {
    displaySales(todaySales, true);
    return;
  }

  // Día pasado: se consulta la nube (solo lectura)
  $("#sales-list").innerHTML = "";
  $("#sales-summary").classList.add("hidden");
  $("#sales-empty").textContent = "Cargando ventas…";
  $("#sales-empty").classList.remove("hidden");
  try {
    const [y, m, d] = value.split("-").map(Number);
    const start = new Date(y, m - 1, d, 0, 0, 0, 0);
    const end = new Date(y, m - 1, d + 1, 0, 0, 0, 0);
    const sales = await salesApi.fetchRange(currentUser.uid, start, end);
    // Más recientes primero, como en la vista de hoy
    sales.sort((a, b) => (b.ts || 0) - (a.ts || 0));
    displaySales(sales, false);
  } catch (e) {
    if (isQuotaError && isQuotaError(e)) showQuotaBanner();
    $("#sales-empty").textContent =
      "No se pudieron cargar las ventas de ese día. Revisá tu conexión e intentá de nuevo.";
    $("#sales-empty").classList.remove("hidden");
  }
}

function openSaleEdit(sale) {
  if (!sale) return;
  editingSale = {
    ts: sale.ts,
    metodoPago: sale.metodoPago,
    fiadoId: sale.fiadoId || null,
    fiadoNombre: sale.fiadoNombre || null,
    items: (sale.items || []).map((it) => ({ ...it })),
  };
  const hora = new Date(sale.ts || Date.now()).toLocaleTimeString("es", { hour: "2-digit", minute: "2-digit" });
  $("#se-subtitle").textContent = `Venta de las ${hora}`;
  renderSaleEdit();
  openModal("sale-edit-modal");
}

function saleEditTotal() {
  return editingSale.items.reduce((s, it) => s + (it.precio || 0) * (it.cantidad || 0), 0);
}

function renderSaleEdit() {
  const list = $("#se-items");
  $("#se-total").textContent = "$" + formatPrice(saleEditTotal());

  list.innerHTML = editingSale.items
    .map((it, i) => {
      const fijo = it.pesable || it.manual; // línea de precio fijo: se edita el precio
      const left = `
        <div class="min-w-0 flex-1">
          <p class="truncate text-sm font-semibold text-ink">${escapeHtml(it.nombre)}</p>
          <p class="text-xs text-ink/40">${it.pesable ? "Pesable" : it.manual ? "Ítem manual" : `$${formatPrice(it.precio)} c/u`}</p>
        </div>`;
      const middle = fijo
        ? `<input data-se-price="${i}" type="number" inputmode="numeric" min="0" step="1" value="${it.precio || 0}"
             class="w-24 rounded-lg border-ink/15 py-1.5 text-right text-sm font-bold focus:border-brand focus:ring-brand" />`
        : `<div class="flex items-center gap-1.5">
             <button data-se-dec="${i}" class="flex h-8 w-8 items-center justify-center rounded-lg bg-ink/10 text-lg font-bold text-ink active:scale-95">−</button>
             <span class="w-6 text-center text-sm font-bold text-ink">${it.cantidad}</span>
             <button data-se-inc="${i}" class="flex h-8 w-8 items-center justify-center rounded-lg bg-ink/10 text-lg font-bold text-ink active:scale-95">+</button>
           </div>
           <span class="w-20 text-right text-sm font-bold text-ink">$${formatPrice((it.precio || 0) * (it.cantidad || 0))}</span>`;
      return `
      <li class="flex items-center gap-2 rounded-xl border border-ink/10 bg-paper p-2.5">
        ${left}
        ${middle}
        <button data-se-del="${i}" aria-label="Quitar" class="flex h-8 w-8 items-center justify-center rounded-lg text-ink/40 transition hover:bg-ink/5 hover:text-ink">
          <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </li>`;
    })
    .join("");

  list.querySelectorAll("[data-se-inc]").forEach((el) =>
    el.addEventListener("click", () => {
      const it = editingSale.items[parseInt(el.dataset.seInc, 10)];
      // No permite superar el stock disponible actual + lo ya vendido en esta venta
      const orig = (todaySales.find((v) => v.ts === editingSale.ts)?.items || [])
        .find((o) => o.codigo === it.codigo);
      const disponible = stockOf(it.codigo) + (orig?.cantidad || 0);
      if (it.cantidad + 1 > disponible) {
        showToast("Sin stock suficiente", "error");
        return;
      }
      it.cantidad++;
      renderSaleEdit();
    })
  );
  list.querySelectorAll("[data-se-dec]").forEach((el) =>
    el.addEventListener("click", () => {
      const it = editingSale.items[parseInt(el.dataset.seDec, 10)];
      if (it.cantidad > 1) { it.cantidad--; renderSaleEdit(); }
    })
  );
  list.querySelectorAll("[data-se-del]").forEach((el) =>
    el.addEventListener("click", () => {
      editingSale.items.splice(parseInt(el.dataset.seDel, 10), 1);
      renderSaleEdit();
    })
  );
  list.querySelectorAll("[data-se-price]").forEach((el) =>
    el.addEventListener("input", () => {
      const it = editingSale.items[parseInt(el.dataset.sePrice, 10)];
      it.precio = parseFloat(el.value) || 0;
      $("#se-total").textContent = "$" + formatPrice(saleEditTotal());
    })
  );

  // Métodos de pago
  const wrap = $("#se-methods");
  // "Fiado" solo se ofrece si la venta ya era fiada (cambiar HACIA fiado
  // requeriría elegir persona; se hace anulando y cobrando de nuevo).
  const methods = PAYMENT_METHODS.filter(
    (m) => m.id !== "fiado" || editingSale.fiadoId
  );
  wrap.innerHTML = methods.map((m) => {
    const active = editingSale.metodoPago === m.id;
    const cls = active
      ? "border-brand bg-brand text-white"
      : "border-ink/15 bg-white text-ink/80 hover:bg-paper";
    const label = m.id === "fiado" ? `Fiado (${escapeHtml(editingSale.fiadoNombre || "")})` : m.label;
    return `<button data-se-method="${m.id}" class="rounded-xl border px-3 py-2.5 text-sm font-semibold transition active:scale-[0.98] ${cls}">${label}</button>`;
  }).join("");
  wrap.querySelectorAll("[data-se-method]").forEach((el) =>
    el.addEventListener("click", () => {
      editingSale.metodoPago = el.dataset.seMethod;
      renderSaleEdit();
    })
  );
}

async function saveSaleEdit() {
  if (!editingSale) return;
  const orig = todaySales.find((v) => v.ts === editingSale.ts);
  if (!orig) { closeModal("sale-edit-modal"); return; }

  // Sin artículos = anular la venta completa
  if (editingSale.items.length === 0) {
    const ok = await showConfirm({
      title: "Anular venta",
      message: "Quitaste todos los artículos. Se anulará la venta completa y se repondrá el stock.",
      confirmLabel: "Anular",
      danger: true,
    });
    if (!ok) return;
    closeModal("sale-edit-modal");
    await annulSale(orig);
    showToast("Venta anulada", "success");
    return;
  }

  const newItems = editingSale.items.map((it) => ({ ...it }));
  const newTotal = newItems.reduce((s, it) => s + (it.precio || 0) * (it.cantidad || 0), 0);

  // Ajuste de la deuda del fiador: si era fiada, la deuda cambia con el total
  // (o desaparece si se cambió el método de pago).
  const origFiadoId = orig.fiadoId || null;
  const origTotal = orig.total || 0;
  const sigueFiado = editingSale.metodoPago === "fiado";
  const fiadoDelta = origFiadoId
    ? { fiadoId: origFiadoId, delta: sigueFiado ? newTotal - origTotal : -origTotal }
    : null;

  // Deltas de stock solo para productos con control de stock:
  // positivo = devolver al stock, negativo = descontar más.
  const deltas = [];
  for (const o of orig.items || []) {
    if (!saleTracksStock(o)) continue;
    const n = newItems.find((it) => it.codigo === o.codigo);
    const delta = (o.cantidad || 0) - (n?.cantidad || 0);
    if (delta !== 0) deltas.push({ codigo: o.codigo, nombre: o.nombre, delta });
  }

  // 1) Aplica deltas al stock local + movimientos de ajuste
  const now = Date.now();
  for (const d of deltas) {
    const idx = products.findIndex((p) => p.codigo === d.codigo);
    if (idx >= 0) {
      products[idx] = {
        ...products[idx],
        cantidad: (products[idx].cantidad ?? 0) + d.delta,
      };
      await localDB.putProduct(products[idx]);
    }
    const mov = {
      codigo: d.codigo,
      nombre: `Ajuste venta: ${d.nombre}`,
      accion: d.delta > 0 ? "entrada" : "salida",
      cantidad: Math.abs(d.delta),
      ts: now,
    };
    todayMovements.unshift(mov);
    await localDB.addMovement(mov);
  }

  // 2) Actualiza la venta (caché + IndexedDB)
  orig.items = newItems;
  orig.total = newTotal;
  orig.metodoPago = editingSale.metodoPago;
  orig.fiadoId = editingSale.metodoPago === "fiado" ? editingSale.fiadoId : null;
  orig.fiadoNombre = editingSale.metodoPago === "fiado" ? editingSale.fiadoNombre : null;
  await localDB.replaceSales(todaySales);

  // 3) Nube: si sigue en la cola, se reemplaza el commit pendiente por el
  //    corregido; si ya se subió, se encola la actualización con los deltas.
  const pending = await localDB.getOutbox();
  const queued = pending.find(
    (op) => op.type === "sale" && op.payload?.sale?.ts === orig.ts
  );
  if (queued) {
    // El commit pendiente se reemplaza: al subir aplicará el saldo correcto.
    await localDB.deleteFromOutbox(queued.id);
    await localDB.addToOutbox({ uid: currentUser.uid, type: "sale", payload: { sale: { ...orig } } });
  } else {
    await localDB.addToOutbox({
      uid: currentUser.uid,
      type: "updateSale",
      payload: { sale: { ...orig }, deltas, fiadoDelta },
    });
  }
  scheduleFlush();

  if (fiadoDelta && fiadoDelta.delta) {
    await applyFiadoDeltaLocal(fiadoDelta.fiadoId, fiadoDelta.delta);
  }

  closeModal("sale-edit-modal");
  editingSale = null;
  renderInventory();
  renderReports();
  renderSales();
  renderHistory(todayMovements);
  showToast("Venta actualizada", "success");
}

async function deleteSaleFromEdit() {
  if (!editingSale) return;
  const orig = todaySales.find((v) => v.ts === editingSale.ts);
  if (!orig) { closeModal("sale-edit-modal"); return; }
  const ok = await showConfirm({
    title: "Anular venta",
    message: `Se anulará la venta de $${formatPrice(orig.total || 0)} y se repondrá el stock.`,
    confirmLabel: "Anular",
    danger: true,
  });
  if (!ok) return;
  closeModal("sale-edit-modal");
  editingSale = null;
  await annulSale(orig);
  showToast("Venta anulada", "success");
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
    // Pesables y manuales: sin control de stock, no se valida cantidad
    if (!c.pesable && !c.manual && c.cantidad > stockOf(c.codigo)) {
      showToast(`Sin stock suficiente de ${c.nombre}`, "error");
      return;
    }
  }

  const items = cart.map((c) => ({
    codigo: c.codigo,
    nombre: c.nombre,
    precio: c.precio,
    cantidad: c.cantidad,
    pesable: !!c.pesable,
    manual: !!c.manual,
    gramos: c.gramos || 0,
    codigoBase: c.codigoBase || null,
    nombreBase: c.nombreBase || null,
  }));
  if (posMethod === "fiado" && !posFiado) {
    showToast("Elegí a quién se le fía", "error");
    openFiadoModal();
    return;
  }

  const total = cartTotal();

  // Cupo de crédito: bloquea si la venta deja la deuda por encima del límite
  if (posMethod === "fiado" && posFiado) {
    const f = fiadores.find((x) => x.id === posFiado.id) || posFiado;
    const err = cupoError(f, total);
    if (err) {
      showToast(err, "error");
      return;
    }
  }
  const sale = {
    items,
    total,
    metodoPago: posMethod,
    fiadoId: posMethod === "fiado" ? posFiado.id : null,
    fiadoNombre: posMethod === "fiado" ? posFiado.nombre : null,
    ts: Date.now(),
  };
  const metodoLabel = PAYMENT_METHODS.find((m) => m.id === posMethod)?.label || posMethod;

  await persistSale(sale);

  posClear();
  focusPosInput();

  showToast(
    `Venta cobrada · ${metodoLabel} · $${formatPrice(total)}`,
    "success"
  );
}

// Persiste una venta (de caja o del cuaderno de fiados): descuenta stock,
// registra movimientos, guarda local, encola a la nube y refresca la UI.
async function persistSale(sale) {
  for (const it of sale.items) {
    if (!it.pesable && !it.manual) {
      const idx = products.findIndex((p) => p.codigo === it.codigo);
      if (idx >= 0) {
        products[idx] = {
          ...products[idx],
          cantidad: (products[idx].cantidad ?? 0) - it.cantidad,
        };
        await localDB.putProduct(products[idx]);
      }
    }
    const mov = {
      codigo: it.pesable ? (it.codigoBase || it.codigo) : it.codigo,
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

  await localDB.addToOutbox({ uid: currentUser.uid, type: "sale", payload: { sale } });
  scheduleFlush();

  if (sale.fiadoId) await applyFiadoDeltaLocal(sale.fiadoId, sale.total || 0, sale.ts);

  renderInventory();
  renderReports();
  renderSales();
  renderHistory(todayMovements);
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
  $("#pf-cantidad-wrap").classList.remove("hidden");
  $("#pf-minimo-wrap").classList.remove("hidden");
  $("#pf-venta-wrap").classList.remove("hidden");
  $("#pf-cantidad-label").textContent = "Cantidad actual";
  $("#pf-costo-label").textContent = "Precio costo";
  $("#pf-cantidad").required = true;
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
      // Pesable: sin control de stock — solo precios por kilo
      $("#pf-cantidad-wrap").classList.add("hidden");
      $("#pf-minimo-wrap").classList.add("hidden");
      $("#pf-venta-wrap").classList.add("hidden");
      $("#pf-costo-label").textContent = "Costo por kilo";
      $("#pf-cantidad").required = false;
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
    // Pesables: sin control de stock (la cantidad no se registra)
    cantidad: pesable ? 0 : parseFloat($("#pf-cantidad").value) || 0,
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
  const ok = await showConfirm({
    title: "Eliminar producto",
    message: "Se borrará del inventario en este dispositivo y en la nube. Esta acción no se puede deshacer.",
    confirmLabel: "Eliminar",
    danger: true,
  });
  if (!ok) return;

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
let inventoryFilter = "all"; // "all" | "low"

function isLowStock(p) {
  if (p.pesable) return false; // pesables no llevan control de stock
  return (p.cantidad ?? 0) <= (p.stockMinimo ?? 0);
}

function renderInventory() {
  const term = $("#inventory-search").value.trim().toLowerCase();
  const list = $("#inventory-list");
  let filtered = products.filter(
    (p) =>
      !term ||
      (p.nombre || "").toLowerCase().includes(term) ||
      (p.codigo || "").includes(term)
  );
  if (inventoryFilter === "low") filtered = filtered.filter(isLowStock);

  // Contador rojo en el botón "Bajo stock"
  const lowCount = products.filter(isLowStock).length;
  const countEl = $("#inv-low-count");
  if (countEl) {
    countEl.textContent = lowCount;
    countEl.classList.toggle("hidden", lowCount === 0);
  }

  // Estado visual de los botones de filtro
  document.querySelectorAll(".inv-filter-btn").forEach((b) => {
    const active = b.dataset.filter === inventoryFilter;
    if (b.dataset.filter === "low") {
      b.classList.toggle("bg-red-600", active);
      b.classList.toggle("text-white", active);
      b.classList.toggle("bg-white", !active);
      b.classList.toggle("text-red-600", !active);
    } else {
      b.classList.toggle("bg-brand", active);
      b.classList.toggle("text-white", active);
      b.classList.toggle("bg-white", !active);
      b.classList.toggle("text-ink", !active);
    }
  });

  renderInventorySummary();
  const emptyEl = $("#inventory-empty");
  emptyEl.textContent =
    inventoryFilter === "low" && products.length > 0
      ? "Ningún producto está bajo el stock mínimo."
      : "No hay productos todavía. Toca el botón + para agregar el primero.";
  emptyEl.classList.toggle("hidden", filtered.length > 0);
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
  const agotado = !p.pesable && cantidad === 0;
  const bajo = !p.pesable && !agotado && cantidad <= minimo;
  const ok = !agotado && !bajo;

  const cardClasses = agotado
    ? "border-red-600 bg-red-50"
    : bajo
    ? "border-red-400 bg-red-50/60"
    : "border-ink/15 bg-white";

  const cantColor = agotado
    ? "text-red-600"
    : bajo
    ? "text-red-500"
    : "text-ink/80";

  const badge = agotado
    ? `<span class="inline-flex items-center gap-1 rounded-full bg-red-600 px-2 py-0.5 text-xs font-semibold text-white">
         <svg class="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><path d="M12 9v4M12 17h.01" stroke-linecap="round"/></svg>
         Sin stock
       </span>`
    : bajo
    ? `<span class="inline-flex items-center gap-1 rounded-full bg-red-500 px-2 py-0.5 text-xs font-semibold text-white">
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
        <p class="mt-0.5 text-xs text-ink/50">${p.pesable ? "Pesable · sin control de stock" : `Mín: ${minimo} · Venta: $${formatPrice(p.precioVenta)}`}</p>
      </div>
      <div class="text-right">
        ${p.pesable
          ? `<p class="text-lg font-bold leading-none text-ink">$${formatPrice(p.precioKilo)}</p>
             <p class="text-[11px] uppercase tracking-wide text-ink/40">por kg</p>`
          : `<p class="text-2xl font-bold leading-none ${cantColor}">${cantidad}</p>
             <p class="text-[11px] uppercase tracking-wide text-ink/40">unid.</p>`}
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
  updateUndoButton();
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

  // --- Fiados (hoy): fiado nuevo y abonos recibidos ---
  const fiadoSales = todaySales.filter((v) => v.metodoPago === "fiado");
  const fiadoTotal = fiadoSales.reduce((s, v) => s + (v.total || 0), 0);
  $("#rep-fiado-total").textContent = "$" + formatPrice(fiadoTotal);
  $("#rep-fiado-count").textContent =
    fiadoSales.length === 0 ? "Sin fiados hoy" : `${fiadoSales.length} ${fiadoSales.length === 1 ? "venta fiada" : "ventas fiadas"}`;

  const abonosTotal = todayAbonos.reduce((s, a) => s + (a.monto || 0), 0);
  $("#rep-abonos-total").textContent = "$" + formatPrice(abonosTotal);
  $("#rep-abonos-count").textContent =
    todayAbonos.length === 0 ? "Sin abonos hoy" : `${todayAbonos.length} ${todayAbonos.length === 1 ? "abono" : "abonos"}`;

  const conSaldo = fiadores.filter((f) => (f.saldo ?? 0) > 0);
  const porCobrar = conSaldo.reduce((sum, f) => sum + f.saldo, 0);
  const sinCalcular = fiadores.filter((f) => f.saldo == null).length;
  $("#rep-por-cobrar").textContent = "$" + formatPrice(porCobrar);
  $("#rep-por-cobrar-count").textContent =
    (conSaldo.length === 0
      ? "Nadie debe"
      : `${conSaldo.length} ${conSaldo.length === 1 ? "persona debe" : "personas deben"}`) +
    (sinCalcular > 0 ? ` · ${sinCalcular} sin calcular` : "");

  $("#rep-abonos").innerHTML = todayAbonos
    .map((a) => {
      const hora = new Date(a.ts || Date.now()).toLocaleTimeString("es", { hour: "2-digit", minute: "2-digit" });
      const metodo = PAYMENT_METHODS.find((m) => m.id === a.metodoPago)?.label || a.metodoPago;
      return `
      <li class="flex items-center justify-between rounded-2xl bg-white p-3 shadow-sm ring-1 ring-ink/10">
        <div class="min-w-0">
          <p class="truncate font-medium text-ink">${escapeHtml(a.fiadoNombre || "")}</p>
          <p class="text-xs text-ink/40">${hora} · ${metodo}</p>
        </div>
        <span class="text-lg font-bold text-ink">$${formatPrice(a.monto || 0)}</span>
      </li>`;
    })
    .join("");

  // --- Vendido por peso (hoy) ---
  const byWeighed = {};
  for (const v of todaySales) {
    for (const it of v.items || []) {
      if (!it.pesable) continue;
      const key = it.codigoBase || it.nombre;
      const nombre = it.nombreBase || (it.nombre || "").replace(/\s*\(\d+(\.\d+)?g\)$/, "");
      if (!byWeighed[key]) byWeighed[key] = { nombre, gramos: 0, total: 0, ventas: 0 };
      byWeighed[key].gramos += it.gramos || 0;
      byWeighed[key].total += (it.precio || 0) * (it.cantidad || 1);
      byWeighed[key].ventas++;
    }
  }
  const weighedRows = Object.values(byWeighed).sort((a, b) => b.total - a.total);
  const weighedList = $("#rep-weighed");
  $("#rep-weighed-empty").classList.toggle("hidden", weighedRows.length > 0);
  weighedList.innerHTML = weighedRows
    .map((w) => {
      const kg = w.gramos >= 1000 ? `${(w.gramos / 1000).toFixed(2)} kg` : `${w.gramos} g`;
      return `
      <li class="flex items-center justify-between rounded-2xl bg-white p-3 shadow-sm ring-1 ring-ink/10">
        <div class="min-w-0">
          <p class="truncate font-medium text-ink">${escapeHtml(w.nombre)}</p>
          <p class="text-xs text-ink/40">${kg} · ${w.ventas} ${w.ventas === 1 ? "pesada" : "pesadas"}</p>
        </div>
        <span class="text-lg font-bold text-ink">$${formatPrice(w.total)}</span>
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
    <li class="flex items-center gap-3 rounded-2xl border ${agotado ? "border-red-600 bg-red-50" : "border-red-400 bg-red-50/60"} p-3 shadow-sm">
      <span class="flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${agotado ? "bg-red-600" : "bg-red-500"} text-white">
        <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><path d="M12 9v4M12 17h.01" stroke-linecap="round"/><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/></svg>
      </span>
      <div class="min-w-0 flex-1">
        <p class="truncate font-semibold text-red-700">${escapeHtml(p.nombre || p.codigo)}</p>
        <p class="text-xs text-red-400">Mínimo: ${minimo} · ${agotado ? "¡Sin stock!" : "Quedan pocos"}</p>
      </div>
      <span class="text-lg font-bold ${agotado ? "text-red-600" : "text-red-500"}">${cantidad}</span>
    </li>`;
}

// ============================================================
//  Render: Historial
// ============================================================
// ── Historial: día seleccionado ──
// Los movimientos se guardan siempre en la nube (colección "movimientos");
// el día actual además vive en el teléfono. Días anteriores se consultan
// desde Firestore, por lo que requieren conexión.
let historyDate = todayISO();       // día que se está viendo (yyyy-mm-dd)
let historyMovements = [];          // lo que se muestra en pantalla

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// La llaman caja/ajustes al registrar movimientos: actualiza la caché de hoy
// y refresca la pantalla solo si se está viendo el día de hoy.
function renderHistory(movements) {
  todayMovements = movements;
  if (historyDate === todayISO()) displayHistory(movements);
}

function displayHistory(movements) {
  historyMovements = movements;
  const list = $("#history-list");
  const [y, m, d] = historyDate.split("-").map(Number);
  $("#history-date").textContent = new Date(y, m - 1, d).toLocaleDateString("es", {
    weekday: "long",
    day: "numeric",
    month: "long",
  });
  $("#history-empty").textContent =
    historyDate === todayISO()
      ? "Aún no hay movimientos registrados hoy."
      : "No hay movimientos registrados este día.";
  $("#history-empty").classList.toggle("hidden", movements.length > 0);
  $("#export-csv-btn").disabled = movements.length === 0;
  list.innerHTML = movements.map(renderMovementRow).join("");
}

async function onHistoryDayChange() {
  const value = $("#history-day").value || todayISO();
  historyDate = value;

  if (value === todayISO()) {
    displayHistory(todayMovements);
    return;
  }

  // Día pasado: se consulta la nube
  $("#history-list").innerHTML = "";
  $("#history-empty").textContent = "Cargando movimientos…";
  $("#history-empty").classList.remove("hidden");
  $("#export-csv-btn").disabled = true;
  try {
    const [y, m, d] = value.split("-").map(Number);
    const start = new Date(y, m - 1, d, 0, 0, 0, 0);
    const end = new Date(y, m - 1, d + 1, 0, 0, 0, 0);
    const movs = await movementsApi.fetchRange(currentUser.uid, start, end);
    displayHistory(movs);
  } catch (e) {
    if (isQuotaError && isQuotaError(e)) showQuotaBanner();
    $("#history-empty").textContent =
      "No se pudo cargar ese día. Revisá tu conexión e intentá de nuevo.";
    $("#history-empty").classList.remove("hidden");
  }
}

function exportHistoryCsv() {
  if (historyMovements.length === 0) return;
  const headers = ["Fecha", "Hora", "Codigo", "Producto", "Accion", "Cantidad"];
  const rows = historyMovements.map((m) => {
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
  const stamp = historyDate;
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
function exportFiadosXlsx() {
  if (!excelReady()) return;
  if (!fiadores.length) {
    showToast("No hay personas registradas para exportar", "error");
    return;
  }
  const rows = fiadores.map((f) => {
    const saldo = f.saldo;
    const estado =
      saldo == null ? "Sin calcular" : saldo > 0 ? "Debe" : saldo < 0 ? "A favor" : "Al día";
    const cupo = cupoOf(f);
    const disp = cupoDisponible(f);
    return {
      "Persona": f.nombre,
      "Saldo": saldo == null ? "" : saldo,
      "Estado": estado,
      "Cupo": cupo == null ? "Sin límite" : cupo,
      "Cupo disponible": disp == null ? "" : Math.max(0, disp),
      "Último movimiento": f.ultimoMovimiento
        ? new Date(f.ultimoMovimiento).toLocaleDateString("es")
        : "",
    };
  });
  // Los que más deben, primero
  rows.sort((a, b) => (Number(b["Saldo"]) || 0) - (Number(a["Saldo"]) || 0));
  const totalRow = {
    "Persona": "TOTAL POR COBRAR",
    "Saldo": fiadores.reduce((sum, f) => sum + Math.max(0, f.saldo ?? 0), 0),
    "Estado": "",
    "Último movimiento": "",
  };
  const ws = XLSX.utils.json_to_sheet([...rows, totalRow]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Fiados");
  XLSX.writeFile(wb, `fiados-${new Date().toISOString().slice(0, 10)}.xlsx`);
  showToast("Cuaderno de fiados exportado", "success");
}

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
    if (p.pesable) {
      return {
        "Código": p.codigo,
        "Nombre": p.nombre || "",
        "Cantidad": "Pesable (sin control de stock)",
        "Stock mínimo": "",
        "Precio costo": costo ? `${costo} /kg` : "",
        "Precio venta": `${Number(p.precioKilo) || 0} /kg`,
        "Valor costo": "",
        "Valor venta": "",
      };
    }
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
//  MÓDULO: ESTADÍSTICAS Y TENDENCIAS
// ============================================================

let statsperiodDays = 7;       // período activo: 7, 30 o 90 días
let statsLoading = false;

async function renderStats() {
  if (statsLoading) return;
  statsLoading = true;

  const end   = new Date(); end.setHours(23, 59, 59, 999);
  const start = new Date(); start.setDate(start.getDate() - statsperiodDays + 1); start.setHours(0,0,0,0);

  let sales = [];
  let periodAbonos = [];
  try {
    [sales, periodAbonos] = await Promise.all([
      salesApi.fetchRange(currentUser.uid, start, end),
      abonosApi.fetchRange(currentUser.uid, start, end).catch(() => []),
    ]);
  } catch (e) {
    if (isQuotaError && isQuotaError(e)) showQuotaBanner();
    statsLoading = false;
    return;
  }

  const abonosEl = $("#stats-abonos");
  if (abonosEl) {
    const abTotal = periodAbonos.reduce((sum, a) => sum + (a.monto || 0), 0);
    abonosEl.classList.toggle("hidden", periodAbonos.length === 0);
    abonosEl.textContent = `Abonos de fiados en el período: $${formatPrice(abTotal)} (${periodAbonos.length} ${periodAbonos.length === 1 ? "abono" : "abonos"})`;
  }

  const empty = $("#stats-empty");
  if (!sales.length) {
    empty.classList.remove("hidden");
    ["chart-daily","chart-hourly","chart-top-products","chart-methods"]
      .forEach(id => { const el = $(`#${id}`); if (el) el.innerHTML = ""; });
    $("#stats-total").textContent = "$0";
    $("#stats-count").textContent = "0";
    $("#stats-avg").textContent   = "$0";
    $("#stats-best-day").textContent = "—";
    statsLoading = false;
    return;
  }
  empty.classList.add("hidden");

  // ── KPIs ──────────────────────────────────────────────────
  const total = sales.reduce((s, v) => s + (v.total || 0), 0);
  const count = sales.length;
  $("#stats-total").textContent = "$" + formatPrice(total);
  $("#stats-count").textContent = count;
  $("#stats-avg").textContent   = "$" + formatPrice(count ? total / count : 0);

  // ── Ventas por día ────────────────────────────────────────
  const byDay = {};
  for (let d = 0; d < statsperiodDays; d++) {
    const dt = new Date(start); dt.setDate(dt.getDate() + d);
    byDay[dt.toISOString().slice(0,10)] = 0;
  }
  for (const s of sales) {
    const k = new Date(s.ts).toISOString().slice(0,10);
    if (k in byDay) byDay[k] += s.total || 0;
  }
  const dayEntries = Object.entries(byDay);
  const maxDay = Math.max(...dayEntries.map(([,v]) => v), 1);
  const bestDayEntry = dayEntries.reduce((a, b) => b[1] > a[1] ? b : a, dayEntries[0]);
  const bestDt = new Date(bestDayEntry[0] + "T12:00:00");
  $("#stats-best-day").textContent = bestDt.toLocaleDateString("es", { weekday: "short", day: "numeric", month: "short" });

  // Gráfico de barras por día (SVG)
  const barW = statsperiodDays <= 7 ? 32 : statsperiodDays <= 30 ? 16 : 8;
  const gap   = statsperiodDays <= 7 ? 8  : statsperiodDays <= 30 ? 4  : 2;
  const chartH = 80;
  const svgW   = dayEntries.length * (barW + gap);
  const dailySvg = `<svg viewBox="0 0 ${svgW} ${chartH + 24}" width="${svgW}" height="${chartH + 24}" style="min-width:100%">
    ${dayEntries.map(([date, val], i) => {
      const bh = val > 0 ? Math.max(4, Math.round((val / maxDay) * chartH)) : 2;
      const x  = i * (barW + gap);
      const y  = chartH - bh;
      const isToday = date === new Date().toISOString().slice(0,10);
      const color = isToday ? "#1a1a1a" : "#8a8a8a";
      const label = statsperiodDays <= 30
        ? new Date(date + "T12:00:00").toLocaleDateString("es", { day: "numeric" })
        : "";
      return `<rect x="${x}" y="${y}" width="${barW}" height="${bh}" rx="4" fill="${color}" opacity="${val > 0 ? 1 : 0.2}"/>
              ${label ? `<text x="${x + barW/2}" y="${chartH + 14}" text-anchor="middle" font-size="9" fill="#8a8a8a">${label}</text>` : ""}`;
    }).join("")}
  </svg>`;
  $("#chart-daily").innerHTML = dailySvg;

  // ── Ventas por hora ───────────────────────────────────────
  const byHour = Array(24).fill(0);
  for (const s of sales) byHour[new Date(s.ts).getHours()] += s.total || 0;
  const maxHour = Math.max(...byHour, 1);
  const hBarH = 16; const hGap = 3;
  const hChartW = 200;
  const hourlySvg = `<svg viewBox="0 0 ${hChartW + 60} ${24 * (hBarH + hGap)}" width="100%" style="max-width:400px">
    ${byHour.map((val, h) => {
      const bw = val > 0 ? Math.max(4, Math.round((val / maxHour) * hChartW)) : 2;
      const y  = h * (hBarH + hGap);
      const label = `${String(h).padStart(2,"0")}:00`;
      const color = val === Math.max(...byHour) ? "#1a1a1a" : "#8a8a8a";
      return `<text x="32" y="${y + hBarH - 3}" text-anchor="end" font-size="10" fill="#8a8a8a">${label}</text>
              <rect x="36" y="${y}" width="${bw}" height="${hBarH}" rx="3" fill="${color}" opacity="${val > 0 ? 0.85 : 0.15}"/>
              ${val > 0 ? `<text x="${36 + bw + 4}" y="${y + hBarH - 3}" font-size="10" fill="#1a1a1a">$${formatPrice(val)}</text>` : ""}`;
    }).join("")}
  </svg>`;
  $("#chart-hourly").innerHTML = hourlySvg;

  // ── Top productos ─────────────────────────────────────────
  const byProduct = {};
  for (const sale of sales) {
    for (const it of (sale.items || [])) {
      const nombre = it.nombre?.replace(/\s*\(\d+g\)/, "") || it.codigo;
      if (!byProduct[nombre]) byProduct[nombre] = { units: 0, total: 0 };
      byProduct[nombre].units += it.pesable ? 1 : (it.cantidad || 1);
      byProduct[nombre].total += it.pesable ? it.precio : (it.precio * (it.cantidad || 1));
    }
  }
  const topProds = Object.entries(byProduct)
    .sort((a, b) => b[1].total - a[1].total)
    .slice(0, 8);

  if (topProds.length) {
    const maxProd = topProds[0][1].total;
    $("#chart-top-products").innerHTML = `<div class="space-y-2">
      ${topProds.map(([nombre, { units, total }], i) => {
        const pct = Math.round((total / maxProd) * 100);
        const medal = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : "";
        return `<div>
          <div class="mb-1 flex items-center justify-between text-xs">
            <span class="font-medium text-ink truncate max-w-[60%]">${medal} ${escapeHtml(nombre)}</span>
            <span class="text-ink/50">$${formatPrice(total)}</span>
          </div>
          <div class="h-2 w-full rounded-full bg-ink/5">
            <div class="h-2 rounded-full bg-[#8a8a8a]" style="width:${pct}%"></div>
          </div>
        </div>`;
      }).join("")}
    </div>`;
  }

  // ── Métodos de pago ───────────────────────────────────────
  const byMethod = {};
  const METHOD_LABELS = { efectivo:"Efectivo", debito:"Débito", credito:"Crédito", transferencia:"Transferencia", qr:"QR / Billetera", otro:"Otro" };
  for (const s of sales) {
    const k = s.metodoPago || "otro";
    if (!byMethod[k]) byMethod[k] = 0;
    byMethod[k] += s.total || 0;
  }
  const methodEntries = Object.entries(byMethod).sort((a,b) => b[1]-a[1]);
  const totalMethods  = methodEntries.reduce((s,[,v]) => s+v, 0);
  const COLORS = ["#1a1a1a","#8a8a8a","#d4d4d4","#000000","#6b6b6b","#c4c4c4"];
  if (methodEntries.length) {
    $("#chart-methods").innerHTML = `<div class="space-y-2">
      ${methodEntries.map(([key, val], i) => {
        const pct = totalMethods > 0 ? Math.round((val / totalMethods) * 100) : 0;
        return `<div class="flex items-center gap-3">
          <span class="h-3 w-3 shrink-0 rounded-full" style="background:${COLORS[i % COLORS.length]}"></span>
          <span class="flex-1 text-sm text-ink">${METHOD_LABELS[key] || key}</span>
          <span class="text-sm font-semibold text-ink">$${formatPrice(val)}</span>
          <span class="w-10 text-right text-xs text-ink/40">${pct}%</span>
        </div>`;
      }).join("")}
    </div>`;
  }

  statsLoading = false;
}

// ============================================================
//  Wiring de eventos
// ============================================================
function bindEvents() {
  // Selector de período de estadísticas
  document.addEventListener("click", (e) => {
    const btn = e.target.closest(".stats-period-btn");
    if (!btn) return;
    statsperiodDays = parseInt(btn.dataset.period, 10);
    $$(".stats-period-btn").forEach((b) => {
      const active = b === btn;
      b.classList.toggle("bg-white", active);
      b.classList.toggle("shadow", active);
      b.classList.toggle("text-ink", active);
      b.classList.toggle("text-ink/40", !active);
    });
    const labels = { 7: "Últimos 7 días", 30: "Últimos 30 días", 90: "Últimos 90 días" };
    $("#stats-period-label").textContent = labels[statsperiodDays] || "";
    renderStats();
  });
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

  // El módulo de escaneo no tiene input manual ni botón.
  // El lector USB escribe a nivel de documento y es capturado por BarcodeScanner.

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
  $("#pos-undo-btn").addEventListener("click", undoLastSale);
  $("#pos-manual-btn").addEventListener("click", openManualItem);
  $("#mi-add-btn").addEventListener("click", confirmManualItem);
  $("#mi-precio").addEventListener("keydown", (e) => { if (e.key === "Enter") confirmManualItem(); });
  $("#se-save-btn").addEventListener("click", saveSaleEdit);
  $("#se-delete-btn").addEventListener("click", deleteSaleFromEdit);
  $("#fiado-search").addEventListener("input", () => renderFiadoMatches($("#fiado-search").value));
  $("#fiado-search").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !$("#fiado-create-btn").classList.contains("hidden")) createFiado();
  });
  $("#fiado-create-btn").addEventListener("click", createFiado);
  $("#fiados-search").addEventListener("input", renderFiadosPeople);
  $("#fiados-search").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !$("#fiados-create-btn").classList.contains("hidden")) createFiadoFromModule();
  });
  $("#fiados-create-btn").addEventListener("click", createFiadoFromModule);
  $("#fiados-entry-btn").addEventListener("click", openFiadoEntry);
  $("#fiados-pay-btn").addEventListener("click", openAbonoModal);
  $("#fiados-delete-btn").addEventListener("click", deleteFiador);
  $("#fiados-history-btn").addEventListener("click", loadFullFiadoHistory);
  $("#fiados-cupo-btn").addEventListener("click", openCupoModal);
  $("#cupo-save-btn").addEventListener("click", () => saveCupo(false));
  $("#cupo-remove-btn").addEventListener("click", () => saveCupo(true));
  $("#cupo-monto").addEventListener("keydown", (e) => {
    if (e.key === "Enter") saveCupo(false);
  });
  $("#fiados-export-btn").addEventListener("click", exportFiadosXlsx);
  $("#ab-total-btn").addEventListener("click", () => { $("#ab-monto").value = selectedFiadoSaldo; });
  $("#ab-save-btn").addEventListener("click", confirmAbono);
  $("#ab-monto").addEventListener("keydown", (e) => { if (e.key === "Enter") confirmAbono(); });
  $("#fe-save-btn").addEventListener("click", confirmFiadoEntry);
  $("#fe-search").addEventListener("input", renderFeResults);
  $("#fe-add-line-btn").addEventListener("click", feAddFreeLine);
  $("#fe-valor").addEventListener("keydown", (e) => { if (e.key === "Enter") feAddFreeLine(); });

  // Modal de confirmación genérico
  $("#confirm-accept-btn").addEventListener("click", () => resolveConfirm(true));
  document.querySelectorAll("[data-confirm-cancel]").forEach((el) =>
    el.addEventListener("click", () => resolveConfirm(false))
  );

  // Modal de pesable: confirmar gramos
  $("#weigh-grams").addEventListener("input", () => {
    const prod = pendingWeighProduct;
    if (!prod) return;
    const g = parseFloat($("#weigh-grams").value) || 0;
    const precio = roundToTen((prod.precioKilo * g) / 1000);
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
    $("#pf-cantidad-wrap").classList.toggle("hidden", isPesable);
    $("#pf-minimo-wrap").classList.toggle("hidden", isPesable);
    $("#pf-venta-wrap").classList.toggle("hidden", isPesable);
    $("#pf-costo-label").textContent = isPesable ? "Costo por kilo" : "Precio costo";
    $("#pf-cantidad").required = !isPesable;
    $("#pf-minimo").required = !isPesable;
    if (isPesable) {
      $("#pf-cantidad").value = 0;
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
  document.querySelectorAll(".inv-filter-btn").forEach((b) => {
    b.addEventListener("click", () => {
      inventoryFilter = b.dataset.filter;
      $("#inventory-search").value = "";
      renderInventory();
    });
  });

  $("#export-csv-btn").addEventListener("click", exportHistoryCsv);
  const historyDay = $("#history-day");
  historyDay.value = todayISO();
  historyDay.max = todayISO();
  historyDay.addEventListener("change", onHistoryDayChange);
  const salesDay = $("#sales-day");
  salesDay.value = todayISO();
  salesDay.max = todayISO();
  salesDate = todayISO();
  salesDay.addEventListener("change", onSalesDayChange);

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