import * as core from '@actions/core';
import * as github from '@actions/github';

type OctokitClient = ReturnType<typeof github.getOctokit>;

type PullRequestFile = {
  filename: string;
  patch?: string;
  status?: string;
};

const GITHUB_API_URL = process.env.GITHUB_API_URL || 'https://api.github.com';

interface RepositoryInfo {
  name: string;
  owner: string;
  url: string;
}

interface PullRequestModel {
  name: string;
  number: number;
  url: string;
}

interface PullRequestMetadata extends PullRequestModel {
  headSha: string;
}

interface FileModel {
  name: string;
  path: string;
  content: string;
  diff: string;
}

interface PullRequestResultEntry extends PullRequestModel {
  files: FileModel[];
}

interface ActionResultModel {
  repository: RepositoryInfo;
  pullRequests: PullRequestResultEntry[];
}

interface PullRequestContext {
  repository: RepositoryInfo;
  pullRequest: PullRequestMetadata;
  token: string;
  octokit: OctokitClient;
}

interface PullRequestApiResponse {
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
  html_url: string;
  headSha: string;
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

  const repository: RepositoryInfo = {
    name: repo,
    owner,
    url: `https://github.com/${owner}/${repo}`
  };

  const pullRequest: PullRequestMetadata = {
    name: pullRequestDetails.title ?? `Pull Request #${pullRequestNumber}`,
    number: pullRequestNumber,
    url: pullRequestDetails.html_url,
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
  repository: RepositoryInfo,
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
  const data = await requestGithubJson<PullRequestApiResponse>(
    token,
    `/repos/${owner}/${repo}/pulls/${pullNumber}`
  );

  const headSha = data.head?.sha;

  if (!headSha) {
    throw new Error('Unable to determine the pull request head SHA.');
  }

  return {
    title: data.title,
    html_url: data.html_url,
    headSha
  };
}

async function buildAffectedFilesModel(
  token: string,
  repository: RepositoryInfo,
  pullRequest: PullRequestMetadata,
  files: PullRequestFile[]
): Promise<FileModel[]> {
  const affectedFiles: FileModel[] = [];

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
      diff: file.patch ?? ''
    });
  }

  return affectedFiles;
}

async function fetchFileContent(
  token: string,
  repository: RepositoryInfo,
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

async function requestGithubJson<T>(
  token: string,
  path: string,
  query?: Record<string, string>
): Promise<T> {
  const url = buildGithubUrl(path, query);
  const response = await fetch(url, {
    headers: buildGithubHeaders(token)
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

    const affectedFiles = await buildAffectedFilesModel(
      context.token,
      context.repository,
      context.pullRequest,
      files
    );

    const result: ActionResultModel = {
      repository: context.repository,
      pullRequests: [
        {
          name: context.pullRequest.name,
          number: context.pullRequest.number,
          url: context.pullRequest.url,
          files: affectedFiles
        }
      ]
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
