import { IntegrationValidationTool } from '@gitroom/nestjs-libraries/chat/tools/integration.validation.tool';
import { IntegrationTriggerTool } from '@gitroom/nestjs-libraries/chat/tools/integration.trigger.tool';
import { IntegrationSchedulePostTool } from './integration.schedule.post';
import { GenerateVideoOptionsTool } from '@gitroom/nestjs-libraries/chat/tools/generate.video.options.tool';
import { VideoFunctionTool } from '@gitroom/nestjs-libraries/chat/tools/video.function.tool';
import { GenerateVideoTool } from '@gitroom/nestjs-libraries/chat/tools/generate.video.tool';
import { GenerateImageTool } from '@gitroom/nestjs-libraries/chat/tools/generate.image.tool';
import { IntegrationListTool } from '@gitroom/nestjs-libraries/chat/tools/integration.list.tool';
import { IntegrationListPostsTool } from '@gitroom/nestjs-libraries/chat/tools/integration.list.posts.tool';
import { IntegrationDeletePostTool } from '@gitroom/nestjs-libraries/chat/tools/integration.delete.post.tool';
import { IntegrationEditPostDateTool } from '@gitroom/nestjs-libraries/chat/tools/integration.edit.post.date.tool';
import { IntegrationEditPostContentTool } from '@gitroom/nestjs-libraries/chat/tools/integration.edit.post.content.tool';
import { IntegrationAnalyticsTool } from '@gitroom/nestjs-libraries/chat/tools/integration.analytics.tool';

export const toolList = [
  IntegrationListTool,
  IntegrationValidationTool,
  IntegrationTriggerTool,
  IntegrationSchedulePostTool,
  GenerateVideoOptionsTool,
  VideoFunctionTool,
  GenerateVideoTool,
  GenerateImageTool,
  IntegrationListPostsTool,
  IntegrationDeletePostTool,
  IntegrationEditPostDateTool,
  IntegrationEditPostContentTool,
  IntegrationAnalyticsTool,
];
