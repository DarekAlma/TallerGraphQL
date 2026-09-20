/**
 * Cascaron de la aplicacion: barra superior, rutas y el inspector Zero-REST.
 *
 * El contador del carrito de la barra superior se alimenta con `useQuery` de
 * `ActiveCart`. Como la cache de Apollo es unica y normalizada, cuando
 * cualquier mutation devuelve el carrito actualizado, Apollo lo fusiona por su
 * `id` y ESTE contador se repinta solo, sin que la barra superior sepa nada de
 * quien hizo el cambio ni tenga que refrescar por su cuenta.
 */
import { useEffect, useState } from 'react';
import { NavLink, Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import { useQuery } from '@apollo/client/react';
import { ACTIVE_CART, ME } from './graphql/operations';
import { clearSession, getStoredPatient, getStoredToken } from './state/session';
import { apolloClient } from './apollo/client';
import { ZeroRestInspector } from './components/ZeroRestInspector';
import { CatalogPage } from './pages/CatalogPage';
import { MedicationDetailPage } from './pages/MedicationDetailPage';
import { CartPage } from './pages/CartPage';
import { OrderPage } from './pages/OrderPage';
import { OrdersPage } from './pages/OrdersPage';
import { SignInPage } from './pages/SignInPage';
import type { Cart } from './types';

function TopBar() {
  const navigate = useNavigate();
  const [patient, setPatient] = useState(getStoredPatient());
  const hasSession = !!getStoredToken();

  // `me` valida contra el servidor que el token siga vivo. Si caduco, el
  // servidor devuelve null y limpiamos la sesion local.
  const { data: meData } = useQuery<{ me: { id: string; fullName: string; email: string } | null }>(ME, {
    skip: !hasSession,
  });

  const { data: cartData } = useQuery<{ activeCart: Cart | null }>(ACTIVE_CART, { skip: !hasSession });

  useEffect(() => {
    if (hasSession && meData && meData.me === null) {
      clearSession();
      setPatient(null);
    }
  }, [meData, hasSession]);

  const units = cartData?.activeCart?.unitsCount ?? 0;

  async function signOut() {
    clearSession();
    setPatient(null);
    // Se vacia la cache al cerrar sesion: los datos del paciente anterior no
    // deben quedar accesibles para el siguiente.
    await apolloClient.clearStore();
    navigate('/');
  }

  return (
    <header className="topbar">
      <NavLink to="/" className="brand">
        <span className="brand-mark">✚</span>
        <span>
          Afirmative Pill
          <small>GraphQL · CQRS</small>
        </span>
      </NavLink>

      <nav className="nav">
        <NavLink to="/" end>
          Catálogo
        </NavLink>
        <NavLink to="/carrito">
          Carrito
          {units > 0 && <span className="cart-count">{units}</span>}
        </NavLink>
        <NavLink to="/pedidos">Mis pedidos</NavLink>

        {hasSession ? (
          <div className="row" style={{ marginLeft: 12, gap: 8 }}>
            <span className="tiny muted">{meData?.me?.fullName ?? patient?.fullName ?? ''}</span>
            <button className="btn btn-sm" onClick={signOut}>
              Salir
            </button>
          </div>
        ) : (
          <NavLink to="/entrar" style={{ marginLeft: 8 }}>
            <span className="btn btn-sm btn-primary">Iniciar sesión</span>
          </NavLink>
        )}
      </nav>
    </header>
  );
}

export function App() {
  return (
    <div className="app">
      <TopBar />
      <Routes>
        <Route path="/" element={<CatalogPage />} />
        <Route path="/medicamento/:id" element={<MedicationDetailPage />} />
        <Route path="/carrito" element={<CartPage />} />
        <Route path="/pedidos" element={<OrdersPage />} />
        <Route path="/pedidos/:id" element={<OrderPage />} />
        <Route path="/entrar" element={<SignInPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      <ZeroRestInspector />
    </div>
  );
}
