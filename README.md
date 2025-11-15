# Code Review Assistant GitHub Action

This repository contains a TypeScript GitHub Action that enumerates the files changed in the pull request that triggered the workflow.

## Usage

Add the following step to your workflow to invoke the action:

```yaml
- name: List changed files with Code Review Assistant
  uses: ./. # Replace with the repository path once published
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
```

The provided token must have permission to read pull request metadata. When executed on a pull request event the action prints each filename to the job logs.

## Releasing

1. Ensure `dist/` contains the compiled JavaScript by running `npm run build`.
2. Commit and push all changes to the default branch.
3. Create a semantic version tag (for example, `v1.0.0`) and push the tag: `git tag v1.0.0 && git push origin v1.0.0`.
4. Draft a GitHub Release for the new tag. Once published, the action becomes consumable via `uses: <owner>/<repo>@v1` (or the specific tag).

## Adding to a Pull Request workflow

To run the action whenever a pull request is opened, updated, or reopened, add a workflow such as:

```yaml
name: Code Review Assistant changed files

on:
  pull_request:
    types: [opened, synchronize, reopened]

jobs:
  greet:
    runs-on: ubuntu-latest
    steps:
      - name: List pull request changes
        uses: <owner>/<repo>@v1
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
```

## Development

1. Make changes in `src/`.
2. Compile the action with `npm run build` (requires TypeScript tooling).
3. Commit both the source files and the generated files in `dist/`.

## License

[MIT](LICENSE)
