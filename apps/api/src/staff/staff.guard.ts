import {
  Injectable,
  NotFoundException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from '../auth/fastify.types';
import { PrismaService } from '../prisma/prisma.service';
import { STAFF_ONLY_KEY, type StaffRequest } from './staff.decorators';

/**
 * Admits platform staff to staff routes. Every other route passes untouched.
 *
 * Asked of the database on every request rather than remembered in the
 * session: removing someone from platform_staff takes effect immediately.
 * Read through the caller's own identity, which is the only row the
 * application role may see there.
 *
 * Refuses with 404, like a route that does not exist: a customer who tries a
 * staff URL learns nothing about there being one.
 */
@Injectable()
export class StaffGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const staffOnly = this.reflector.getAllAndOverride<boolean>(STAFF_ONLY_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!staffOnly) return true;

    const request = context.switchToHttp().getRequest<FastifyRequest & StaffRequest>();
    const session = request.session;

    // AuthGuard has already refused anyone signed out; this is belt and braces.
    if (!session) throw new NotFoundException();

    const staff = await this.prisma.withUserOnly(session.userId, (tx) =>
      tx.platformStaff.findUnique({ where: { userId: session.userId } }),
    );

    if (!staff) throw new NotFoundException();

    request.staff = { userId: session.userId, email: session.user.email };
    return true;
  }
}
