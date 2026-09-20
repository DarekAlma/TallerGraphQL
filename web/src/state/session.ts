/**
 * Sesion del paciente.
 *
 * El token JWT lo emite la mutation `signIn` (no hay endpoint REST de login) y
 * se guarda en `localStorage` para sobrevivir a un refresco de pagina.
 *
 * Esta pieza vive fuera de React a proposito: el `authLink` de Apollo necesita
 * leer el token en cada operacion, y un link no puede usar hooks. Al ser un
 * modulo plano, tanto los links como los componentes leen la misma fuente.
 */

const TOKEN_KEY = 'afirmative-pill.token';
const PATIENT_KEY = 'afirmative-pill.patient';

export interface StoredPatient {
  id: string;
  fullName: string;
  email: string;
}

export function getStoredToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    // Modo privado o almacenamiento bloqueado: se degrada a sesion en memoria.
    return null;
  }
}

export function getStoredPatient(): StoredPatient | null {
  try {
    const raw = localStorage.getItem(PATIENT_KEY);
    return raw ? (JSON.parse(raw) as StoredPatient) : null;
  } catch {
    return null;
  }
}

export function storeSession(token: string, patient: StoredPatient) {
  try {
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(PATIENT_KEY, JSON.stringify(patient));
  } catch {
    /* sin persistencia: la sesion durara lo que dure la pestana */
  }
}

export function clearSession() {
  try {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(PATIENT_KEY);
  } catch {
    /* nada que limpiar */
  }
}
