// ============================================================
//  Escáner de código de barras (envuelve html5-qrcode)
//  (No necesitas editar este archivo)
// ============================================================

const SUPPORTED_FORMATS = [
  // Formatos típicos de productos de almacén
  "EAN_13",
  "EAN_8",
  "UPC_A",
  "UPC_E",
  "CODE_128",
  "CODE_39",
  "ITF",
];

export class BarcodeScanner {
  constructor(containerId) {
    this.containerId = containerId;
    this.instance = null;
    this.running = false;
  }

  async start(onDetected, onError) {
    if (this.running) return;

    if (typeof Html5Qrcode === "undefined") {
      onError?.("No se pudo cargar el escáner. Revisa tu conexión.");
      return;
    }

    // Mapea los nombres de formato a los enums de la librería
    const formats = SUPPORTED_FORMATS.map((f) => Html5QrcodeSupportedFormats[f]).filter(
      (f) => f !== undefined
    );

    this.instance = new Html5Qrcode(this.containerId, {
      formatsToSupport: formats,
      verbose: false,
    });

    const config = {
      fps: 10,
      qrbox: { width: 250, height: 160 },
      aspectRatio: 1.0,
    };

    try {
      await this.instance.start(
        { facingMode: "environment" }, // cámara trasera del celular
        config,
        (decodedText) => {
          // Limpia espacios y caracteres no numéricos comunes
          const code = decodedText.trim();
          onDetected?.(code);
        },
        () => {
          /* lecturas fallidas por frame: se ignoran silenciosamente */
        }
      );
      this.running = true;
    } catch (err) {
      console.log("[v0] Error al iniciar cámara:", err?.message || err);
      let msg = "No se pudo acceder a la cámara.";
      if (String(err).includes("NotAllowedError") || String(err).includes("Permission")) {
        msg = "Permiso de cámara denegado. Habilítalo en el navegador y reintenta.";
      } else if (String(err).includes("NotFoundError")) {
        msg = "No se encontró ninguna cámara en este dispositivo.";
      } else if (location.protocol !== "https:" && location.hostname !== "localhost") {
        msg = "La cámara requiere HTTPS. En GitHub Pages funcionará correctamente.";
      }
      onError?.(msg);
    }
  }

  async stop() {
    if (!this.instance || !this.running) return;
    try {
      await this.instance.stop();
      await this.instance.clear();
    } catch (e) {
      console.log("[v0] Error al detener escáner:", e?.message || e);
    }
    this.running = false;
    this.instance = null;
  }

  isRunning() {
    return this.running;
  }
}
