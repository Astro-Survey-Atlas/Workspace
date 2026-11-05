# Main Branch Protection

Protect `main` with a pull request requirement, require all of these checks before merging, and block force pushes and branch deletion:

- `Build & test (node)`
- `Desktop smoke (no GUI)`
- `Helm lint & render`
- `Docker build (no push)`
- `Secret scan (gitleaks)`

The repository CI workflow and `.pre-commit-config.yaml` define these checks. GitHub stores branch protection outside the repository, so an administrator must apply this rule in the repository settings.
