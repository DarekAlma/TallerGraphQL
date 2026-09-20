/**
 * ESCENARIO A (segunda historia) · Ficha detallada del medicamento.
 *
 * Aqui SI se pide todo: laboratorio, categoria, indicaciones, regimen de
 * dispensacion y alternativas terapeuticas. Es el contraste exacto con la
 * vista condensada del listado: misma API, misma entidad, distinta seleccion
 * de campos segun lo que la pantalla necesita de verdad.
 *
 * En el servidor, resolver `category`, `manufacturer` y las 4 alternativas
 * cuesta 4 consultas gracias a los DataLoaders.
 */
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery } from '@apollo/client/react';
import { ACTIVE_CART, ADD_MEDICATION_TO_CART, CREATE_CART, MEDICATION_DETAIL } from '../graphql/operations';
import { getStoredToken } from '../state/session';
import { AvailabilityBadge, DispensingBadge, DomainErrors, Empty } from '../components/ui';
import { useState } from 'react';
import type { Cart, DomainError, Medication } from '../types';

export function MedicationDetailPage() {
  const { id } = useParams<{ id: string }>();
  const hasSession = !!getStoredToken();
  const [quantity, setQuantity] = useState(1);
  const [errors, setErrors] = useState<DomainError[]>([]);

  const { data, loading } = useQuery<{ medication: Medication | null }>(MEDICATION_DETAIL, {
    variables: { id },
  });

  const { data: cartData } = useQuery<{ activeCart: Cart | null }>(ACTIVE_CART, { skip: !hasSession });
  const activeCart = cartData?.activeCart ?? null;

  const [createCart, { loading: creating }] = useMutation(CREATE_CART, {
    refetchQueries: [{ query: ACTIVE_CART }],
  });
  const [addToCart, { loading: adding }] = useMutation(ADD_MEDICATION_TO_CART);

  const medication = data?.medication;

  async function handleAdd() {
    if (!medication) return;
    setErrors([]);

    const result = activeCart
      ? await addToCart({ variables: { input: { cartId: activeCart.id, medicationId: medication.id, quantity } } })
      : await createCart({ variables: { input: { medicationId: medication.id, quantity } } });

    const payload: any = activeCart
      ? (result.data as any)?.addMedicationToCart
      : (result.data as any)?.createCart;

    if (payload && !payload.success) setErrors(payload.errors ?? []);
  }

  if (loading && !medication) {
    return (
      <main className="container container-narrow">
        <div className="skeleton" style={{ height: 320 }} />
      </main>
    );
  }

  if (!medication) {
    return (
      <main className="container container-narrow">
        <Empty icon="💊" title="Medicamento no encontrado">
          <Link to="/">Volver al catálogo</Link>
        </Empty>
      </main>
    );
  }

  return (
    <main className="container container-narrow">
      <Link to="/" className="tiny muted">
        ← Volver al catálogo
      </Link>

      <div className="card card-pad mt-3">
        <div className="row-between wrap">
          <div>
            <span className="mono faint">{medication.sku}</span>
            <h1 className="page-title mt-2">{medication.name}</h1>
            <p className="page-sub">
              {medication.activeIngredient} · {medication.dosage}
            </p>
          </div>
          <div className="stack-sm" style={{ textAlign: 'right' }}>
            <div style={{ fontSize: 28, fontWeight: 700, color: 'var(--brand-dark)' }}>
              {medication.price.formatted}
            </div>
            <AvailabilityBadge availability={medication.availability} stock={medication.stock} />
          </div>
        </div>

        <div className="row wrap mt-3" style={{ gap: 6 }}>
          <DispensingBadge requiresPrescription={medication.requiresPrescription} />
          {medication.category && <span className="badge badge-neutral">{medication.category.name}</span>}
          {medication.manufacturer && (
            <span className="badge badge-info">{medication.manufacturer.name}</span>
          )}
        </div>

        {medication.requiresPrescription && (
          <div className="alert alert-warn mt-3">
            <span>℞</span>
            <div>
              <strong>Requiere fórmula médica</strong>
              Podrás agregarlo al carrito, pero el pedido no se emitirá hasta que adjuntes la prescripción.
              Esa regla la aplica el servidor dentro de la transacción, no el navegador.
            </div>
          </div>
        )}

        {medication.description && (
          <div className="mt-3">
            <div className="section-title">Indicaciones</div>
            <p className="muted">{medication.description}</p>
          </div>
        )}

        <div className="grid mt-4" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))' }}>
          <Fact label="Presentación" value={medication.presentation} />
          <Fact label="Concentración" value={medication.dosage ?? '—'} />
          <Fact label="Laboratorio" value={medication.manufacturer?.name ?? '—'} />
          <Fact
            label="Categoría"
            value={`${medication.category?.name ?? '—'}${
              medication.category?.medicationCount ? ` (${medication.category.medicationCount} productos)` : ''
            }`}
          />
        </div>

        {errors.length > 0 && (
          <div className="mt-3">
            <DomainErrors errors={errors} />
          </div>
        )}

        <div className="row mt-4">
          <div className="qty">
            <button onClick={() => setQuantity((q) => Math.max(1, q - 1))} disabled={quantity <= 1}>
              −
            </button>
            <span>{quantity}</span>
            <button onClick={() => setQuantity((q) => q + 1)} disabled={quantity >= medication.stock}>
              +
            </button>
          </div>
          <button
            className="btn btn-primary"
            disabled={medication.availability === 'OUT_OF_STOCK' || adding || creating || !hasSession}
            onClick={handleAdd}
          >
            {hasSession ? 'Agregar al carrito' : 'Inicia sesión para comprar'}
          </button>
        </div>
      </div>

      {medication.relatedMedications && medication.relatedMedications.length > 0 && (
        <section className="mt-4">
          <div className="section-title">
            Alternativas en {medication.category?.name}
            <span className="tiny faint" style={{ fontWeight: 400, marginLeft: 8 }}>
              (resolver anidado de segundo nivel, agrupado por DataLoader)
            </span>
          </div>
          <div className="med-grid">
            {medication.relatedMedications.map((related) => (
              <Link key={related.id} to={`/medicamento/${related.id}`} className="med-card">
                <span className="sku">{related.sku}</span>
                <span className="name">{related.name}</span>
                <span className="presentation">{related.presentation}</span>
                <div className="spacer" />
                <span className="price">{related.price.formatted}</span>
              </Link>
            ))}
          </div>
        </section>
      )}
    </main>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="tiny faint">{label}</div>
      <div style={{ fontWeight: 550 }}>{value}</div>
    </div>
  );
}
