// The server tells its network it is here (mDNS, _slopify._tcp), so Home
// Assistant and other apps on the LAN can offer to set it up without anyone
// typing an address. The TXT record carries a display name and the server's
// random id, which lets an app recognise a server it already knows under
// another address (a public hostname, say); nothing in it names the software
// version or any account.
//
// Answered by hand over multicast-dns rather than through bonjour-service's
// publish: that one announces an A record for every interface of the host
// (Docker bridges, VPNs included) under the host's own name, so a discovering
// app could pick an address it cannot reach and the host's own mDNS name would
// collide. Here the only address given out is the LAN one, under a name of
// its own.
import os from 'node:os';
import type { FastifyInstance } from 'fastify';
import makeMdns from 'multicast-dns';
import type { DB } from './db.js';
import { userId as randomId } from './ids.js';
import { lanAddress } from './speakers/discovery.js';

const TYPE = '_slopify._tcp.local';
const SERVICES = '_services._dns-sd._udp.local';

export function serverId(db: DB): string {
  const row = db.prepare("SELECT v FROM kv WHERE k = 'server_id'").get() as { v: string } | undefined;
  if (row) return row.v;
  db.prepare("INSERT INTO kv (k, v) VALUES ('server_id', ?) ON CONFLICT(k) DO NOTHING").run(randomId());
  return (db.prepare("SELECT v FROM kv WHERE k = 'server_id'").get() as { v: string }).v;
}

export const defaultServerName = () => `Slopify on ${os.hostname().split('.')[0] || 'this server'}`;

export function registerServerInfo(app: FastifyInstance, db: DB, opts: { name: string }) {
  const id = serverId(db);
  app.get('/api/server', { preHandler: (app as any).requireUser }, async () => ({ id, name: opts.name }));
}

// The records for one server; ttl 0 says goodbye.
export function records(o: { name: string; id: string; port: number; address: string }, ttl = 120) {
  const instance = `${o.name.replace(/\./g, ' ').slice(0, 63)}.${TYPE}`;
  const host = `slopify-${o.id.slice(0, 8)}.local`;
  return {
    instance, host,
    answers: [{ name: TYPE, type: 'PTR' as const, ttl: ttl && 4500, data: instance }],
    additionals: [
      { name: instance, type: 'SRV' as const, ttl, flush: true, data: { port: o.port, target: host, priority: 0, weight: 0 } },
      { name: instance, type: 'TXT' as const, ttl: ttl && 4500, flush: true, data: [`id=${o.id}`, `name=${o.name}`] },
      { name: host, type: 'A' as const, ttl, flush: true, data: o.address },
    ],
  };
}

// Returns a stop function that says goodbye on the network (call it before exit).
export function advertise(app: FastifyInstance, db: DB, opts: { port: number; name: string }): () => Promise<void> {
  const address = lanAddress();
  if (!address) { app.log.info('mdns advertise: no LAN address, not announcing'); return async () => {}; }
  const id = serverId(db);
  const rec = records({ name: opts.name, id, port: opts.port, address });
  let mdns: ReturnType<typeof makeMdns>;
  // Bound to every address: a socket bound to the interface's own address
  // (multicast-dns's default when given one) never receives multicast on
  // Linux, so it would announce once and then never hear a query.
  try { mdns = makeMdns({ interface: address, bind: '0.0.0.0', reuseAddr: true }); }
  catch (e: any) { app.log.warn(`mdns advertise: ${e.message}`); return async () => {}; }
  mdns.on('error', (e: any) => app.log.warn(`mdns advertise: ${e?.message || e}`));
  const lower = (s: string) => s.toLowerCase();
  mdns.on('query', (q: any, rinfo: any) => {
    // A one-shot query from some other port wants its answer sent straight back.
    const respond = (res: any) => (rinfo && rinfo.port !== 5353 ? mdns.respond(res, rinfo) : mdns.respond(res));
    for (const question of q.questions || []) {
      const name = lower(question.name || ''), type = question.type;
      const any = type === 'ANY';
      if (name === lower(TYPE) && (type === 'PTR' || any)) { respond({ answers: rec.answers, additionals: rec.additionals }); return; }
      if (name === lower(SERVICES) && (type === 'PTR' || any)) { respond({ answers: [{ name: SERVICES, type: 'PTR', ttl: 4500, data: TYPE }] }); return; }
      if (name === lower(rec.instance) && (type === 'SRV' || type === 'TXT' || any)) { respond({ answers: rec.additionals.filter((r) => r.name === rec.instance), additionals: rec.additionals.filter((r) => r.type === 'A') }); return; }
      if (name === lower(rec.host) && (type === 'A' || any)) { respond({ answers: rec.additionals.filter((r) => r.type === 'A') }); return; }
    }
  });
  // Announce at start (twice, a second apart, as the spec asks) so anything
  // already browsing sees the server without waiting for its next query.
  const announce = () => { try { mdns.respond({ answers: rec.answers, additionals: rec.additionals }); } catch { /* socket gone */ } };
  announce();
  const again = setTimeout(announce, 1000); again.unref();
  app.log.info(`mdns: announcing "${opts.name}" at ${address}:${opts.port}`);
  return async () => {
    clearTimeout(again);
    const bye = records({ name: opts.name, id, port: opts.port, address }, 0);
    await new Promise<void>((resolve) => { try { mdns.respond({ answers: bye.answers, additionals: bye.additionals }, () => resolve()); } catch { resolve(); } setTimeout(resolve, 500).unref(); });
    try { mdns.destroy(); } catch { /* torn down */ }
  };
}
