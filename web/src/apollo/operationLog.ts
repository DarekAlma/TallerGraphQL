/**
 * Registro de operaciones GraphQL enviadas por el cliente.
 *
 * Alimenta el panel "Inspector Zero-REST" de la interfaz. Su proposito es de
 * sustentacion: permite demostrar en la propia pantalla —sin depender de que
 * se vea bien DevTools en el video— que absolutamente todo el trafico de la
 * aplicacion sale hacia /graphql como Query, Mutation o Subscription, y que no
 * existe ni una sola llamada a un endpoint REST.
 *
 * Es un store minimo con suscriptores, al estilo de `useSyncExternalStore`:
 * no necesita ninguna libreria de estado adicional.
 */

export interface LoggedOperation {
  id: number;
  name: string;
  kind: 'query' | 'mutation' | 'subscription';
  endpoint: string;
  variables: Record<string, unknown>;
  at: Date;
}

const MAX_ENTRIES = 60;

let operations: LoggedOperation[] = [];
let nextId = 1;
const listeners = new Set<() => void>();

export function recordOperation(entry: Omit<LoggedOperation, 'id'>) {
  // Se antepone la mas reciente y se recorta: el panel muestra un historial
  // acotado, no un log infinito que consuma memoria durante la demo.
  operations = [{ ...entry, id: nextId++ }, ...operations].slice(0, MAX_ENTRIES);
  listeners.forEach((listener) => listener());
}

export function subscribeToOperations(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getOperations() {
  return operations;
}

export function clearOperations() {
  operations = [];
  listeners.forEach((listener) => listener());
}
