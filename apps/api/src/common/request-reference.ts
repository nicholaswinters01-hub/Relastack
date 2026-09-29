import { randomBytes } from 'node:crypto';

/**
 * Each request's reference: short enough to read out over the phone, and
 * random so it says nothing about how busy the service is. Fastify's own
 * counter restarts with the process, so two errors could share one.
 */
export const requestReference = (): string => randomBytes(4).toString('hex');

// Structural, like internal-gate.ts: see auth/fastify.types.ts for why.
interface ReferenceHost {
  addHook(
    name: 'onSend',
    hook: (
      request: { id: string },
      reply: { header(name: string, value: string): unknown },
    ) => Promise<unknown>,
  ): unknown;
}

/** Every response carries its reference, so an error seen anywhere can be found in the logs. */
export function registerRequestReference(host: ReferenceHost): void {
  host.addHook('onSend', async (request, reply) => {
    reply.header('x-request-id', request.id);
  });
}
