/**
 * Construccion de valores monetarios.
 *
 * El schema expone `Money { amount, currency, formatted }` en lugar de un
 * `Float`. Centralizar el formateo aqui garantiza que TODA la aplicacion
 * muestre los pesos igual y que el frontend no tenga que reimplementar
 * `Intl.NumberFormat` en cada componente.
 */

export interface Money {
  amount: number;
  currency: 'COP';
  formatted: string;
}

const formatter = new Intl.NumberFormat('es-CO', {
  style: 'currency',
  currency: 'COP',
  // Los precios colombianos se manejan en pesos enteros: mostrar ",00" solo
  // agrega ruido visual en la interfaz.
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

export function money(amount: number | string | null | undefined): Money {
  const value = typeof amount === 'string' ? Number.parseFloat(amount) : (amount ?? 0);
  const safe = Number.isFinite(value) ? Math.round(value * 100) / 100 : 0;
  return {
    amount: safe,
    currency: 'COP',
    formatted: formatter.format(safe),
  };
}
