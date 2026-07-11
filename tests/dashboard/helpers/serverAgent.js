import http from 'node:http';
import request from 'supertest';

/**
 * Starts one persistent server for a test scope.
 *
 * Repeated `request(app)` calls make Supertest listen on and close an ephemeral
 * server for every request. Binding Supertest to an already-listening server
 * removes that per-request lifecycle boundary.
 *
 * @param {import('http').RequestListener} app
 * @returns {Promise<{ client: import('supertest').Agent, close: () => Promise<void> }>}
 */
export async function serverAgent(app) {
  const server = http.createServer(app);

  await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };

    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(0, '127.0.0.1');
  });

  const client = request(server);
  let closePromise;

  function close() {
    if (!closePromise) {
      closePromise = new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }

    return closePromise;
  }

  return { client, close };
}
