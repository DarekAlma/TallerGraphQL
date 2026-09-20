/**
 * Punto de entrada de la aplicacion.
 *
 * `ApolloProvider` envuelve TODO el arbol de React. Eso es lo que el taller
 * llama "el arbol de contexto de Apollo": a partir de aqui, cualquier
 * componente, a cualquier profundidad, puede usar `useQuery`, `useMutation` o
 * `useSubscription` sin recibir el cliente por props ni importarlo.
 *
 * Al estar el provider en la raiz, la cache normalizada tambien es unica y
 * compartida: si el catalogo ya trajo un medicamento, el carrito lo lee de
 * cache sin volver a pedirlo.
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { ApolloProvider } from '@apollo/client/react';
import { apolloClient } from './apollo/client';
import { App } from './App';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ApolloProvider client={apolloClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </ApolloProvider>
  </StrictMode>,
);
