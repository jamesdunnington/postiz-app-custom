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
import { BadBody } from '@gitroom/nestjs-libraries/integrations/social.abstract';
import { concurrency } from '@gitroom/helpers/utils/concurrency.service';
import { ioRedis } from '@gitroom/nestjs-libraries/redis/redis.service';

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
    'boards:read_secret',
    'boards:write',
    'boards:write_secret',
    'pins:read',
    'pins:read_secret',
    'pins:write',
    'pins:write_secret',
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
        this.scopes.join(',')
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
  async boards(
    accessToken: string,
    data?: { includeArchived?: boolean; privacy?: 'ALL' | 'PUBLIC' | 'PROTECTED' | 'SECRET' | 'PUBLIC_AND_SECRET' }
  ) {
    let allBoards: any[] = [];
    let bookmark: string | undefined = undefined;
    let hasMore = true;
    let pageCount = 0;
    const maxPages = 20; // Safety limit to prevent infinite loops
    const archivedParam = data?.includeArchived ? '&include_archived=true' : '';
    // Defaults to ALL rather than relying on Pinterest's documented "no
    // privacy param = all privacy levels" default — this guarantees
    // secret/private boards are always included by default, regardless of
    // any future change to that default. Callers that want a narrower set
    // (e.g. Pin Move only offering secret boards as archive targets, so a
    // public board can never be picked by mistake) pass an explicit value.
    const privacyParam = `&privacy=${data?.privacy || 'ALL'}`;

    try {
      // Uses this.fetch (not raw fetch()) so board listing shares the same
      // rate-limited, auto-retrying queue as every other Pinterest call this
      // app makes (posting, pin/board deletion) instead of racing against
      // Pinterest's real API limits — an account with many boards needs
      // several pages here, and an un-throttled raw fetch loop could get
      // 429'd mid-pagination and silently truncate the result.
      while (hasMore && pageCount < maxPages) {
        const url = bookmark
          ? `https://api.pinterest.com/v5/boards?page_size=250&bookmark=${bookmark}${archivedParam}${privacyParam}`
          : `https://api.pinterest.com/v5/boards?page_size=250${archivedParam}${privacyParam}`;

        const fetchResponse = await this.fetch(url, {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
        });

        const response = await fetchResponse.json();

        if (response.items && response.items.length > 0) {
          allBoards = allBoards.concat(
            response.items.map((item: any) => ({
              name: item.name,
              id: item.id,
            }))
          );
        } else {
          // No items returned, stop pagination
          break;
        }

        // Check if there's a next page
        bookmark = response.bookmark;
        hasMore = !!bookmark;
        pageCount++;
      }
    } catch (error) {
      console.error('Error fetching Pinterest boards:', error);
    }

    return allBoards;
  }

  // Uses this.fetch (not the raw fetch() boards() above uses) so board
  // creation shares the same global, rate-limit-aware queue as every other
  // Pinterest call this app makes — including pin deletion — instead of
  // racing it against Pinterest's real API limits.
  async createBoard(
    id: string,
    accessToken: string,
    board: { name: string; description?: string; isPrivate?: boolean }
  ): Promise<{ id: string }> {
    const response = await this.fetch('https://api.pinterest.com/v5/boards', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: board.name,
        description: board.description || '',
        privacy: board.isPrivate ? 'SECRET' : 'PUBLIC',
      }),
    });

    const created = await response.json();
    return { id: created.id };
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

      const lowerCaseMessage = String(errorDetails.error_message).toLowerCase();
      const isMissingBoard =
        lowerCaseMessage.includes('board') &&
        (response.status === 404 ||
          lowerCaseMessage.includes('not found') ||
          lowerCaseMessage.includes('does not exist') ||
          lowerCaseMessage.includes('invalid board'));

      const friendlyMessage = isMissingBoard
        ? 'The selected Pinterest board is no longer available (it may have been deleted or archived). Please choose a different board and post again.'
        : `Pinterest API error (${response.status}): ${errorDetails.error_message}`;

      throw new BadBody(
        'pinterest',
        JSON.stringify(responseData),
        JSON.stringify(errorDetails.requestData) as any,
        friendlyMessage
      );
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

        if (typeof item.metrics.IMPRESSION !== 'undefined') {
          acc[0].data.push({
            date: item.date,
            total: item.metrics.IMPRESSION,
            tentative: isTentative,
          });
        }

        if (typeof item.metrics.OUTBOUND_CLICK !== 'undefined') {
          acc[1].data.push({
            date: item.date,
            total: item.metrics.OUTBOUND_CLICK,
            tentative: isTentative,
          });
        }

        // Save Rate is provided directly by Pinterest's API as a decimal (e.g. 0.18 = 18%)
        if (typeof item.metrics.SAVE_RATE !== 'undefined') {
          acc[2].data.push({
            date: item.date,
            total: (item.metrics.SAVE_RATE * 100).toFixed(2),
            tentative: isTentative,
          });
        }

        if (typeof item.metrics.PIN_CLICK !== 'undefined') {
          acc[3].data.push({
            date: item.date,
            total: item.metrics.PIN_CLICK,
            tentative: isTentative,
          });
        }

        if (typeof item.metrics.ENGAGEMENT !== 'undefined') {
          acc[4].data.push({
            date: item.date,
            total: item.metrics.ENGAGEMENT,
            tentative: isTentative,
          });
        }

        if (typeof item.metrics.SAVE !== 'undefined') {
          acc[5].data.push({
            date: item.date,
            total: item.metrics.SAVE,
            tentative: isTentative,
          });
        }

        return acc;
      },
      [
        { label: 'Impressions', data: [] as any[] },
        { label: 'Outbound Clicks', data: [] as any[] },
        { label: 'Save Rate', average: true, data: [] as any[] },
        { label: 'Pin Clicks', data: [] as any[] },
        { label: 'Engagement', data: [] as any[] },
        { label: 'Saves', data: [] as any[] },
      ]
    );
  }

  private parseAnalyticsMetrics(daily_metrics: any[]): AnalyticsData[] {
    const today = dayjs().format('YYYY-MM-DD');
    const yesterday = dayjs().subtract(1, 'day').format('YYYY-MM-DD');

    return daily_metrics.reduce(
      (acc: any, item: any) => {
        const isTentative = item.date === today || item.date === yesterday;

        if (typeof item.metrics.IMPRESSION !== 'undefined') {
          acc[0].data.push({ date: item.date, total: item.metrics.IMPRESSION, tentative: isTentative });
        }
        if (typeof item.metrics.OUTBOUND_CLICK !== 'undefined') {
          acc[1].data.push({ date: item.date, total: item.metrics.OUTBOUND_CLICK, tentative: isTentative });
        }
        if (typeof item.metrics.SAVE_RATE !== 'undefined') {
          acc[2].data.push({
            date: item.date,
            total: (item.metrics.SAVE_RATE * 100).toFixed(2),
            tentative: isTentative,
          });
        }
        if (typeof item.metrics.PIN_CLICK !== 'undefined') {
          acc[3].data.push({ date: item.date, total: item.metrics.PIN_CLICK, tentative: isTentative });
        }
        if (typeof item.metrics.ENGAGEMENT !== 'undefined') {
          acc[4].data.push({ date: item.date, total: item.metrics.ENGAGEMENT, tentative: isTentative });
        }
        if (typeof item.metrics.SAVE !== 'undefined') {
          acc[5].data.push({ date: item.date, total: item.metrics.SAVE, tentative: isTentative });
        }

        return acc;
      },
      [
        { label: 'Impressions', data: [] as any[] },
        { label: 'Outbound Clicks', data: [] as any[] },
        { label: 'Save Rate', average: true, data: [] as any[] },
        { label: 'Pin Clicks', data: [] as any[] },
        { label: 'Engagement', data: [] as any[] },
        { label: 'Saves', data: [] as any[] },
      ]
    );
  }

  async analyticsCustomRange(
    id: string,
    accessToken: string,
    startDate: string,
    endDate: string
  ): Promise<AnalyticsData[]> {
    const {
      all: { daily_metrics },
    } = await (
      await fetch(
        `https://api.pinterest.com/v5/user_account/analytics?start_date=${startDate}&end_date=${endDate}`,
        {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
        }
      )
    ).json();

    return this.parseAnalyticsMetrics(daily_metrics);
  }

  // ---------------------------------------------------------------------
  // Top Pins (Analytics tab)
  //
  // Rate-limit strategy — every call below goes through the SAME shared
  // Bottleneck queue as posting (1 request/second, max 3 in flight, kept in
  // Redis), so analytics can never burst on top of scheduled posts:
  //   * top_pins is called at most twice (sorted by impressions and by
  //     outbound clicks — Pinterest caps one response at 50 pins, and the
  //     table groups pins by URL, so two lists get closer to 50 distinct URLs).
  //   * Pin title / image / destination link and the "live pins per URL"
  //     count come from paginated GET /pins (250 per page) instead of one
  //     GET /pins/{id} per top pin — ~1 call per 250 pins rather than 1 per pin.
  //   * That pin listing is cached in Redis for 6 hours and shared by every
  //     date range, so switching 7/28/30/90 days never re-lists the pins.
  //   * The first 429 (or an almost-empty x-ratelimit-remaining) stops all
  //     further calls and puts the account in a 10 minute cool-down.
  // ---------------------------------------------------------------------
  private static readonly TOP_PINS_PER_QUERY = 50; // Pinterest's max num_of_pins
  private static readonly MAX_LIVE_PIN_PAGES = 20; // 20 x 250 = 5000 pins
  private static readonly MAX_PIN_DETAIL_FALLBACKS = 10;
  private static readonly BACKOFF_SECONDS = 600;

  private static normalizeLink(link?: string): string {
    if (!link) {
      return '';
    }
    const trimmed = link.trim();
    try {
      const url = new URL(trimmed);
      url.hash = '';
      return (
        url.protocol +
        '//' +
        url.host.toLowerCase() +
        url.pathname.replace(/\/+$/, '') +
        url.search
      );
    } catch {
      return trimmed.replace(/#.*$/, '').replace(/\/+$/, '');
    }
  }

  private async queuedGet(url: string, accessToken: string) {
    const res = await concurrency<Response>(
      this.identifier,
      this.maxConcurrentJob,
      () =>
        fetch(url, {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
        })
    );

    if (!res) {
      return { ok: false, status: 0, backOff: false, json: null as any };
    }

    const remainingHeader =
      res.headers.get('x-ratelimit-remaining') ??
      res.headers.get('x-userratelimit-remaining');
    const remaining =
      remainingHeader === null ? NaN : Number(remainingHeader);
    const rateLimited = res.status === 429;

    let json: any = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }

    return {
      ok: res.ok,
      status: res.status,
      // Stop issuing further calls when Pinterest says we are (nearly) out.
      backOff: rateLimited || (Number.isFinite(remaining) && remaining <= 5),
      json,
    };
  }

  private async startBackoff(id: string) {
    await ioRedis
      .set(
        `pinterest-backoff:${id}`,
        '1',
        'EX',
        PinterestProvider.BACKOFF_SECONDS
      )
      .catch(() => undefined);
  }

  // IDs of the account's PUBLIC, NON-ARCHIVED boards. Pins on secret or
  // archived boards are excluded from Top Pins and from the live Pin Count.
  // GET /boards leaves archived boards out unless include_archived=true is
  // passed, and privacy=PUBLIC leaves out secret/protected boards.
  // Returns null when the list could not be fetched completely.
  private async getPublicBoardIds(
    id: string,
    accessToken: string,
    cacheTtl: number
  ): Promise<Set<string> | null> {
    const cacheKey = `pinterest-public-boards:${id}`;
    const cached = await ioRedis.get(cacheKey).catch(() => null);
    if (cached) {
      try {
        return new Set<string>(JSON.parse(cached));
      } catch {
        // fall through and refetch
      }
    }

    const ids: string[] = [];
    let bookmark: string | undefined;
    let pages = 0;

    while (true) {
      const response = await this.queuedGet(
        `https://api.pinterest.com/v5/boards?privacy=PUBLIC&page_size=250${
          bookmark ? `&bookmark=${encodeURIComponent(bookmark)}` : ''
        }`,
        accessToken
      );

      if (!response.ok) {
        if (response.status === 429) {
          await this.startBackoff(id);
        }
        return null;
      }

      for (const board of response.json?.items || []) {
        if (board?.id) {
          ids.push(String(board.id));
        }
      }

      bookmark = response.json?.bookmark || undefined;
      pages++;

      if (response.backOff) {
        await this.startBackoff(id);
        // an incomplete board list would wrongly hide real pins
        return bookmark ? null : this.cacheBoardIds(cacheKey, ids, cacheTtl);
      }
      if (!bookmark) {
        break;
      }
      if (pages >= PinterestProvider.MAX_LIVE_PIN_PAGES) {
        return null;
      }
    }

    return this.cacheBoardIds(cacheKey, ids, cacheTtl);
  }

  private async cacheBoardIds(key: string, ids: string[], ttl: number) {
    await ioRedis.set(key, JSON.stringify(ids), 'EX', ttl).catch(() => undefined);
    return new Set<string>(ids);
  }

  private async getLivePins(
    id: string,
    accessToken: string,
    cacheTtl: number
  ): Promise<{
    pins: {
      id: string;
      link: string;
      title: string;
      image: string;
      board: string;
    }[];
    truncated: boolean;
  } | null> {
    const cacheKey = `pinterest-live-pins-v2:${id}`;
    const cached = await ioRedis.get(cacheKey).catch(() => null);
    if (cached) {
      try {
        return JSON.parse(cached);
      } catch {
        // fall through and refetch
      }
    }

    const pins: {
      id: string;
      link: string;
      title: string;
      image: string;
      board: string;
    }[] = [];
    let bookmark: string | undefined;
    let pages = 0;
    let truncated = false;
    let failed = false;

    while (true) {
      const response = await this.queuedGet(
        `https://api.pinterest.com/v5/pins?page_size=250${
          bookmark ? `&bookmark=${encodeURIComponent(bookmark)}` : ''
        }`,
        accessToken
      );

      if (!response.ok) {
        if (response.status === 429) {
          await this.startBackoff(id);
        }
        failed = true;
        truncated = true;
        break;
      }

      for (const pin of response.json?.items || []) {
        pins.push({
          id: pin.id,
          link: pin.link || '',
          title: (pin.title || pin.description || '').substring(0, 60),
          image:
            pin.media?.images?.['150x150']?.url ||
            pin.media?.images?.['400x300']?.url ||
            '',
          board: pin.board_id ? String(pin.board_id) : '',
        });
      }

      bookmark = response.json?.bookmark || undefined;
      pages++;

      if (response.backOff) {
        await this.startBackoff(id);
        truncated = !!bookmark;
        failed = true;
        break;
      }
      if (!bookmark) {
        break;
      }
      if (pages >= PinterestProvider.MAX_LIVE_PIN_PAGES) {
        truncated = true;
        break;
      }
    }

    if (!pins.length) {
      return null;
    }

    const result = { pins, truncated };
    // A listing cut short by an error is only kept briefly so it is retried soon.
    await ioRedis
      .set(
        cacheKey,
        JSON.stringify(result),
        'EX',
        failed ? Math.min(cacheTtl, 600) : cacheTtl
      )
      .catch(() => undefined);
    return result;
  }

  async getTopBoardsAndPins(
    id: string,
    accessToken: string,
    date: number,
    startDate?: string,
    endDate?: string
  ): Promise<{
    topBoards: any[];
    topPins: any[];
    livePinsTruncated?: boolean;
  }> {
    const since =
      date === -1 && startDate
        ? startDate
        : dayjs().subtract(date, 'day').format('YYYY-MM-DD');
    const until =
      date === -1 && endDate ? endDate : dayjs().format('YYYY-MM-DD');

    const isDev =
      !process.env.NODE_ENV || process.env.NODE_ENV === 'development';
    const cacheTtl = isDev ? 1 : 6 * 60 * 60;

    // Cool-down after a previous 429 — do not touch Pinterest at all.
    if (await ioRedis.get(`pinterest-backoff:${id}`).catch(() => null)) {
      Sentry.logger.warn(
        'Skipping Pinterest top pins, in rate-limit cool-down',
        { id }
      );
      return { topBoards: [], topPins: [] };
    }

    try {
      // 1) Top pins by impressions, then by outbound clicks (union, de-duplicated).
      const topPinMetrics = new Map<string, any>();
      let backOff = false;

      for (const sortBy of ['IMPRESSION', 'OUTBOUND_CLICK']) {
        if (backOff) {
          break;
        }
        const response = await this.queuedGet(
          `https://api.pinterest.com/v5/user_account/analytics/top_pins?start_date=${since}&end_date=${until}&sort_by=${sortBy}&from_claimed_content=BOTH&pin_format=ALL&app_types=ALL&content_type=ALL&source=ALL&metric_types=IMPRESSION,PIN_CLICK,OUTBOUND_CLICK,SAVE&num_of_pins=${PinterestProvider.TOP_PINS_PER_QUERY}`,
          accessToken
        );

        if (!response.ok) {
          Sentry.logger.warn('Pinterest top_pins request failed', {
            status: response.status,
            sortBy,
          });
          if (response.status === 429) {
            await this.startBackoff(id);
          }
          backOff = true;
          continue;
        }

        for (const pin of response.json?.pins || []) {
          const pinId = pin.pin_id || pin.id;
          if (pinId && !topPinMetrics.has(pinId)) {
            topPinMetrics.set(pinId, pin);
          }
        }

        if (response.backOff) {
          await this.startBackoff(id);
          backOff = true;
        }
      }

      if (!topPinMetrics.size) {
        return { topBoards: [], topPins: [] };
      }

      // Secret and archived boards must not appear in the results, so every
      // pin has to be confirmed to sit on a public, non-archived board. If we
      // cannot confirm that (rate limit / API error), show nothing rather than
      // risk showing pins from those boards. The short failure cache and the
      // cool-down keep this from hammering Pinterest.
      if (backOff) {
        return { topBoards: [], topPins: [] };
      }

      // 2) Public board ids + live pin listing: gives link/title/image for the
      //    top pins AND how many live pins point at each destination URL.
      const publicBoards = await this.getPublicBoardIds(
        id,
        accessToken,
        cacheTtl
      );
      const live = publicBoards
        ? await this.getLivePins(id, accessToken, cacheTtl)
        : null;

      if (!publicBoards || !live) {
        Sentry.logger.warn(
          'Pinterest top pins: could not verify board privacy, returning none',
          { id }
        );
        return { topBoards: [], topPins: [] };
      }

      const listedIds = new Set<string>();
      const publicById = new Map<
        string,
        { link: string; title: string; image: string }
      >();
      const liveCounts = new Map<string, number>();
      for (const pin of live.pins) {
        listedIds.add(pin.id);
        if (!pin.board || !publicBoards.has(pin.board)) {
          continue; // secret or archived board
        }
        publicById.set(pin.id, pin);
        const key = PinterestProvider.normalizeLink(pin.link);
        if (key) {
          liveCounts.set(key, (liveCounts.get(key) || 0) + 1);
        }
      }

      // 3) Top pins missing from a truncated listing: a small, sequential,
      //    capped number of single-pin lookups (each also checked against the
      //    public board list).
      let fallbacks = 0;
      const topPins: any[] = [];
      for (const [pinId, pin] of topPinMetrics) {
        let details = publicById.get(pinId);

        if (!details) {
          // Listed but on a secret/archived board -> excluded. Not listed at
          // all and the listing is complete -> deleted/hidden -> excluded.
          if (
            listedIds.has(pinId) ||
            !live.truncated ||
            backOff ||
            fallbacks >= PinterestProvider.MAX_PIN_DETAIL_FALLBACKS
          ) {
            continue;
          }

          fallbacks++;
          const detail = await this.queuedGet(
            `https://api.pinterest.com/v5/pins/${pinId}`,
            accessToken
          );
          if (detail.status === 429 || detail.backOff) {
            await this.startBackoff(id);
            backOff = true;
          }
          const board = detail.json?.board_id
            ? String(detail.json.board_id)
            : '';
          if (!detail.ok || !board || !publicBoards.has(board)) {
            continue;
          }
          details = {
            link: detail.json?.link || '',
            title: (
              detail.json?.title ||
              detail.json?.description ||
              ''
            ).substring(0, 60),
            image:
              detail.json?.media?.images?.['150x150']?.url ||
              detail.json?.media?.images?.['400x300']?.url ||
              '',
          };
        }

        const destinationUrl = details.link || pin.link || '';
        topPins.push({
          id: pinId,
          title: details.title || pin.title || '',
          imageUrl:
            details.image ||
            pin.media?.images?.['150x150']?.url ||
            pin.image_medium_url ||
            '',
          url: `https://www.pinterest.com/pin/${pinId}`,
          destinationUrl,
          livePinCount:
            liveCounts.get(PinterestProvider.normalizeLink(destinationUrl)) ||
            0,
          impressions: pin.metrics?.IMPRESSION || 0,
          pinClicks: pin.metrics?.PIN_CLICK || 0,
          outboundClicks: pin.metrics?.OUTBOUND_CLICK || 0,
          saves: pin.metrics?.SAVE || 0,
        });
      }

      return {
        topBoards: [],
        topPins,
        livePinsTruncated: live.truncated,
      };
    } catch (err) {
      // top_pins_analytics may not be available for all account types
      Sentry.logger.warn('Pinterest top pins failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return { topBoards: [], topPins: [] };
    }
  }
}
