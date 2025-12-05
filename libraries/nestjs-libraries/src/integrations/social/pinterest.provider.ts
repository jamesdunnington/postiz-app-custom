import {
  AnalyticsData,
  AuthTokenDetails,
  PostDetails,
  PostResponse,
  SocialProvider,
} from '@gitroom/nestjs-libraries/integrations/social/social.integrations.interface';
import { makeId } from '@gitroom/nestjs-libraries/services/make.is';
import { PinterestSettingsDto } from '@gitroom/nestjs-libraries/dtos/posts/providers-settings/pinterest.dto';
import axios from 'axios';
import FormData from 'form-data';
import { timer } from '@gitroom/helpers/utils/timer';
import { SocialAbstract } from '@gitroom/nestjs-libraries/integrations/social.abstract';
import dayjs from 'dayjs';
import { Tool } from '@gitroom/nestjs-libraries/integrations/tool.decorator';
import { Rules } from '@gitroom/nestjs-libraries/chat/rules.description.decorator';
import * as Sentry from '@sentry/nextjs';

@Rules(
  'Pinterest requires at least one media, if posting a video, you must have two attachment, one for video, one for the cover picture, When posting a video, there can be only one'
)
export class PinterestProvider
  extends SocialAbstract
  implements SocialProvider
{
  identifier = 'pinterest';
  name = 'Pinterest';
  isBetweenSteps = false;
  scopes = [
    'boards:read',
    'boards:write',
    'pins:read',
    'pins:write',
    'user_accounts:read',
  ];
  override maxConcurrentJob = 3; // Pinterest has more lenient rate limits
  maxLength() {
    return 500;
  }

  dto = PinterestSettingsDto;

  editor = 'normal' as const;

  public override handleErrors(body: string):
    | {
        type: 'refresh-token' | 'bad-body';
        value: string;
      }
    | undefined {
    if (body.indexOf('cover_image_url or cover_image_content_type') > -1) {
      return {
        type: 'bad-body' as const,
        value:
          'When uploading a video, you must add also an image to be used as a cover image.',
      };
    }

    return undefined;
  }

  async refreshToken(refreshToken: string): Promise<AuthTokenDetails> {
    const { access_token, expires_in } = await (
      await fetch('https://api.pinterest.com/v5/oauth/token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: `Basic ${Buffer.from(
            `${process.env.PINTEREST_CLIENT_ID}:${process.env.PINTEREST_CLIENT_SECRET}`
          ).toString('base64')}`,
        },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          scope: this.scopes.join(','),
          redirect_uri: `${process.env.FRONTEND_URL}/integrations/social/pinterest`,
        }),
      })
    ).json();

    const { id, profile_image, username } = await (
      await fetch('https://api.pinterest.com/v5/user_account', {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${access_token}`,
        },
      })
    ).json();

    return {
      id: id,
      name: username,
      accessToken: access_token,
      refreshToken: refreshToken,
      expiresIn: expires_in,
      picture: profile_image || '',
      username,
    };
  }

  async generateAuthUrl() {
    const state = makeId(6);
    return {
      url: `https://www.pinterest.com/oauth/?client_id=${
        process.env.PINTEREST_CLIENT_ID
      }&redirect_uri=${encodeURIComponent(
        `${process.env.FRONTEND_URL}/integrations/social/pinterest`
      )}&response_type=code&scope=${encodeURIComponent(
        'boards:read,boards:write,pins:read,pins:write,user_accounts:read'
      )}&state=${state}`,
      codeVerifier: makeId(10),
      state,
    };
  }

  async authenticate(params: {
    code: string;
    codeVerifier: string;
    refresh: string;
  }) {
    const { access_token, refresh_token, expires_in, scope } = await (
      await fetch('https://api.pinterest.com/v5/oauth/token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: `Basic ${Buffer.from(
            `${process.env.PINTEREST_CLIENT_ID}:${process.env.PINTEREST_CLIENT_SECRET}`
          ).toString('base64')}`,
        },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: params.code,
          redirect_uri: `${process.env.FRONTEND_URL}/integrations/social/pinterest`,
        }),
      })
    ).json();

    this.checkScopes(this.scopes, scope);

    const { id, profile_image, username } = await (
      await fetch('https://api.pinterest.com/v5/user_account', {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${access_token}`,
        },
      })
    ).json();

    return {
      id: id,
      name: username,
      accessToken: access_token,
      refreshToken: refresh_token,
      expiresIn: expires_in,
      picture: profile_image,
      username,
    };
  }

  @Tool({ description: 'List of boards', dataSchema: [] })
  async boards(accessToken: string) {
    const { items } = await (
      await fetch('https://api.pinterest.com/v5/boards', {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      })
    ).json();

    return (
      items?.map((item: any) => ({
        name: item.name,
        id: item.id,
      })) || []
    );
  }

  async post(
    id: string,
    accessToken: string,
    postDetails: PostDetails<PinterestSettingsDto>[]
  ): Promise<PostResponse[]> {
    let mediaId = '';
    const findMp4 = postDetails?.[0]?.media?.find(
      (p) => (p.path?.indexOf('mp4') || -1) > -1
    );
    const picture = postDetails?.[0]?.media?.find(
      (p) => (p.path?.indexOf('mp4') || -1) === -1
    );

    if (findMp4) {
      const { upload_url, media_id, upload_parameters } = await (
        await this.fetch('https://api.pinterest.com/v5/media', {
          method: 'POST',
          body: JSON.stringify({
            media_type: 'video',
          }),
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${accessToken}`,
          },
        })
      ).json();

      const { data, status } = await axios.get(
        postDetails?.[0]?.media?.[0]?.path!,
        {
          responseType: 'stream',
        }
      );

      const formData = Object.keys(upload_parameters)
        .filter((f) => f)
        .reduce((acc, key) => {
          acc.append(key, upload_parameters[key]);
          return acc;
        }, new FormData());

      formData.append('file', data);
      await axios.post(upload_url, formData);

      let statusCode = '';
      while (statusCode !== 'succeeded') {
        const mediafile = await (
          await this.fetch(
            'https://api.pinterest.com/v5/media/' + media_id,
            {
              method: 'GET',
              headers: {
                Authorization: `Bearer ${accessToken}`,
              },
            },
            '',
            0,
            true
          )
        ).json();

        await timer(30000);
        statusCode = mediafile.status;
      }

      mediaId = media_id;
    }

    // Convert images to base64 for more reliable uploads, fall back to URL if base64 fails
    const mapImages = await Promise.all(
      postDetails?.[0]?.media?.map(async (m) => {
        try {
          const response = await axios.get(m.path, {
            responseType: 'arraybuffer',
            timeout: 10000,
          });
          const base64Image = Buffer.from(response.data).toString('base64');
          
          // Detect content type from response headers or URL extension
          let contentType = response.headers['content-type'] || 'image/jpeg';
          if (!contentType.startsWith('image/')) {
            // Fallback to detecting from URL extension
            const ext = m.path.toLowerCase().split('.').pop();
            if (ext === 'png') contentType = 'image/png';
            else if (ext === 'gif') contentType = 'image/gif';
            else if (ext === 'webp') contentType = 'image/webp';
            else contentType = 'image/jpeg';
          }
          
          console.log(`[Pinterest] Base64 encoded image: ${m.path}, size: ${base64Image.length} chars, type: ${contentType}`);
          
          return {
            path: m.path,
            base64: base64Image,
            contentType: contentType,
          };
        } catch (error) {
          // Fallback to URL if base64 conversion fails
          console.log('[Pinterest] Base64 conversion failed, using URL fallback:', m.path);
          Sentry.captureException(error, {
            extra: {
              context: 'Pinterest image base64 conversion failed',
              imagePath: m.path,
            },
          });
          return {
            path: m.path,
            base64: null,
            contentType: 'image/jpeg',
          };
        }
      }) || []
    );

    const response = await this.fetch('https://api.pinterest.com/v5/pins', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ...(postDetails?.[0]?.settings.link
          ? { link: postDetails?.[0]?.settings.link }
          : {}),
        ...(postDetails?.[0]?.settings.title
          ? { title: postDetails?.[0]?.settings.title }
          : {}),
        description: postDetails?.[0]?.message,
        ...(postDetails?.[0]?.settings.dominant_color
          ? { dominant_color: postDetails?.[0]?.settings.dominant_color }
          : {}),
        board_id: postDetails?.[0]?.settings.board,
        media_source: mediaId
          ? {
              source_type: 'video_id',
              media_id: mediaId,
              cover_image_url: picture?.path,
            }
          : mapImages?.length === 1
          ? mapImages[0].base64
            ? {
                source_type: 'image_base64',
                content_type: mapImages[0].contentType,
                data: mapImages[0].base64,
              }
            : {
                source_type: 'image_url',
                url: mapImages[0].path,
              }
          : {
              source_type: 'multiple_image_base64',
              items: mapImages
                .filter((img) => img.base64)
                .map((img) => ({ 
                  content_type: img.contentType,
                  data: img.base64 
                })),
            },
      }),
    });

    const responseData = await response.json();
    
    // Log the full response for debugging
    if (!response.ok || !responseData.id) {
      const errorDetails = {
        status: response.status,
        statusText: response.statusText,
        error_message: responseData.message || responseData.error || responseData.error_description || 'No error message provided',
        responseData: responseData,
        requestData: {
          link: postDetails?.[0]?.settings.link,
          title: postDetails?.[0]?.settings.title,
          description: postDetails?.[0]?.message,
          board_id: postDetails?.[0]?.settings.board,
          media_source_type: mediaId ? 'video_id' : (mapImages?.length === 1 ? 'image_base64' : 'multiple_image_base64'),
          base64_size: mapImages?.length === 1 && mapImages[0].base64 ? mapImages[0].base64.length : 
                       mapImages?.filter(img => img.base64).reduce((sum, img) => sum + (img.base64?.length || 0), 0),
          has_base64: mapImages?.some(img => img.base64),
        },
      };
      
      console.error('[Pinterest API Error]', JSON.stringify(errorDetails, null, 2));
      
      Sentry.captureException(new Error(`Pinterest API error: ${errorDetails.error_message}`), {
        extra: errorDetails,
      });
      
      throw new Error(`Pinterest API error (${response.status}): ${errorDetails.error_message} - Full response: ${JSON.stringify(responseData)}`);
    }

    const { id: pId } = responseData;

    return [
      {
        id: postDetails?.[0]?.id,
        postId: pId,
        releaseURL: `https://www.pinterest.com/pin/${pId}`,
        status: 'success',
      },
    ];
  }

  async analytics(
    id: string,
    accessToken: string,
    date: number
  ): Promise<AnalyticsData[]> {
    const until = dayjs().format('YYYY-MM-DD');
    const since = dayjs().subtract(date, 'day').format('YYYY-MM-DD');

    const {
      all: { daily_metrics },
    } = await (
      await fetch(
        `https://api.pinterest.com/v5/user_account/analytics?start_date=${since}&end_date=${until}`,
        {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
        }
      )
    ).json();

    const today = dayjs().format('YYYY-MM-DD');
    const yesterday = dayjs().subtract(1, 'day').format('YYYY-MM-DD');

    return daily_metrics.reduce(
      (acc: any, item: any, index: number) => {
        // Mark the latest 2 days as tentative (dotted lines on Pinterest)
        const isTentative = item.date === today || item.date === yesterday;

        if (typeof item.metrics.OUTBOUND_CLICK !== 'undefined') {
          acc[0].data.push({
            date: item.date,
            total: item.metrics.OUTBOUND_CLICK,
            tentative: isTentative,
          });
        }

        if (typeof item.metrics.IMPRESSION !== 'undefined') {
          acc[1].data.push({
            date: item.date,
            total: item.metrics.IMPRESSION,
            tentative: isTentative,
          });
        }

        if (typeof item.metrics.PIN_CLICK !== 'undefined') {
          acc[2].data.push({
            date: item.date,
            total: item.metrics.PIN_CLICK,
            tentative: isTentative,
          });
        }

        if (typeof item.metrics.ENGAGEMENT !== 'undefined') {
          acc[3].data.push({
            date: item.date,
            total: item.metrics.ENGAGEMENT,
            tentative: isTentative,
          });
        }

        if (typeof item.metrics.SAVE !== 'undefined') {
          acc[4].data.push({
            date: item.date,
            total: item.metrics.SAVE,
            tentative: isTentative,
          });
        }

        return acc;
      },
      [
        { label: 'Outbound Clicks', data: [] as any[] },
        { label: 'Impressions', data: [] as any[] },
        { label: 'Pin Clicks', data: [] as any[] },
        { label: 'Engagement', data: [] as any[] },
        { label: 'Saves', data: [] as any[] },
      ]
    );
  }
}
