import { Module } from '@nestjs/common';
import { ContactsService } from './contacts.service';
import { CustomFieldsController } from './custom-fields.controller';
import { CustomFieldsService } from './custom-fields.service';
import { CustomersController } from './customers.controller';
import { CustomersService } from './customers.service';
import { NotesService } from './notes.service';
import { TagsController } from './tags.controller';
import { TagsService } from './tags.service';

/**
 * CRM (Phase 7).
 *
 * The first business module. It depends on platform services — Prisma, RBAC,
 * entitlement — and on no other business module, which is the rule every
 * module after it follows.
 */
@Module({
  controllers: [CustomersController, TagsController, CustomFieldsController],
  providers: [CustomersService, ContactsService, NotesService, TagsService, CustomFieldsService],
  exports: [CustomersService],
})
export class CrmModule {}
