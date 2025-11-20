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
    const pullRequestDetails = await fetchPullRequestDetails(octokit, owner, repo, pullRequestNumber);
    const repository = {
        name: repo,
        owner,
        url: `https://github.com/${owner}/${repo}`
    };
    const pullRequest = {
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
async function listChangedFiles(octokit, repository, pullRequest) {
    return await github.paginate(octokit.rest.pulls.listFiles, {
        owner: repository.owner,
        repo: repository.name,
        pull_number: pullRequest.number,
        per_page: 100
    }, (response) => response.data);
}
async function fetchPullRequestDetails(octokit, owner, repo, pullNumber) {
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
async function buildAffectedFilesModel(octokit, repository, pullRequest, files, fileComments) {
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
            diff: file.patch ?? '',
            commentThreads: fileComments[file.filename] ?? []
        });
    }
    return affectedFiles;
}
async function fetchFileContent(octokit, repository, pullRequest, path) {
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
function encodeRepositoryPath(path) {
    return path
        .split('/')
        .map((segment) => encodeURIComponent(segment))
        .join('/');
}
async function fetchCommentsForFiles(octokit, repository, pullRequest) {
    const comments = await github.paginate(octokit.rest.pulls.listReviewComments, {
        owner: repository.owner,
        repo: repository.name,
        pull_number: pullRequest.number,
        per_page: 100
    }, (response) => response.data);
    const groupedByPath = new Map();
    for (const comment of comments) {
        if (!comment.path) {
            continue;
        }
        const list = groupedByPath.get(comment.path) ?? [];
        list.push(comment);
        groupedByPath.set(comment.path, list);
    }
    const result = {};
    for (const [path, pathComments] of groupedByPath.entries()) {
        result[path] = buildCommentThreads(pathComments);
    }
    return result;
}
function buildCommentThreads(comments) {
    const threads = new Map();
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
function fetchCourseInfo() {
    const id = process.env.COURSE_ID;
    const name = process.env.COURSE_NAME;
    if (!id || !name) {
        core.info('Course information environment variables were not fully provided.');
        return null;
    }
    return { id, name };
}
async function addComment(owner, repo, number, commitHash, comment, octokit) {
    switch (comment.type) {
        case 'general':
            await octokit.rest.pulls.createReviewComment({
                owner: owner,
                repo: repo,
                pull_number: number,
                body: comment.content
            });
            break;
        case 'reply':
            await octokit.rest.pulls.createReviewComment({
                owner: owner,
                repo: repo,
                pull_number: number,
                body: comment.content,
                in_reply_to: Number(comment.inReplyTo)
            });
            break;
        case 'line':
            await octokit.rest.pulls.createReviewComment({
                owner: owner,
                repo: repo,
                pull_number: number,
                body: comment.content,
                commit_id: commitHash,
                path: comment.path,
                line: comment.line,
                side: comment.side
            });
            break;
    }
}
async function addReview(review, octokit) {
    for (const comment of review.comments) {
        await addComment(review.repositoryOwner, review.repositoryName, review.pullRequestNumber, review.pullRequestCommitHash, comment, octokit);
    }
}
async function addReviewTest(repository, pullRequest, files, octokit) {
    if (files.length === 0) {
        return;
    }
    const comments = [];
    for (const file of files) {
        const lineCount = file.content && file.content.length > 0 ? file.content.split(/\r?\n/).length : 1;
        const randomLine = Math.max(1, Math.floor(Math.random() * lineCount) + 1);
        comments.push({
            type: 'line',
            content: `Test review comment for ${file.path} on line ${randomLine}`,
            path: file.path,
            line: randomLine,
            side: 'RIGHT'
        });
    }
    const review = {
        repositoryName: repository.name,
        repositoryOwner: repository.owner,
        pullRequestNumber: pullRequest.number,
        pullRequestUrl: pullRequest.url,
        pullRequestCommitHash: pullRequest.commitHash,
        comments
    };
    await addReview(review, octokit);
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
        const fileComments = await fetchCommentsForFiles(context.octokit, context.repository, context.pullRequest);
        const affectedFiles = await buildAffectedFilesModel(context.octokit, context.repository, context.pullRequest, files, fileComments);
        await addReviewTest(context.repository, context.pullRequest, affectedFiles, context.octokit);
        const courseInfo = fetchCourseInfo();
        if (!courseInfo) {
            core.setFailed('Course information is required but could not be determined from the environment.');
            return;
        }
        const repositoryResult = {
            name: context.repository.name,
            owner: context.repository.owner,
            url: context.repository.url,
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
        const result = {
            ...courseInfo,
            repository: repositoryResult
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
