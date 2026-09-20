/**
 * Inicio de sesion.
 *
 * Cumplimiento del mandato Zero-REST en su punto mas sensible: el taller
 * prohibe expresamente "consultar endpoints HTTP REST para ... autenticar".
 * Aqui no hay `fetch('/api/login')`: hay un `useMutation(SIGN_IN)` que viaja
 * por el mismo POST /graphql que el resto de la aplicacion.
 *
 * El token devuelto se guarda y el `authLink` lo adjuntara automaticamente a
 * la siguiente operacion.
 */
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation } from '@apollo/client/react';
import { SIGN_IN } from '../graphql/operations';
import { storeSession } from '../state/session';
import { apolloClient } from '../apollo/client';
import { DomainErrors } from '../components/ui';
import type { DomainError } from '../types';

interface SignInData {
  signIn: {
    success: boolean;
    token: string | null;
    patient: { id: string; fullName: string; email: string; documentId: string } | null;
    errors: DomainError[];
  };
}

const DEMO_ACCOUNTS = [
  { email: 'ana.gomez@correo.com', name: 'Ana María Gómez' },
  { email: 'carlos.rueda@correo.com', name: 'Carlos Rueda' },
  { email: 'lucia.mendez@correo.com', name: 'Lucía Méndez' },
];

export function SignInPage() {
  const navigate = useNavigate();
  const [email, setEmail] = useState('ana.gomez@correo.com');
  const [password, setPassword] = useState('afirmative123');

  // `useMutation` devuelve la funcion ejecutora y el estado reactivo.
  const [signIn, { loading, data }] = useMutation<SignInData>(SIGN_IN);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    const result = await signIn({ variables: { input: { email, password } } });
    const payload = result.data?.signIn;

    if (payload?.success && payload.token && payload.patient) {
      storeSession(payload.token, {
        id: payload.patient.id,
        fullName: payload.patient.fullName,
        email: payload.patient.email,
      });
      // Se reinician las queries activas para que se re-ejecuten ya con el
      // token puesto (por ejemplo `activeCart`, que antes devolvia null).
      await apolloClient.resetStore();
      navigate('/');
    }
  }

  return (
    <main className="container container-narrow">
      <div style={{ maxWidth: 420, margin: '40px auto' }}>
        <h1 className="page-title">Iniciar sesión</h1>
        <p className="page-sub">
          La autenticación es una <b>Mutation de GraphQL</b>, no un endpoint REST.
        </p>

        <form className="card card-pad mt-4" onSubmit={onSubmit}>
          <div className="field">
            <label htmlFor="email">Correo electrónico</label>
            <input
              id="email"
              className="input"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>

          <div className="field">
            <label htmlFor="password">Contraseña</label>
            <input
              id="password"
              className="input"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>

          {data?.signIn?.errors && data.signIn.errors.length > 0 && (
            <div className="mb-3">
              <DomainErrors errors={data.signIn.errors} />
            </div>
          )}

          <button className="btn btn-primary btn-block" disabled={loading}>
            {loading ? 'Verificando…' : 'Entrar'}
          </button>
        </form>

        <div className="card card-pad mt-3">
          <div className="section-title">Cuentas de demostración</div>
          <p className="tiny muted mb-3">Las tres comparten la contraseña «afirmative123».</p>
          <div className="stack-sm">
            {DEMO_ACCOUNTS.map((account) => (
              <button
                key={account.email}
                type="button"
                className="btn btn-sm"
                onClick={() => {
                  setEmail(account.email);
                  setPassword('afirmative123');
                }}
              >
                {account.name} · {account.email}
              </button>
            ))}
          </div>
        </div>
      </div>
    </main>
  );
}
