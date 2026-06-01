import { Body, Controller, Delete, Get, Param, Post, Query } from '@nestjs/common';
import { GetOrgFromRequest } from '@gitroom/nestjs-libraries/user/org.from.request';
import { Organization } from '@prisma/client';
import { StarsService } from '@gitroom/nestjs-libraries/database/prisma/stars/stars.service';
import { CheckPolicies } from '@gitroom/backend/services/auth/permissions/permissions.ability';
import { OrganizationService } from '@gitroom/nestjs-libraries/database/prisma/organizations/organization.service';
import { AddTeamMemberDto } from '@gitroom/nestjs-libraries/dtos/settings/add.team.member.dto';
import { ApiTags } from '@nestjs/swagger';
import { AuthorizationActions, Sections } from '@gitroom/backend/services/auth/permissions/permission.exception.class';
import { GlobalSettingsService } from '@gitroom/nestjs-libraries/database/prisma/global-settings/global-settings.service';

@ApiTags('Settings')
@Controller('/settings')
export class SettingsController {
  constructor(
    private _starsService: StarsService,
    private _organizationService: OrganizationService,
    private _globalSettings: GlobalSettingsService
  ) {}

  @Get('/github')
  @CheckPolicies([AuthorizationActions.Create, Sections.ADMIN])
  async getConnectedGithubAccounts(@GetOrgFromRequest() org: Organization) {
    return {
      github: (
        await this._starsService.getGitHubRepositoriesByOrgId(org.id)
      ).map((repo) => ({
        id: repo.id,
        login: repo.login,
      })),
    };
  }

  @Post('/github')
  @CheckPolicies([AuthorizationActions.Create, Sections.ADMIN])
  async addGitHub(
    @GetOrgFromRequest() org: Organization,
    @Body('code') code: string
  ) {
    if (!code) {
      throw new Error('No code provided');
    }
    await this._starsService.addGitHub(org.id, code);
  }

  @Get('/github/url')
  @CheckPolicies([AuthorizationActions.Create, Sections.ADMIN])
  authUrl() {
    return {
      url: `https://github.com/login/oauth/authorize?client_id=${
        process.env.GITHUB_CLIENT_ID
      }&scope=${encodeURIComponent(
        'user:email'
      )}&redirect_uri=${encodeURIComponent(
        `${process.env.FRONTEND_URL}/settings`
      )}`,
    };
  }

  @Get('/organizations/:id')
  @CheckPolicies([AuthorizationActions.Create, Sections.ADMIN])
  async getOrganizations(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string
  ) {
    return {
      organizations: await this._starsService.getOrganizations(org.id, id),
    };
  }

  @Get('/organizations/:id/:github')
  @CheckPolicies([AuthorizationActions.Create, Sections.ADMIN])
  async getRepositories(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string,
    @Param('github') github: string
  ) {
    return {
      repositories: await this._starsService.getRepositoriesOfOrganization(
        org.id,
        id,
        github
      ),
    };
  }

  @Post('/organizations/:id')
  @CheckPolicies([AuthorizationActions.Create, Sections.ADMIN])
  async updateGitHubLogin(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string,
    @Body('login') login: string
  ) {
    return this._starsService.updateGitHubLogin(org.id, id, login);
  }

  @Delete('/repository/:id')
  @CheckPolicies([AuthorizationActions.Create, Sections.ADMIN])
  async deleteRepository(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string
  ) {
    return this._starsService.deleteRepository(org.id, id);
  }

  @Get('/team')
  @CheckPolicies(
    [AuthorizationActions.Create, Sections.TEAM_MEMBERS],
    [AuthorizationActions.Create, Sections.ADMIN]
  )
  async getTeam(@GetOrgFromRequest() org: Organization) {
    return this._organizationService.getTeam(org.id);
  }

  @Post('/team')
  @CheckPolicies(
    [AuthorizationActions.Create, Sections.TEAM_MEMBERS],
    [AuthorizationActions.Create, Sections.ADMIN]
  )
  async inviteTeamMember(
    @GetOrgFromRequest() org: Organization,
    @Body() body: AddTeamMemberDto
  ) {
    return this._organizationService.inviteTeamMember(org.id, body);
  }

  @Delete('/team/:id')
  @CheckPolicies(
    [AuthorizationActions.Create, Sections.TEAM_MEMBERS],
    [AuthorizationActions.Create, Sections.ADMIN]
  )
  deleteTeamMember(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string
  ) {
    return this._organizationService.deleteTeamMember(org, id);
  }

  @Get('/llm')
  @CheckPolicies([AuthorizationActions.Create, Sections.ADMIN])
  getLlmSettings() {
    return this._globalSettings.getLlmSettingsForDisplay();
  }

  @Post('/llm')
  @CheckPolicies([AuthorizationActions.Create, Sections.ADMIN])
  async saveLlmSettings(
    @Body('provider') provider: 'openai' | 'openrouter',
    @Body('apiKey') apiKey: string,
    @Body('textModel') textModel: string
  ) {
    await this._globalSettings.setLlmSettings({ provider, apiKey, textModel });
    return this._globalSettings.getLlmSettingsForDisplay();
  }

  @Get('/llm/models')
  @CheckPolicies([AuthorizationActions.Create, Sections.ADMIN])
  async getLlmModels(@Query('provider') queryProvider?: string) {
    const settings = await this._globalSettings.getLlmSettings();
    const provider = queryProvider || settings.provider;
    if (provider === 'openrouter') {
      const res = await fetch('https://openrouter.ai/api/v1/models', {
        headers: settings.apiKey
          ? { Authorization: `Bearer ${settings.apiKey}` }
          : {},
      });
      if (!res.ok) return { models: [] };
      const data = (await res.json()) as {
        data: { id: string; name: string }[];
      };
      return {
        models: data.data
          .map((m) => ({ id: m.id, name: m.name || m.id }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      };
    }
    // OpenAI common chat models (static — their /models endpoint includes many non-chat models)
    return {
      models: [
        { id: 'gpt-4.1', name: 'GPT-4.1' },
        { id: 'gpt-4.1-mini', name: 'GPT-4.1 Mini' },
        { id: 'gpt-4.1-nano', name: 'GPT-4.1 Nano' },
        { id: 'gpt-4o', name: 'GPT-4o' },
        { id: 'gpt-4o-mini', name: 'GPT-4o Mini' },
        { id: 'gpt-4-turbo', name: 'GPT-4 Turbo' },
        { id: 'o1', name: 'o1' },
        { id: 'o1-mini', name: 'o1 Mini' },
        { id: 'o3-mini', name: 'o3 Mini' },
      ],
    };
  }
}
