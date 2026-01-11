import { Command } from 'nestjs-command';
import { Injectable } from '@nestjs/common';
import { PostsRepository } from '@gitroom/nestjs-libraries/database/prisma/posts/posts.repository';
import * as Sentry from '@sentry/nestjs';

const { logger } = Sentry;

@Injectable()
export class CleanupPostsWithoutImages {
  constructor(private _postsRepository: PostsRepository) {}
  
  @Command({
    command: 'list:posts-without-images',
    describe: 'List all scheduled posts without images',
  })
  async listPostsWithoutImages() {
    logger.info('Searching for scheduled posts without images...');
    
    try {
      const posts = await this._postsRepository.findPostsWithoutImages();
      
      if (posts.length === 0) {
        logger.info('✅ No scheduled posts without images found.');
        console.log('✅ No scheduled posts without images found.');
        return true;
      }
      
      logger.info(logger.fmt`Found ${posts.length} scheduled posts without images`);
      console.log(`\n📋 Found ${posts.length} scheduled posts without images:\n`);
      
      // Group by integration for better readability
      const groupedByIntegration: Record<string, typeof posts> = {};
      
      posts.forEach(post => {
        const integrationName = post.integration?.name || 'Unknown';
        if (!groupedByIntegration[integrationName]) {
          groupedByIntegration[integrationName] = [];
        }
        groupedByIntegration[integrationName].push(post);
      });
      
      Object.entries(groupedByIntegration).forEach(([integrationName, posts]) => {
        console.log(`\n🔹 ${integrationName} (${posts[0].integration?.providerIdentifier}):`);
        console.log(`   Total posts: ${posts.length}\n`);
        
        posts.forEach(post => {
          console.log(`   • Post ID: ${post.id}`);
          console.log(`     Scheduled: ${new Date(post.publishDate).toLocaleString()}`);
          console.log(`     State: ${post.state}`);
          console.log(`     Content preview: ${post.content.substring(0, 60)}...`);
          console.log('');
        });
      });
      
      console.log(`\n💡 To delete these posts, run:\n   pnpm --filter ./apps/commands run command cleanup:posts-without-images\n`);
      
      return true;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('Failed to list posts without images', { error: errorMessage });
      console.error('❌ Error:', errorMessage);
      return false;
    }
  }
  
  @Command({
    command: 'cleanup:posts-without-images',
    describe: 'Delete all scheduled posts without images',
  })
  async deletePostsWithoutImages() {
    logger.info('Starting cleanup of posts without images...');
    console.log('🧹 Starting cleanup of scheduled posts without images...\n');
    
    try {
      const posts = await this._postsRepository.findPostsWithoutImages();
      
      if (posts.length === 0) {
        logger.info('No scheduled posts without images found');
        console.log('✅ No scheduled posts without images found. Nothing to delete.');
        return true;
      }
      
      console.log(`Found ${posts.length} posts to delete.\n`);
      
      // Delete posts by their group
      const uniqueGroups = [...new Set(posts.map(p => p.group))];
      logger.info(logger.fmt`Deleting ${uniqueGroups.length} post groups (${posts.length} total posts)`);
      
      let deletedCount = 0;
      for (const group of uniqueGroups) {
        const groupPosts = posts.filter(p => p.group === group);
        const orgId = groupPosts[0].organizationId;
        
        try {
          await this._postsRepository.deletePost(orgId, group);
          deletedCount++;
          console.log(`✓ Deleted post group: ${group} (${groupPosts.length} posts)`);
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
      logger.error('Failed to cleanup posts without images', { error: errorMessage });
      console.error('❌ Error:', errorMessage);
      return false;
    }
  }
  
  @Command({
    command: 'list:posts-without-images-by-org <orgId>',
    describe: 'List scheduled posts without images for a specific organization',
  })
  async listPostsWithoutImagesByOrg(orgId: string) {
    logger.info(logger.fmt`Searching for posts without images for organization: ${orgId}`);
    console.log(`\n🔍 Searching for scheduled posts without images for organization: ${orgId}\n`);
    
    try {
      const posts = await this._postsRepository.findPostsWithoutImages(orgId);
      
      if (posts.length === 0) {
        logger.info('No posts without images found for this organization');
        console.log('✅ No scheduled posts without images found for this organization.');
        return true;
      }
      
      logger.info(logger.fmt`Found ${posts.length} posts without images for organization`);
      console.log(`📋 Found ${posts.length} scheduled posts without images:\n`);
      
      posts.forEach((post, index) => {
        console.log(`${index + 1}. Post ID: ${post.id}`);
        console.log(`   Integration: ${post.integration?.name} (${post.integration?.providerIdentifier})`);
        console.log(`   Scheduled: ${new Date(post.publishDate).toLocaleString()}`);
        console.log(`   State: ${post.state}`);
        console.log(`   Content: ${post.content.substring(0, 100)}...`);
        console.log('');
      });
      
      console.log(`\n💡 To delete these posts, run:\n   pnpm --filter ./apps/commands run command cleanup:posts-without-images-by-org ${orgId}\n`);
      
      return true;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('Failed to list posts without images by org', { 
        organizationId: orgId, 
        error: errorMessage 
      });
      console.error('❌ Error:', errorMessage);
      return false;
    }
  }
  
  @Command({
    command: 'cleanup:posts-without-images-by-org <orgId>',
    describe: 'Delete scheduled posts without images for a specific organization',
  })
  async deletePostsWithoutImagesByOrg(orgId: string) {
    logger.info(logger.fmt`Starting cleanup of posts without images for organization: ${orgId}`);
    console.log(`\n🧹 Starting cleanup of posts without images for organization: ${orgId}\n`);
    
    try {
      const posts = await this._postsRepository.findPostsWithoutImages(orgId);
      
      if (posts.length === 0) {
        logger.info('No posts without images found for this organization');
        console.log('✅ No scheduled posts without images found. Nothing to delete.');
        return true;
      }
      
      console.log(`Found ${posts.length} posts to delete.\n`);
      
      const uniqueGroups = [...new Set(posts.map(p => p.group))];
      logger.info(logger.fmt`Deleting ${uniqueGroups.length} post groups for organization`);
      
      let deletedCount = 0;
      for (const group of uniqueGroups) {
        try {
          await this._postsRepository.deletePost(orgId, group);
          deletedCount++;
          console.log(`✓ Deleted post group: ${group}`);
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
      logger.error('Failed to cleanup posts without images by org', { 
        organizationId: orgId,
        error: errorMessage 
      });
      console.error('❌ Error:', errorMessage);
      return false;
    }
  }
}
