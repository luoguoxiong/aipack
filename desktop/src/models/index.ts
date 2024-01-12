import { Models } from '@rematch/core';
import user from './user';
import app from './app';

export interface RootModel extends Models<RootModel> {
  user: typeof user;
  app: typeof app;
}

export const models: RootModel = { user, app };
