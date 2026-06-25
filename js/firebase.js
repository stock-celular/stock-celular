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

  // Escucha cambios en tiempo real sobre la colección completa.
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