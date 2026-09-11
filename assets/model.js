/* Ledger — bookkeeping rules, shared by the page, the editor and the local
 * server so all three compute exactly the same numbers.
 *
 * Ledger shape:
 * {
 *   version: 1,
 *   config: { reserva: 1000, miembros: ["Daniel", ...] },
 *   movimientos: [{
 *     id, fecha: "YYYY-MM-DD", evento, tipo: ingreso|gasto|distribucion,
 *     monto (always positive), concepto, miembro (distribucion only),
 *     estado: ok|pendiente, imagen: null | { id, mime, nombre }
 *   }]
 * }
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Ledger = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const VERSION = 1;
  const TIPOS = ['ingreso', 'gasto', 'distribucion'];
  const ESTADOS = ['ok', 'pendiente'];
  const TIPO_LABEL = { ingreso: 'Ingreso', gasto: 'Gasto', distribucion: 'Distribución' };
  const IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

  function nuevoLibro() {
    return { version: VERSION, config: { reserva: 1000, miembros: [] }, movimientos: [] };
  }

  function nuevoId() {
    return 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function signo(m) { return m.tipo === 'ingreso' ? 1 : -1; }
  function valor(m) { return signo(m) * m.monto; }
  function round2(n) { return Math.round(n * 100) / 100; }

  /* Headline numbers. Pending movements never touch the fund. */
  function resumen(libro) {
    const r = {
      fondo: 0, ingresos: 0, gastos: 0, distribuido: 0,
      pendienteCobrar: 0, pendientePagar: 0,
      reserva: Number(libro.config.reserva) || 0,
      miembros: (libro.config.miembros || []).length,
    };
    for (const m of libro.movimientos) {
      if (m.estado === 'pendiente') {
        if (m.tipo === 'ingreso') r.pendienteCobrar += m.monto;
        else r.pendientePagar += m.monto;
        continue;
      }
      r.fondo += valor(m);
      if (m.tipo === 'ingreso') r.ingresos += m.monto;
      else if (m.tipo === 'gasto') r.gastos += m.monto;
      else r.distribuido += m.monto;
    }
    for (const k of ['fondo', 'ingresos', 'gastos', 'distribuido', 'pendienteCobrar', 'pendientePagar']) r[k] = round2(r[k]);
    r.completo = r.fondo >= r.reserva;
    r.faltante = round2(Math.max(0, r.reserva - r.fondo));
    r.disponible = round2(Math.max(0, r.fondo - r.reserva));
    r.porMiembro = r.miembros ? round2(r.disponible / r.miembros) : 0;
    return r;
  }

  /* Per-calendar-year totals. Pending movements are excluded, same as the fund.
   * Returns { anios: ['2026', '2025', ...] (newest first), por: { '2026': {...} } }. */
  function porAnio(libro) {
    const por = {};
    for (const m of libro.movimientos) {
      if (m.estado === 'pendiente') continue;
      const y = String(m.fecha).slice(0, 4);
      const r = por[y] || (por[y] = { ingresos: 0, gastos: 0, distribuido: 0, neto: 0 });
      if (m.tipo === 'ingreso') r.ingresos += m.monto;
      else if (m.tipo === 'gasto') r.gastos += m.monto;
      else r.distribuido += m.monto;
      r.neto += valor(m);
    }
    for (const r of Object.values(por)) for (const k in r) r[k] = round2(r[k]);
    return { anios: Object.keys(por).sort().reverse(), por };
  }

  /* The year to show by default: the current one if it has data, else the latest. */
  function anioInicial(anios) {
    const actual = String(new Date().getFullYear());
    return anios.includes(actual) ? actual : anios[0] || null;
  }

  /* Cards for display: one per event (ingresos + gastos sharing an evento name),
   * and one per distribution date (all members paid that day). Newest first. */
  function grupos(libro) {
    const map = new Map();
    for (const m of libro.movimientos) {
      const key = m.tipo === 'distribucion'
        ? 'dist:' + m.fecha
        : 'ev:' + String(m.evento || '').trim().toLowerCase();
      let g = map.get(key);
      if (!g) {
        g = {
          key,
          clase: m.tipo === 'distribucion' ? 'distribucion' : 'evento',
          titulo: m.tipo === 'distribucion' ? 'Distribución de utilidades' : String(m.evento || '').trim(),
          desde: m.fecha, hasta: m.fecha,
          movimientos: [],
          ingresos: 0, gastos: 0, neto: 0, pendiente: 0,
        };
        map.set(key, g);
      }
      g.movimientos.push(m);
      if (m.fecha < g.desde) g.desde = m.fecha;
      if (m.fecha > g.hasta) g.hasta = m.fecha;
      if (m.estado === 'pendiente') { g.pendiente += valor(m); continue; }
      g.neto += valor(m);
      if (m.tipo === 'ingreso') g.ingresos += m.monto; else g.gastos += m.monto;
    }
    const out = [...map.values()];
    for (const g of out) {
      g.movimientos.sort((a, b) => a.fecha < b.fecha ? -1 : a.fecha > b.fecha ? 1 : 0);
      for (const k of ['ingresos', 'gastos', 'neto', 'pendiente']) g[k] = round2(g[k]);
    }
    out.sort((a, b) => a.hasta < b.hasta ? 1 : a.hasta > b.hasta ? -1 : 0);
    return out;
  }

  function fechaValida(s) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s || '')) return false;
    const [y, mo, d] = s.split('-').map(Number);
    const dt = new Date(y, mo - 1, d);
    return dt.getFullYear() === y && dt.getMonth() === mo - 1 && dt.getDate() === d;
  }

  /* Returns a list of human-readable problems; empty list means the ledger is sound. */
  function validar(libro) {
    const err = [];
    if (!libro || typeof libro !== 'object') return ['El libro no es un objeto'];
    if (libro.version !== VERSION) err.push('Versión de libro desconocida: ' + libro.version);
    const cfg = libro.config || {};
    if (!(Number.isFinite(cfg.reserva) && cfg.reserva >= 0)) err.push('La reserva debe ser un número ≥ 0');
    const miembros = Array.isArray(cfg.miembros) ? cfg.miembros : null;
    if (!miembros) err.push('config.miembros debe ser una lista');
    else {
      const seen = new Set();
      miembros.forEach((n, i) => {
        if (typeof n !== 'string' || !n.trim()) err.push('Miembro #' + (i + 1) + ' sin nombre');
        else if (seen.has(n.trim().toLowerCase())) err.push('Miembro repetido: ' + n);
        seen.add(String(n).trim().toLowerCase());
      });
    }
    if (!Array.isArray(libro.movimientos)) return err.concat('movimientos debe ser una lista');
    const ids = new Set();
    libro.movimientos.forEach((m, i) => {
      const at = 'Movimiento #' + (i + 1) + (m && m.evento ? ' (' + m.evento + ')' : '') + ': ';
      if (!m || typeof m !== 'object') { err.push(at + 'no es un objeto'); return; }
      if (typeof m.id !== 'string' || !m.id) err.push(at + 'sin id');
      else if (ids.has(m.id)) err.push(at + 'id repetido ' + m.id);
      ids.add(m.id);
      if (!fechaValida(m.fecha)) err.push(at + 'fecha inválida "' + m.fecha + '" (usar AAAA-MM-DD)');
      if (!TIPOS.includes(m.tipo)) err.push(at + 'tipo inválido "' + m.tipo + '"');
      if (!(Number.isFinite(m.monto) && m.monto > 0)) err.push(at + 'el monto debe ser un número mayor a 0');
      if (!ESTADOS.includes(m.estado)) err.push(at + 'estado inválido "' + m.estado + '"');
      if (typeof m.concepto !== 'string') err.push(at + 'concepto debe ser texto');
      if (m.tipo === 'distribucion') {
        if (typeof m.miembro !== 'string' || !m.miembro.trim()) err.push(at + 'una distribución necesita un miembro');
        else if (miembros && !miembros.includes(m.miembro)) err.push(at + 'miembro desconocido "' + m.miembro + '"');
      } else if (typeof m.evento !== 'string' || !m.evento.trim()) {
        err.push(at + 'ingresos y gastos necesitan un nombre de evento');
      }
      if (m.imagen != null) {
        const im = m.imagen;
        if (typeof im !== 'object' || typeof im.id !== 'string' || !/^[a-z0-9]+$/.test(im.id)
            || !IMAGE_MIMES.includes(im.mime) || typeof im.nombre !== 'string') {
          err.push(at + 'referencia de imagen inválida');
        }
      }
    });
    return err;
  }

  const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
  function fmtMonto(n) { return usd.format(n); }
  function fmtSigned(m) { return (m.tipo === 'ingreso' ? '+' : '−') + usd.format(m.monto); }

  const fechaFmt = new Intl.DateTimeFormat('es', { day: 'numeric', month: 'short', year: 'numeric' });
  function fmtFecha(iso) {
    if (!fechaValida(iso)) return iso || '';
    const [y, mo, d] = iso.split('-').map(Number);
    return fechaFmt.format(new Date(y, mo - 1, d)).replace(/\./g, '');
  }

  return {
    VERSION, TIPOS, ESTADOS, TIPO_LABEL, IMAGE_MIMES,
    nuevoLibro, nuevoId, valor, resumen, porAnio, anioInicial, grupos, validar, fechaValida,
    fmtMonto, fmtSigned, fmtFecha,
  };
});
