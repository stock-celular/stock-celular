// ============================================================
//  CONFIGURACIÓN DE FIREBASE  ←  ÚNICO ARCHIVO QUE DEBES EDITAR
// ============================================================
//
//  1. Entra a https://console.firebase.google.com y crea un proyecto.
//  2. Crea una "App Web" (icono </>) y copia el objeto firebaseConfig.
//  3. Pega tus valores reemplazando los de abajo.
//  4. En la consola de Firebase:
//        - Authentication → Sign-in method → habilita "Correo/Contraseña".
//        - Firestore Database → Crear base de datos (modo producción).
//        - Pega las reglas de seguridad que están en el README.
//
//  No necesitas tocar ningún otro archivo. ¡Listo!
// ============================================================

export const firebaseConfig = {
  apiKey: "AIzaSyCB6mlKoTX_yQRko2B4MDq99lhcHtTn_Ig",
  authDomain: "stock-celular.firebaseapp.com",
  projectId: "stock-celular",
  storageBucket: "stock-celular.firebasestorage.app",
  messagingSenderId: "953647568198",
  appId: "1:953647568198:web:71fea72d12438c426f4147",
  measurementId: "G-XDP68C8XS2"
};

// No edites esto: detecta si todavía faltan las credenciales.
export const isConfigured =
  firebaseConfig.apiKey &&
  !firebaseConfig.apiKey.startsWith("TU_") &&
  firebaseConfig.projectId &&
  !firebaseConfig.projectId.startsWith("TU_");
