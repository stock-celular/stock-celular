// ============================================================
//  Lector de código de barras USB (tipo teclado / HID)
//  Compatible con lectores 2D USB como el 7100N: "teclean" el
//  código muy rápido y terminan con Enter. Este módulo captura
//  esa ráfaga de teclas en cualquier parte de la app.
//  (No necesitas editar este archivo)
// ============================================================

export class BarcodeScanner {
  /**
   * @param {object} opts
   * @param {(code:string)=>void} opts.onScan  Se llama con el código leído.
   * @param {number} [opts.minLength=3]   Largo mínimo para considerarlo válido.
   * @param {string[]} [opts.endKeys]     Teclas que terminan la lectura.
   * @param {number} [opts.interCharMs=60] Máx. ms entre teclas de una misma ráfaga.
   */
  constructor({ onScan, minLength = 3, endKeys = ["Enter", "Tab"], interCharMs = 60 } = {}) {
    this.onScan = onScan;
    this.minLength = minLength;
    this.endKeys = endKeys;
    this.interCharMs = interCharMs;
    this.buffer = "";
    this.lastTime = 0;
    this.enabled = false;
    this._onKey = this._onKey.bind(this);
  }

  // Empieza a escuchar el teclado (el lector USB se comporta como uno).
  start() {
    if (this.enabled) return;
    this.enabled = true;
    document.addEventListener("keydown", this._onKey, true);
  }

  stop() {
    this.enabled = false;
    document.removeEventListener("keydown", this._onKey, true);
    this.buffer = "";
  }

  isRunning() {
    return this.enabled;
  }

  // Si el foco está en un campo (búsqueda, formulario, el propio campo de
  // escaneo…), dejamos que el navegador escriba normalmente y NO interceptamos.
  _editableFocused() {
    const el = document.activeElement;
    if (!el) return false;
    const tag = el.tagName;
    return el.isContentEditable || tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
  }

  _onKey(e) {
    if (!this.enabled) return;
    if (this._editableFocused()) return; // hay un campo activo: no molestamos

    const now = Date.now();
    // Si pasó demasiado tiempo desde la última tecla, es tecleo humano:
    // reiniciamos el buffer. El lector USB manda todo en milisegundos.
    if (now - this.lastTime > this.interCharMs) this.buffer = "";
    this.lastTime = now;

    if (this.endKeys.includes(e.key)) {
      const code = this.buffer.trim();
      this.buffer = "";
      if (code.length >= this.minLength) {
        e.preventDefault();
        this.onScan?.(code);
      }
      return;
    }

    // Acumula solo caracteres imprimibles (dígitos/letras del código)
    if (e.key.length === 1) {
      this.buffer += e.key;
    }
  }
}
