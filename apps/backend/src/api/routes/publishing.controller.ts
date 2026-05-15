import { Controller, Get, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CheckPolicies } from '@gitroom/backend/services/auth/permissions/permissions.ability';
import {
  AuthorizationActions,
  Sections,
} from '@gitroom/backend/services/auth/permissions/permission.exception.class';
import { PostsService } from '@gitroom/nestjs-libraries/database/prisma/posts/posts.service';

@ApiTags('Publishing')
@Controller('/publishing')
export class PublishingController {
  constructor(private _postsService: PostsService) {}

  @Get('/state')
  async getState() {
    return this._postsService.getPublishingState();
  }

  @Post('/pause')
  @CheckPolicies([AuthorizationActions.Create, Sections.ADMIN])
  async pause() {
    return this._postsService.pauseAllPublishing();
  }

  @Post('/resume')
  @CheckPolicies([AuthorizationActions.Create, Sections.ADMIN])
  async resume() {
    return this._postsService.resumeAllPublishing();
  }
}
