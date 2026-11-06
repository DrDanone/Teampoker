import WebSocket from 'ws';

/**
 * Testclient für das WebSocket-Protokoll: sammelt eingehende Nachrichten
 * und wartet gezielt auf bestimmte.
 */
export async function connectClient(url) {
  const ws = new WebSocket(url);
  const messages = [];
  const waiters = [];
  let closeInfo = null;
  const closeWaiters = [];

  ws.on('message', (data) => {
    const message = JSON.parse(data.toString());
    messages.push(message);
    for (const waiter of [...waiters]) {
      if (waiter.match(message)) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(message);
      }
    }
  });
  ws.on('close', (code) => {
    closeInfo = { code };
    for (const resolve of closeWaiters.splice(0)) resolve(closeInfo);
  });
  ws.on('error', () => {});

  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });

  const client = {
    ws,
    messages,
    send(payload) {
      ws.send(JSON.stringify(payload));
    },
    /**
     * Wartet auf die nächste (noch nicht abgeholte) Nachricht, die passt.
     *
     * @param {string | string[]} type ein oder mehrere Nachrichtentypen
     */
    next(type, predicate = () => true, timeoutMs = 2000) {
      const types = Array.isArray(type) ? type : [type];
      const match = (m) => types.includes(m.type) && predicate(m);
      const index = messages.findIndex((m) => !m.consumed && match(m));
      if (index >= 0) {
        messages[index].consumed = true;
        return Promise.resolve(messages[index]);
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Keine Nachricht ${type}`)), timeoutMs);
        waiters.push({
          match,
          resolve: (m) => {
            clearTimeout(timer);
            m.consumed = true;
            resolve(m);
          },
        });
      });
    },
    /** Neuester Zustand (letzte `state`-Nachricht). */
    get lastState() {
      return messages.filter((m) => m.type === 'state').at(-1) ?? null;
    },
    async join(code, name, token) {
      client.send({ type: 'join', code, name, token });
      return client.next(['joined', 'error']);
    },
    closed() {
      if (closeInfo) return Promise.resolve(closeInfo);
      return new Promise((resolve) => closeWaiters.push(resolve));
    },
    close() {
      ws.close();
      return client.closed();
    },
  };
  return client;
}

/** Wartet, bis eine Bedingung erfüllt ist. */
export async function eventually(check, timeoutMs = 2000) {
  const start = Date.now();
  for (;;) {
    const result = check();
    if (result) return result;
    if (Date.now() - start > timeoutMs) throw new Error('Bedingung nicht erfüllt');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
