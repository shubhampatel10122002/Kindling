import { WebSocketServer } from 'ws';
import { env } from '../lib/env';
import { getDemoChild, query, one, schemaIsReady, describeTarget } from '../lib/db';
import { Session } from './session';
import type { ChildMemory, ClientMessage, Mastery } from '../lib/types';

/**
 * Standalone WebSocket server that owns the live session (PLAN.md §2.1).
 * One concurrent session is fine for the MVP.
 */

const wss = new WebSocketServer({ port: env.wsPort, path: '/session' });

wss.on('connection', async (ws) => {
  console.log('[ws] client connected');
  let session: Session | null = null;

  try {
    const { ready, missing } = await schemaIsReady();
    if (!ready) {
      ws.send(
        JSON.stringify({
          t: 'error',
          message:
            `Database ${describeTarget()} has no schema (missing: ${missing.join(', ')}). ` +
            'Run `npm run db:reset` in the project directory, then reload this page.',
        }),
      );
      ws.close();
      return;
    }

    // No child is not an error any more: it means we have never met her, and the
    // session opens with onboarding instead of a story. `npm run db:seed` is now
    // a convenience for demos rather than a precondition.
    const child = await getDemoChild();

    const memoryRow = child
      ? await one<ChildMemory & { child_id: string }>(
          'SELECT interests, personality_notes, canon, version FROM child_memory WHERE child_id = $1',
          [child.id],
        )
      : null;
    const memory: ChildMemory = memoryRow ?? {
      interests: [],
      personality_notes: '',
      canon: {},
    };

    const mastery = child
      ? await query<Mastery>(
          'SELECT skill_id, p_mastery, last_practiced FROM skill_mastery WHERE child_id = $1',
          [child.id],
        )
      : [];

    session = new Session(ws, child, memory, mastery);

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        session?.onAudio(data as Buffer);
        return;
      }
      let msg: ClientMessage;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      void session?.handleMessage(msg);
    });

    ws.on('close', () => {
      console.log('[ws] client disconnected');
      void session?.close();
    });

    ws.on('error', (err) => console.error('[ws] socket error', err));

    // The browser starts the session, not the server: it has to tell us what
    // time it is where the child is, and the opening depends on that.
    console.log('[ws] session ready, waiting for the browser to start it');
  } catch (err) {
    console.error('[ws] session failed to start', err);
    try {
      ws.send(JSON.stringify({ t: 'error', message: String((err as Error).message ?? err) }));
    } catch {
      /* socket already gone */
    }
    void session?.close();
    ws.close();
  }
});

wss.on('listening', () => {
  console.log(`[ws] session server listening on ws://localhost:${env.wsPort}/session`);
});

const shutdown = () => {
  console.log('\n[ws] shutting down');
  wss.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
