/**
 * IDENTIDAD · Resolvers.
 *
 * Cumplimiento del mandato Zero-REST: la autenticacion es una Mutation.
 * No hay `POST /login` en ninguna parte del backend, y el frontend obtiene su
 * token por el mismo canal /graphql que usa para todo lo demas.
 */
import { errors } from '../../shared/errors.js';
import { log } from '../../shared/logger.js';
import { signToken, type PatientRow } from './identity.service.js';
import type { GraphQLContext } from '../../graphql/context.js';

export const identityResolvers = {
  Query: {
    /** Paciente de la sesion. `null` para visitantes anonimos, no un error. */
    me(_: unknown, __: unknown, ctx: GraphQLContext) {
      if (!ctx.auth.patientId) return null;
      return ctx.repos.identity.findById(ctx.auth.patientId);
    },
  },

  Mutation: {
    async signIn(_: unknown, args: { input: { email: string; password: string } }, ctx: GraphQLContext) {
      const patient = await ctx.repos.identity.verifyCredentials(args.input.email, args.input.password);

      if (!patient) {
        // Mensaje deliberadamente ambiguo: no revela si el correo existe.
        log.warn(`signIn fallido para ${args.input.email}`);
        return {
          success: false,
          token: null,
          patient: null,
          errors: [errors.unauthenticated('Correo o contrasena incorrectos.')],
        };
      }

      log.ok(`signIn correcto · ${patient.email}`);
      return {
        success: true,
        token: signToken(patient),
        patient,
        errors: [],
      };
    },
  },

  Patient: {
    fullName: (p: PatientRow) => p.full_name,
    documentId: (p: PatientRow) => p.document_id,
    createdAt: (p: PatientRow) => p.created_at,
  },
};
