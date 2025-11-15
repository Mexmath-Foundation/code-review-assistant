import * as core from '@actions/core';
import { readFileSync } from 'fs';

interface PullRequestPayload {
  pull_request?: {
    number?: number;
  };
  repository?: {
    name?: string;
    owner?: {
      login?: string;
    };
  };
}

async function run(): Promise<void> {
  try {
    const tokenInput = core.getInput('github-token');
    const token = tokenInput || process.env.GITHUB_TOKEN;

    if (!token) {
      core.setFailed('A GitHub token is required to list changed files.');
      return;
    }

    const eventPath = process.env.GITHUB_EVENT_PATH;

    if (!eventPath) {
      core.setFailed('GITHUB_EVENT_PATH is not set. This action must run within a GitHub Actions environment.');
      return;
    }

    let payload: PullRequestPayload;

    try {
      const rawPayload = readFileSync(eventPath, 'utf8');
      payload = JSON.parse(rawPayload) as PullRequestPayload;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      core.setFailed(`Failed to read GitHub event payload: ${message}`);
      return;
    }

    const pullRequestNumber = payload.pull_request?.number;

    if (!pullRequestNumber) {
      core.info('No pull request context detected. Skipping changed file lookup.');
      return;
    }

    const repositoryOwner = payload.repository?.owner?.login ?? process.env.GITHUB_REPOSITORY?.split('/')[0];
    const repositoryName = payload.repository?.name ?? process.env.GITHUB_REPOSITORY?.split('/')[1];

    if (!repositoryOwner || !repositoryName) {
      core.setFailed('Repository information is missing from the event payload.');
      return;
    }

    const apiBaseUrl = process.env.GITHUB_API_URL ?? 'https://api.github.com';
    const perPage = 100;
    const filenames: string[] = [];

    for (let page = 1; ; page += 1) {
      const response = await fetch(
        `${apiBaseUrl}/repos/${repositoryOwner}/${repositoryName}/pulls/${pullRequestNumber}/files?per_page=${perPage}&page=${page}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
            'User-Agent': 'code-review-assistant-action',
            'X-GitHub-Api-Version': '2022-11-28'
          }
        }
      );

      if (!response.ok) {
        core.setFailed(`GitHub API request failed with status ${response.status}: ${response.statusText}`);
        return;
      }

      const files = (await response.json()) as Array<{ filename: string }>;

      if (files.length === 0) {
        break;
      }

      for (const file of files) {
        filenames.push(file.filename);
      }

      if (files.length < perPage) {
        break;
      }
    }

    if (filenames.length === 0) {
      core.info('No changed files found for this pull request.');
      return;
    }

    core.info('Changed files in this pull request:');
    for (const filename of filenames) {
      core.info(`- ${filename}`);
    }
  } catch (error) {
    if (error instanceof Error) {
      core.setFailed(error.message);
    } else {
      core.setFailed('Unknown error occurred while listing changed files.');
    }
  }
}

run();
