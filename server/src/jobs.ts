// Long-running work a client starts and then polls: generating a playlist,
// importing a Spotify export. In memory on purpose: a job lives for the
// minute or two it takes plus an hour of results, and a restart mid-job is
// answered by starting it again.
import type { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';

export type Job = {
  id: string; userId: string; kind: string;
  state: 'queued' | 'running' | 'done' | 'error';
  step: string; progress: number | null; // 0..1 when the step can say
  info?: any; // job-specific detail for the client (stages, time left)
  result: any; error: string | null; created: number; finished: number | null;
};

const jobs = new Map<string, Job>();
const KEEP_MS = 60 * 60 * 1000;

export function startJob(userId: string, kind: string, run: (job: Job) => Promise<any>): Job {
  for (const [id, j] of jobs) if (j.finished && Date.now() - j.finished > KEEP_MS) jobs.delete(id);
  const job: Job = { id: crypto.randomBytes(8).toString('hex'), userId, kind, state: 'running', step: 'Starting', progress: null, result: null, error: null, created: Date.now(), finished: null };
  jobs.set(job.id, job);
  run(job).then((result) => { job.result = result; job.state = 'done'; job.progress = 1; },
    (e) => { job.error = e?.message || String(e); job.state = 'error'; })
    .finally(() => { job.finished = Date.now(); });
  return job;
}

export const jobOut = (j: Job) => ({ id: j.id, kind: j.kind, state: j.state, step: j.step, progress: j.progress, info: j.info ?? null, result: j.result, error: j.error, created: j.created, finished: j.finished });

export function registerJobs(app: FastifyInstance) {
  app.get('/api/jobs/:id', { preHandler: (app as any).requireUser }, async (req: any, reply) => {
    const j = jobs.get(req.params.id);
    if (!j || j.userId !== req.user.id) return reply.code(404).send({ error: 'no such job' });
    return jobOut(j);
  });
}
