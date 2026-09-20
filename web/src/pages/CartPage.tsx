/**
 * ============================================================================
 *  ESCENARIO B · Creacion del pedido y control de prescripcion
 * ============================================================================
 *
 * La pieza interesante de esta pantalla es `cart.blockers`.
 *
 * El servidor evalua las invariantes de negocio en el LADO DE LECTURA usando
 * exactamente la misma funcion de dominio que despues usara el comando
 * `placeOrder`. Por eso la interfaz puede:
 *
 *   · deshabilitar el boton de confirmar,
 *   · explicar con precision que falta (que fórmula, cuántas unidades),
 *   · y garantizar que su veredicto coincidira con el del servidor.
 *
 * No hay reglas de negocio duplicadas en el navegador. El navegador solo pinta
 * lo que el dominio ya decidio. Si alguien saltara la interfaz y lanzara la
 * mutation a mano, el comando volveria a validarlo todo dentro de la
 * transaccion y lo rechazaria igual.
 */
import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQuery } from '@apollo/client/react';
import {
  ACTIVE_CART,
  ATTACH_PRESCRIPTION,
  CHANGE_CART_LINE_QUANTITY,
  MY_ORDERS,
  PLACE_ORDER,
  REMOVE_MEDICATION_FROM_CART,
} from '../graphql/operations';
import { getStoredToken } from '../state/session';
import { DispensingBadge, DomainErrors, Empty } from '../components/ui';
import type { Cart, DomainError } from '../types';

export function CartPage() {
  const navigate = useNavigate();
  const hasSession = !!getStoredToken();

  const [address, setAddress] = useState('Calle 127 #15-45, Apto 302, Bogotá D.C.');
  const [notes, setNotes] = useState('');
  const [prescriptionFor, setPrescriptionFor] = useState<string | null>(null);
  const [errors, setErrors] = useState<DomainError[]>([]);

  const { data, loading } = useQuery<{ activeCart: Cart | null }>(ACTIVE_CART, { skip: !hasSession });
  const cart = data?.activeCart ?? null;

  const [changeQuantity, { loading: changing }] = useMutation(CHANGE_CART_LINE_QUANTITY);
  const [removeLine, { loading: removing }] = useMutation(REMOVE_MEDICATION_FROM_CART);
  const [placeOrder, { loading: placing }] = useMutation(PLACE_ORDER, {
    // Tras emitir la orden, el carrito queda CHECKED_OUT y nace una orden
    // nueva: ambas consultas deben rehacerse.
    refetchQueries: [{ query: ACTIVE_CART }, { query: MY_ORDERS, variables: { first: 10 } }],
  });

  if (!hasSession) {
    return (
      <main className="container container-narrow">
        <Empty icon="🔒" title="Inicia sesión para ver tu carrito">
          <Link to="/entrar">Ir a iniciar sesión</Link>
        </Empty>
      </main>
    );
  }

  if (loading && !cart) {
    return (
      <main className="container container-narrow">
        <div className="skeleton" style={{ height: 260 }} />
      </main>
    );
  }

  if (!cart || cart.lines.length === 0) {
    return (
      <main className="container container-narrow">
        <Empty icon="🛒" title="Tu carrito está vacío">
          <Link to="/">Explorar el catálogo</Link>
        </Empty>
      </main>
    );
  }

  async function onPlaceOrder(event: FormEvent) {
    event.preventDefault();
    if (!cart) return;
    setErrors([]);

    const result = await placeOrder({
      variables: {
        input: {
          cartId: cart.id,
          // El total aceptado viaja en el comando: si cambio mientras el
          // paciente decidia, el servidor rechaza en vez de cobrar otra cifra.
          acceptedTotal: cart.subtotal.amount,
          deliveryAddress: address,
          notes: notes || null,
        },
      },
    });

    const payload: any = (result.data as any)?.placeOrder;
    if (payload?.success && payload.order) {
      // Se navega al seguimiento con la orden recien confirmada. Alli veremos
      // la proyeccion "sincronizando" y como se completa sola.
      navigate(`/pedidos/${payload.order.id}`);
    } else {
      setErrors(payload?.errors ?? []);
    }
  }

  const pending = cart.prescriptionRequirements.filter((requirement) => !requirement.satisfied);

  return (
    <main className="container">
      <h1 className="page-title mb-3">Tu pedido</h1>

      <div className="cart-layout">
        <section className="stack">
          {/* --------------------------- Lineas --------------------------- */}
          <div className="card card-pad">
            {cart.lines.map((line) => (
              <div className="cart-line" key={line.id}>
                <div>
                  <div className="row wrap" style={{ gap: 7 }}>
                    <Link to={`/medicamento/${line.medication.id}`} style={{ fontWeight: 650 }}>
                      {line.medication.name}
                    </Link>
                    <DispensingBadge requiresPrescription={line.medication.requiresPrescription} />
                  </div>
                  <div className="tiny muted">
                    {line.medication.presentation} · {line.unitPrice.formatted} c/u
                  </div>
                  {line.stockWarning && (
                    <div className="tiny" style={{ color: 'var(--warn)', marginTop: 3 }}>
                      ⚠ {line.stockWarning}
                    </div>
                  )}
                </div>

                <div className="qty">
                  <button
                    disabled={changing || line.quantity <= 1}
                    onClick={() =>
                      changeQuantity({
                        variables: {
                          input: {
                            cartId: cart.id,
                            medicationId: line.medication.id,
                            quantity: line.quantity - 1,
                          },
                        },
                      })
                    }
                  >
                    −
                  </button>
                  <span>{line.quantity}</span>
                  <button
                    disabled={changing || line.quantity >= line.medication.stock}
                    onClick={() =>
                      changeQuantity({
                        variables: {
                          input: {
                            cartId: cart.id,
                            medicationId: line.medication.id,
                            quantity: line.quantity + 1,
                          },
                        },
                      })
                    }
                  >
                    +
                  </button>
                </div>

                <div style={{ textAlign: 'right', minWidth: 110 }}>
                  <div style={{ fontWeight: 700 }}>{line.subtotal.formatted}</div>
                  <button
                    className="btn btn-sm btn-ghost tiny"
                    style={{ color: 'var(--danger)' }}
                    disabled={removing}
                    onClick={() =>
                      removeLine({
                        variables: { input: { cartId: cart.id, medicationId: line.medication.id } },
                      })
                    }
                  >
                    quitar
                  </button>
                </div>
              </div>
            ))}
          </div>

          {/* ------------------- Requisitos regulatorios ------------------- */}
          {cart.prescriptionRequirements.length > 0 && (
            <div className="card card-pad">
              <div className="section-title">Fórmulas médicas requeridas</div>
              <p className="tiny muted mb-3">
                Estos medicamentos son de venta bajo prescripción. El comando <code>placeOrder</code> no
                aceptará el pedido sin su soporte.
              </p>

              <div className="stack-sm">
                {cart.prescriptionRequirements.map((requirement) => (
                  <div key={requirement.medication.id} className="stack-sm">
                    <div className="row-between">
                      <div>
                        <div style={{ fontWeight: 600 }}>{requirement.medication.name}</div>
                        {requirement.prescription && (
                          <div className="tiny muted">
                            Dr(a). {requirement.prescription.doctorName} · Reg.{' '}
                            {requirement.prescription.doctorLicense} · {requirement.prescription.issuedAt}
                          </div>
                        )}
                      </div>
                      {requirement.satisfied ? (
                        <span className="badge badge-otc">✓ Adjuntada</span>
                      ) : (
                        <button
                          className="btn btn-sm btn-accent"
                          onClick={() =>
                            setPrescriptionFor(
                              prescriptionFor === requirement.medication.id ? null : requirement.medication.id,
                            )
                          }
                        >
                          Adjuntar fórmula
                        </button>
                      )}
                    </div>

                    {prescriptionFor === requirement.medication.id && (
                      <PrescriptionForm
                        cartId={cart.id}
                        medicationId={requirement.medication.id}
                        medicationName={requirement.medication.name}
                        onDone={() => setPrescriptionFor(null)}
                      />
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </section>

        {/* --------------------------- Resumen --------------------------- */}
        <aside className="card card-pad" style={{ position: 'sticky', top: 82 }}>
          <div className="section-title">Resumen</div>

          <div className="summary-row">
            <span className="muted">Medicamentos</span>
            <span>{cart.itemCount}</span>
          </div>
          <div className="summary-row">
            <span className="muted">Unidades</span>
            <span>{cart.unitsCount}</span>
          </div>
          <div className="summary-row summary-total">
            <span>Total</span>
            <span>{cart.subtotal.formatted}</span>
          </div>

          {/* Los bloqueos vienen del servidor, evaluados por el dominio. */}
          {cart.blockers.length > 0 && (
            <div className="mt-3">
              <DomainErrors errors={cart.blockers} title="Falta algo antes de confirmar" />
            </div>
          )}

          {errors.length > 0 && (
            <div className="mt-3">
              <DomainErrors errors={errors} title="El comando fue rechazado" />
            </div>
          )}

          <form onSubmit={onPlaceOrder} className="mt-3">
            <div className="field">
              <label htmlFor="address">Dirección de despacho</label>
              <input
                id="address"
                className="input"
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                required
              />
            </div>
            <div className="field">
              <label htmlFor="notes">Notas (opcional)</label>
              <input
                id="notes"
                className="input"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Indicaciones para el domiciliario"
              />
            </div>

            <button
              className="btn btn-primary btn-block"
              disabled={!cart.readyForCheckout || placing || pending.length > 0}
            >
              {placing ? 'Procesando comando…' : 'Confirmar pedido'}
            </button>

            <p className="tiny faint mt-2 center">
              {cart.readyForCheckout
                ? 'Todas las invariantes se cumplen.'
                : 'El servidor bloquea la emisión hasta resolver lo anterior.'}
            </p>
          </form>
        </aside>
      </div>
    </main>
  );
}

/* -------------------------------------------------------------------------- */
/* Formulario de formula medica                                                */
/* -------------------------------------------------------------------------- */

/**
 * Comando `attachPrescription`.
 *
 * El servidor valida el formato del registro medico y la vigencia de la
 * formula (no futura, no mayor de 180 dias). Si algo falla, lo devuelve como
 * `ValidationError` tipado con el campo exacto que lo provoco.
 */
function PrescriptionForm({
  cartId,
  medicationId,
  medicationName,
  onDone,
}: {
  cartId: string;
  medicationId: string;
  medicationName: string;
  onDone: () => void;
}) {
  const [doctorName, setDoctorName] = useState('');
  const [doctorLicense, setDoctorLicense] = useState('');
  const [issuedAt, setIssuedAt] = useState(new Date().toISOString().slice(0, 10));
  const [errors, setErrors] = useState<DomainError[]>([]);

  const [attach, { loading }] = useMutation(ATTACH_PRESCRIPTION);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setErrors([]);

    const result = await attach({
      variables: { input: { cartId, medicationId, doctorName, doctorLicense, issuedAt } },
    });

    const payload: any = (result.data as any)?.attachPrescription;
    if (payload?.success) onDone();
    else setErrors(payload?.errors ?? []);
  }

  return (
    <form
      onSubmit={onSubmit}
      className="card-pad"
      style={{ background: 'var(--surface-2)', borderRadius: 'var(--radius-sm)' }}
    >
      <div className="tiny muted mb-3">
        Fórmula médica para <b>{medicationName}</b>
      </div>

      <div className="field">
        <label>Médico prescriptor</label>
        <input
          className="input"
          value={doctorName}
          onChange={(e) => setDoctorName(e.target.value)}
          placeholder="Camila Restrepo"
          required
        />
      </div>

      <div className="field">
        <label>Registro médico</label>
        <input
          className="input"
          value={doctorLicense}
          onChange={(e) => setDoctorLicense(e.target.value)}
          placeholder="RM-88421"
          required
        />
        <span className="hint">Mínimo 5 caracteres alfanuméricos. El servidor valida el formato.</span>
      </div>

      <div className="field">
        <label>Fecha de expedición</label>
        <input
          className="input"
          type="date"
          value={issuedAt}
          onChange={(e) => setIssuedAt(e.target.value)}
          required
        />
        <span className="hint">No puede ser futura ni tener más de 180 días.</span>
      </div>

      {errors.length > 0 && (
        <div className="mb-3">
          <DomainErrors errors={errors} />
        </div>
      )}

      <div className="row">
        <button className="btn btn-sm btn-primary" disabled={loading}>
          {loading ? 'Enviando…' : 'Adjuntar'}
        </button>
        <button type="button" className="btn btn-sm btn-ghost" onClick={onDone}>
          Cancelar
        </button>
      </div>
    </form>
  );
}
