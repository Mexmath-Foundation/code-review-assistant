import * as core from '@actions/core';
import * as github from '@actions/github';

type BaseOctokit = ReturnType<typeof github.getOctokit>;
type OctokitClient = BaseOctokit & {
  rest: {
    pulls: BaseOctokit['rest']['pulls'] & Record<string, unknown>;
    repos: Record<string, unknown>;
  };
};

type PullRequestFile = {
  filename: string;
  patch?: string;
  status?: string;
};

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
  octokit: OctokitClient;
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

  const octokit = github.getOctokit(token) as OctokitClient;
  const pullsApi = octokit.rest.pulls as Record<string, unknown>;
  const pullRequestResponse = await (pullsApi.get as (
    params: { owner: string; repo: string; pull_number: number }
  ) => Promise<{ data: { head?: { sha?: string }; title?: string; html_url: string } }>)({
    owner,
    repo,
    pull_number: pullRequestNumber
  });

  const headSha = pullRequestResponse.data.head?.sha;

  if (!headSha) {
    core.setFailed('Unable to determine the pull request head SHA.');
    return null;
  }

  const repository: RepositoryInfo = {
    name: repo,
    owner,
    url: `https://github.com/${owner}/${repo}`
  };

  const pullRequest: PullRequestMetadata = {
    name: pullRequestResponse.data.title ?? `Pull Request #${pullRequestNumber}`,
    number: pullRequestNumber,
    url: pullRequestResponse.data.html_url,
    headSha
  };

  return {
    repository,
    pullRequest,
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

async function buildAffectedFilesModel(
  octokit: OctokitClient,
  repository: RepositoryInfo,
  pullRequest: PullRequestMetadata,
  files: PullRequestFile[]
): Promise<FileModel[]> {
  const affectedFiles: FileModel[] = [];

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
      diff: file.patch ?? ''
    });
  }

  return affectedFiles;
}

async function fetchFileContent(
  octokit: OctokitClient,
  repository: RepositoryInfo,
  pullRequest: PullRequestMetadata,
  path: string
): Promise<string> {
  const reposApi = octokit.rest.repos as {
    getContent: (params: { owner: string; repo: string; path: string; ref: string }) => Promise<{
      data: { content?: string; encoding?: string } | Array<unknown>;
    }>;
  };

  const response = await reposApi.getContent({
    owner: repository.owner,
    repo: repository.name,
    path,
    ref: pullRequest.headSha
  });

  if (Array.isArray(response.data)) {
    return '';
  }

  const file = response.data as { content?: string; encoding?: string };
  if (typeof file.content !== 'string') {
    return '';
  }

  return decodeFileContent(file.content, file.encoding);
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
      context.octokit,
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
