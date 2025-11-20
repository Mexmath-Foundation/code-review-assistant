import * as core from '@actions/core';
import * as github from '@actions/github';
import type {
  Course,
  FileChange,
  FileCommentThread,
  PullRequestSummary,
  Repository,
  RepositorySummary,
  ReviewComment
} from './model';

type OctokitClient = ReturnType<typeof github.getOctokit>;

type PullRequestFile = {
  filename: string;
  patch?: string;
  status?: string;
};

type PullRequestMetadata = PullRequestSummary & {
  headSha: string;
};

type CourseMetadata = Omit<Course, 'repository'>;

type FileCommentsMap = Record<string, FileCommentThread[]>;

interface PullRequestContext {
  repository: RepositorySummary;
  pullRequest: PullRequestMetadata;
  octokit: OctokitClient;
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
  const pullRequestDetails = await fetchPullRequestDetails(octokit, owner, repo, pullRequestNumber);

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
  octokit: OctokitClient,
  owner: string,
  repo: string,
  pullNumber: number
): Promise<PullRequestDetails> {
  const response = await octokit.rest.pulls.get({
    owner,
    repo,
    pull_number: pullNumber
  });

  const headSha = response.data.head?.sha;

  if (!headSha) {
    throw new Error('Unable to determine the pull request head SHA.');
  }

  return {
    title: response.data.title,
    htmlUrl: response.data.html_url,
    headSha
  };
}

async function buildAffectedFilesModel(
  octokit: OctokitClient,
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
        content = await fetchFileContent(octokit, repository, pullRequest, file.filename);
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
  octokit: OctokitClient,
  repository: RepositorySummary,
  pullRequest: PullRequestMetadata,
  path: string
): Promise<string> {
  const response = await octokit.rest.repos.getContent({
    owner: repository.owner,
    repo: repository.name,
    path,
    ref: pullRequest.headSha
  });

  if (Array.isArray(response.data)) {
    return '';
  }

  if (response.data.type && response.data.type !== 'file') {
    return '';
  }

  if (typeof response.data.content !== 'string') {
    return '';
  }

  return decodeFileContent(response.data.content, response.data.encoding);
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
  octokit: OctokitClient,
  repository: RepositorySummary,
  pullRequest: PullRequestMetadata
): Promise<FileCommentsMap> {
  const comments = await github.paginate(
    octokit.rest.pulls.listReviewComments,
    {
      owner: repository.owner,
      repo: repository.name,
      pull_number: pullRequest.number,
      per_page: 100
    },
    (response) => response.data as PullRequestReviewComment[]
  );
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

async function addCommentToPullRequest(
  octokit: OctokitClient,
  repository: RepositorySummary,
  pullRequest: PullRequestMetadata,
  comment: ReviewComment
): Promise<void> {
  if (comment.type === 'reply') {
    await octokit.rest.pulls.createReviewComment({
      owner: repository.owner,
      repo: repository.name,
      pull_number: pullRequest.number,
      body: comment.content,
      in_reply_to: Number(comment.inReplyTo)
    });
    return;
  }

  await octokit.rest.pulls.createReviewComment({
    owner: repository.owner,
    repo: repository.name,
    pull_number: pullRequest.number,
    body: comment.content,
    commit_id: comment.commitHash,
    path: comment.path,
    line: comment.line,
    side: comment.side
  });
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

    const fileComments = await fetchCommentsForFiles(context.octokit, context.repository, context.pullRequest);

    const affectedFiles = await buildAffectedFilesModel(
      context.octokit,
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

    const repositoryResult: Repository = {
      summary: context.repository,
      pullRequests: [
        {
          summary: {
            name: context.pullRequest.name,
            number: context.pullRequest.number,
            url: context.pullRequest.url,
            commitHash: context.pullRequest.commitHash
          },
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
