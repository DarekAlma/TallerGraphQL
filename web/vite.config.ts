import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Configuracion de Vite.
 *
 * No hay proxy ni reescritura de rutas: el cliente habla directamente con
 * http://localhost:4000/graphql. Asi, en la pestana Network de DevTools, cada
 * peticion aparece con su URL real y se ve sin ambiguedad que TODAS van al
 * mismo endpoint GraphQL (evidencia del mandato Zero-REST).
 */
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, strictPort: true },
});
