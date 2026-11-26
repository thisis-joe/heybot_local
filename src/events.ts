import type { Target } from './contracts.js';

export interface Comment {
  id: string;
  body: string;
  author: string;
  authorId?: number;
  parentId: string | null;
  discussionId: string | null;
  surface: 'issue' | 'review' | 'note';
}
export function commentKey(comment: Pick<Comment, 'surface' | 'id'>): string {
  return `${comment.surface}-${comment.id}`;
}
export interface Event {
  kind: 'review' | 'command';
  target: Target;
  deliveryId: string;
  headSha?: string;
  requested?: boolean;
  merged?: boolean;
  regenerate?: boolean;
  comment?: Comment;
}

/** Every bot write has a marker on its own line. Author names alone cannot distinguish a user's own commands. */
export function hasOutputMarker(body: string): boolean {
  return /^<!-- codereviewbot:[\w:-]+ -->(?:\r?\n|$)/.test(body);
}
