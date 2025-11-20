export interface FileChange {
  name: string;
  path: string;
  content: string;
  diff: string;
  commentThreads: FileCommentThread[];
}

export interface PullRequest {
  name: string;
  number: number;
  url: string;
  commitHash: string;
  files: FileChange[];
}

export interface FileCommentThread {
  lineNumber: number;
  comments: Comment[];
}

export interface Comment {
  id: string;
  content: string;
  author: string;
  parentId?: string;
}

export interface NewComment {
  content: string;
  parentId?: string;
}

export interface GenralComment {
  type: 'general';
  content: string;
}

export interface ReplyComment {
  type: 'reply';
  content: string;
  inReplyTo: string;
}

export interface CodeLineComment {
  type: 'line';
  content: string;
  path: string;
  line: number;
  side: 'LEFT' | 'RIGHT';
}


export type ReviewComment = GenralComment | ReplyComment | CodeLineComment;

export interface PullRequestReview {
  repositoryName: string;
  repositoryOwner: string;
  pullRequestNumber: number;
  pullRequestUrl: string;
  pullRequestCommitHash: string;
  comments: ReviewComment[];
}

export interface RepositoryReview {
  name: string;
  owner: string;
  url: string;
  onBehaf: string
  pullRequestsReviews: PullRequestReview[];
}



export interface Course {
  id: string;
  name: string;
  repository: Repository;
}

export interface Repository {
  name: string;
  owner: string;
  url: string;
  pullRequests: PullRequest[];
}
