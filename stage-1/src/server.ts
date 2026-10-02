/**
 * Entry point: listen, and close cleanly.
 *
 * `startServer` is what the tests use (ephemeral port, no process side effects) and
 * `main` is the thin wrapper that reads the environment and installs the signal
 * handlers. Nothing here participates in the booking guarantee.
 */

import { createServer, type Server } from 'node:http';
import { createRequestListener } from './routes.ts';
import { openDatabase, type Db, type TxOptions } from './db.ts';

export type StartedServer = {
  server: Server;
  db: Db;
  port: number;
  close: () => Promise<void>;
};

export type StartOptions = {
  /** Defaults to 0, so a test never fights the machine for a port. */
  port?: number;
  host?: string;
  busyTimeoutMs?: number;
  /** Lets the busy-path test shrink the retry budget; production uses the defaults. */
  txOptions?: TxOptions;
};

export function startServer(databasePath: string, options: StartOptions = {}): Promise<StartedServer> {
  const port = options.port ?? 0;
  const host = options.host ?? '127.0.0.1';
  const db = openDatabase(databasePath, { busyTimeoutMs: options.busyTimeoutMs });

  return new Promise<StartedServer>((resolve, reject) => {
    const server = createServer(createRequestListener(db, options.txOptions ?? {}));
    server.on('error', (err) => {
      db.close();
      reject(err);
    });
    server.listen(port, host, () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        server.close();
        db.close();
        reject(new Error('server did not bind to a TCP port'));
        return;
      }
      resolve({
        server,
        db,
        port: address.port,
        close: () =>
          new Promise<void>((done, fail) => {
            server.close((err) => {
              db.close();
              if (err) fail(err);
              else done();
            });
            server.closeAllConnections();
          }),
      });
    });
  });
}

async function main(): Promise<void> {
  const databasePath = process.env.TABLEKEEPER_DB ?? 'tablekeeper.db';
  const port = Number(process.env.PORT ?? 3000);
  const started = await startServer(databasePath, { port });
  process.stdout.write(`tablekeeper stage-1 listening on http://127.0.0.1:${started.port}\n`);

  let closing = false;
  const shutdown = (): void => {
    if (closing) return;
    closing = true;
    void started.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  await main();
}