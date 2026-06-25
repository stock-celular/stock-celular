// ============================================================
//  Inicialización de Firebase y operaciones de datos
//  (No necesitas editar este archivo)
// ============================================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore,
  enableIndexedDbPersistence,
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  deleteDoc,
  addDoc,
  query,
  where,
  orderBy,
  onSnapshot,
  serverTimestamp,
  Timestamp,
  increment,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

import { firebaseConfig } from "./config.js";

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);

// ── Persistencia offline ────────────────────────────────────
// Guarda todos los documentos en IndexedDB del navegador.
// onSnapshot devuelve datos locales al instante y solo va a la
// red cuando hay cambios reales → ahorra lecturas significativamente.
enableIndexedDbPersistence(db).catch((err) => {
  if (err.code === "failed-precondition") {
    // Más de una pestaña abierta: la persistencia solo funciona en una.
    console.warn("[firebase] Persistencia desactivada: múltiples pestañas.");
  } else if (err.code === "unimplemented") {
    // Navegador sin soporte (Safari antiguo, etc.)
    console.warn("[firebase] Persistencia no soportada en este navegador.");
  }
});

// ── Detección de cuota agotada ──────────────────────────────
export function isQuotaError(err) {
  const code = err?.code || err?.message || "";
  return (
    code.includes("resource-exhausted") ||
    code.includes("quota-exceeded") ||
    code.includes("RESOURCE_EXHAUSTED")
  );
}

// ---------- Autenticación ----------
export const authApi = {
  login: (email, password) => signInWithEmailAndPassword(auth, email, password),
  logout: () => signOut(auth),
  onChange: (cb) => onAuthStateChanged(auth, cb),
};

// ---------- Estructura de datos ----------
function userDoc(uid) {
  return doc(db, "usuarios", uid);
}
function productsCol(uid) {
  return collection(db, "usuarios", uid, "productos");
}
function productDoc(uid, codigo) {
  return doc(db, "usuarios", uid, "productos", codigo);
}
function movementsCol(uid) {
  return collection(db, "usuarios", uid, "movimientos");
}
function salesCol(uid) {
  return collection(db, "usuarios", uid, "ventas");
}
// Documento señal: un único doc que solo guarda un timestamp.
// El listener lo escucha en vez de escuchar toda la colección de productos,
// lo que cuesta 1 lectura por evento en lugar de N (una por producto).
function signalDoc(uid) {
  return doc(db, "usuarios", uid, "meta", "signal");
}

// ---------- Perfil de usuario ----------
export const usersApi = {
  async ensureProfile(uid, email) {
    await setDoc(
      userDoc(uid),
      { email: email || "", ultimoAcceso: serverTimestamp() },
      { merge: true }
    );
  },
};

// ---------- Productos ----------
export const productsApi = {
  async fetchAll(uid) {
    const q = query(productsCol(uid), orderBy("nombre"));
    const snap = await getDocs(q);
    return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  },

  // ── Listener de señal ────────────────────────────────────
  // Escucha UN solo documento. Cuando cambia, avisa para que la
  // app descargue los productos frescos con fetchAll().
  // Costo: 1 lectura por evento (no importa cuántos productos haya).
  listenSignal(uid, onChange, onError) {
    return onSnapshot(signalDoc(uid), onChange, onError);
  },

  // Toca la señal después de cada escritura para que otros dispositivos
  // sepan que hay datos nuevos. Costo: 1 escritura.
  async touchSignal(uid) {
    await setDoc(signalDoc(uid), { ts: serverTimestamp() }, { merge: true });
  },

  async getByCode(uid, codigo) {
    const snap = await getDoc(productDoc(uid, codigo));
    return snap.exists() ? { id: snap.id, ...snap.data() } : null;
  },

  async save(uid, data) {
    const { codigo, ...rest } = data;
    await setDoc(
      productDoc(uid, codigo),
      { ...rest, codigo, actualizado: serverTimestamp() },
      { merge: true }
    );
    await productsApi.touchSignal(uid);
  },

  async delete(uid, codigo) {
    await deleteDoc(productDoc(uid, codigo));
    await productsApi.touchSignal(uid);
  },

  async adjustStock(uid, producto, accion, cantidad) {
    const delta = accion === "entrada" ? cantidad : -cantidad;
    await updateDoc(productDoc(uid, producto.codigo), {
      cantidad: increment(delta),
      actualizado: serverTimestamp(),
    });
    await addDoc(movementsCol(uid), {
      codigo: producto.codigo,
      nombre: producto.nombre,
      accion,
      cantidad,
      fecha: serverTimestamp(),
    });
    await productsApi.touchSignal(uid);
  },
};

// ---------- Movimientos ----------
export const movementsApi = {
  async fetchToday(uid) {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const q = query(
      movementsCol(uid),
      where("fecha", ">=", Timestamp.fromDate(start)),
      orderBy("fecha", "desc")
    );
    const snap = await getDocs(q);
    return snap.docs.map((d) => {
      const data = d.data();
      const fecha = data.fecha?.toDate ? data.fecha.toDate() : new Date();
      return {
        codigo: data.codigo,
        nombre: data.nombre,
        accion: data.accion,
        cantidad: data.cantidad,
        ts: fecha.getTime(),
      };
    });
  },
};

// ---------- Ventas (caja) ----------
export const salesApi = {
  async commit(uid, sale) {
    for (const it of sale.items) {
      // Pesables no modifican stock numérico
      if (!it.pesable) {
        await updateDoc(productDoc(uid, it.codigoBase || it.codigo), {
          cantidad: increment(-it.cantidad),
          actualizado: serverTimestamp(),
        });
      }
      await addDoc(movementsCol(uid), {
        codigo: it.codigoBase || it.codigo,
        nombre: it.nombre,
        accion: "salida",
        cantidad: it.pesable ? it.gramos : it.cantidad,
        esPesable: !!it.pesable,
        fecha: serverTimestamp(),
      });
    }
    await addDoc(salesCol(uid), {
      total: sale.total,
      metodoPago: sale.metodoPago,
      items: sale.items,
      fecha: serverTimestamp(),
    });
    await productsApi.touchSignal(uid);
  },

  async fetchToday(uid) {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const q = query(
      salesCol(uid),
      where("fecha", ">=", Timestamp.fromDate(start)),
      orderBy("fecha", "desc")
    );
    const snap = await getDocs(q);
    return snap.docs.map((d) => {
      const data = d.data();
      const fecha = data.fecha?.toDate ? data.fecha.toDate() : new Date();
      return {
        total: data.total || 0,
        metodoPago: data.metodoPago || "otro",
        items: data.items || [],
        ts: fecha.getTime(),
      };
    });
  },

  async fetchRange(uid, start, end) {
    const q = query(
      salesCol(uid),
      where("fecha", ">=", Timestamp.fromDate(start)),
      where("fecha", "<", Timestamp.fromDate(end)),
      orderBy("fecha", "asc")
    );
    const snap = await getDocs(q);
    return snap.docs.map((d) => {
      const data = d.data();
      const fecha = data.fecha?.toDate ? data.fecha.toDate() : new Date();
      return {
        total: data.total || 0,
        metodoPago: data.metodoPago || "otro",
        items: data.items || [],
        ts: fecha.getTime(),
      };
    });
  },
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);

// ── Detección de cuota agotada ──────────────────────────────
// Firebase lanza "resource-exhausted" al superar el plan gratuito.
// Cualquier parte de la app puede llamar a isQuotaError(err) para
// saber si debe mostrar la alerta especial en lugar de un toast genérico.
export function isQuotaError(err) {
  const code = err?.code || err?.message || "";
  return (
    code.includes("resource-exhausted") ||
    code.includes("quota-exceeded") ||
    code.includes("RESOURCE_EXHAUSTED")
  );
}

// ---------- Autenticación ----------
// Nota: NO se expone "register". Las cuentas se crean a mano por un
// administrador en la consola de Firebase (Authentication → Users).
export const authApi = {
  login: (email, password) => signInWithEmailAndPassword(auth, email, password),
  logout: () => signOut(auth),
  onChange: (cb) => onAuthStateChanged(auth, cb),
};

// ---------- Estructura de datos (aislada por usuario) ----------
// Cada usuario tiene su propio espacio y NO se mezcla con otros:
//   usuarios/{uid}                 → documento de perfil (la "tabla de usuarios")
//   usuarios/{uid}/productos/{cod} → su inventario
//   usuarios/{uid}/movimientos/{}  → su historial
function userDoc(uid) {
  return doc(db, "usuarios", uid);
}
function productsCol(uid) {
  return collection(db, "usuarios", uid, "productos");
}
function productDoc(uid, codigo) {
  return doc(db, "usuarios", uid, "productos", codigo);
}
function movementsCol(uid) {
  return collection(db, "usuarios", uid, "movimientos");
}
function salesCol(uid) {
  return collection(db, "usuarios", uid, "ventas");
}

// ---------- Perfil de usuario ----------
export const usersApi = {
  // Crea/actualiza el documento de perfil del usuario al iniciar sesión.
  async ensureProfile(uid, email) {
    await setDoc(
      userDoc(uid),
      { email: email || "", ultimoAcceso: serverTimestamp() },
      { merge: true }
    );
  },
};

// ---------- Productos ----------
export const productsApi = {
  // Descarga TODOS los productos una sola vez (para el caché inicial).
  async fetchAll(uid) {
    const q = query(productsCol(uid), orderBy("nombre"));
    const snap = await getDocs(q);
    return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  },

  // Escucha cambios en tiempo real. Llama a onData(productos[]) cada vez
  // que algo cambia en Firestore. Devuelve la función para cancelar el listener.
  listenProducts(uid, onData, onError) {
    const q = query(productsCol(uid), orderBy("nombre"));
    return onSnapshot(
      q,
      (snap) => {
        const list = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        onData(list);
      },
      onError
    );
  },

  async getByCode(uid, codigo) {
    const snap = await getDoc(productDoc(uid, codigo));
    return snap.exists() ? { id: snap.id, ...snap.data() } : null;
  },

  // Crea o reemplaza un producto (usa el código de barras como id)
  async save(uid, data) {
    const { codigo, ...rest } = data;
    await setDoc(
      productDoc(uid, codigo),
      { ...rest, codigo, actualizado: serverTimestamp() },
      { merge: true }
    );
  },

  async delete(uid, codigo) {
    await deleteDoc(productDoc(uid, codigo));
  },

  // Suma (entrada) o resta (salida) stock de forma atómica y registra el movimiento
  async adjustStock(uid, producto, accion, cantidad) {
    const delta = accion === "entrada" ? cantidad : -cantidad;
    await updateDoc(productDoc(uid, producto.codigo), {
      cantidad: increment(delta),
      actualizado: serverTimestamp(),
    });
    await addDoc(movementsCol(uid), {
      codigo: producto.codigo,
      nombre: producto.nombre,
      accion,
      cantidad,
      fecha: serverTimestamp(),
    });
  },
};

// ---------- Movimientos (historial del día) ----------
export const movementsApi = {
  // Descarga los movimientos de hoy una sola vez (al sincronizar el día).
  async fetchToday(uid) {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const q = query(
      movementsCol(uid),
      where("fecha", ">=", Timestamp.fromDate(start)),
      orderBy("fecha", "desc")
    );
    const snap = await getDocs(q);
    return snap.docs.map((d) => {
      const data = d.data();
      const fecha = data.fecha?.toDate ? data.fecha.toDate() : new Date();
      return {
        codigo: data.codigo,
        nombre: data.nombre,
        accion: data.accion,
        cantidad: data.cantidad,
        ts: fecha.getTime(),
      };
    });
  },
};

// ---------- Ventas (caja) ----------
export const salesApi = {
  // Cobra una venta completa: descuenta stock + registra movimientos de
  // salida por cada ítem y guarda el comprobante de venta. Todo en línea.
  async commit(uid, sale) {
    for (const it of sale.items) {
      await updateDoc(productDoc(uid, it.codigo), {
        cantidad: increment(-it.cantidad),
        actualizado: serverTimestamp(),
      });
      await addDoc(movementsCol(uid), {
        codigo: it.codigo,
        nombre: it.nombre,
        accion: "salida",
        cantidad: it.cantidad,
        fecha: serverTimestamp(),
      });
    }
    await addDoc(salesCol(uid), {
      total: sale.total,
      metodoPago: sale.metodoPago,
      items: sale.items,
      fecha: serverTimestamp(),
    });
  },

  // Descarga las ventas de hoy una sola vez (al sincronizar el día).
  async fetchToday(uid) {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const q = query(
      salesCol(uid),
      where("fecha", ">=", Timestamp.fromDate(start)),
      orderBy("fecha", "desc")
    );
    const snap = await getDocs(q);
    return snap.docs.map((d) => {
      const data = d.data();
      const fecha = data.fecha?.toDate ? data.fecha.toDate() : new Date();
      return {
        total: data.total || 0,
        metodoPago: data.metodoPago || "otro",
        items: data.items || [],
        ts: fecha.getTime(),
      };
    });
  },

  // Descarga las ventas en un rango [start, end) (para reportes mensuales).
  async fetchRange(uid, start, end) {
    const q = query(
      salesCol(uid),
      where("fecha", ">=", Timestamp.fromDate(start)),
      where("fecha", "<", Timestamp.fromDate(end)),
      orderBy("fecha", "asc")
    );
    const snap = await getDocs(q);
    return snap.docs.map((d) => {
      const data = d.data();
      const fecha = data.fecha?.toDate ? data.fecha.toDate() : new Date();
      return {
        total: data.total || 0,
        metodoPago: data.metodoPago || "otro",
        items: data.items || [],
        ts: fecha.getTime(),
      };
    });
  },
};