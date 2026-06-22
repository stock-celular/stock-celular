// ============================================================
//  Inicialización de Firebase y operaciones de datos
//  (No necesitas editar este archivo)
// ============================================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore,
  collection,
  doc,
  getDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  onSnapshot,
  addDoc,
  query,
  where,
  orderBy,
  serverTimestamp,
  Timestamp,
  increment,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

import { firebaseConfig } from "./config.js";

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);

// ---------- Autenticación ----------
export const authApi = {
  login: (email, password) => signInWithEmailAndPassword(auth, email, password),
  register: (email, password) => createUserWithEmailAndPassword(auth, email, password),
  logout: () => signOut(auth),
  onChange: (cb) => onAuthStateChanged(auth, cb),
};

// ---------- Helpers de colecciones (scoping por usuario) ----------
// Cada usuario guarda sus datos bajo: usuarios/{uid}/productos y /movimientos
function productsCol(uid) {
  return collection(db, "usuarios", uid, "productos");
}
function productDoc(uid, codigo) {
  return doc(db, "usuarios", uid, "productos", codigo);
}
function movementsCol(uid) {
  return collection(db, "usuarios", uid, "movimientos");
}

// ---------- Productos ----------
export const productsApi = {
  // Escucha en tiempo real todos los productos
  subscribe(uid, callback) {
    const q = query(productsCol(uid), orderBy("nombre"));
    return onSnapshot(q, (snap) => {
      const items = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      callback(items);
    });
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
  subscribeToday(uid, callback) {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const q = query(
      movementsCol(uid),
      where("fecha", ">=", Timestamp.fromDate(start)),
      orderBy("fecha", "desc")
    );
    return onSnapshot(q, (snap) => {
      const items = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      callback(items);
    });
  },
};
