# Guion para el video de sustentación (5–8 minutos)

Guion pensado para que no tengas que improvisar. Cada bloque dice **qué mostrar**
en pantalla y **qué decir**, y está alineado con un criterio concreto de la
rúbrica.

---

## Antes de grabar · lista de verificación

```bash
# 1. Supabase activo (el plan gratuito pausa proyectos inactivos).
#    Entra al panel y confirma que el proyecto NO dice "paused".

# 2. Estado limpio del catálogo y el inventario
npm run db:setup --prefix server

# 3. Backend, con logs SQL encendidos
cd server && npm run dev

# 4. Frontend, en otra terminal
cd web && npm run dev
```

**Ajusta `server/.env` para grabar:**

```env
PROJECTION_DELAY_MS=2500   # que el banner "sincronizando" se vea con holgura
LOG_SQL=true               # evidencia del DataLoader
```

**Prepara el escritorio:**

- Navegador con dos pestañas: la app (`localhost:5173`) y el panel de Supabase.
- DevTools abierto en la pestaña **Network**, con el filtro escrito en **`graphql`**.
- La terminal del backend visible (media pantalla) o lista para alternar.
- Aumenta el tamaño de letra de la terminal: en un video comprimido, el log
  pequeño no se lee.
- Cierra notificaciones y pestañas que no uses.

---

## Bloque 0 · Presentación (0:00 – 0:30)

**Mostrar:** el catálogo ya cargado.

> «Afirmative Pill: e-commerce farmacéutico con arquitectura GraphQL y CQRS.
> Backend en Apollo Server con TypeScript, frontend en React con Apollo Client,
> y persistencia en PostgreSQL sobre Supabase con los 50 medicamentos del
> dataset. Dos restricciones guían todo el diseño: cero endpoints REST, y
> separación estricta entre el modelo de lectura y el de escritura.»

---

## Bloque 1 · Supabase y el dataset (0:30 – 1:10)

> *Criterio 4 · Persistencia en Supabase (15%)*

**Mostrar:** el panel de Supabase → **Table Editor** → tabla `medications`.

> «El dataset vive en PostgreSQL sobre Supabase. Cincuenta medicamentos.»

**Mostrar:** las tablas `categories` y `manufacturers`.

> «El Excel del taller venía como una tabla plana de doce columnas. Lo normalicé
> en tres tablas a propósito: al separar categoría y laboratorio en entidades
> propias, resolver esas relaciones en GraphQL genera el problema N+1 real, que
> es justo lo que la rúbrica pide mitigar. Sin esa normalización no habría nada
> que demostrar.»

**Mostrar rápido:** las tablas `domain_events` y `order_read_model`.

> «Y aquí están las dos piezas de CQRS: el log de eventos de dominio, y la tabla
> de proyección desnormalizada desde la que lee la aplicación.»

---

## Bloque 2 · Zero-REST (1:10 – 1:50)

> *Criterio 1 · Zero-REST*

**Mostrar:** DevTools → Network, filtro `graphql`. Recarga la página.

> «Todo el tráfico sale a un único endpoint: `/graphql`. No hay ni una llamada
> REST en toda la aplicación.»

**Mostrar:** navega al catálogo, busca algo, entra a una ficha. Señala que en
Network solo aparecen entradas `graphql`.

**Mostrar:** abre el **Inspector Zero-REST** (abajo a la derecha).

> «Añadí este panel porque en un video DevTools se ve pequeño y mezclado con las
> peticiones del propio Vite. Cuenta las operaciones por tipo —queries,
> mutations, subscriptions— y el contador de llamadas REST está en cero.»

**Opcional, muy efectivo (10 segundos):** en una pestaña nueva, entra a
`http://localhost:4000/api/medications`.

> «Y no es que simplemente no haya escrito endpoints REST: el servidor los
> rechaza. Cualquier ruta que no sea `/graphql` responde con este error.»

Se ve: `{"error":"ZERO_REST_MANDATE", ...}`

---

## Bloque 3 · Over-fetching y el schema (1:50 – 2:50)

> *Criterio 1 · Diseño e implementación de GraphQL (40%)*

**Mostrar:** el catálogo en **Vista condensada**. Señala el recuadro oscuro
explicativo.

> «El listado ejecuta una query que pide solo seis campos: nombre, precio,
> presentación y disponibilidad. Exactamente lo que la historia de usuario pide:
> no sobrecargar la conexión móvil con información clínica.»

**Mostrar:** en Network, clic en la petición → pestaña **Response**.

> «La respuesta trae exactamente esos campos. Ni uno más.»

**Mostrar:** pulsa **Ficha completa**. Mira la nueva petición en Network.

> «Mismo campo del schema, misma API, mismo backend. Solo cambió la selección de
> campos: ahora pido categoría, laboratorio y medicamentos relacionados. La
> respuesta crece varias veces. Bajo REST esto exigiría dos endpoints distintos,
> o devolver siempre todo.»

**Mostrar (opcional):** abre `server/src/graphql/schema.graphql` y baja por las
secciones.

> «El schema está dividido en dos mitades porque el contrato es donde se hace
> visible CQRS: arriba el lado de lectura, abajo los comandos. Tiene siete
> scalars personalizados que validan en el borde —`PositiveInt` impide pedir
> cero cajas sin ejecutar un solo resolver—, once enums, y una interfaz
> `DomainError` con seis implementaciones para que los errores de negocio viajen
> como datos tipados y no como excepciones.»

---

## Bloque 4 · DataLoader y el problema N+1 (2:50 – 3:40)

> *Criterio 1 · Mitigación del N+1 — **el video lo exige explícitamente***

**Mostrar:** la terminal del backend, grande y legible. Límpiala antes.

**Mostrar:** en la app, con la **Ficha completa** activa, recarga o cambia un
filtro para lanzar la query.

**Mostrar:** el log que aparece. Señala las líneas `BATCH` en magenta:

```
BATCH  DataLoader:categoryById — 8 claves resueltas en 1 sola consulta
       (sin DataLoader habrían sido 8 consultas)
BATCH  DataLoader:manufacturerById — 8 claves resueltas en 1 sola consulta
BATCH  DataLoader:medicationsByCategory — 8 claves resueltas en 1 sola consulta
──────── RESUMEN · MedicationsFull ────────
INFO   6 consultas SQL · 5 en lote resolvieron 40 claves
INFO   DataLoader evitó 35 consultas (habrían sido 41 sin batching)
```

> «Esta pantalla pide doce medicamentos con su categoría, su laboratorio y tres
> alternativas cada uno. Sin DataLoader serían más de sesenta viajes a
> Supabase: uno por la lista y uno por cada relación de cada fila. Ese es el
> problema N+1.
>
> DataLoader acumula todas esas peticiones durante el mismo tick del event loop
> y las resuelve con un único `WHERE id = ANY(...)`. Toda la pantalla se
> resuelve en seis consultas, y el propio servidor lo reporta.»

**Mostrar (opcional, 15 s):** `server/src/modules/catalog/catalog.loaders.ts`.

> «Un detalle importante: los loaders se crean dentro del contexto, es decir, uno
> nuevo por cada petición. Si fueran globales, la caché sobreviviría entre
> usuarios y un paciente podría ver el stock que ya cambió para otro.»

---

## Bloque 5 · Comandos e invariantes (3:40 – 5:00)

> *Criterio 2 · CQRS y modelo de dominio (25%)*

**Mostrar:** inicia sesión (`ana.gomez@correo.com` / `afirmative123`).

> «El login es una Mutation de GraphQL. El taller prohíbe autenticar por REST,
> así que no existe ningún `POST /login`: el token viaja por el mismo endpoint
> que todo lo demás.»

**Mostrar:** en el catálogo, agrega **Amoxicilina Clavulanato** (tiene el
distintivo ℞) y ve al carrito.

> «Este medicamento es de venta bajo fórmula médica.»

**Mostrar:** el panel de resumen, con «Falta algo antes de confirmar» y el
botón deshabilitado.

> «Fíjense en que el botón está bloqueado y el servidor explica por qué, con un
> error tipado `PrescriptionRequiredError` que nombra el medicamento concreto.
>
> Y esto es lo interesante: ese bloqueo lo calcula el campo `Cart.blockers`, en
> el lado de lectura, ejecutando **exactamente la misma función de dominio** que
> usará después el comando `placeOrder`. No hay reglas de negocio duplicadas en
> el navegador. El veredicto de la interfaz coincide con el del servidor porque
> es literalmente el mismo código.»

**Mostrar:** pulsa **Adjuntar fórmula**, escribe un registro inválido como `ab`
e intenta enviar.

> «El servidor valida el formato del registro médico y también la vigencia de la
> fórmula: no puede ser futura ni tener más de 180 días.»

**Mostrar:** ahora sí, `Camila Restrepo` / `RM-88421` / fecha de hoy → Adjuntar.

> «Ahora el carrito queda listo: `readyForCheckout` pasa a verdadero.»

**Mostrar (opcional, muy buen momento):** abre
`server/src/modules/ordering/ordering.commands.ts` en `placeOrder`.

> «El comando ocurre todo dentro de una transacción: bloquea el carrito, bloquea
> las filas de inventario con `FOR UPDATE` ordenadas por id para evitar
> interbloqueos, evalúa las invariantes, descuenta el stock con una guarda
> `stock >= cantidad`, crea la orden y anexa el evento de dominio. Si algo falla,
> `ROLLBACK`: no se descuenta inventario, no se crea orden, no se emite evento.»

---

## Bloque 6 · Consistencia eventual y tiempo real (5:00 – 6:30)

> *Criterio 2 · Consistencia eventual · Criterio 3 · Apollo Client*

**Mostrar:** pulsa **Confirmar pedido**. **No cortes aquí**: esta es la parte
más importante del video.

**Se verá:** la pantalla del pedido con el banner amarillo y el spinner
*«Sincronizando la proyección de lectura»*.

> «Miren lo que acaba de pasar. El comando ya confirmó: la orden existe y el
> inventario está reservado en el modelo de escritura. Pero la consulta devuelve
> `OrderProjectionPending`, no un error ni una pantalla vacía.
>
> Esta es la respuesta a la pregunta del taller: *¿qué ve el usuario mientras la
> orden se valida?* Ve un estado transitorio que el schema modela
> explícitamente, con el estado ya confirmado por el write model, mientras el
> proyector reconstruye la tabla de lectura.»

**Se verá (a los ~2.5 s):** el banner se vuelve verde y la pantalla se completa.

> «Y ahí está. La proyección llegó por Subscription, con el retraso real medido:
> `lag` en milisegundos, versión del agregado y número de evento. No escondemos
> el desfase, lo exponemos.»

**Mostrar:** la caja **«Eventos recibidos por WebSocket»**.

**Mostrar:** pulsa **Verificar fórmulas y aprobar**.

> «Cada botón es un comando distinto, no un `update` genérico.»

**Se verá:** la etiqueta pasa a «Aprobada», aparece un nuevo evento WebSocket
`PENDING_APPROVAL → APPROVED`, la versión de la proyección sube a 2.

> «La pantalla se actualizó sin ningún refetch. El evento trae la proyección
> completa dentro, y como Apollo Client normaliza por `__typename` más `id`, la
> fusiona sola con la que ya tenía en caché.»

**Mostrar:** pulsa **Despachar**. Luego intenta **Anular**.

> «Y la máquina de estados del dominio decide qué comandos son válidos. Una orden
> ya despachada es terminal: si forzamos la anulación, el servidor responde con
> un `ConflictError` que dice el estado actual y la transición intentada.»

**Mostrar:** baja hasta el **Historial del pedido**.

> «El historial no se guarda en una tabla aparte: se reconstruye desde el log de
> eventos de dominio, la misma fuente que produjo cada cambio. Por eso no puede
> desincronizarse.»

---

## Bloque 7 · Cierre (6:30 – 7:15)

**Mostrar:** vuelve al catálogo y busca el medicamento que compraste.

> «Y el inventario bajó. El catálogo escucha una Subscription de movimientos de
> stock y actualiza la caché de Apollo campo por campo, sin recargar la página.»

**Mostrar:** el Inspector Zero-REST abierto, con los contadores finales.

> «Cerrando: todas las operaciones del recorrido completo —catálogo, selección,
> carrito, mutación y consulta de la orden proyectada— pasaron por `/graphql`.
> Cero llamadas REST.
>
> El schema tiene siete scalars personalizados, once enums, dos interfaces y una
> unión. Los comandos protegen dos invariantes farmacéuticas dentro de
> transacciones atómicas. El lado de lectura vive en una proyección
> desnormalizada alimentada por eventos, con la consistencia eventual medida y
> expuesta en la interfaz. Y el DataLoader reduce cuarenta y cinco consultas a
> siete.»

---

## Si te sobra tiempo (extras de alto impacto)

| Extra | Qué mostrar | Cuánto dura |
|---|---|---|
| **Stock atómico** | Pon un medicamento en el carrito con cantidad mayor a su stock. Sale `InsufficientStockError` con `requested` y `available`, y la UI sugiere la cantidad exacta que sí cabe. | 20 s |
| **Anulación** | Anula un pedido `PENDING_APPROVAL` y muestra en Supabase que el stock volvió a subir. | 25 s |
| **Aislamiento** | Cierra sesión, entra como Carlos y pega la URL del pedido de Ana: devuelve `NotFoundError`. | 20 s |
| **Apollo Sandbox** | Abre `localhost:4000/graphql` y recorre el schema autodocumentado. | 25 s |
| **Scalar en acción** | En Sandbox, manda `quantity: 0`. Se rechaza antes de tocar la base. | 15 s |

---

## Errores a evitar al grabar

1. **No dejes el retraso de proyección en 0.** Perderías la demostración más
   valiosa del video (el estado `CATCHING_UP`).
2. **No grabes con `LOG_SQL=false`.** El log del DataLoader es evidencia
   explícitamente exigida.
3. **No filtres Network por «XHR» a secas.** Filtra por la palabra `graphql`
   para que no aparezcan los módulos de Vite y se vea limpio.
4. **No olvides revisar que Supabase no esté pausado.** Es el fallo más molesto
   que puede aparecer a mitad de grabación.
5. **No corras.** Es mejor cubrir bien los bloques 3, 4 y 6 —que concentran el
   65% de la nota— que enseñarlo todo a medias.
