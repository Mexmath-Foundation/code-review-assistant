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
async function run() {
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
        const filenames = await github.paginate((parameters) => octokit.rest.pulls.listFiles(parameters), {
            owner,
            repo,
            pull_number: pullRequestNumber,
            per_page: 100
        }, (response) => response.data.map((file) => file.filename));
        if (filenames.length === 0) {
            core.info('No changed files found for this pull request.');
            return;
        }
        core.info('Changed files in this pull request:');
        for (const filename of filenames) {
            core.info(`- ${filename}`);
        }
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
