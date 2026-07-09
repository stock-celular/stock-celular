// ============================================================
//  Almacenamiento local en el teléfono (IndexedDB)
//  Guarda el inventario, los movimientos del día, la marca de
//  sincronización y una "cola de envío" (outbox) para los cambios
//  que todavía no se subieron a Firebase.
//  (No necesitas editar este archivo)
// ============================================================

const DB_NAME = "stock-barrio";
const DB_VERSION = 4;
const STORES = {
  productos: { keyPath: "codigo" },
  fiadores: { keyPath: "id" },
  abonos: { keyPath: "id", autoIncrement: true },
  movimientos: { keyPath: "id", autoIncrement: true },
  ventas: { keyPath: "id", autoIncrement: true },
  meta: { keyPath: "key" },
  outbox: { keyPath: "id", autoIncrement: true },
};

let _db = null;

function openDB() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const [name, opts] of Object.entries(STORES)) {
        if (!db.objectStoreNames.contains(name)) {
          db.createObjectStore(name, opts);
        }
      }
    };
    req.onsuccess = () => {
      _db = req.result;
      resolve(_db);
    };
    req.onerror = () => reject(req.error);
  });
}

function tx(store, mode, fn) {
  return openDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction(store, mode);
        const s = t.objectStore(store);
        const result = fn(s);
        t.oncomplete = () => resolve(result?.value !== undefined ? result.value : result);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      })
  );
}

function reqToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export const localDB = {
  // ---------- Productos ----------
  async getAllProducts() {
    const db = await openDB();
    return reqToPromise(db.transaction("productos").objectStore("productos").getAll());
  },
  async replaceProducts(list) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const t = db.transaction("productos", "readwrite");
      const s = t.objectStore("productos");
      s.clear();
      (list || []).forEach((p) => s.put(p));
      t.oncomplete = () => resolve(true);
      t.onerror = () => reject(t.error);
    });
  },
  async putProduct(p) {
    const db = await openDB();
    return reqToPromise(db.transaction("productos", "readwrite").objectStore("productos").put(p));
  },
  async deleteProduct(codigo) {
    const db = await openDB();
    return reqToPromise(
      db.transaction("productos", "readwrite").objectStore("productos").delete(codigo)
    );
  },

  // ---------- Movimientos del día ----------
  async getTodayMovements() {
    const db = await openDB();
    const all = await reqToPromise(
      db.transaction("movimientos").objectStore("movimientos").getAll()
    );
    // Más recientes primero
    return all.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  },
  async replaceMovements(list) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const t = db.transaction("movimientos", "readwrite");
      const s = t.objectStore("movimientos");
      s.clear();
      (list || []).forEach((m) => s.put(m));
      t.oncomplete = () => resolve(true);
      t.onerror = () => reject(t.error);
    });
  },
  async addMovement(m) {
    const db = await openDB();
    return reqToPromise(
      db.transaction("movimientos", "readwrite").objectStore("movimientos").put(m)
    );
  },

  // ---------- Ventas del día (caja) ----------
  async getTodaySales() {
    const db = await openDB();
    const all = await reqToPromise(db.transaction("ventas").objectStore("ventas").getAll());
    return all.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  },
  async replaceSales(list) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const t = db.transaction("ventas", "readwrite");
      const s = t.objectStore("ventas");
      s.clear();
      (list || []).forEach((v) => s.put(v));
      t.oncomplete = () => resolve(true);
      t.onerror = () => reject(t.error);
    });
  },
  async addSale(v) {
    const db = await openDB();
    return reqToPromise(db.transaction("ventas", "readwrite").objectStore("ventas").put(v));
  },

  // ---------- Fiadores (clientes con cuenta corriente) ----------
  async getFiadores() {
    const db = await openDB();
    return reqToPromise(db.transaction("fiadores").objectStore("fiadores").getAll());
  },
  async putFiador(f) {
    const db = await openDB();
    return reqToPromise(db.transaction("fiadores", "readwrite").objectStore("fiadores").put(f));
  },
  async replaceFiadores(list) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const t = db.transaction("fiadores", "readwrite");
      const s = t.objectStore("fiadores");
      s.clear();
      (list || []).forEach((f) => s.put(f));
      t.oncomplete = () => resolve(true);
      t.onerror = () => reject(t.error);
    });
  },

  // ---------- Abonos del día (pagos de fiados) ----------
  async getTodayAbonos() {
    const db = await openDB();
    const all = await reqToPromise(db.transaction("abonos").objectStore("abonos").getAll());
    return all.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  },
  async addAbono(a) {
    const db = await openDB();
    return reqToPromise(db.transaction("abonos", "readwrite").objectStore("abonos").put(a));
  },
  async replaceAbonos(list) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const t = db.transaction("abonos", "readwrite");
      const s = t.objectStore("abonos");
      s.clear();
      (list || []).forEach((a) => s.put(a));
      t.oncomplete = () => resolve(true);
      t.onerror = () => reject(t.error);
    });
  },

  // ---------- Marca de sincronización ----------
  async getMeta() {
    const db = await openDB();
    return reqToPromise(db.transaction("meta").objectStore("meta").get("sync"));
  },
  async setMeta(meta) {
    const db = await openDB();
    return reqToPromise(
      db.transaction("meta", "readwrite").objectStore("meta").put({ key: "sync", ...meta })
    );
  },

  // ---------- Cola de envío (cambios pendientes de subir) ----------
  async addToOutbox(op) {
    const db = await openDB();
    return reqToPromise(
      db.transaction("outbox", "readwrite").objectStore("outbox").add({ ...op, ts: Date.now() })
    );
  },
  async getOutbox() {
    const db = await openDB();
    const all = await reqToPromise(db.transaction("outbox").objectStore("outbox").getAll());
    return all.sort((a, b) => (a.id || 0) - (b.id || 0)); // en orden de creación
  },
  async deleteFromOutbox(id) {
    const db = await openDB();
    return reqToPromise(
      db.transaction("outbox", "readwrite").objectStore("outbox").delete(id)
    );
  },
  async outboxCount() {
    const db = await openDB();
    return reqToPromise(db.transaction("outbox").objectStore("outbox").count());
  },

  // ---------- Borrado total (al cambiar de usuario) ----------
  async wipe() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const t = db.transaction(Object.keys(STORES), "readwrite");
      Object.keys(STORES).forEach((s) => t.objectStore(s).clear());
      t.oncomplete = () => resolve(true);
      t.onerror = () => reject(t.error);
    });
  },
};