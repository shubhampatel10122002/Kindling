import { WebSocketServer } from 'ws';
import { env } from '../lib/env';
import { getDemoChild, query, one, schemaIsReady, describeTarget } from '../lib/db';
import { Session } from './session';
import { tts } from './cartesia';
import type { ChildMemory, ClientMessage, Mastery } from '../lib/types';

/**
 * Standalone WebSocket server that owns the live session (PLAN.md §2.1).
 * One concurrent session is fine for the MVP.
 */

const wss = new WebSocketServer({ port: env.wsPort, path: '/session' });

/** The schema cannot change under a running server, so check it once. */
let schemaVerified = false;

wss.on('connection', async (ws) => {
  console.log('[ws] client connected');
  let session: Session | null = null;

  /**
   * Messages that arrived before the session existed.
   *
   * The browser sends `start` the instant the socket opens, and building the
   * session takes several database round-trips. A listener attached after those
   * awaits is attached too late: `ws` emits the message, nothing is listening,
   * and it is gone — the session then waits forever for a start that already
   * happened. So the listener goes on synchronously, before anything can await,
   * and queues until there is something to hand the messages to.
   */
  const pending: ClientMessage[] = [];

  const dispatch = (msg: ClientMessage) => {
    if (!session) {
      pending.push(msg);
      return;
    }
    void session.handleMessage(msg);
  };

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      // Mic frames before the session exists are simply early. Dropping them is
      // correct — there is nothing listening to the child yet.
      session?.onAudio(data as Buffer);
      return;
    }
    try {
      dispatch(JSON.parse(data.toString()) as ClientMessage);
    } catch {
      /* ignore malformed frame */
    }
  });

  ws.on('close', () => {
    console.log('[ws] client disconnected');
    void session?.close();
  });

  ws.on('error', (err) => console.error('[ws] socket error', err));

  try {
    // Checked once per process, not once per connection: the schema does not
    // change under a running server, and this is a database round-trip in front
    // of every session start.
    if (!schemaVerified) {
      const { ready, missing } = await schemaIsReady();
      if (!ready) {
        ws.send(
          JSON.stringify({
            t: 'error',
            message:
              `Database ${describeTarget()} is missing: ${missing.join(', ')}.\n\n` +
              'Run `npm run db:migrate` and reload — it adds what is missing and keeps ' +
              "everything already there.\n\nUse `npm run db:reset` only if you want to erase " +
              "the child's history and start clean.",
          }),
        );
        ws.close();
        return;
      }
      schemaVerified = true;
    }

    // No child is not an error any more: it means we have never met her, and the
    // session opens with onboarding instead of a story. `npm run db:seed` is now
    // a convenience for demos rather than a precondition.
    const child = await getDemoChild();

    // Both of these depend only on the child, so they go together rather than
    // one after the other. Every millisecond here is silence she is sitting in.
    const [memoryRow, mastery] = await Promise.all([
      child
        ? one<ChildMemory & { child_id: string }>(
            'SELECT interests, personality_notes, canon, version FROM child_memory WHERE child_id = $1',
            [child.id],
          )
        : Promise.resolve(null),
      child
        ? query<Mastery>(
            'SELECT skill_id, p_mastery, last_practiced FROM skill_mastery WHERE child_id = $1',
            [child.id],
          )
        : Promise.resolve([] as Mastery[]),
    ]);

    const memory: ChildMemory = memoryRow ?? {
      interests: [],
      personality_notes: '',
      canon: {},
    };

    session = new Session(ws, child, memory, mastery);

    // The browser starts the session, not the server: it has to tell us what
    // time it is where the child is, and the opening depends on that. Its
    // `start` almost certainly arrived while we were still reading the database.
    console.log(`[ws] session ready (${pending.length} message(s) queued during setup)`);
    for (const msg of pending.splice(0)) void session.handleMessage(msg);
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
  // Pay the TTS handshake now, while nobody is waiting on it.
  void tts().warm();
});

const shutdown = () => {
  console.log('\n[ws] shutting down');
  wss.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
