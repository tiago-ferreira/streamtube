import { randomBytes } from 'node:crypto';

export function generateVideoSlug(): string {
  return randomBytes(8).toString('base64url');
}
