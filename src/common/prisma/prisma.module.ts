import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';

/* PrismaService global — mọi module tiêm được nhưng chỉ dùng model của schema mình (Database Rules). */
@Global()
@Module({ providers: [PrismaService], exports: [PrismaService] })
export class PrismaModule {}
