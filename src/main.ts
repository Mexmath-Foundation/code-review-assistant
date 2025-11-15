import * as core from '@actions/core';
import * as github from '@actions/github';

async function run(): Promise<void> {
  try {
    const token = core.getInput('github-token') || process.env.GITHUB_TOKEN;

    if (!token) {
      core.setFailed('A GitHub token is required to list changed files.');
      return;
    }

    const pullRequestNumber = github.context.payload.pull_request?.number;

    if (!pullRequestNumber) {
      core.info('No pull request context detected. Skipping changed file lookup.');
      return;
    }

    const owner = github.context.repo.owner;
    const repo = github.context.repo.repo;

    if (!owner || !repo) {
      core.setFailed('Repository information is missing from the event context.');
      return;
    }

    const octokit = github.getOctokit(token);

    const filenames = await github.paginate(
      (parameters) => octokit.rest.pulls.listFiles(parameters),
      {
        owner,
        repo,
        pull_number: pullRequestNumber,
        per_page: 100
      },
      (response) => response.data.map((file) => file.filename)
    );

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
