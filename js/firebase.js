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
function fiadoresCol(uid) {
  return collection(db, "usuarios", uid, "fiadores");
}
function abonosCol(uid) {
  return collection(db, "usuarios", uid, "abonos");
}

// Ajusta el saldo de un fiador de forma atómica (increment).
// delta > 0 = debe más (fiado nuevo); delta < 0 = debe menos (abono/anulación).
function adjustFiadorSaldo(uid, fiadoId, delta, ts) {
  return setDoc(
    fiadorDoc(uid, fiadoId),
    { saldo: increment(delta), ultimoMovimiento: ts || Date.now() },
    { merge: true }
  );
}
function fiadorDoc(uid, id) {
  return doc(db, "usuarios", uid, "fiadores", id);
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

  // Movimientos de un rango de fechas (para el selector de día del historial).
  async fetchRange(uid, start, end) {
    const q = query(
      movementsCol(uid),
      where("fecha", ">=", Timestamp.fromDate(start)),
      where("fecha", "<", Timestamp.fromDate(end)),
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

// ---------- Fiadores (clientes con cuenta corriente) ----------
export const fiadoresApi = {
  async fetchAll(uid) {
    const snap = await getDocs(query(fiadoresCol(uid), orderBy("nombre")));
    return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  },

  // El documento usa el nombre normalizado como id: dos personas con el
  // mismo nombre chocan en el mismo doc, así los nombres no se repiten.
  async save(uid, fiador) {
    await setDoc(
      fiadorDoc(uid, fiador.id),
      { nombre: fiador.nombre, creado: serverTimestamp() },
      { merge: true }
    );
  },

  // Migración: fija el saldo absoluto (calculado del historial una sola vez).
  async setSaldo(uid, id, saldo, ts) {
    await setDoc(
      fiadorDoc(uid, id),
      { saldo, ultimoMovimiento: ts || Date.now() },
      { merge: true }
    );
  },
};

// ---------- Abonos (pagos totales o parciales de fiados) ----------
export const abonosApi = {
  async commit(uid, abono) {
    await addDoc(abonosCol(uid), {
      fiadoId: abono.fiadoId,
      fiadoNombre: abono.fiadoNombre || "",
      monto: abono.monto || 0,
      metodoPago: abono.metodoPago || "efectivo",
      ts: abono.ts || Date.now(),
      fecha: serverTimestamp(),
    });
    await adjustFiadorSaldo(uid, abono.fiadoId, -(abono.monto || 0), abono.ts);
  },

  // Anula un abono: borra el documento (ubicado por ts) y devuelve la deuda.
  async revert(uid, abono) {
    if (abono.ts) {
      const q = query(abonosCol(uid), where("ts", "==", abono.ts));
      const snap = await getDocs(q);
      for (const d of snap.docs) {
        await deleteDoc(doc(db, "usuarios", uid, "abonos", d.id));
      }
    }
    await adjustFiadorSaldo(uid, abono.fiadoId, abono.monto || 0);
  },

  async fetchRange(uid, start, end) {
    const q = query(
      abonosCol(uid),
      where("fecha", ">=", Timestamp.fromDate(start)),
      where("fecha", "<", Timestamp.fromDate(end)),
      orderBy("fecha", "desc")
    );
    const snap = await getDocs(q);
    return snap.docs.map((d) => {
      const data = d.data();
      const fecha = data.fecha?.toDate ? data.fecha.toDate() : new Date();
      return {
        fiadoId: data.fiadoId || null,
        fiadoNombre: data.fiadoNombre || "",
        monto: data.monto || 0,
        metodoPago: data.metodoPago || "efectivo",
        ts: data.ts || fecha.getTime(),
      };
    });
  },

  async fetchToday(uid) {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const q = query(
      abonosCol(uid),
      where("fecha", ">=", Timestamp.fromDate(start)),
      orderBy("fecha", "desc")
    );
    const snap = await getDocs(q);
    return snap.docs.map((d) => {
      const data = d.data();
      const fecha = data.fecha?.toDate ? data.fecha.toDate() : new Date();
      return {
        fiadoId: data.fiadoId || null,
        fiadoNombre: data.fiadoNombre || "",
        monto: data.monto || 0,
        metodoPago: data.metodoPago || "efectivo",
        ts: data.ts || fecha.getTime(),
      };
    });
  },

  // Todos los abonos de una persona (un solo where → sin índice compuesto)
  async fetchByFiado(uid, fiadoId) {
    const q = query(abonosCol(uid), where("fiadoId", "==", fiadoId));
    const snap = await getDocs(q);
    return snap.docs
      .map((d) => {
        const data = d.data();
        const fecha = data.fecha?.toDate ? data.fecha.toDate() : new Date();
        return {
          fiadoId: data.fiadoId || null,
          fiadoNombre: data.fiadoNombre || "",
          monto: data.monto || 0,
          metodoPago: data.metodoPago || "efectivo",
          ts: data.ts || fecha.getTime(),
        };
      })
      .sort((a, b) => (b.ts || 0) - (a.ts || 0));
  },
};

// ---------- Ventas (caja) ----------
export const salesApi = {
  async commit(uid, sale) {
    for (const it of sale.items) {
      // Pesables y manuales: no llevan control de stock (su "código" de
      // línea no corresponde a un documento de producto).
      if (!it.pesable && !it.manual) {
        await updateDoc(productDoc(uid, it.codigo), {
          cantidad: increment(-it.cantidad),
          actualizado: serverTimestamp(),
        });
      }
      await addDoc(movementsCol(uid), {
        codigo: it.pesable ? (it.codigoBase || it.codigo) : it.codigo,
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
      fiadoId: sale.fiadoId || null,
      fiadoNombre: sale.fiadoNombre || null,
      ts: sale.ts || Date.now(), // marca local: permite ubicar la venta al anularla
      fecha: serverTimestamp(),
    });
    if (sale.fiadoId) {
      await adjustFiadorSaldo(uid, sale.fiadoId, sale.total || 0, sale.ts);
    }
  },

  // Anula una venta ya subida: repone stock, registra movimientos de
  // entrada y elimina el documento de la venta (ubicado por su ts local).
  async revert(uid, sale) {
    for (const it of sale.items || []) {
      if (!it.pesable && !it.manual) {
        await updateDoc(productDoc(uid, it.codigo), {
          cantidad: increment(it.cantidad || 0),
          actualizado: serverTimestamp(),
        });
      }
      await addDoc(movementsCol(uid), {
        codigo: it.pesable ? (it.codigoBase || it.codigo) : it.codigo,
        nombre: `Anulación: ${it.nombre}`,
        accion: "entrada",
        cantidad: it.cantidad || 0,
        fecha: serverTimestamp(),
      });
    }
    if (sale.ts) {
      const q = query(salesCol(uid), where("ts", "==", sale.ts));
      const snap = await getDocs(q);
      for (const d of snap.docs) {
        await deleteDoc(doc(db, "usuarios", uid, "ventas", d.id));
      }
    }
    if (sale.fiadoId) {
      await adjustFiadorSaldo(uid, sale.fiadoId, -(sale.total || 0));
    }
  },

  // Corrige una venta ya subida: aplica los deltas de stock, registra
  // movimientos de ajuste y actualiza el documento (ubicado por su ts local).
  // delta > 0 devuelve stock; delta < 0 descuenta más.
  async update(uid, sale, deltas, fiadoDelta) {
    if (fiadoDelta && fiadoDelta.fiadoId && fiadoDelta.delta) {
      await adjustFiadorSaldo(uid, fiadoDelta.fiadoId, fiadoDelta.delta);
    }
    for (const d of deltas || []) {
      await updateDoc(productDoc(uid, d.codigo), {
        cantidad: increment(d.delta),
        actualizado: serverTimestamp(),
      });
      await addDoc(movementsCol(uid), {
        codigo: d.codigo,
        nombre: `Ajuste venta: ${d.nombre}`,
        accion: d.delta > 0 ? "entrada" : "salida",
        cantidad: Math.abs(d.delta),
        fecha: serverTimestamp(),
      });
    }
    if (sale.ts) {
      const q = query(salesCol(uid), where("ts", "==", sale.ts));
      const snap = await getDocs(q);
      for (const d of snap.docs) {
        await updateDoc(doc(db, "usuarios", uid, "ventas", d.id), {
          total: sale.total,
          metodoPago: sale.metodoPago,
          items: sale.items,
          fiadoId: sale.fiadoId || null,
          fiadoNombre: sale.fiadoNombre || null,
        });
      }
    }
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
        fiadoId: data.fiadoId || null,
        fiadoNombre: data.fiadoNombre || null,
        ts: data.ts || fecha.getTime(),
      };
    });
  },

  async fetchByFiado(uid, fiadoId) {
    const q = query(salesCol(uid), where("fiadoId", "==", fiadoId));
    const snap = await getDocs(q);
    return snap.docs
      .map((d) => {
        const data = d.data();
        const fecha = data.fecha?.toDate ? data.fecha.toDate() : new Date();
        return {
          total: data.total || 0,
          metodoPago: data.metodoPago || "otro",
          items: data.items || [],
          fiadoId: data.fiadoId || null,
          fiadoNombre: data.fiadoNombre || null,
          ts: data.ts || fecha.getTime(),
        };
      })
      .sort((a, b) => (b.ts || 0) - (a.ts || 0));
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
        fiadoId: data.fiadoId || null,
        fiadoNombre: data.fiadoNombre || null,
        ts: data.ts || fecha.getTime(),
      };
    });
  },
};