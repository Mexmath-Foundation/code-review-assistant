export interface RepositoryInfo {
  name: string;
  owner: string;
  url: string;
}

export interface FileChange {
  name: string;
  path: string;
  content: string;
  diff: string;
  commentThreads: FileCommentThread[];
}

export interface PullRequestInfo {
  name: string;
  number: number;
  url: string;
  files: FileChange[];
}

export interface FileCommentThread {
  lineNumber: number;
  comments: Comment[];
}

export interface Comment {
  content: string;
  author: string;
  parentCommentId?: string;
}

export interface CourseInfo {
  id: string;
  name: string;
}

export interface ReviewResult {
  repository: RepositoryInfo;
  pullRequests: PullRequestInfo[];
  course: CourseInfo;
}
