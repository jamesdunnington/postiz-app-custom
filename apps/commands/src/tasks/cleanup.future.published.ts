import { Command } from 'nestjs-command';
import { Injectable } from '@nestjs/common';
import { PostsRepository } from '@gitroom/nestjs-libraries/database/prisma/posts/posts.repository';

@Injectable()
export class CleanupFuturePublished {
  constructor(private _postsRepository: PostsRepository) {}
  
  @Command({
    command: 'cleanup:future-published',
    describe: 'Find and delete PUBLISHED posts with future schedule dates',
  })
  async cleanup() {
    console.log('Starting cleanup of future PUBLISHED posts...');
    
    const result = await this._postsRepository.deleteFuturePublishedPosts();
    
    if (result.deleted > 0) {
      console.log(`\n✅ Cleanup complete: ${result.deleted} future PUBLISHED posts removed.`);
      console.log('\nRemoved posts:');
      result.posts.forEach(p => {
        console.log(`  - ${p.integration?.name} (${p.integration?.providerIdentifier})`);
        console.log(`    Scheduled: ${p.publishDate}`);
        console.log(`    Post ID: ${p.id}`);
        if (p.releaseURL) {
          console.log(`    URL: ${p.releaseURL}`);
        }
        console.log('');
      });
    } else {
      console.log('✅ No future PUBLISHED posts found. Schedule is clean.');
    }
    
    return true;
  }
  
  @Command({
    command: 'list:future-published',
    describe: 'List PUBLISHED posts with future schedule dates (without deleting)',
  })
  async list() {
    console.log('Searching for PUBLISHED posts with future dates...\n');
    
    const posts = await this._postsRepository.findFuturePublishedPosts();
    
    if (posts.length === 0) {
      console.log('✅ No future PUBLISHED posts found.');
      return true;
    }
    
    console.log(`Found ${posts.length} PUBLISHED posts with future dates:\n`);
    
    posts.forEach(p => {
      console.log(`  - ${p.integration?.name} (${p.integration?.providerIdentifier})`);
      console.log(`    Scheduled: ${p.publishDate}`);
      console.log(`    Post ID: ${p.id}`);
      if (p.releaseURL) {
        console.log(`    URL: ${p.releaseURL}`);
      }
      console.log('');
    });
    
    console.log(`\nTo delete these posts, run: pnpm --filter ./apps/commands run command cleanup:future-published`);
    
    return true;
  }
}
