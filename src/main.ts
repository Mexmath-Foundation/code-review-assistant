import * as core from '@actions/core';
import * as github from '@actions/github';
import type {
  Course,
  FileChange,
  FileCommentThread,
  PullRequestEntry,
  Repository,
  ReviewComment
} from './model';

type OctokitClient = ReturnType<typeof github.getOctokit>;

type PullRequestFile = {
  filename: string;
  patch?: string;
  status?: string;
};

const GITHUB_API_URL = process.env.GITHUB_API_URL || 'https://api.github.com';

type PullRequestMetadata = Omit<PullRequestEntry, 'files'> & {
  headSha: string;
};

type RepositorySummary = Pick<Repository, 'name' | 'owner' | 'url'>;
type CourseMetadata = Omit<Course, 'repository'>;

type FileCommentsMap = Record<string, FileCommentThread[]>;

interface PullRequestContext {
  repository: RepositorySummary;
  pullRequest: PullRequestMetadata;
  token: string;
  octokit: OctokitClient;
}

interface GithubPullRequestApiResponse {
  title?: string;
  html_url: string;
  head?: {
    sha?: string;
  };
}

interface RepositoryContentApiResponse {
  content?: string;
  encoding?: string;
  type?: string;
}

interface PullRequestDetails {
  title?: string;
  htmlUrl: string;
  headSha: string;
}

interface PullRequestReviewComment {
  id: number;
  in_reply_to_id?: number;
  path?: string;
  body?: string;
  user?: {
    login?: string;
  };
  line?: number | null;
  original_line?: number | null;
  created_at?: string;
}

async function resolvePullRequestContext(): Promise<PullRequestContext | null> {
  const token = core.getInput('github-token') || process.env.GITHUB_TOKEN;

  if (!token) {
    core.setFailed('A GitHub token is required to list changed files.');
    return null;
  }

  const pullRequestNumber = github.context.payload.pull_request?.number;

  if (!pullRequestNumber) {
    core.info('No pull request context detected. Skipping changed file lookup.');
    return null;
  }

  const owner = github.context.repo.owner;
  const repo = github.context.repo.repo;

  if (!owner || !repo) {
    core.setFailed('Repository information is missing from the event context.');
    return null;
  }

  const octokit = github.getOctokit(token);
  const pullRequestDetails = await fetchPullRequestDetails(token, owner, repo, pullRequestNumber);

  const repository: RepositorySummary = {
    name: repo,
    owner,
    url: `https://github.com/${owner}/${repo}`
  };

  const pullRequest: PullRequestMetadata = {
    name: pullRequestDetails.title ?? `Pull Request #${pullRequestNumber}`,
    number: pullRequestNumber,
    url: pullRequestDetails.htmlUrl,
    commitHash: pullRequestDetails.headSha,
    headSha: pullRequestDetails.headSha
  };

  return {
    repository,
    pullRequest,
    token,
    octokit
  };
}

async function listChangedFiles(
  octokit: OctokitClient,
  repository: RepositorySummary,
  pullRequest: PullRequestMetadata
): Promise<PullRequestFile[]> {
  return await github.paginate(
    octokit.rest.pulls.listFiles,
    {
      owner: repository.owner,
      repo: repository.name,
      pull_number: pullRequest.number,
      per_page: 100
    },
    (response) => response.data as PullRequestFile[]
  );
}

async function fetchPullRequestDetails(
  token: string,
  owner: string,
  repo: string,
  pullNumber: number
): Promise<PullRequestDetails> {
  const data = await requestGithubJson<GithubPullRequestApiResponse>(
    token,
    `/repos/${owner}/${repo}/pulls/${pullNumber}`
  );

  const headSha = data.head?.sha;

  if (!headSha) {
    throw new Error('Unable to determine the pull request head SHA.');
  }

  return {
    title: data.title,
    htmlUrl: data.html_url,
    headSha
  };
}

async function buildAffectedFilesModel(
  token: string,
  repository: RepositorySummary,
  pullRequest: PullRequestMetadata,
  files: PullRequestFile[],
  fileComments: FileCommentsMap
): Promise<FileChange[]> {
  const affectedFiles: FileChange[] = [];

  for (const file of files) {
    let content = '';

    if (file.status !== 'removed') {
      try {
        content = await fetchFileContent(token, repository, pullRequest, file.filename);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        core.info(`Warning: Unable to retrieve content for ${file.filename}: ${message}`);
      }
    }

    affectedFiles.push({
      name: extractFileName(file.filename),
      path: file.filename,
      content,
      diff: file.patch ?? '',
      commentThreads: fileComments[file.filename] ?? []
    });
  }

  return affectedFiles;
}

async function fetchFileContent(
  token: string,
  repository: RepositorySummary,
  pullRequest: PullRequestMetadata,
  path: string
): Promise<string> {
  const encodedPath = encodeRepositoryPath(path);
  const response = await requestGithubJson<RepositoryContentApiResponse | RepositoryContentApiResponse[]>(
    token,
    `/repos/${repository.owner}/${repository.name}/contents/${encodedPath}`,
    { ref: pullRequest.headSha }
  );

  if (Array.isArray(response)) {
    return '';
  }

  if (response.type && response.type !== 'file') {
    return '';
  }

  if (typeof response.content !== 'string') {
    return '';
  }

  return decodeFileContent(response.content, response.encoding);
}

function extractFileName(filePath: string): string {
  const segments = filePath.split('/');
  return segments[segments.length - 1] ?? filePath;
}

function decodeFileContent(content: string, encoding?: string): string {
  if (encoding === 'base64') {
    return Buffer.from(content, 'base64').toString('utf8');
  }

  return content;
}

function encodeRepositoryPath(path: string): string {
  return path
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

async function fetchCommentsForFiles(
  token: string,
  repository: RepositorySummary,
  pullRequest: PullRequestMetadata
): Promise<FileCommentsMap> {
  const comments = await paginatePullRequestComments(token, repository, pullRequest);
  const groupedByPath = new Map<string, PullRequestReviewComment[]>();

  for (const comment of comments) {
    if (!comment.path) {
      continue;
    }

    const list = groupedByPath.get(comment.path) ?? [];
    list.push(comment);
    groupedByPath.set(comment.path, list);
  }

  const result: FileCommentsMap = {};
  for (const [path, pathComments] of groupedByPath.entries()) {
    result[path] = buildCommentThreads(pathComments);
  }

  return result;
}

async function paginatePullRequestComments(
  token: string,
  repository: RepositorySummary,
  pullRequest: PullRequestMetadata
): Promise<PullRequestReviewComment[]> {
  const perPage = 100;
  const comments: PullRequestReviewComment[] = [];
  let page = 1;

  while (true) {
    const pageData = await requestGithubJson<PullRequestReviewComment[]>(
      token,
      `/repos/${repository.owner}/${repository.name}/pulls/${pullRequest.number}/comments`,
      { per_page: perPage.toString(), page: page.toString() }
    );

    if (!Array.isArray(pageData)) {
      break;
    }

    comments.push(...pageData);

    if (pageData.length < perPage) {
      break;
    }

    page += 1;
  }

  return comments;
}

function buildCommentThreads(comments: PullRequestReviewComment[]): FileCommentThread[] {
  const threads = new Map<number, FileCommentThread>();
  const sorted = [...comments].sort((a, b) => {
    const aTime = a.created_at ? Date.parse(a.created_at) : 0;
    const bTime = b.created_at ? Date.parse(b.created_at) : 0;

    if (aTime === bTime) {
      return a.id - b.id;
    }

    return aTime - bTime;
  });

  for (const comment of sorted) {
    if (!comment.path) {
      continue;
    }

    const rootId = comment.in_reply_to_id ?? comment.id;
    let thread = threads.get(rootId);

    if (!thread) {
      thread = {
        lineNumber: comment.line ?? comment.original_line ?? 0,
        comments: []
      };
      threads.set(rootId, thread);
    }

    thread.comments.push({
      id: String(comment.id),
      content: comment.body ?? '',
      author: comment.user?.login ?? 'unknown',
      parentId: comment.in_reply_to_id ? String(comment.in_reply_to_id) : undefined
    });
  }

  return Array.from(threads.values());
}

function fetchCourseInfo(): CourseMetadata | null {
  const id = process.env.COURSE_ID;
  const name = process.env.COURSE_NAME;

  if (!id || !name) {
    core.info('Course information environment variables were not fully provided.');
    return null;
  }

  return { id, name };
}

async function requestGithubJson<T>(
  token: string,
  path: string,
  query?: Record<string, string>,
  options?: {
    method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
    body?: unknown;
    headers?: Record<string, string>;
  }
): Promise<T> {
  const url = buildGithubUrl(path, query);
  const response = await fetch(url, {
    method: options?.method ?? 'GET',
    headers: {
      ...buildGithubHeaders(token),
      ...(options?.headers ?? {}),
      ...(options?.body ? { 'Content-Type': 'application/json' } : {})
    },
    body: options?.body ? JSON.stringify(options.body) : undefined
  });

  const data = (await response.json()) as T;

  if (!response.ok) {
    const errorMessage = typeof data === 'object' && data !== null && 'message' in data ? (data as { message?: string }).message : undefined;
    throw new Error(errorMessage || `GitHub API request failed with status ${response.status}`);
  }

  return data;
}

function buildGithubUrl(path: string, query?: Record<string, string>): string {
  const url = new URL(path.startsWith('/') ? path : `/${path}`, GITHUB_API_URL);

  if (query) {
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, value);
    }
  }

  return url.toString();
}

function buildGithubHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'code-review-assistant-action',
    'X-GitHub-Api-Version': '2022-11-28'
  };
}

async function addCommentToPullRequest(
  token: string,
  repository: RepositorySummary,
  pullRequest: PullRequestMetadata,
  comment: ReviewComment
): Promise<void> {
  const body: Record<string, unknown> = {
    body: comment.content
  };

  if (comment.type === 'reply') {
    body.in_reply_to = Number(comment.inReplyTo);
  } else {
    body.commit_id = comment.commitHash;
    body.path = comment.path;
    body.line = comment.line;
    body.side = comment.side;
  }

  await requestGithubJson(
    token,
    `/repos/${repository.owner}/${repository.name}/pulls/${pullRequest.number}/comments`,
    undefined,
    {
      method: 'POST',
      body
    }
  );
}

async function run(): Promise<void> {
  try {
    const context = await resolvePullRequestContext();

    if (!context) {
      return;
    }

    const files = await listChangedFiles(context.octokit, context.repository, context.pullRequest);

    if (files.length === 0) {
      core.info('No changed files found for this pull request.');
      return;
    }

    const fileComments = await fetchCommentsForFiles(context.token, context.repository, context.pullRequest);

    const affectedFiles = await buildAffectedFilesModel(
      context.token,
      context.repository,
      context.pullRequest,
      files,
      fileComments
    );

    const courseInfo = fetchCourseInfo();

    if (!courseInfo) {
      core.setFailed('Course information is required but could not be determined from the environment.');
      return;
    }

    const repositorySummary: RepositorySummary = {
      name: context.repository.name,
      owner: context.repository.owner,
      url: context.repository.url
    };

    const repositoryResult: Repository = {
      ...repositorySummary,
      pullRequests: [
        {
          name: context.pullRequest.name,
          number: context.pullRequest.number,
          url: context.pullRequest.url,
          commitHash: context.pullRequest.commitHash,
          files: affectedFiles
        }
      ]
    };

    const result: Course = {
      ...courseInfo,
      repository: repositoryResult
    };

    core.info(`Processed ${affectedFiles.length} changed files for pull request #${context.pullRequest.number}.`);
    core.info(JSON.stringify(result, null, 2));
    core.setOutput('result', JSON.stringify(result));
  } catch (error) {
    if (error instanceof Error) {
      core.setFailed(error.message);
    } else {
      core.setFailed('Unknown error occurred while listing changed files.');
    }
  }
}

run();
