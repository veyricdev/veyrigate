import type { Model } from 'mongoose';
import { type Resource, ResourceService } from './resource.service';
import { InvalidResourceError } from './resource.validator';

/** CodeQL #8 (D92.9): a non-string `resourceId` never reaches the Mongo filter. */
describe('ResourceService.createUnique non-string resourceId', () => {
  it.each([
    ['operator object', { $ne: null }],
    ['array', ['r1']],
  ])('%s => InvalidResourceError, no query, no write', async (_n, resourceId) => {
    const calls = { exists: 0, create: 0 };
    const model = {
      exists: async () => {
        calls.exists++;
        return null;
      },
      create: async () => {
        calls.create++;
        return { toObject: () => ({}) };
      },
    } as unknown as Model<Resource>;
    await expect(
      new ResourceService(model).createUnique({
        resourceId: resourceId as unknown as string,
        identifier: 'https://r.example.com/',
      }),
    ).rejects.toThrow(InvalidResourceError);
    expect(calls).toEqual({ exists: 0, create: 0 });
  });
});
