/**
 * Inventario en vivo para TODA la aplicacion.
 *
 * Escucha la Subscription `stockChanged` y escribe el stock nuevo directamente
 * en la entidad `Medication` de la cache normalizada con `cache.modify`. Se
 * tocan solo dos campos del medicamento afectado: no se invalida ninguna
 * consulta ni se refetchea nada.
 *
 * Vive en la raiz (junto al `ApolloProvider`) y no dentro del catalogo a
 * proposito: si estuviera en `CatalogPage`, al irse a la pagina del pedido la
 * suscripcion se cerraria, y al volver el catalogo mostraria un stock viejo
 * hasta que respondiera la red. Aqui la cache se mantiene al dia en cualquier
 * pantalla: catalogo, ficha y carrito leen el mismo `Medication:<id>`.
 *
 * No pinta nada; es un componente solo de efectos.
 */
import { useSubscription } from '@apollo/client/react';
import { STOCK_SUBSCRIPTION } from '../graphql/operations';

export function LiveInventory() {
  useSubscription(STOCK_SUBSCRIPTION, {
    onData({ client, data: subscriptionData }) {
      const event = (subscriptionData.data as any)?.stockChanged;
      if (!event) return;

      // El evento trae el stock ABSOLUTO, no un delta: aplicarlo dos veces da
      // el mismo resultado, asi que no importa si llega repetido.
      client.cache.modify({
        id: client.cache.identify({ __typename: 'Medication', id: event.medicationId }),
        fields: {
          stock: () => event.stock,
          availability: () => event.availability,
        },
      });
    },
  });

  return null;
}
