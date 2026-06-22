# Stock Barrio — Control de inventario

App web **responsiva (mobile-first)** para el control de stock de un pequeño negocio de barrio.
Hecha con **HTML + Tailwind (CDN) + JavaScript vanilla**, usando **Firebase** (Auth + Firestore) y lista para desplegar en **GitHub Pages**.

## Funcionalidades

- **Escáner de código de barras** con la cámara del celular (EAN-13, UPC, Code-128, etc.). Si falla, hay un botón para **ingresar el código manualmente**.
- **Operaciones rápidas**: al escanear, se elige **Sumar stock** (entrada) o **Restar venta** (salida).
- **Formulario de producto**: código de barra, nombre, cantidad actual, stock mínimo, precio de costo y precio de venta.
- **Alertas**: los productos en o por debajo de su stock mínimo se resaltan en **rojo** en el inventario.
- **Historial del día**: lista de movimientos (hora, producto, acción y cantidad).
- **Login** con correo y contraseña (Firebase Authentication).

## Estructura

```
.
├── index.html          ← interfaz (UI)
├── css/styles.css      ← estilos complementarios
└── js/
    ├── config.js       ← ⚠️ ÚNICO archivo que debes editar (tus credenciales)
    ├── firebase.js     ← inicialización + operaciones de datos
    ├── scanner.js      ← escáner de código de barras
    └── app.js          ← lógica de la aplicación
```

## 1) Configurar Firebase

1. Entra a [console.firebase.google.com](https://console.firebase.google.com) y **crea un proyecto**.
2. Crea una **App Web** (icono `</>`) y copia el objeto `firebaseConfig`.
3. Pega tus valores en **`js/config.js`** (reemplaza los `TU_...`).
4. En **Authentication → Sign-in method**, habilita **Correo/Contraseña**.
5. En **Firestore Database**, crea la base de datos (modo producción) y pega estas reglas en **Firestore → Reglas**:

```js
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    // Cada usuario solo puede leer y escribir SUS propios datos
    match /usuarios/{uid}/{document=**} {
      allow read, write: if request.auth != null && request.auth.uid == uid;
    }
  }
}
```

> Los datos se guardan por usuario en `usuarios/{uid}/productos` y `usuarios/{uid}/movimientos`.
> El código de barras se usa como ID del producto, por lo que la búsqueda al escanear es instantánea.

## 2) Probar localmente

Cualquier servidor estático sirve. Por ejemplo:

```bash
npx serve .
```

Abre la URL que te indique. **Nota:** la cámara requiere `https://` o `localhost`.

## 3) Desplegar en GitHub Pages

1. Sube estos archivos a un repositorio de GitHub.
2. Ve a **Settings → Pages**.
3. En **Source** elige la rama (ej. `main`) y la carpeta **/ (root)**. Guarda.
4. En unos minutos tu app estará en `https://TU_USUARIO.github.io/TU_REPO/`.

GitHub Pages sirve por HTTPS, así que la **cámara funciona** sin configuración extra.
El archivo `.nojekyll` ya está incluido para evitar problemas con las carpetas.

## Notas

- Tailwind se carga por **CDN** para empezar rápido. Para producción a mayor escala puedes
  reemplazarlo por una versión compilada, pero no es necesario para este uso.
- Las claves de Firebase del cliente (`apiKey`, etc.) **no son secretas**: la seguridad real
  la dan las **reglas de Firestore** de arriba. Por eso es seguro publicarlas en GitHub Pages.
```
