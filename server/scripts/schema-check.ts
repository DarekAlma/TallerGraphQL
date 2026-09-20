/**
 * Verificacion del contrato GraphQL sin arrancar el servidor ni tocar la base.
 *
 *     npm run schema:check
 *
 * Construye el schema ejecutable uniendo `schema.graphql` con el mapa de
 * resolvers. Si un resolver apunta a un campo que no existe en el SDL (o al
 * reves), `makeExecutableSchema` falla aqui, en un segundo, en vez de fallar
 * en mitad de la demostracion.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { makeExecutableSchema } from '@graphql-tools/schema';

/**
 * Los resolvers importan el pool de PostgreSQL, y el modulo de configuracion
 * aborta el proceso si falta `DATABASE_URL`. Esta comprobacion no ejecuta ni
 * una consulta —`pg` abre conexiones de forma perezosa—, asi que basta con un
 * valor de relleno para que la validacion de configuracion no interrumpa.
 *
 * Por eso los resolvers se cargan con `import()` dinamico: un `import` normal
 * se evaluaria antes de esta linea.
 */
if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = 'postgresql://schema-check:sin-uso@localhost:5432/sin-uso';
}

const { resolvers } = await import('../src/graphql/resolvers.js');
const { log, color } = await import('../src/shared/logger.js');

const typeDefs = readFileSync(fileURLToPath(new URL('../src/graphql/schema.graphql', import.meta.url)), 'utf8');
const schema = makeExecutableSchema({ typeDefs, resolvers });

const types = Object.values(schema.getTypeMap()).filter((t) => !t.name.startsWith('__'));
const countOf = (ctor: string) => types.filter((t) => t.constructor.name === ctor).length;

log.ok('Schema ejecutable construido sin errores.');
console.log(`
  ${color.bold}CONTRATO GRAPHQL${color.reset}
    Queries ............... ${Object.keys(schema.getQueryType()!.getFields()).length}
    Mutations (comandos) .. ${Object.keys(schema.getMutationType()!.getFields()).length}
    Subscriptions ......... ${Object.keys(schema.getSubscriptionType()!.getFields()).length}

    Object types .......... ${countOf('GraphQLObjectType')}
    Input types ........... ${countOf('GraphQLInputObjectType')}
    Enums ................. ${countOf('GraphQLEnumType')}
    Interfaces ............ ${countOf('GraphQLInterfaceType')}
    Unions ................ ${countOf('GraphQLUnionType')}
    Scalars ............... ${countOf('GraphQLScalarType')}  (4 nativos + 7 personalizados)
`);

// El proceso mantendria vivo el pool de `pg` aunque nunca se haya conectado.
process.exit(0);
