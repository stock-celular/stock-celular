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
  apiKey: "TU_API_KEY",
  authDomain: "TU_PROYECTO.firebaseapp.com",
  projectId: "TU_PROYECTO",
  storageBucket: "TU_PROYECTO.appspot.com",
  messagingSenderId: "TU_SENDER_ID",
  appId: "TU_APP_ID",
};

// No edites esto: detecta si todavía faltan las credenciales.
export const isConfigured =
  firebaseConfig.apiKey &&
  !firebaseConfig.apiKey.startsWith("TU_") &&
  firebaseConfig.projectId &&
  !firebaseConfig.projectId.startsWith("TU_");
