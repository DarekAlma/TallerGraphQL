/**
 * ============================================================================
 *  ESCENARIO A · Exploracion eficiente de farmacos
 * ============================================================================
 *
 * Tres cosas de esta pantalla merecen atencion durante la sustentacion:
 *
 * 1. CONMUTADOR DE VISTA (condensada / completa)
 *    El mismo campo `medications` se consulta con DOS documentos distintos.
 *    En la pestana Network se ve como la respuesta cambia de tamano —y en el
 *    log del servidor, como cambia el numero de consultas SQL— sin tocar una
 *    linea del backend. Es la demostracion mas directa contra el over-fetching
 *    y contra el problema N+1 a la vez.
 *
 * 2. FACETAS EN LA MISMA PETICION
 *    El panel de filtros muestra conteos reales. Bajo REST harian falta
 *    llamadas adicionales a /categories y /manufacturers; aqui vienen dentro
 *    de la propia consulta del catalogo.
 *
 * 3. INVENTARIO EN VIVO
 *    La Subscription `stockChanged` vive en la raiz (`LiveInventory`) y
 *    escribe el stock en la cache con `cache.modify`. Como las tarjetas leen
 *    la misma entidad `Medication:<id>`, si otro paciente compra la tarjeta
 *    cambia sola: sin refetch y sin recargar la pagina.
 *
 * 4. FILTRAR SIN PARPADEOS
 *    Al cambiar un filtro, las variables de la query cambian y `data` queda
 *    vacio hasta que responde el servidor. En lugar de vaciar la rejilla y
 *    mostrar el esqueleto de carga, se sigue pintando `previousData` (el
 *    resultado anterior) atenuado, con un indicador de "actualizando". La
 *    respuesta nueva reemplaza a la vieja en cuanto llega.
 */
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery } from '@apollo/client/react';
import {
  ACTIVE_CART,
  ADD_MEDICATION_TO_CART,
  CATALOG_FACETS,
  CREATE_CART,
  MEDICATIONS_CONDENSED,
  MEDICATIONS_FULL,
} from '../graphql/operations';
import { writeActiveCart } from '../apollo/cacheUpdates';
import { getStoredToken } from '../state/session';
import { AvailabilityBadge, CardSkeleton, DispensingBadge, DomainErrors, Empty } from '../components/ui';
import type { Cart, CatalogFacets, DomainError, Medication, MedicationConnection } from '../types';

type ViewMode = 'condensed' | 'full';

const PAGE_SIZE = 12;

const SORT_OPTIONS = [
  { value: 'NAME:ASC', label: 'Nombre (A–Z)' },
  { value: 'PRICE:ASC', label: 'Precio: menor a mayor' },
  { value: 'PRICE:DESC', label: 'Precio: mayor a menor' },
  { value: 'STOCK:DESC', label: 'Mayor disponibilidad' },
  { value: 'RELEVANCE:DESC', label: 'Relevancia de búsqueda' },
];

export function CatalogPage() {
  const hasSession = !!getStoredToken();

  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [categories, setCategories] = useState<string[]>([]);
  const [manufacturerIds, setManufacturerIds] = useState<string[]>([]);
  const [dispensingRule, setDispensingRule] = useState<string>('');
  const [onlyAvailable, setOnlyAvailable] = useState(false);
  const [sortValue, setSortValue] = useState('NAME:ASC');
  const [view, setView] = useState<ViewMode>('condensed');

  /* Debounce del buscador: sin esto se dispararia una operacion GraphQL por
     cada tecla pulsada, que es precisamente lo que no queremos demostrar. */
  useEffect(() => {
    const timer = setTimeout(() => setSearch(searchInput), 320);
    return () => clearTimeout(timer);
  }, [searchInput]);

  const filter = useMemo(
    () => ({
      search: search || null,
      categories: categories.length > 0 ? categories : null,
      manufacturerIds: manufacturerIds.length > 0 ? manufacturerIds : null,
      dispensingRule: dispensingRule || null,
      onlyAvailable,
    }),
    [search, categories, manufacturerIds, dispensingRule, onlyAvailable],
  );

  const sort = useMemo(() => {
    const [field, direction] = sortValue.split(':');
    return { field, direction };
  }, [sortValue]);

  /* ---------------------- Consulta principal ---------------------- */
  // Un unico `useQuery` cuyo DOCUMENTO cambia segun la vista elegida.
  const { data, previousData, loading, error, fetchMore } = useQuery<{ medications: MedicationConnection }>(
    view === 'condensed' ? MEDICATIONS_CONDENSED : MEDICATIONS_FULL,
    { variables: { filter, sort, first: PAGE_SIZE } },
  );

  const { data: facetData, previousData: previousFacetData } = useQuery<{
    medications: { facets: CatalogFacets };
  }>(CATALOG_FACETS, { variables: { filter } });

  // Mientras llega la respuesta del filtro nuevo se sigue mostrando la anterior.
  const refreshing = loading && !data && !!previousData;

  /* ---------------------- Comandos de carrito ---------------------- */
  const { data: cartData } = useQuery<{ activeCart: Cart | null }>(ACTIVE_CART, { skip: !hasSession });
  const activeCart = cartData?.activeCart ?? null;

  // El carrito recien abierto viaja en la respuesta: se escribe como
  // `activeCart` en la cache en lugar de volver a pedirlo al servidor.
  const [createCart, { loading: creating }] = useMutation(CREATE_CART, {
    update: (cache, { data: result }) => writeActiveCart(cache, (result as any)?.createCart?.cart),
  });
  const [addToCart, { loading: adding }] = useMutation(ADD_MEDICATION_TO_CART);
  const [cartErrors, setCartErrors] = useState<DomainError[]>([]);

  async function handleAdd(medication: Medication) {
    setCartErrors([]);

    // Si aun no hay carrito abierto, el comando de apertura admite un primer
    // item; si ya existe, se usa el comando de adicion. Cada intencion tiene
    // su propio comando, que es justo lo que pide CQRS.
    const result = activeCart
      ? await addToCart({
          variables: { input: { cartId: activeCart.id, medicationId: medication.id, quantity: 1 } },
        })
      : await createCart({ variables: { input: { medicationId: medication.id, quantity: 1 } } });

    const payload: any = activeCart
      ? (result.data as any)?.addMedicationToCart
      : (result.data as any)?.createCart;

    if (payload && !payload.success) setCartErrors(payload.errors ?? []);
  }

  /* --------------------------- Paginacion -------------------------- */
  const connection = (data ?? previousData)?.medications;
  const canLoadMore = connection?.pageInfo?.hasNextPage ?? false;

  function loadMore() {
    if (!connection?.pageInfo.endCursor) return;
    // La `typePolicy` de `medications` concatena las paginas en la cache.
    void fetchMore({ variables: { after: connection.pageInfo.endCursor } });
  }

  const facets = (facetData ?? previousFacetData)?.medications?.facets;
  const activeFilters =
    categories.length + manufacturerIds.length + (dispensingRule ? 1 : 0) + (onlyAvailable ? 1 : 0);

  function toggle(list: string[], value: string, setter: (next: string[]) => void) {
    setter(list.includes(value) ? list.filter((v) => v !== value) : [...list, value]);
  }

  return (
    <main className="container">
      <div className="row-between mb-3">
        <div>
          <h1 className="page-title">Catálogo de medicamentos</h1>
          <p className="page-sub">
            {connection ? `${connection.totalCount} medicamentos` : 'Cargando…'}
            {activeFilters > 0 && ` · ${activeFilters} filtro(s) activo(s)`}
            {refreshing && ' · actualizando…'}
          </p>
        </div>
      </div>

      {/* ---------------- Barra de herramientas ---------------- */}
      <div className="toolbar">
        <div className="search-box" style={{ flex: 1, minWidth: 220 }}>
          <span className="icon">🔍</span>
          <input
            className="input"
            placeholder="Buscar por nombre comercial, principio activo o SKU…"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
          />
        </div>

        <select className="select" style={{ width: 'auto' }} value={sortValue} onChange={(e) => setSortValue(e.target.value)}>
          {SORT_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>

        {/* EL CONMUTADOR CLAVE PARA LA DEMOSTRACION */}
        <div className="seg" title="Cambia la selección de campos de la misma query">
          <button className={view === 'condensed' ? 'active' : ''} onClick={() => setView('condensed')}>
            Vista condensada
          </button>
          <button className={view === 'full' ? 'active' : ''} onClick={() => setView('full')}>
            Ficha completa
          </button>
        </div>
      </div>

      <div className="demo-note mb-3">
        {view === 'condensed' ? (
          <>
            Ejecutando <b>MedicationsCondensed</b>: se piden solo <b>nombre, precio, presentación y
            disponibilidad</b>. Los campos <b>category</b>, <b>manufacturer</b> y <b>relatedMedications</b> no se
            piden, así que sus resolvers ni siquiera se ejecutan en el servidor. Coste típico:{' '}
            <b>1 consulta SQL</b> (página y total en el mismo viaje).
          </>
        ) : (
          <>
            Ejecutando <b>MedicationsFull</b>: se piden además <b>category</b>, <b>manufacturer</b> y{' '}
            <b>relatedMedications</b>. Eso son 3 resolvers anidados × {PAGE_SIZE} medicamentos ={' '}
            <b>~45 consultas sin DataLoader</b>. Mira el log del backend: se resuelven en{' '}
            <b>6 consultas</b> (1 búsqueda + 5 lotes).
          </>
        )}
      </div>

      {cartErrors.length > 0 && (
        <div className="mb-3">
          <DomainErrors errors={cartErrors} />
        </div>
      )}

      <div className="catalog-layout">
        {/* ------------------- Panel de filtros ------------------- */}
        <aside className="card card-pad">
          <div className="row-between mb-3">
            <span className="section-title" style={{ marginBottom: 0 }}>
              Filtros
            </span>
            {activeFilters > 0 && (
              <button
                className="btn btn-sm btn-ghost"
                onClick={() => {
                  setCategories([]);
                  setManufacturerIds([]);
                  setDispensingRule('');
                  setOnlyAvailable(false);
                }}
              >
                limpiar
              </button>
            )}
          </div>

          <label className="check-row">
            <input type="checkbox" checked={onlyAvailable} onChange={(e) => setOnlyAvailable(e.target.checked)} />
            Solo disponibles
          </label>

          <div className="field mt-3">
            <label>Régimen de dispensación</label>
            <select className="select" value={dispensingRule} onChange={(e) => setDispensingRule(e.target.value)}>
              <option value="">Todos</option>
              <option value="OVER_THE_COUNTER">Venta libre (OTC)</option>
              <option value="PRESCRIPTION_REQUIRED">Con fórmula médica</option>
            </select>
          </div>

          <div className="section-title mt-3">Categoría terapéutica</div>
          <div style={{ maxHeight: 232, overflowY: 'auto' }}>
            {facets?.categories.map((facet) => (
              <label className="check-row" key={facet.category.id}>
                <input
                  type="checkbox"
                  checked={categories.includes(facet.category.code)}
                  onChange={() => toggle(categories, facet.category.code, setCategories)}
                />
                <span>{facet.category.name}</span>
                <span className="count">{facet.count}</span>
              </label>
            ))}
          </div>

          <div className="section-title mt-3">Laboratorio</div>
          <div style={{ maxHeight: 208, overflowY: 'auto' }}>
            {facets?.manufacturers.map((facet) => (
              <label className="check-row" key={facet.manufacturer.id}>
                <input
                  type="checkbox"
                  checked={manufacturerIds.includes(facet.manufacturer.id)}
                  onChange={() => toggle(manufacturerIds, facet.manufacturer.id, setManufacturerIds)}
                />
                <span>{facet.manufacturer.name}</span>
                <span className="count">{facet.count}</span>
              </label>
            ))}
          </div>

          {facets?.priceRange && (
            <div className="tiny faint mt-3">
              Rango de precios: {facets.priceRange.min.formatted} – {facets.priceRange.max.formatted}
            </div>
          )}
        </aside>

        {/* -------------------- Rejilla de resultados -------------------- */}
        <section>
          {error && (
            <div className="alert alert-error mb-3">
              <span>⚠️</span>
              <div>
                <strong>No se pudo cargar el catálogo</strong>
                {error.message}
              </div>
            </div>
          )}

          {loading && !connection && <CardSkeleton />}

          {connection && connection.nodes.length === 0 && (
            <Empty icon="🔍" title="Sin resultados">
              Prueba con otro término de búsqueda o retira algunos filtros.
            </Empty>
          )}

          <div className="med-grid" style={{ opacity: refreshing ? 0.55 : 1, transition: 'opacity 120ms' }}>
            {connection?.nodes.map((medication) => (
              <article key={medication.id} className="med-card">
                <div className="row-between">
                  <span className="sku">{medication.sku}</span>
                  <AvailabilityBadge availability={medication.availability} stock={medication.stock} />
                </div>

                <Link to={`/medicamento/${medication.id}`} className="name">
                  {medication.name}
                </Link>
                <div className="presentation">{medication.presentation}</div>

                <div className="badges">
                  <DispensingBadge requiresPrescription={medication.requiresPrescription} />
                  {medication.category && <span className="badge badge-neutral">{medication.category.name}</span>}
                </div>

                {/* Estos datos SOLO existen en la vista completa: es la prueba
                    visual de que la seleccion de campos cambia la respuesta. */}
                {view === 'full' && (
                  <div className="extra">
                    <div>
                      <b>Principio activo:</b> {medication.activeIngredient} · {medication.dosage}
                    </div>
                    <div>
                      <b>Laboratorio:</b> {medication.manufacturer?.name}
                    </div>
                    {medication.relatedMedications && medication.relatedMedications.length > 0 && (
                      <div className="faint">
                        Alternativas: {medication.relatedMedications.map((r) => r.name).join(', ')}
                      </div>
                    )}
                  </div>
                )}

                <div className="spacer" />

                <div className="row-between">
                  <span className="price">{medication.price.formatted}</span>
                  <button
                    className="btn btn-sm btn-primary"
                    disabled={medication.availability === 'OUT_OF_STOCK' || adding || creating || !hasSession}
                    title={!hasSession ? 'Inicia sesión para comprar' : undefined}
                    onClick={() => handleAdd(medication)}
                  >
                    Agregar
                  </button>
                </div>
              </article>
            ))}
          </div>

          {canLoadMore && (
            <div className="center mt-4">
              <button className="btn" onClick={loadMore} disabled={loading}>
                {loading ? 'Cargando…' : `Cargar más (${connection!.nodes.length} de ${connection!.totalCount})`}
              </button>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
