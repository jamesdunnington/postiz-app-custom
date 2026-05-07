import { PrismaRepository } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { Injectable } from '@nestjs/common';
import { SaveMediaInformationDto } from '@gitroom/nestjs-libraries/dtos/media/save.media.information.dto';

@Injectable()
export class MediaRepository {
  constructor(private _media: PrismaRepository<'media'>) {}

  /**
   * Hard-delete all soft-deleted media records (where deletedAt is set)
   */
  async purgeDeletedMedia() {
    return this._media.model.media.deleteMany({
      where: {
        deletedAt: { not: null },
      },
    });
  }

  /**
   * Get all active (non-deleted) media records for validation
   */
  async getAllActiveMedia() {
    return this._media.model.media.findMany({
      where: {
        deletedAt: null,
      },
      select: {
        id: true,
        path: true,
        organizationId: true,
      },
    });
  }

  /**
   * Soft-delete media records by IDs (for orphaned files)
   */
  async softDeleteMediaByIds(ids: string[]) {
    return this._media.model.media.updateMany({
      where: {
        id: { in: ids },
      },
      data: {
        deletedAt: new Date(),
      },
    });
  }

  saveFile(org: string, fileName: string, filePath: string) {
    return this._media.model.media.create({
      data: {
        organization: {
          connect: {
            id: org,
          },
        },
        name: fileName,
        path: filePath,
      },
      select: {
        id: true,
        name: true,
        path: true,
        thumbnail: true,
        alt: true,
      },
    });
  }

  getMediaById(id: string) {
    return this._media.model.media.findUnique({
      where: {
        id,
      },
    });
  }

  deleteMedia(org: string, id: string) {
    return this._media.model.media.update({
      where: {
        id,
        organizationId: org,
      },
      data: {
        deletedAt: new Date(),
      },
    });
  }

  saveMediaInformation(org: string, data: SaveMediaInformationDto) {
    return this._media.model.media.update({
      where: {
        id: data.id,
        organizationId: org,
      },
      data: {
        alt: data.alt,
        thumbnail: data.thumbnail,
        thumbnailTimestamp: data.thumbnailTimestamp,
      },
      select: {
        id: true,
        name: true,
        alt: true,
        thumbnail: true,
        path: true,
        thumbnailTimestamp: true,
      },
    });
  }

  async getExistingPathsForOrg(org: string, paths: string[]) {
    if (paths.length === 0) return new Set<string>();
    const records = await this._media.model.media.findMany({
      where: { organizationId: org, path: { in: paths } },
      select: { path: true },
    });
    return new Set(records.map((r) => r.path));
  }

  async restoreSoftDeletedByPaths(org: string, paths: string[]) {
    if (paths.length === 0) return 0;
    const result = await this._media.model.media.updateMany({
      where: {
        organizationId: org,
        path: { in: paths },
        deletedAt: { not: null },
      },
      data: { deletedAt: null },
    });
    return result.count;
  }

  async createMediaRecords(
    org: string,
    paths: string[]
  ): Promise<number> {
    if (paths.length === 0) return 0;
    await this._media.model.media.createMany({
      data: paths.map((path) => ({
        organizationId: org,
        name: path.split('/').pop() ?? path,
        path,
      })),
      skipDuplicates: true,
    });
    return paths.length;
  }

  async getMedia(org: string, page: number) {
    const pageNum = (page || 1) - 1;
    const query = {
      where: {
        organizationId: org,
        deletedAt: null,
      },
    };
    const pages =
      pageNum === 0
        ? Math.ceil((await this._media.model.media.count(query)) / 28)
        : 0;
    const results = await this._media.model.media.findMany({
      where: {
        organizationId: org,
        deletedAt: null,
      },
      orderBy: {
        createdAt: 'desc',
      },
      select: {
        id: true,
        name: true,
        path: true,
        thumbnail: true,
        alt: true,
        thumbnailTimestamp: true,
      },
      skip: pageNum * 28,
      take: 28,
    });

    return {
      pages,
      results,
    };
  }
}
