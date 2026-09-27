import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import {
  addStaffNoteRequestSchema,
  extendTrialRequestSchema,
  setBusinessStatusRequestSchema,
  staffActionRequestSchema,
  staffBusinessQuerySchema,
  staffChangePlanRequestSchema,
  type AddStaffNoteRequest,
  type ExtendTrialRequest,
  type ReissueInvitationResponse,
  type SetBusinessStatusRequest,
  type StaffActionRequest,
  type StaffAuditResponse,
  type StaffBusinessDetail,
  type StaffBusinessesResponse,
  type StaffBusinessQuery,
  type StaffChangePlanRequest,
  type StaffOverview,
} from '@platform/shared';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { CurrentStaff, StaffOnly, type StaffIdentity } from './staff.decorators';
import { StaffService } from './staff.service';

/**
 * The staff console. Transport only; every rule lives in StaffService.
 *
 * @StaffOnly on the class covers every route: StaffGuard admits platform staff
 * and nobody else, answering 404 to everyone who is not.
 */
@StaffOnly()
@Controller('staff')
export class StaffController {
  constructor(private readonly staff: StaffService) {}

  /** Lets the web app decide whether to show the Staff link. 404 for everyone else. */
  @Get('me')
  me(@CurrentStaff() staff: StaffIdentity): { email: string } {
    return { email: staff.email };
  }

  @Get('overview')
  overview(@CurrentStaff() staff: StaffIdentity): Promise<StaffOverview> {
    return this.staff.overview(staff);
  }

  @Get('businesses')
  async businesses(
    @CurrentStaff() staff: StaffIdentity,
    @Query(new ZodValidationPipe(staffBusinessQuerySchema)) query: StaffBusinessQuery,
  ): Promise<StaffBusinessesResponse> {
    return { businesses: await this.staff.listBusinesses(staff, query) };
  }

  @Get('businesses/:id')
  business(
    @CurrentStaff() staff: StaffIdentity,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<StaffBusinessDetail> {
    return this.staff.businessDetail(staff, id);
  }

  @Get('audit')
  async audit(@CurrentStaff() staff: StaffIdentity): Promise<StaffAuditResponse> {
    return { events: await this.staff.auditTrail(staff) };
  }

  @Post('businesses/:id/trial')
  @HttpCode(HttpStatus.NO_CONTENT)
  extendTrial(
    @CurrentStaff() staff: StaffIdentity,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(extendTrialRequestSchema)) body: ExtendTrialRequest,
  ): Promise<void> {
    return this.staff.extendTrial(staff, id, new Date(body.until), body.reason);
  }

  @Post('businesses/:id/plan')
  @HttpCode(HttpStatus.NO_CONTENT)
  changePlan(
    @CurrentStaff() staff: StaffIdentity,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(staffChangePlanRequestSchema)) body: StaffChangePlanRequest,
  ): Promise<void> {
    return this.staff.changePlan(staff, id, body.planKey, body.reason);
  }

  @Post('businesses/:id/status')
  @HttpCode(HttpStatus.NO_CONTENT)
  setStatus(
    @CurrentStaff() staff: StaffIdentity,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(setBusinessStatusRequestSchema)) body: SetBusinessStatusRequest,
  ): Promise<void> {
    return this.staff.setBusinessStatus(staff, id, body.status, body.reason);
  }

  @Post('businesses/:id/members/:userId/unlock')
  @HttpCode(HttpStatus.NO_CONTENT)
  unlock(
    @CurrentStaff() staff: StaffIdentity,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body(new ZodValidationPipe(staffActionRequestSchema)) body: StaffActionRequest,
  ): Promise<void> {
    return this.staff.unlockMember(staff, id, userId, body.reason);
  }

  @Post('businesses/:id/members/:userId/sign-out')
  @HttpCode(HttpStatus.NO_CONTENT)
  signOut(
    @CurrentStaff() staff: StaffIdentity,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body(new ZodValidationPipe(staffActionRequestSchema)) body: StaffActionRequest,
  ): Promise<void> {
    return this.staff.signOutMember(staff, id, userId, body.reason);
  }

  @Post('businesses/:id/invitations/:invitationId/reissue')
  async reissue(
    @CurrentStaff() staff: StaffIdentity,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('invitationId', ParseUUIDPipe) invitationId: string,
    @Body(new ZodValidationPipe(staffActionRequestSchema)) body: StaffActionRequest,
  ): Promise<ReissueInvitationResponse> {
    return { acceptUrl: await this.staff.reissueInvitation(staff, id, invitationId, body.reason) };
  }

  @Post('businesses/:id/notes')
  @HttpCode(HttpStatus.NO_CONTENT)
  addNote(
    @CurrentStaff() staff: StaffIdentity,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(addStaffNoteRequestSchema)) body: AddStaffNoteRequest,
  ): Promise<void> {
    return this.staff.addNote(staff, id, body.body);
  }
}
