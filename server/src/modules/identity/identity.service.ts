/**
 * IDENTIDAD · Autenticacion por GraphQL.
 *
 * El taller prohibe explicitamente autenticar contra endpoints REST. Por eso
 * NO existe `POST /login` ni `POST /auth/token` en este backend: el unico
 * camino es la mutation `signIn`, que viaja por /graphql como cualquier otra
 * operacion.
 *
 * Flujo:
 *   1. `signIn(email, password)` → verifica el hash bcrypt contra `patients`.
 *   2. Si coincide, firma un JWT con el id del paciente.
 *   3. El frontend guarda el token y lo manda en `Authorization: Bearer <token>`.
 *   4. `createContext()` lo verifica en cada peticion y deja `auth.patientId`
 *      disponible para los resolvers.
 */
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { query, type SqlStats } from '../../db/pool.js';
import { env } from '../../config/env.js';

export interface PatientRow {
  id: string;
  email: string;
  full_name: string;
  document_id: string;
  password_hash?: string;
  created_at: Date;
}

interface TokenPayload {
  sub: string;
  email: string;
}

/** Firma un JWT de sesion para el paciente indicado. */
export function signToken(patient: PatientRow): string {
  const payload: TokenPayload = { sub: patient.id, email: patient.email };
  return jwt.sign(payload, env.jwtSecret, { expiresIn: env.jwtExpiresIn as jwt.SignOptions['expiresIn'] });
}

/**
 * Verifica el token de la cabecera Authorization.
 * Devuelve null en vez de lanzar: un token ausente o caducado significa
 * simplemente "visitante anonimo", que es un estado valido (puede navegar el
 * catalogo). Son los comandos los que exigen sesion.
 */
export function verifyToken(authorizationHeader: string | undefined): string | null {
  if (!authorizationHeader) return null;
  const [scheme, token] = authorizationHeader.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !token) return null;
  try {
    const decoded = jwt.verify(token, env.jwtSecret) as TokenPayload;
    return decoded.sub ?? null;
  } catch {
    return null;
  }
}

export function createIdentityRepository(stats?: SqlStats) {
  const meta = (label: string) => ({ label, stats });

  return {
    async findById(id: string): Promise<PatientRow | null> {
      const { rows } = await query<PatientRow>(
        `SELECT id, email, full_name, document_id, created_at FROM patients WHERE id = $1`,
        [id],
        meta('identity.findById'),
      );
      return rows[0] ?? null;
    },

    async findByEmailWithHash(email: string): Promise<PatientRow | null> {
      const { rows } = await query<PatientRow>(
        `SELECT id, email, full_name, document_id, password_hash, created_at
           FROM patients WHERE LOWER(email) = LOWER($1)`,
        [email],
        meta('identity.findByEmail'),
      );
      return rows[0] ?? null;
    },

    /**
     * Verifica credenciales.
     *
     * Devuelve el mismo resultado (null) tanto si el correo no existe como si
     * la clave es incorrecta. Distinguir ambos casos permitiria enumerar que
     * correos estan registrados en la plataforma.
     */
    async verifyCredentials(email: string, password: string): Promise<PatientRow | null> {
      const patient = await this.findByEmailWithHash(email);
      if (!patient?.password_hash) return null;
      const matches = await bcrypt.compare(password, patient.password_hash);
      if (!matches) return null;
      delete patient.password_hash;
      return patient;
    },
  };
}

export type IdentityRepository = ReturnType<typeof createIdentityRepository>;
