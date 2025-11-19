"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const core = __importStar(require("@actions/core"));
const github = __importStar(require("@actions/github"));
async function resolvePullRequestContext() {
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
    const pullsApi = octokit.rest.pulls;
    const pullRequestResponse = await pullsApi.get({
        owner,
        repo,
        pull_number: pullRequestNumber
    });
    const headSha = pullRequestResponse.data.head?.sha;
    if (!headSha) {
        core.setFailed('Unable to determine the pull request head SHA.');
        return null;
    }
    const repository = {
        name: repo,
        owner,
        url: `https://github.com/${owner}/${repo}`
    };
    const pullRequest = {
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
async function listChangedFiles(octokit, repository, pullRequest) {
    return await github.paginate(octokit.rest.pulls.listFiles, {
        owner: repository.owner,
        repo: repository.name,
        pull_number: pullRequest.number,
        per_page: 100
    }, (response) => response.data);
}
async function buildAffectedFilesModel(octokit, repository, pullRequest, files) {
    const affectedFiles = [];
    for (const file of files) {
        let content = '';
        if (file.status !== 'removed') {
            try {
                content = await fetchFileContent(octokit, repository, pullRequest, file.filename);
            }
            catch (error) {
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
async function fetchFileContent(octokit, repository, pullRequest, path) {
    const reposApi = octokit.rest.repos;
    const response = await reposApi.getContent({
        owner: repository.owner,
        repo: repository.name,
        path,
        ref: pullRequest.headSha
    });
    if (Array.isArray(response.data)) {
        return '';
    }
    const file = response.data;
    if (typeof file.content !== 'string') {
        return '';
    }
    return decodeFileContent(file.content, file.encoding);
}
function extractFileName(filePath) {
    const segments = filePath.split('/');
    return segments[segments.length - 1] ?? filePath;
}
function decodeFileContent(content, encoding) {
    if (encoding === 'base64') {
        return Buffer.from(content, 'base64').toString('utf8');
    }
    return content;
}
async function run() {
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
        const affectedFiles = await buildAffectedFilesModel(context.octokit, context.repository, context.pullRequest, files);
        const result = {
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
    }
    catch (error) {
        if (error instanceof Error) {
            core.setFailed(error.message);
        }
        else {
            core.setFailed('Unknown error occurred while listing changed files.');
        }
    }
}
run();
