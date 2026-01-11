import { Command } from 'nestjs-command';
import { Injectable } from '@nestjs/common';
import { PostsRepository } from '@gitroom/nestjs-libraries/database/prisma/posts/posts.repository';
import * as Sentry from '@sentry/nestjs';

const { logger } = Sentry;

interface InvalidPost {
  id: string;
  publishDate: Date;
  state: string;
  content: string;
  image: string | null;
  settings: string | null;
  group: string;
  organizationId: string;
  integration: {
    name: string;
    providerIdentifier: string;
  } | null;
  missingImage: boolean;
  missingBoardId: boolean;
  isPinterest: boolean;
}

@Injectable()
export class CleanupInvalidPosts {
  constructor(private _postsRepository: PostsRepository) {}
  
  @Command({
    command: 'list:invalid-posts',
    describe: 'List all scheduled posts without images and/or without board ID (for Pinterest)',
  })
  async listInvalidPosts() {
    logger.info('Searching for scheduled posts with missing images or board IDs...');
    console.log('🔍 Searching for scheduled posts with missing images or board IDs...\n');
    
    try {
      const posts = await this._postsRepository.findInvalidPosts();
      
      if (posts.length === 0) {
        logger.info('No invalid posts found');
        console.log('✅ No invalid posts found.');
        return true;
      }
      
      const summary = this.generateSummary(posts);
      
      logger.info(logger.fmt`Found ${posts.length} invalid posts`);
      console.log(`\n📋 Found ${posts.length} invalid posts:\n`);
      console.log(summary);
      
      console.log(`\n💡 To delete these posts, run:\n   pnpm --filter ./apps/commands run command cleanup:invalid-posts\n`);
      
      return true;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('Failed to list invalid posts', { error: errorMessage });
      console.error('❌ Error:', errorMessage);
      return false;
    }
  }
  
  @Command({
    command: 'cleanup:invalid-posts',
    describe: 'Delete all scheduled posts without images and/or without board ID (for Pinterest)',
  })
  async deleteInvalidPosts() {
    logger.info('Starting cleanup of invalid posts...');
    console.log('🧹 Starting cleanup of invalid posts...\n');
    
    try {
      const posts = await this._postsRepository.findInvalidPosts();
      
      if (posts.length === 0) {
        logger.info('No invalid posts found');
        console.log('✅ No invalid posts found. Nothing to delete.');
        return true;
      }
      
      console.log(`Found ${posts.length} posts to delete.\n`);
      
      const uniqueGroups = [...new Set(posts.map(p => p.group))];
      logger.info(logger.fmt`Deleting ${uniqueGroups.length} post groups (${posts.length} total posts)`);
      
      let deletedCount = 0;
      for (const group of uniqueGroups) {
        const groupPosts = posts.filter(p => p.group === group);
        const orgId = groupPosts[0].organizationId;
        const post = groupPosts[0];
        
        try {
          await this._postsRepository.deletePost(orgId, group);
          deletedCount++;
          
          const reasons = [];
          if (post.missingImage) reasons.push('no image');
          if (post.missingBoardId) reasons.push('no board ID');
          
          console.log(`✓ Deleted: ${post.integration?.name} - ${reasons.join(', ')}`);
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          logger.error(logger.fmt`Failed to delete post group ${group}`, { error: errorMessage });
          console.error(`✗ Failed to delete group ${group}: ${errorMessage}`);
        }
      }
      
      logger.info(logger.fmt`Cleanup complete: ${deletedCount} post groups deleted`);
      console.log(`\n✅ Cleanup complete: ${deletedCount} post groups (${posts.length} posts) removed.\n`);
      
      return true;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('Failed to cleanup invalid posts', { error: errorMessage });
      console.error('❌ Error:', errorMessage);
      return false;
    }
  }
  
  @Command({
    command: 'list:invalid-posts-by-org <orgId>',
    describe: 'List invalid posts for a specific organization',
  })
  async listInvalidPostsByOrg(orgId: string) {
    logger.info(logger.fmt`Searching for invalid posts for organization: ${orgId}`);
    console.log(`\n🔍 Searching for invalid posts for organization: ${orgId}\n`);
    
    try {
      const posts = await this._postsRepository.findInvalidPosts(orgId);
      
      if (posts.length === 0) {
        logger.info('No invalid posts found for this organization');
        console.log('✅ No invalid posts found for this organization.');
        return true;
      }
      
      const summary = this.generateSummary(posts);
      
      logger.info(logger.fmt`Found ${posts.length} invalid posts for organization`);
      console.log(`📋 Found ${posts.length} invalid posts:\n`);
      console.log(summary);
      
      console.log(`\n💡 To delete these posts, run:\n   pnpm --filter ./apps/commands run command cleanup:invalid-posts-by-org ${orgId}\n`);
      
      return true;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('Failed to list invalid posts by org', { 
        organizationId: orgId, 
        error: errorMessage 
      });
      console.error('❌ Error:', errorMessage);
      return false;
    }
  }
  
  @Command({
    command: 'cleanup:invalid-posts-by-org <orgId>',
    describe: 'Delete invalid posts for a specific organization',
  })
  async deleteInvalidPostsByOrg(orgId: string) {
    logger.info(logger.fmt`Starting cleanup of invalid posts for organization: ${orgId}`);
    console.log(`\n🧹 Starting cleanup of invalid posts for organization: ${orgId}\n`);
    
    try {
      const posts = await this._postsRepository.findInvalidPosts(orgId);
      
      if (posts.length === 0) {
        logger.info('No invalid posts found for this organization');
        console.log('✅ No invalid posts found. Nothing to delete.');
        return true;
      }
      
      console.log(`Found ${posts.length} posts to delete.\n`);
      
      const uniqueGroups = [...new Set(posts.map(p => p.group))];
      logger.info(logger.fmt`Deleting ${uniqueGroups.length} post groups for organization`);
      
      let deletedCount = 0;
      for (const group of uniqueGroups) {
        const groupPosts = posts.filter(p => p.group === group);
        const post = groupPosts[0];
        
        try {
          await this._postsRepository.deletePost(orgId, group);
          deletedCount++;
          const reasons = [];
          if (post.missingImage) reasons.push('no image');
          if (post.missingBoardId) reasons.push('no board ID');
          
          console.log(`✓ Deleted: ${post.integration?.name} - ${reasons.join(', ')}`);
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          logger.error(logger.fmt`Failed to delete post group ${group}`, { 
            organizationId: orgId,
            error: errorMessage 
          });
          console.error(`✗ Failed to delete group ${group}: ${errorMessage}`);
        }
      }
      
      logger.info(logger.fmt`Cleanup complete: ${deletedCount} post groups deleted for organization ${orgId}`);
      console.log(`\n✅ Cleanup complete: ${deletedCount} post groups (${posts.length} posts) removed.\n`);
      
      return true;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('Failed to cleanup invalid posts by org', { 
        organizationId: orgId,
        error: errorMessage 
      });
      console.error('❌ Error:', errorMessage);
      return false;
    }
  }
  
  private generateSummary(posts: InvalidPost[]): string {
    const categories = {
      missingImageOnly: posts.filter(p => p.missingImage && !p.missingBoardId),
      missingBoardOnly: posts.filter(p => !p.missingImage && p.missingBoardId),
      missingBoth: posts.filter(p => p.missingImage && p.missingBoardId),
    };
    
    let output = '';
    
    if (categories.missingImageOnly.length > 0) {
      output += `\n🔸 Posts without images (${categories.missingImageOnly.length}):\n`;
      const grouped = this.groupByIntegration(categories.missingImageOnly);
      Object.entries(grouped).forEach(([integration, posts]) => {
        output += `   • ${integration}: ${posts.length} posts\n`;
      });
    }
    
    if (categories.missingBoardOnly.length > 0) {
      output += `\n🔸 Pinterest posts without board ID (${categories.missingBoardOnly.length}):\n`;
      const grouped = this.groupByIntegration(categories.missingBoardOnly);
      Object.entries(grouped).forEach(([integration, posts]) => {
        output += `   • ${integration}: ${posts.length} posts\n`;
      });
    }
    
    if (categories.missingBoth.length > 0) {
      output += `\n🔸 Posts missing both image AND board ID (${categories.missingBoth.length}):\n`;
      const grouped = this.groupByIntegration(categories.missingBoth);
      Object.entries(grouped).forEach(([integration, posts]) => {
        output += `   • ${integration}: ${posts.length} posts\n`;
      });
    }
    
    output += `\n📊 Summary by integration:\n`;
    const allGrouped = this.groupByIntegration(posts);
    Object.entries(allGrouped).forEach(([integration, integrationPosts]) => {
      const missingImage = integrationPosts.filter(p => p.missingImage).length;
      const missingBoard = integrationPosts.filter(p => p.missingBoardId).length;
      output += `   • ${integration}: ${integrationPosts.length} total`;
      if (missingImage > 0) output += ` (${missingImage} no image)`;
      if (missingBoard > 0) output += ` (${missingBoard} no board)`;
      output += '\n';
    });
    
    return output;
  }
  
  private groupByIntegration(posts: InvalidPost[]): Record<string, InvalidPost[]> {
    return posts.reduce((acc, post) => {
      const key = `${post.integration?.name || 'Unknown'} (${post.integration?.providerIdentifier || 'unknown'})`;
      if (!acc[key]) acc[key] = [];
      acc[key].push(post);
      return acc;
    }, {} as Record<string, InvalidPost[]>);
  }
}
