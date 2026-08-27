import { Global, Module } from '@nestjs/common';
import { serverEnvProvider } from '../config.provider';
import { PrismaService } from './prisma.service';

/**
 * Global so that every feature module can inject PrismaService without
 * re-importing this module. There is exactly one database client per process.
 */
@Global()
@Module({
  providers: [serverEnvProvider, PrismaService],
  exports: [PrismaService, serverEnvProvider],
})
export class PrismaModule {}
