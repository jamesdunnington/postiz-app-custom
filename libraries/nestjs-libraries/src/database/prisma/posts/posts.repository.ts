import { PrismaRepository } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { Injectable } from '@nestjs/common';
import { Post as PostBody } from '@gitroom/nestjs-libraries/dtos/posts/create.post.dto';
import { APPROVED_SUBMIT_FOR_ORDER, Post, State } from '@prisma/client';
import { GetPostsDto } from '@gitroom/nestjs-libraries/dtos/posts/get.posts.dto';
import dayjs from 'dayjs';
import isoWeek from 'dayjs/plugin/isoWeek';
import weekOfYear from 'dayjs/plugin/weekOfYear';
import isSameOrAfter from 'dayjs/plugin/isSameOrAfter';
import utc from 'dayjs/plugin/utc';
import { v4 as uuidv4 } from 'uuid';
import { CreateTagDto } from '@gitroom/nestjs-libraries/dtos/posts/create.tag.dto';

dayjs.extend(isoWeek);
dayjs.extend(weekOfYear);
dayjs.extend(isSameOrAfter);
dayjs.extend(utc);

@Injectable()
export class PostsRepository {
  constructor(
    private _post: PrismaRepository<'post'>,
    private _popularPosts: PrismaRepository<'popularPosts'>,
    private _comments: PrismaRepository<'comments'>,
    private _tags: PrismaRepository<'tags'>,
    private _tagsPosts: PrismaRepository<'tagsPosts'>,
    private _errors: PrismaRepository<'errors'>
  ) {}

  checkPending15minutesBack() {
    return this._post.model.post.findMany({
      where: {
        publishDate: {
          lte: dayjs.utc().subtract(15, 'minute').toDate(),
          gte: dayjs.utc().subtract(30, 'minute').toDate(),
        },
        state: 'QUEUE',
        deletedAt: null,
        parentPostId: null,
      },
      select: {
        id: true,
        publishDate: true,
      },
    });
  }

  searchForMissingThreeHoursPosts() {
    return this._post.model.post.findMany({
      where: {
        integration: {
          refreshNeeded: false,
          inBetweenSteps: false,
          disabled: false,
        },
        publishDate: {
          gte: dayjs.utc().toDate(),
          lt: dayjs.utc().add(3, 'hour').toDate(),
        },
        state: 'QUEUE',
        deletedAt: null,
        parentPostId: null,
      },
      select: {
        id: true,
        publishDate: true,
      },
    });
  }

  getOldPosts(orgId: string, date: string) {
    return this._post.model.post.findMany({
      where: {
        integration: {
          refreshNeeded: false,
          inBetweenSteps: false,
          disabled: false,
        },
        organizationId: orgId,
        publishDate: {
          lte: dayjs(date).toDate(),
        },
        deletedAt: null,
        parentPostId: null,
      },
      orderBy: {
        publishDate: 'desc',
      },
      select: {
        id: true,
        content: true,
        publishDate: true,
        releaseURL: true,
        state: true,
        integration: {
          select: {
            id: true,
            name: true,
            providerIdentifier: true,
            picture: true,
            type: true,
          },
        },
      },
    });
  }

  updateImages(id: string, images: string) {
    return this._post.model.post.update({
      where: {
        id,
      },
      data: {
        image: images,
      },
    });
  }

  getPostUrls(orgId: string, ids: string[]) {
    return this._post.model.post.findMany({
      where: {
        organizationId: orgId,
        id: {
          in: ids,
        },
      },
      select: {
        id: true,
        releaseURL: true,
      },
    });
  }

  async getPosts(orgId: string, query: GetPostsDto) {
    // Use the provided start and end dates directly
    const startDate = dayjs.utc(query.startDate).toDate();
    const endDate = dayjs.utc(query.endDate).toDate();

    const list = await this._post.model.post.findMany({
      where: {
        AND: [
          {
            OR: [
              {
                organizationId: orgId,
              },
              {
                submittedForOrganizationId: orgId,
              },
            ],
          },
          {
            OR: [
              {
                publishDate: {
                  gte: startDate,
                  lte: endDate,
                },
              },
              {
                intervalInDays: {
                  not: null,
                },
              },
            ],
          },
        ],
        deletedAt: null,
        parentPostId: null,
        ...(query.customer
          ? {
              integration: {
                customerId: query.customer,
              },
            }
          : {}),
      },
      select: {
        id: true,
        content: true,
        publishDate: true,
        releaseURL: true,
        submittedForOrganizationId: true,
        submittedForOrderId: true,
        state: true,
        intervalInDays: true,
        group: true,
        tags: {
          select: {
            tag: true,
          },
        },
        integration: {
          select: {
            id: true,
            providerIdentifier: true,
            name: true,
            picture: true,
          },
        },
      },
    });

    return list.reduce((all, post) => {
      if (!post.intervalInDays) {
        return [...all, post];
      }

      const addMorePosts = [];
      let startingDate = dayjs.utc(post.publishDate);
      while (dayjs.utc(endDate).isSameOrAfter(startingDate)) {
        if (dayjs(startingDate).isSameOrAfter(dayjs.utc(post.publishDate))) {
          addMorePosts.push({
            ...post,
            publishDate: startingDate.toDate(),
            actualDate: post.publishDate,
          });
        }

        startingDate = startingDate.add(post.intervalInDays, 'days');
      }

      return [...all, ...addMorePosts];
    }, [] as any[]);
  }

  async deletePost(orgId: string, group: string) {
    await this._post.model.post.updateMany({
      where: {
        organizationId: orgId,
        group,
      },
      data: {
        deletedAt: new Date(),
      },
    });

    return this._post.model.post.findFirst({
      where: {
        organizationId: orgId,
        group,
        parentPostId: null,
      },
      select: {
        id: true,
      },
    });
  }

  getPost(
    id: string,
    includeIntegration = false,
    orgId?: string,
    isFirst?: boolean
  ) {
    return this._post.model.post.findUnique({
      where: {
        id,
        ...(orgId ? { organizationId: orgId } : {}),
        deletedAt: null,
      },
      include: {
        ...(includeIntegration
          ? {
              integration: true,
              tags: {
                select: {
                  tag: true,
                },
              },
            }
          : {}),
        childrenPost: true,
      },
    });
  }

  updatePost(id: string, postId: string, releaseURL: string) {
    return this._post.model.post.update({
      where: {
        id,
      },
      data: {
        state: 'PUBLISHED',
        releaseURL,
        releaseId: postId,
      },
    });
  }

  async changeState(id: string, state: State, err?: any, body?: any) {
    const update = await this._post.model.post.update({
      where: {
        id,
      },
      data: {
        state,
        ...(err
          ? { error: typeof err === 'string' ? err : JSON.stringify(err) }
          : {}),
      },
      include: {
        integration: {
          select: {
            providerIdentifier: true,
          },
        },
      },
    });

    if (state === 'ERROR' && err && body) {
      try {
        await this._errors.model.errors.create({
          data: {
            message: typeof err === 'string' ? err : JSON.stringify(err),
            organizationId: update.organizationId,
            platform: update.integration.providerIdentifier,
            postId: update.id,
            body: typeof body === 'string' ? body : JSON.stringify(body),
          },
        });
      } catch (err) {}
    }

    return update;
  }

  async checkForDuplicateAtTime(
    integrationId: string,
    publishDate: Date,
    excludePostId?: string
  ) {
    const targetMinute = dayjs(publishDate).second(0).millisecond(0);
    const startOfMinute = targetMinute.toDate();
    const endOfMinute = targetMinute.add(1, 'minute').toDate();

    return this._post.model.post.findFirst({
      where: {
        integrationId,
        publishDate: {
          gte: startOfMinute,
          lt: endOfMinute,
        },
        deletedAt: null,
        state: {
          in: ['QUEUE', 'DRAFT', 'PUBLISHED'],
        },
        ...(excludePostId ? { id: { not: excludePostId } } : {}),
      },
      select: {
        id: true,
        publishDate: true,
        state: true,
      },
    });
  }

  async changeDate(orgId: string, id: string, date: string) {
    // Get the post to check its integration
    const post = await this._post.model.post.findUnique({
      where: { id },
      select: {
        integrationId: true,
        state: true,
        integration: {
          select: {
            postingTimes: true,
          },
        },
      },
    });

    if (!post) {
      throw new Error(`Post ${id} not found`);
    }

    let finalPublishDate = dayjs(date).toDate();

    // Check for duplicate if post is QUEUE or DRAFT
    if (post.state === 'QUEUE' || post.state === 'DRAFT') {
      const existingPost = await this.checkForDuplicateAtTime(
        post.integrationId,
        finalPublishDate,
        id // Exclude current post
      );

      if (existingPost) {
        console.log(
          `[changeDate] Duplicate detected at ${dayjs(finalPublishDate).format('YYYY-MM-DD HH:mm')} ` +
          `for integration ${post.integrationId}. Auto-rescheduling to next available slot.`
        );

        const postingTimes = post.integration?.postingTimes as number[] || [];

        if (postingTimes.length > 0) {
          const availableSlots = await this.getNextAvailableSlots(
            orgId,
            post.integrationId,
            1,
            postingTimes,
            true // searchFromEnd
          );

          if (availableSlots.length > 0) {
            finalPublishDate = availableSlots[0];
            console.log(
              `[changeDate] Rescheduled to ${dayjs(finalPublishDate).format('YYYY-MM-DD HH:mm')}`
            );
          }
        }
      }
    }

    return this._post.model.post.update({
      where: {
        organizationId: orgId,
        id,
      },
      data: {
        publishDate: finalPublishDate,
      },
    });
  }

  countPostsFromDay(orgId: string, date: Date) {
    return this._post.model.post.count({
      where: {
        organizationId: orgId,
        publishDate: {
          gte: date,
        },
        OR: [
          {
            deletedAt: null,
            state: {
              in: ['QUEUE'],
            },
          },
          {
            state: 'PUBLISHED',
          },
        ],
      },
    });
  }

  async createOrUpdatePost(
    state: 'draft' | 'schedule' | 'now',
    orgId: string,
    date: string,
    body: PostBody,
    tags: { value: string; label: string }[],
    inter?: number
  ) {
    const posts: Post[] = [];
    const uuid = uuidv4();

    for (const value of body.value) {
      // Check for duplicate schedule and auto-reschedule if needed
      let finalPublishDate = dayjs(date).toDate();
      
      if (state === 'schedule' && body.integration?.id) {
        const existingPost = await this.checkForDuplicateAtTime(
          body.integration.id,
          finalPublishDate,
          value.id // Exclude current post if updating
        );
        
        if (existingPost) {
          console.log(
            `[createOrUpdatePost] Duplicate detected at ${dayjs(finalPublishDate).format('YYYY-MM-DD HH:mm')} ` +
            `for integration ${body.integration.id}. Auto-rescheduling to end of schedule.`
          );
          
          // Get posting times for this integration
          const integration = await this._post.model.integration.findUnique({
            where: { id: body.integration.id },
            select: { postingTimes: true },
          });
          
          const postingTimes = integration?.postingTimes as number[] || [];
          
          if (postingTimes.length > 0) {
            const availableSlots = await this.getNextAvailableSlots(
              orgId,
              body.integration.id,
              1,
              postingTimes,
              true // searchFromEnd
            );
            
            if (availableSlots.length > 0) {
              finalPublishDate = availableSlots[0];
              console.log(
                `[createOrUpdatePost] Rescheduled to ${dayjs(finalPublishDate).format('YYYY-MM-DD HH:mm')}`
              );
            }
          }
        }
      }
      
      const updateData = (type: 'create' | 'update') => ({
        publishDate: finalPublishDate,
        integration: {
          connect: {
            id: body.integration.id,
            organizationId: orgId,
          },
        },
        ...(posts?.[posts.length - 1]?.id
          ? {
              parentPost: {
                connect: {
                  id: posts[posts.length - 1]?.id,
                },
              },
            }
          : type === 'update'
          ? {
              parentPost: {
                disconnect: true,
              },
            }
          : {}),
        content: value.content,
        group: uuid,
        intervalInDays: inter ? +inter : null,
        approvedSubmitForOrder: APPROVED_SUBMIT_FOR_ORDER.NO,
        state: state === 'draft' ? ('DRAFT' as const) : ('QUEUE' as const),
        image: JSON.stringify(value.image),
        settings: JSON.stringify(body.settings),
        organization: {
          connect: {
            id: orgId,
          },
        },
      });

      posts.push(
        await this._post.model.post.upsert({
          where: {
            id: value.id || uuidv4(),
          },
          create: { ...updateData('create') },
          update: {
            ...updateData('update'),
            lastMessage: {
              disconnect: true,
            },
            submittedForOrder: {
              disconnect: true,
            },
          },
        })
      );

      if (posts.length === 1) {
        await this._tagsPosts.model.tagsPosts.deleteMany({
          where: {
            post: {
              id: posts[0].id,
            },
          },
        });

        if (tags.length) {
          const tagsList = await this._tags.model.tags.findMany({
            where: {
              orgId: orgId,
              name: {
                in: tags.map((tag) => tag.label).filter((f) => f),
              },
            },
          });

          if (tagsList.length) {
            await this._post.model.post.update({
              where: {
                id: posts[posts.length - 1].id,
              },
              data: {
                tags: {
                  createMany: {
                    data: tagsList.map((tag) => ({
                      tagId: tag.id,
                    })),
                  },
                },
              },
            });
          }
        }
      }
    }

    const previousPost = body.group
      ? (
          await this._post.model.post.findFirst({
            where: {
              group: body.group,
              deletedAt: null,
              parentPostId: null,
            },
            select: {
              id: true,
            },
          })
        )?.id!
      : undefined;

    if (body.group) {
      await this._post.model.post.updateMany({
        where: {
          group: body.group,
          deletedAt: null,
        },
        data: {
          parentPostId: null,
          deletedAt: new Date(),
        },
      });
    }

    return { previousPost, posts };
  }

  async submit(id: string, order: string, buyerOrganizationId: string) {
    return this._post.model.post.update({
      where: {
        id,
      },
      data: {
        submittedForOrderId: order,
        approvedSubmitForOrder: 'WAITING_CONFIRMATION',
        submittedForOrganizationId: buyerOrganizationId,
      },
      select: {
        id: true,
        description: true,
        submittedForOrder: {
          select: {
            messageGroupId: true,
          },
        },
      },
    });
  }

  updateMessage(id: string, messageId: string) {
    return this._post.model.post.update({
      where: {
        id,
      },
      data: {
        lastMessageId: messageId,
      },
    });
  }

  getPostById(id: string, org?: string) {
    return this._post.model.post.findUnique({
      where: {
        id,
        ...(org ? { organizationId: org } : {}),
      },
      include: {
        integration: true,
        submittedForOrder: {
          include: {
            posts: {
              where: {
                state: 'PUBLISHED',
              },
            },
            ordersItems: true,
            seller: {
              select: {
                id: true,
                account: true,
              },
            },
          },
        },
      },
    });
  }

  findAllExistingCategories() {
    return this._popularPosts.model.popularPosts.findMany({
      select: {
        category: true,
      },
      distinct: ['category'],
    });
  }

  findAllExistingTopicsOfCategory(category: string) {
    return this._popularPosts.model.popularPosts.findMany({
      where: {
        category,
      },
      select: {
        topic: true,
      },
      distinct: ['topic'],
    });
  }

  findPopularPosts(category: string, topic?: string) {
    return this._popularPosts.model.popularPosts.findMany({
      where: {
        category,
        ...(topic ? { topic } : {}),
      },
      select: {
        content: true,
        hook: true,
      },
    });
  }

  createPopularPosts(post: {
    category: string;
    topic: string;
    content: string;
    hook: string;
  }) {
    return this._popularPosts.model.popularPosts.create({
      data: {
        category: 'category',
        topic: 'topic',
        content: 'content',
        hook: 'hook',
      },
    });
  }

  async getPostsCountsByDates(
    orgId: string,
    times: number[],
    date: dayjs.Dayjs
  ) {
    const dates = await this._post.model.post.findMany({
      where: {
        deletedAt: null,
        organizationId: orgId,
        publishDate: {
          in: times.map((time) => {
            return date.clone().add(time, 'minutes').toDate();
          }),
        },
      },
    });

    return times.filter(
      (time) =>
        date.clone().add(time, 'minutes').isAfter(dayjs.utc()) &&
        !dates.find((dateFind) => {
          return (
            dayjs
              .utc(dateFind.publishDate)
              .diff(date.clone().startOf('day'), 'minutes') == time
          );
        })
    );
  }

  async getComments(postId: string) {
    return this._comments.model.comments.findMany({
      where: {
        postId,
      },
      orderBy: {
        createdAt: 'asc',
      },
    });
  }

  async getTags(orgId: string) {
    return this._tags.model.tags.findMany({
      where: {
        orgId,
      },
    });
  }

  createTag(orgId: string, body: CreateTagDto) {
    return this._tags.model.tags.create({
      data: {
        orgId,
        name: body.name,
        color: body.color,
      },
    });
  }

  editTag(id: string, orgId: string, body: CreateTagDto) {
    return this._tags.model.tags.update({
      where: {
        id,
      },
      data: {
        name: body.name,
        color: body.color,
      },
    });
  }

  createComment(
    orgId: string,
    userId: string,
    postId: string,
    content: string
  ) {
    return this._comments.model.comments.create({
      data: {
        organizationId: orgId,
        userId,
        postId,
        content,
      },
    });
  }

  async getPostsSince(orgId: string, since: string) {
    return this._post.model.post.findMany({
      where: {
        organizationId: orgId,
        publishDate: {
          gte: new Date(since),
        },
        deletedAt: null,
        parentPostId: null,
      },
      select: {
        id: true,
        content: true,
        publishDate: true,
        releaseURL: true,
        state: true,
        integration: {
          select: {
            id: true,
            name: true,
            providerIdentifier: true,
            picture: true,
            type: true,
          },
        },
      },
    });
  }

  async getMissedPostsForIntegration(integrationId: string) {
    return this._post.model.post.findMany({
      where: {
        integrationId,
        state: 'QUEUE',
        publishDate: {
          lt: dayjs.utc().toDate(),
        },
        deletedAt: null,
        parentPostId: null,
      },
      orderBy: {
        publishDate: 'asc',
      },
      select: {
        id: true,
        publishDate: true,
        organizationId: true,
      },
    });
  }

  async updatePostPublishDate(postId: string, newPublishDate: Date) {
    return this._post.model.post.update({
      where: {
        id: postId,
      },
      data: {
        publishDate: newPublishDate,
      },
    });
  }

  async getNextAvailableSlots(
    orgId: string,
    integrationId: string,
    count: number,
    postingTimes: { time: number }[],
    searchFromEnd: boolean = false
  ) {
    console.log(`[getNextAvailableSlots] Looking for ${count} slot(s) for integration ${integrationId}, searchFromEnd: ${searchFromEnd}`);
    console.log(`[getNextAvailableSlots] Has ${postingTimes.length} posting times configured`);
    
    const slots: Date[] = [];
    const usedTimestamps = new Set<number>(); // Track timestamps to prevent duplicates
    let daysChecked = 0; // Track days checked for logging
    
    if (searchFromEnd) {
      // For duplicate resolution: find the last occupied slot first, then continue from there
      const lastPost = await this._post.model.post.findFirst({
        where: {
          integrationId,
          organizationId: orgId,
          state: 'QUEUE',
          deletedAt: null,
        },
        orderBy: {
          publishDate: 'desc'
        },
        select: {
          publishDate: true
        }
      });
      
      const startDay = lastPost ? dayjs.utc(lastPost.publishDate).add(1, 'day').startOf('day') : dayjs.utc();
      console.log(`[getNextAvailableSlots] Starting search from ${startDay.format('YYYY-MM-DD')} (after last scheduled post at ${lastPost ? dayjs.utc(lastPost.publishDate).format('YYYY-MM-DD HH:mm') : 'N/A'})`);
      console.log(`[getNextAvailableSlots] Will search using configured posting times: ${postingTimes.slice(0, 3).map(t => `${Math.floor(t.time/60)}:${String(t.time%60).padStart(2,'0')}`).join(', ')}...`);
      
      let currentDay = startDay;
      const maxDaysToCheck = 90;

      while (slots.length < count && daysChecked < maxDaysToCheck) {
      for (const { time } of postingTimes) {
        if (slots.length >= count) break;

        const hours = Math.floor(time / 60);
        const minutes = time % 60;
        const slotTime = currentDay.hour(hours).minute(minutes).second(0).millisecond(0);
        const slotTimestamp = slotTime.valueOf();

        // Only consider future slots
        if (slotTime.isAfter(dayjs.utc())) {
          // Check if this slot timestamp has already been assigned in this session
          if (usedTimestamps.has(slotTimestamp)) {
            continue;
          }

          // Check if this slot is already occupied in the database (at minute-level precision)
          const slotDate = slotTime.toDate();
          const endOfMinute = slotTime.add(1, 'minute').toDate();
          
          const existingPost = await this._post.model.post.findFirst({
            where: {
              integrationId,
              organizationId: orgId,
              publishDate: {
                gte: slotDate,
                lt: endOfMinute,
              },
              deletedAt: null,
              state: {
                in: ['QUEUE', 'PUBLISHED'],
              },
            },
          });

          if (!existingPost) {
            slots.push(slotTime.toDate());
            usedTimestamps.add(slotTimestamp); // Mark this timestamp as used
            console.log(`[getNextAvailableSlots] Found available slot: ${slotTime.format('YYYY-MM-DD HH:mm')}`);
          }
        }
      }

        currentDay = currentDay.add(1, 'day');
        daysChecked++;
      }
    } else {
      // Original logic: search from now
      let currentDay = dayjs.utc();
      const maxDaysToCheck = 90;

      while (slots.length < count && daysChecked < maxDaysToCheck) {
        for (const { time } of postingTimes) {
          if (slots.length >= count) break;

          const hours = Math.floor(time / 60);
          const minutes = time % 60;
          const slotTime = currentDay.hour(hours).minute(minutes).second(0).millisecond(0);
          const slotTimestamp = slotTime.valueOf();

          // Only consider future slots
          if (slotTime.isAfter(dayjs.utc())) {
            // Check if this slot timestamp has already been assigned in this session
            if (usedTimestamps.has(slotTimestamp)) {
              continue;
            }

            // Check if this slot is already occupied in the database (at minute-level precision)
            const slotDate = slotTime.toDate();
            const endOfMinute = slotTime.add(1, 'minute').toDate();
            
            const existingPost = await this._post.model.post.findFirst({
              where: {
                integrationId,
                organizationId: orgId,
                publishDate: {
                  gte: slotDate,
                  lt: endOfMinute,
                },
                deletedAt: null,
                state: {
                  in: ['QUEUE', 'PUBLISHED'],
                },
              },
            });

            if (!existingPost) {
              slots.push(slotTime.toDate());
              usedTimestamps.add(slotTimestamp); // Mark this timestamp as used
              console.log(`[getNextAvailableSlots] Found available slot: ${slotTime.format('YYYY-MM-DD HH:mm')}`);
            }
          }
        }

        currentDay = currentDay.add(1, 'day');
        daysChecked++;
      }
    }

    console.log(`[getNextAvailableSlots] Found ${slots.length} slot(s) after checking ${daysChecked} days`);
    return slots;
  }

  // Find duplicate schedules (same integration + same publishDate at minute-level precision)
  async findDuplicateSchedules() {
    const now = dayjs.utc();
    const startOfToday = now.startOf('day').toDate();
    
    console.log(`[findDuplicateSchedules] Searching for duplicates from ${startOfToday.toISOString()} onwards`);
    
    // Get all QUEUE/PUBLISHED posts from today onwards to detect all duplicates
    // (including ones that already posted, to identify the root cause)
    const posts = await this._post.model.post.findMany({
      where: {
        state: {
          in: ['QUEUE', 'PUBLISHED'],
        },
        deletedAt: null,
        publishDate: {
          gte: startOfToday, // Start from beginning of today, not just future posts
        },
      },
      select: {
        id: true,
        integrationId: true,
        organizationId: true,
        publishDate: true,
        createdAt: true,
        state: true,
      },
      orderBy: {
        createdAt: 'asc', // Oldest first
      },
    });

    // Group by integration + minute (ignoring seconds)
    const grouped = new Map<string, typeof posts>();
    
    for (const post of posts) {
      const minute = dayjs(post.publishDate).second(0).millisecond(0).toISOString();
      const key = `${post.integrationId}:${minute}`;
      
      if (!grouped.has(key)) {
        grouped.set(key, []);
      }
      grouped.get(key)!.push(post);
    }

    // Return ONLY QUEUE posts from slots that have duplicates
    // PUBLISHED posts are logged for diagnostics but NEVER rescheduled
    const duplicates = [];
    const duplicateSlots = [];
    const publishedDuplicateCount = { total: 0 };
    
    for (const [key, postsInSlot] of grouped.entries()) {
      if (postsInSlot.length > 1) {
        const queuePosts = postsInSlot.filter(p => p.state === 'QUEUE');
        const publishedPosts = postsInSlot.filter(p => p.state === 'PUBLISHED');
        
        duplicateSlots.push({
          key,
          total: postsInSlot.length,
          queue: queuePosts.length,
          published: publishedPosts.length,
          times: postsInSlot.map(p => dayjs(p.publishDate).format('YYYY-MM-DD HH:mm:ss'))
        });
        
        // ONLY return QUEUE posts for rescheduling - NEVER PUBLISHED
        duplicates.push(...queuePosts);
        publishedDuplicateCount.total += publishedPosts.length;
      }
    }

    console.log(`[findDuplicateSchedules] Found ${posts.length} total posts (QUEUE/PUBLISHED), ${duplicates.length} QUEUE duplicates will be rescheduled`);
    if (publishedDuplicateCount.total > 0) {
      console.log(`[findDuplicateSchedules] WARNING: Found ${publishedDuplicateCount.total} PUBLISHED duplicates (already posted, cannot reschedule)`);
    }
    if (duplicateSlots.length > 0) {
      console.log(`[findDuplicateSchedules] Duplicate slots detail:`, JSON.stringify(duplicateSlots.slice(0, 5), null, 2));
    }
    
    // Diagnostic: Show posting schedule for first few integrations
    const integrationSchedule = new Map<string, any[]>();
    for (const post of posts.slice(0, 200)) { // Check first 200 posts
      if (!integrationSchedule.has(post.integrationId)) {
        integrationSchedule.set(post.integrationId, []);
      }
      integrationSchedule.get(post.integrationId)!.push({
        id: post.id,
        time: dayjs(post.publishDate).format('YYYY-MM-DD HH:mm:ss')
      });
    }
    
    // Show integrations with multiple posts soon
    const integrationsToPrint = Array.from(integrationSchedule.entries())
      .filter(([_, posts]) => posts.length >= 2)
      .slice(0, 3);
    
    if (integrationsToPrint.length > 0) {
      console.log(`[findDuplicateSchedules] Sample integration schedules (first 5 posts each):`);
      for (const [integrationId, posts] of integrationsToPrint) {
        console.log(`  Integration ${integrationId}:`, posts.slice(0, 5).map(p => p.time).join(', '));
      }
    }
    
    return duplicates;
  }

  // Get all posts for a specific integration and publish date (at minute-level precision)
  async getPostsByIntegrationAndDate(integrationId: string, publishDate: Date) {
    // Find posts within the same minute (ignore seconds/milliseconds)
    const startOfMinute = dayjs(publishDate).second(0).millisecond(0).toDate();
    const endOfMinute = dayjs(startOfMinute).add(1, 'minute').toDate();
    
    console.log(`[getPostsByIntegrationAndDate] Query for ${integrationId} between ${startOfMinute.toISOString()} and ${endOfMinute.toISOString()}`);
    
    const posts = await this._post.model.post.findMany({
      where: {
        integrationId,
        publishDate: {
          gte: startOfMinute,
          lt: endOfMinute,
        },
        state: 'QUEUE',
        deletedAt: null,
      },
      orderBy: {
        createdAt: 'asc', // Keep the oldest post, reschedule newer ones
      },
    });
    
    console.log(`[getPostsByIntegrationAndDate] Found ${posts.length} posts`);
    return posts;
  }

  // Find PUBLISHED posts scheduled for future dates (anomaly detection)
  async findFuturePublishedPosts(orgId?: string) {
    const now = dayjs.utc().toDate();
    
    return this._post.model.post.findMany({
      where: {
        state: 'PUBLISHED',
        publishDate: {
          gt: now, // Future dates
        },
        deletedAt: null,
        ...(orgId ? { organizationId: orgId } : {}),
      },
      select: {
        id: true,
        publishDate: true,
        integrationId: true,
        organizationId: true,
        createdAt: true,
        releaseURL: true,
        integration: {
          select: {
            name: true,
            providerIdentifier: true,
          },
        },
      },
      orderBy: {
        publishDate: 'asc',
      },
    });
  }

  // Delete future PUBLISHED posts (cleanup anomalies)
  async deleteFuturePublishedPosts(orgId?: string) {
    const now = dayjs.utc().toDate();
    
    console.log(`[deleteFuturePublishedPosts] Searching for PUBLISHED posts with future dates...`);
    
    const posts = await this.findFuturePublishedPosts(orgId);
    
    if (posts.length === 0) {
      console.log(`[deleteFuturePublishedPosts] No future PUBLISHED posts found.`);
      return { deleted: 0, posts: [] };
    }
    
    console.log(`[deleteFuturePublishedPosts] Found ${posts.length} future PUBLISHED posts to delete:`);
    posts.forEach(p => {
      console.log(`  - Post ${p.id.substring(0, 8)}... scheduled for ${dayjs(p.publishDate).format('YYYY-MM-DD HH:mm')} on ${p.integration?.name}`);
    });
    
    const postIds = posts.map(p => p.id);
    
    await this._post.model.post.updateMany({
      where: {
        id: { in: postIds },
      },
      data: {
        deletedAt: new Date(),
      },
    });
    
    console.log(`[deleteFuturePublishedPosts] Successfully deleted ${posts.length} future PUBLISHED posts.`);
    
    return { deleted: posts.length, posts };
  }
}