# Guía paso a paso: cargar el dataset en Supabase y conectarlo al proyecto

Esta guía te lleva desde «no tengo nada» hasta «el backend está leyendo los 50
medicamentos desde Supabase». No asume conocimiento previo de Supabase.

Al final hay una sección de **problemas frecuentes** con los errores exactos que
te pueden salir y cómo resolverlos.

---

## 0. Qué vamos a hacer (y por qué)

El taller exige que los datos vivan en **PostgreSQL alojado en Supabase**.
Supabase es, en esencia, una base de datos PostgreSQL gestionada en la nube con
un panel web encima.

El dataset del taller viene como un `.xlsx` de una sola hoja con 12 columnas y
50 filas. **No vamos a subir el Excel tal cual.** En su lugar:

1. Ya convertí ese Excel a SQL (`db/02_seed_catalog.sql`), normalizándolo en
   tres tablas relacionadas.
2. Tú solo ejecutas tres archivos SQL en Supabase.

### ¿Por qué no subir el Excel directamente?

Supabase tiene un importador de CSV, pero importar la tabla plana tiene dos
problemas para este taller:

- **Pierdes las relaciones.** La columna `category` sería texto repetido 50
  veces. Con una tabla `categories` aparte, `medications.category_id` apunta a
  ella, y resolver `medication.category` en GraphQL se convierte en el problema
  N+1 que la rúbrica pide mitigar. Sin esa normalización **no hay nada que
  demostrar con DataLoader**.
- **Pierdes los tipos y los índices.** El importador adivina tipos y no crea
  ninguna restricción. Nuestro SQL declara `CHECK (stock >= 0)` —la última
  defensa contra vender inventario que no existe— y ocho índices.

El dataset original está íntegro: los 50 medicamentos, con sus mismos nombres,
precios, stock y banderas de fórmula médica. Solo cambia cómo se guardan.

---

## 1. Crear la cuenta y el proyecto

1. Entra a **<https://supabase.com>** y pulsa **Start your project**. Puedes
   registrarte con GitHub o con correo. El plan gratuito sobra para el taller.

2. Ya dentro, pulsa **New project** y rellena:

   | Campo | Qué poner |
   |---|---|
   | **Name** | `afirmative-pill` |
   | **Database Password** | Genera una y **cópiala a un lugar seguro ahora mismo**. Supabase no vuelve a mostrarla. |
   | **Region** | La más cercana a ti (por ejemplo `South America (São Paulo)` o `East US`). |
   | **Plan** | Free |

   > **Consejo sobre la contraseña:** evita los caracteres `@ : / ? # [ ] %`.
   > La contraseña va dentro de una URL de conexión y esos caracteres hay que
   > escaparlos, lo que es una fuente típica de errores. Una contraseña larga
   > de letras, números y guiones te ahorra el problema.

3. Espera 1-2 minutos a que el proyecto se aprovisione.

---

## 2. Ejecutar los tres archivos SQL

En el menú lateral izquierdo busca el icono de **SQL Editor** (`</>`).

Vas a ejecutar **tres archivos, en este orden exacto**. Para cada uno:

1. Pulsa **New query**.
2. Abre el archivo en tu editor, selecciona **todo** el contenido y cópialo.
3. Pégalo en el editor de Supabase.
4. Pulsa **Run** (o `Ctrl+Enter`).

### Archivo 1 · `db/01_schema.sql`

Crea todas las tablas, los índices y las extensiones.

- **Qué esperar:** `Success. No rows returned`.
- **Tiempo:** ~2 segundos.

Este archivo crea tres zonas claramente separadas (están comentadas dentro):
el **catálogo** (lado lectura), el **write model** (carritos, órdenes,
prescripciones) y el **event store + read model** (proyecciones CQRS).

### Archivo 2 · `db/02_seed_catalog.sql`

Carga los 50 medicamentos, las 14 categorías y los 16 laboratorios.

- **Qué esperar:** una tabla de resultado con estos números exactos:

  | medicamentos | categorias | laboratorios | con_formula_medica |
  |---|---|---|---|
  | 50 | 14 | 16 | 27 |

Si ves esos cuatro números, **el dataset del taller está cargado correctamente**.
Esa es literalmente la evidencia que pide la rúbrica («carga exitosa del dataset
de 50 medicamentos provisto en Supabase PostgreSQL»). Toma captura para el video.

### Archivo 3 · `db/03_seed_patients.sql`

Crea tres pacientes de demostración. Hacen falta porque el taller prohíbe
autenticar por REST, así que el login es una Mutation de GraphQL y necesita
usuarios reales contra los que validar.

- **Qué esperar:** tres filas con los correos de Ana, Carlos y Lucía.
- Las tres cuentas comparten la contraseña **`afirmative123`**.
- Las contraseñas se hashean con bcrypt dentro de PostgreSQL (`crypt()` +
  `gen_salt('bf')`), así que **el hash nunca queda escrito en el repositorio**.

### Verificación visual

Ve a **Table Editor** en el menú lateral. Deberías ver las tablas
`medications`, `categories`, `manufacturers`, `patients`, `carts`, `cart_items`,
`prescriptions`, `orders`, `order_items`, `domain_events` y `order_read_model`.

Abre `medications`: 50 filas, la primera «Acetaminofén Forte».

---

## 3. Obtener la cadena de conexión

Esto es lo que conecta tu backend con la base de datos.

1. Arriba del todo, pulsa el botón **Connect**.
2. Se abre un panel. Elige la pestaña **ORMs** o **Drivers** (según la versión
   del panel; también sirve la sección «Connection string»).
3. Verás **tres** opciones. Elige la del medio:

   | Opción | Puerto | ¿Usar? |
   |---|---|---|
   | Direct connection | 5432 | ❌ Requiere IPv6. La mayoría de redes domésticas y universitarias no lo tienen. |
   | **Session pooler** | **5432** | ✅ **Esta.** Compatible con IPv4 y admite transacciones, que este proyecto necesita para reservar inventario de forma atómica. |
   | Transaction pooler | 6543 | ⚠️ También funciona, pero es más restrictivo. Úsala solo si la anterior falla. |

4. Copia la cadena. Tendrá esta forma:

   ```
   postgresql://postgres.abcdefghijklm:[YOUR-PASSWORD]@aws-0-us-east-1.pooler.supabase.com:5432/postgres
   ```

5. **Sustituye `[YOUR-PASSWORD]`** (incluidos los corchetes) por la contraseña
   que guardaste en el paso 1.

   > Si tu contraseña tiene caracteres especiales, codifícalos:
   > `@` → `%40`, `#` → `%23`, `/` → `%2F`, `?` → `%3F`, `:` → `%3A`,
   > `%` → `%25`.

---

## 4. Conectar el backend

En la carpeta `server/` hay un archivo `.env.example`. Cópialo a `.env`:

```bash
cd server
cp .env.example .env
```

En Windows con PowerShell:

```powershell
Copy-Item .env.example .env
```

Abre `server/.env` y pega tu cadena de conexión en `DATABASE_URL`. Debería
quedar así (el resto de valores ya vienen bien por defecto):

```env
DATABASE_URL=postgresql://postgres.abcdefghijklm:MiClaveSegura123@aws-0-us-east-1.pooler.supabase.com:5432/postgres
PORT=4000
CORS_ORIGINS=http://localhost:5173,http://localhost:4173
JWT_SECRET=pon-aqui-una-cadena-larga-y-aleatoria
PROJECTION_DELAY_MS=1500
LOG_SQL=true
```

> `server/.env` está en `.gitignore`. **Nunca** lo subas al repositorio: contiene
> la contraseña de tu base de datos.

---

## 5. Comprobar que todo funciona

Desde la carpeta `server/`:

```bash
npm run db:check
```

Esto imprime la versión de PostgreSQL, cuántas filas hay en cada tabla, la lista
de índices creados y el plan de ejecución de una búsqueda por texto. Si ves
`medicamentos ... 50`, la conexión y la carga están perfectas.

---

## Atajo: cargar todo con un solo comando

Si prefieres no copiar y pegar los tres archivos en el panel web, puedes hacerlo
desde la terminal una vez configurado el `.env`:

```bash
npm run db:setup --prefix server
```

Este comando ejecuta los tres archivos SQL en orden y verifica los conteos al
final. Es **idempotente**: puedes repetirlo cuantas veces quieras sin duplicar
datos ni romper nada.

Sirve también para **reiniciar la demo**: vuelve a dejar el stock y el catálogo
en su estado original.

---

## Problemas frecuentes

### `password authentication failed for user "postgres"`
La contraseña de `DATABASE_URL` no coincide. Si la olvidaste, puedes generar
otra en **Project Settings → Database → Database password → Reset**. Recuerda
codificar los caracteres especiales.

### `ENOTFOUND` o `ETIMEDOUT`
El host no se resuelve o no responde. Casi siempre es porque copiaste la
**Direct connection** (que necesita IPv6) en vez de la **Session pooler**.
Vuelve al paso 3 y copia la del medio.

### `SASL: SCRAM-SERVER-FIRST-MESSAGE`
Este error aparece cuando la contraseña llega vacía o mal formada, normalmente
porque dejaste los corchetes `[YOUR-PASSWORD]` sin sustituir.

### `relation "medications" does not exist`
No ejecutaste `01_schema.sql`, o lo ejecutaste en un proyecto distinto.
Verifica en **Table Editor** que las tablas estén ahí.

### `extension "pg_trgm" is not available`
Muy raro en Supabase, que la trae de serie. Si ocurriera, ve a
**Database → Extensions**, busca `pg_trgm` y `pgcrypto` y actívalas a mano;
después vuelve a ejecutar `01_schema.sql`.

### El proyecto de Supabase quedó «pausado»
El plan gratuito pausa los proyectos tras una semana sin actividad. Entra al
panel y pulsa **Restore project**. Tarda un minuto y no pierdes datos.

> **Importante antes de grabar el video:** entra al panel de Supabase y confirma
> que el proyecto está activo. Un proyecto pausado hace que el backend no
> arranque, y es el fallo más molesto que puede aparecer a mitad de grabación.

---

## Resumen en cinco líneas

```bash
# 1. Crear proyecto en supabase.com y guardar la contraseña
# 2. SQL Editor → ejecutar db/01_schema.sql, db/02_seed_catalog.sql, db/03_seed_patients.sql
# 3. Botón Connect → copiar la cadena "Session pooler" (puerto 5432)
# 4. cp server/.env.example server/.env  y pegar la cadena en DATABASE_URL
# 5. npm run db:check --prefix server   →  debe decir "medicamentos ... 50"
```
