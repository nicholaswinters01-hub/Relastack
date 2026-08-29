import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import type { TenantContext } from '@platform/db';
import {
  MODULES,
  PERMISSIONS,
  createContactRequestSchema,
  createCustomerRequestSchema,
  createNoteRequestSchema,
  customerQuerySchema,
  setCustomerTagsRequestSchema,
  shareCustomerRequestSchema,
  updateContactRequestSchema,
  updateCustomerRequestSchema,
  type ContactsResponse,
  type CreateContactRequest,
  type CreateCustomerRequest,
  type CreateNoteRequest,
  type CustomerQuery,
  type CustomerResponse,
  type CustomersResponse,
  type NotesResponse,
  type SetCustomerTagsRequest,
  type ShareCustomerRequest,
  type UpdateContactRequest,
  type UpdateCustomerRequest,
} from '@platform/shared';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { RequireModule } from '../modules/module.decorators';
import {
  CurrentMembershipId,
  CurrentPermissions,
  RequirePermissionAnywhere,
} from '../rbac/rbac.decorators';
import type { PermissionSet } from '../rbac/permission-set';
import { CurrentTenant } from '../tenancy/tenant.decorators';
import { ContactsService } from './contacts.service';
import { CustomersService } from './customers.service';
import { NotesService } from './notes.service';

/**
 * Customer endpoints.
 *
 * The whole controller is gated by the CRM module: an organization without it
 * gets 403 MODULE_NOT_ENABLED from every route here, whether or not the
 * interface offered a link. That is the Phase 5 promise being kept on real
 * business data for the first time.
 *
 * Permissions are checked at two levels. `@RequirePermissionAnywhere` refuses
 * a caller who holds customer.read nowhere at all; which particular customers
 * they may reach is decided in the service, because that depends on the
 * customer's location and cannot be known from the route.
 */
@Controller('customers')
@RequireModule(MODULES.CRM)
export class CustomersController {
  constructor(
    private readonly customers: CustomersService,
    private readonly contacts: ContactsService,
    private readonly notes: NotesService,
  ) {}

  @Get()
  @RequirePermissionAnywhere(PERMISSIONS.CUSTOMER_READ)
  async list(
    @CurrentTenant() tenant: TenantContext,
    @CurrentPermissions() permissions: PermissionSet,
    @Query(new ZodValidationPipe(customerQuerySchema)) query: CustomerQuery,
  ): Promise<CustomersResponse> {
    return this.customers.list(tenant, permissions, query);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissionAnywhere(PERMISSIONS.CUSTOMER_WRITE)
  async create(
    @CurrentTenant() tenant: TenantContext,
    @CurrentPermissions() permissions: PermissionSet,
    @Body(new ZodValidationPipe(createCustomerRequestSchema)) body: CreateCustomerRequest,
  ): Promise<CustomerResponse> {
    return { customer: await this.customers.create(tenant, permissions, body) };
  }

  @Get(':id')
  @RequirePermissionAnywhere(PERMISSIONS.CUSTOMER_READ)
  async byId(
    @CurrentTenant() tenant: TenantContext,
    @CurrentPermissions() permissions: PermissionSet,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<CustomerResponse> {
    return { customer: await this.customers.getById(tenant, permissions, id) };
  }

  @Patch(':id')
  @RequirePermissionAnywhere(PERMISSIONS.CUSTOMER_WRITE)
  async update(
    @CurrentTenant() tenant: TenantContext,
    @CurrentPermissions() permissions: PermissionSet,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(updateCustomerRequestSchema)) body: UpdateCustomerRequest,
  ): Promise<CustomerResponse> {
    return { customer: await this.customers.update(tenant, permissions, id, body) };
  }

  /**
   * Archive. The ordinary way a customer goes away.
   *
   * DELETE on the resource does the non-destructive thing, because that is
   * what the interface's delete button should do. Permanent removal is a
   * separate, deliberately more awkward route.
   */
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissionAnywhere(PERMISSIONS.CUSTOMER_WRITE)
  async archive(
    @CurrentTenant() tenant: TenantContext,
    @CurrentPermissions() permissions: PermissionSet,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.customers.archive(tenant, permissions, id);
  }

  /** Permanent. Destroys the notes and contacts too. Owners only. */
  @Delete(':id/permanent')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissionAnywhere(PERMISSIONS.CUSTOMER_DELETE)
  async remove(
    @CurrentTenant() tenant: TenantContext,
    @CurrentPermissions() permissions: PermissionSet,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.customers.remove(tenant, permissions, id);
  }

  // -------------------------------------------------------------------------
  // Tags
  // -------------------------------------------------------------------------

  @Post(':id/tags')
  @HttpCode(HttpStatus.OK)
  @RequirePermissionAnywhere(PERMISSIONS.CUSTOMER_WRITE)
  async setTags(
    @CurrentTenant() tenant: TenantContext,
    @CurrentPermissions() permissions: PermissionSet,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(setCustomerTagsRequestSchema)) body: SetCustomerTagsRequest,
  ): Promise<CustomerResponse> {
    return { customer: await this.customers.setTags(tenant, permissions, id, body.tagIds) };
  }

  // -------------------------------------------------------------------------
  // Sharing across locations
  // -------------------------------------------------------------------------

  /**
   * Serve one customer from several branches.
   *
   * The handler-level @RequireModule overrides the class-level CRM
   * requirement, which is safe because Shared Customers depends on CRM and
   * cannot be enabled without it.
   */
  @Post(':id/locations')
  @HttpCode(HttpStatus.OK)
  @RequireModule(MODULES.SHARED_CUSTOMERS)
  @RequirePermissionAnywhere(PERMISSIONS.CUSTOMER_WRITE)
  async share(
    @CurrentTenant() tenant: TenantContext,
    @CurrentPermissions() permissions: PermissionSet,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(shareCustomerRequestSchema)) body: ShareCustomerRequest,
  ): Promise<CustomerResponse> {
    return {
      customer: await this.customers.setSharedLocations(tenant, permissions, id, body.locationIds),
    };
  }

  // -------------------------------------------------------------------------
  // Contacts
  // -------------------------------------------------------------------------

  @Get(':id/contacts')
  @RequirePermissionAnywhere(PERMISSIONS.CUSTOMER_READ)
  async listContacts(
    @CurrentTenant() tenant: TenantContext,
    @CurrentPermissions() permissions: PermissionSet,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ContactsResponse> {
    await this.customers.assertReadable(tenant, permissions, id);

    return { contacts: await this.contacts.listFor(tenant, id) };
  }

  @Post(':id/contacts')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissionAnywhere(PERMISSIONS.CUSTOMER_WRITE)
  async addContact(
    @CurrentTenant() tenant: TenantContext,
    @CurrentPermissions() permissions: PermissionSet,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(createContactRequestSchema)) body: CreateContactRequest,
  ): Promise<ContactsResponse> {
    await this.customers.assertWritable(tenant, permissions, id);
    await this.contacts.create(tenant, id, body);

    return { contacts: await this.contacts.listFor(tenant, id) };
  }

  @Patch(':id/contacts/:contactId')
  @RequirePermissionAnywhere(PERMISSIONS.CUSTOMER_WRITE)
  async updateContact(
    @CurrentTenant() tenant: TenantContext,
    @CurrentPermissions() permissions: PermissionSet,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('contactId', ParseUUIDPipe) contactId: string,
    @Body(new ZodValidationPipe(updateContactRequestSchema)) body: UpdateContactRequest,
  ): Promise<ContactsResponse> {
    await this.customers.assertWritable(tenant, permissions, id);
    await this.contacts.update(tenant, id, contactId, body);

    return { contacts: await this.contacts.listFor(tenant, id) };
  }

  @Delete(':id/contacts/:contactId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissionAnywhere(PERMISSIONS.CUSTOMER_WRITE)
  async removeContact(
    @CurrentTenant() tenant: TenantContext,
    @CurrentPermissions() permissions: PermissionSet,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('contactId', ParseUUIDPipe) contactId: string,
  ): Promise<void> {
    await this.customers.assertWritable(tenant, permissions, id);
    await this.contacts.remove(tenant, id, contactId);
  }

  // -------------------------------------------------------------------------
  // Notes
  // -------------------------------------------------------------------------

  @Get(':id/notes')
  @RequirePermissionAnywhere(PERMISSIONS.CUSTOMER_READ)
  async listNotes(
    @CurrentTenant() tenant: TenantContext,
    @CurrentPermissions() permissions: PermissionSet,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<NotesResponse> {
    await this.customers.assertReadable(tenant, permissions, id);

    return { notes: await this.notes.listFor(tenant, id) };
  }

  @Post(':id/notes')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissionAnywhere(PERMISSIONS.CUSTOMER_WRITE)
  async addNote(
    @CurrentTenant() tenant: TenantContext,
    @CurrentPermissions() permissions: PermissionSet,
    @CurrentMembershipId() membershipId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(createNoteRequestSchema)) body: CreateNoteRequest,
  ): Promise<NotesResponse> {
    await this.customers.assertWritable(tenant, permissions, id);
    await this.notes.create(tenant, id, membershipId, body.body);

    return { notes: await this.notes.listFor(tenant, id) };
  }

  @Patch(':id/notes/:noteId')
  @RequirePermissionAnywhere(PERMISSIONS.CUSTOMER_WRITE)
  async updateNote(
    @CurrentTenant() tenant: TenantContext,
    @CurrentPermissions() permissions: PermissionSet,
    @CurrentMembershipId() membershipId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('noteId', ParseUUIDPipe) noteId: string,
    @Body(new ZodValidationPipe(createNoteRequestSchema)) body: CreateNoteRequest,
  ): Promise<NotesResponse> {
    await this.customers.assertWritable(tenant, permissions, id);
    await this.notes.update(tenant, permissions, id, noteId, membershipId, body.body);

    return { notes: await this.notes.listFor(tenant, id) };
  }

  @Delete(':id/notes/:noteId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissionAnywhere(PERMISSIONS.CUSTOMER_WRITE)
  async removeNote(
    @CurrentTenant() tenant: TenantContext,
    @CurrentPermissions() permissions: PermissionSet,
    @CurrentMembershipId() membershipId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('noteId', ParseUUIDPipe) noteId: string,
  ): Promise<void> {
    await this.customers.assertWritable(tenant, permissions, id);
    await this.notes.remove(tenant, permissions, id, noteId, membershipId);
  }
}
