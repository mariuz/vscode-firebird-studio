# Publishing Firebird Studio for VS Code

This guide provides step-by-step instructions for publishing **Firebird Studio for VS Code** to the **Visual Studio Marketplace** and the **Open VSX Registry**.

---

## Table of Contents

- [Overview](#overview)
- [Publisher Credentials & Setup](#publisher-credentials--setup)
  - [1. Visual Studio Marketplace](#1-visual-studio-marketplace)
  - [2. Open VSX Registry](#2-open-vsx-registry)
- [Configuring CI/CD Secrets in GitHub](#configuring-cicd-secrets-in-github)
- [Pre-Release Checklist](#pre-release-checklist)
- [Publishing Workflows](#publishing-workflows)
  - [Workflow A: Automated GitHub Actions Release (Recommended)](#workflow-a-automated-github-actions-release-recommended)
  - [Workflow B: Manual Command-Line Publishing (vsce / ovsx)](#workflow-b-manual-command-line-publishing-vsce--ovsx)
  - [Workflow C: Web Management Portal Upload](#workflow-c-web-management-portal-upload)
- [Post-Release Verification](#post-release-verification)
- [Troubleshooting & Common Traps](#troubleshooting--common-traps)

---

## Overview

Firebird Studio is configured for dual-registry distribution:

| Registry | Target Audience / IDEs | Publisher ID | URL |
| :--- | :--- | :--- | :--- |
| **Visual Studio Marketplace** | Official VS Code, VS Code Insiders | `AdrianMariusPopa` | [Marketplace Publisher](https://marketplace.visualstudio.com/manage/publishers/AdrianMariusPopa) |
| **Open VSX Registry** | Cursor, VSCodium, Gitpod, Eclipse Theia | `AdrianMariusPopa` | [Open VSX Registry](https://open-vsx.org/) |

The repository contains an automated release workflow in [`.github/workflows/release.yml`](.github/workflows/release.yml) that automatically builds, tests, packages, smoke-tests, creates a GitHub Release, and publishes to both registries when a version tag (`v*`) is pushed.

---

## Publisher Credentials & Setup

### 1. Visual Studio Marketplace

#### A. Create the Publisher Account
1. Go to the [Visual Studio Marketplace Management Portal](https://marketplace.visualstudio.com/manage).
2. Sign in with your Microsoft account.
3. Click **Create publisher** (if you do not have one already):
   * **Publisher ID**: `AdrianMariusPopa` *(must exactly match `"publisher": "AdrianMariusPopa"` in `package.json`)*.
   * **Publisher Name / Display Name**: `Adrian Marius Popa`.
4. Accept the terms and click **Create**.

#### B. Generate an Azure DevOps Personal Access Token (PAT)
The `@vscode/vsce` CLI publishes using a Personal Access Token managed in Azure DevOps:

1. Sign in to [Azure DevOps](https://dev.azure.com/).
2. Create an organization if needed (e.g. `https://dev.azure.com/<your-org>`).
3. Click the **User Settings** gear icon (top-right next to your avatar) &rarr; select **Personal Access Tokens**.
4. Click **+ New Token**.
5. Fill in the token configuration:
   * **Name**: `vsce-firebird-studio`
   * **Organization**: **All accessible organizations**
     > [!IMPORTANT]
     > You **must** select **"All accessible organizations"** in the dropdown. A token scoped to a single Azure DevOps organization will be rejected with an authentication error by the Marketplace API.
   * **Expiration**: Select 90, 180, or 365 days.
   * **Scopes**:
     * Click **Show all scopes** at the bottom of the list.
     * Scroll down to find **Marketplace**.
     * Check the **Manage** permission (or "Acquire & Manage").
6. Click **Create**.
7. **Copy the PAT immediately** and save it in your password manager — Azure DevOps will never display it again.

---

### 2. Open VSX Registry

Open VSX allows Cursor, VSCodium, and other open-source VS Code derivatives to download and install the extension.

#### A. Create Account & Generate Token
1. Go to [Open VSX](https://open-vsx.org/) and sign in with your GitHub account.
2. Go to **Settings** &rarr; [Access Tokens](https://open-vsx.org/user-settings/tokens).
3. Generate a new personal access token and copy it.

#### B. One-Time Namespace Claim (Required Before First Publish)
Open VSX requires publishers to claim their namespace once before publishing:

```bash
npx ovsx create-namespace AdrianMariusPopa -p <YOUR_OVSX_TOKEN>
```

> [!NOTE]
> This command only ever needs to run **once** in the lifetime of the namespace. Do not include this in recurring CI scripts.

---

## Configuring CI/CD Secrets in GitHub

To enable automated publishing via [`.github/workflows/release.yml`](.github/workflows/release.yml), add the tokens as repository secrets:

1. Navigate to your repository on GitHub:
   `https://github.com/mariuz/vscode-firebird-studio/settings/secrets/actions`
2. Click **New repository secret**:
   * **Secret 1**:
     * Name: `VSCE_PAT`
     * Value: `<Your Azure DevOps Personal Access Token>`
   * **Secret 2**:
     * Name: `OVSX_TOKEN`
     * Value: `<Your Open VSX Personal Access Token>`

If either secret is missing, the release workflow still runs tests, builds the `.vsix`, runs the smoke test, and creates the GitHub Release, but gracefully skips publishing to the unconfigured registry with a notice in the job log.

---

## Pre-Release Checklist

Before tagging a release, ensure the repository is ready:

1. **Verify Version Bump**:
   * Ensure `version` in [`package.json`](package.json) is updated (e.g. `"version": "0.3.1"`).
2. **Update Changelog**:
   * Ensure [`CHANGELOG.md`](CHANGELOG.md) contains a dedicated section for the release version (e.g. `## 0.3.1 - YYYY-MM-DD`).
   * The release script (`scripts/release-notes.mjs`) automatically extracts these notes and stops the release if the version is missing or labelled "Unreleased".
3. **Run Test & Coverage Gate Locally**:
   ```bash
   npm run test:coverage:check
   ```
   *All 2,188+ tests must pass and coverage thresholds (71% Stmt / 88% Branch / 64% Func / 71% Line) must be satisfied.*
4. **Clean Git State**:
   ```bash
   git status
   ```
   *Commit and push all changes to `master`.*

---

## Publishing Workflows

### Workflow A: Automated GitHub Actions Release (Recommended)

1. Create a git tag matching the version in `package.json` prefixed with `v`:
   ```bash
   git tag v0.3.1
   git push origin v0.3.1
   ```

2. Monitor the workflow execution:
   * Open the **Actions** tab on GitHub: [Release Workflow](https://github.com/mariuz/vscode-firebird-studio/actions/workflows/release.yml).
   * The workflow will execute:
     1. Version verification against `package.json` and `CHANGELOG.md`.
     2. Full unit and integration test coverage validation.
     3. Package build (`npm run package`).
     4. Install smoke testing in a headless VS Code instance.
     5. Creation of a tagged GitHub Release with the `.vsix` file attached.
     6. Publication to the Visual Studio Marketplace (using `VSCE_PAT`).
     7. Publication to Open VSX (using `OVSX_TOKEN`).

3. Rehearsing via Dry Run:
   * To test the workflow without publishing, navigate to **Actions** &rarr; **Release** &rarr; **Run workflow**, keep **dry_run** set to `true`, and trigger.

---

### Workflow B: Manual Command-Line Publishing (vsce / ovsx)

If you need to publish manually from a local terminal:

#### 1. Compile and Package the Extension
```bash
# Clean install dependencies
npm install

# Build the .vsix package
npm run package
```
This produces `vscode-firebird-studio-<version>.vsix` in the workspace root.

#### 2. Publish to Visual Studio Marketplace
```bash
npx @vscode/vsce publish --packagePath vscode-firebird-studio-<version>.vsix -p <YOUR_VSCE_PAT>
```

*Alternatively, log in once and publish:*
```bash
npx @vscode/vsce login AdrianMariusPopa
npx @vscode/vsce publish --packagePath vscode-firebird-studio-<version>.vsix
```

#### 3. Publish to Open VSX
```bash
npx ovsx publish vscode-firebird-studio-<version>.vsix -p <YOUR_OVSX_TOKEN>
```

---

### Workflow C: Web Management Portal Upload

If you prefer uploading through the browser:

1. Generate the `.vsix` package:
   ```bash
   npm run package
   ```
2. **Visual Studio Marketplace**:
   * Navigate to the [Marketplace Manage Page](https://marketplace.visualstudio.com/manage/publishers/AdrianMariusPopa).
   * Click **+ New extension** &rarr; **Visual Studio Code**.
   * Drag and drop `vscode-firebird-studio-<version>.vsix`.
   * Click **Upload**.
3. **Open VSX**:
   * Navigate to [Open VSX](https://open-vsx.org/).
   * Click your user profile in the top right &rarr; **Publish Extension**.
   * Drag and drop the `.vsix` package and submit.

---

## Post-Release Verification

1. **Visual Studio Marketplace Validation**:
   * After upload, the Marketplace runs automated security and manifest verification (typically takes 2–5 minutes).
   * Check status at [Marketplace Management](https://marketplace.visualstudio.com/manage/publishers/AdrianMariusPopa). Status will transition from *Verifying* &rarr; *Active*.
2. **VS Code Installation Check**:
   * In VS Code, open Extensions (`Ctrl+Shift+X` / `Cmd+Shift+X`).
   * Search for `@publisher:AdrianMariusPopa` or `Firebird Studio`.
   * Verify the latest version number, extension icon, and README formatting.
3. **Cursor / VSCodium Check**:
   * Open Cursor or VSCodium and verify the extension appears in search results from Open VSX.

---

## Troubleshooting & Common Traps

| Symptom / Error | Cause | Resolution |
| :--- | :--- | :--- |
| `Error: Failed Request: Unauthorized(401)` | Azure DevOps PAT organization scope was not set to **"All accessible organizations"**. | Regenerate the PAT in Azure DevOps, ensuring the organization dropdown is explicitly set to **"All accessible organizations"** and scope includes **Marketplace: Manage**. |
| `Error: Publisher 'AdrianMariusPopa' not found` | The publisher ID has not been created on the Marketplace portal or has a typo. | Visit [marketplace.visualstudio.com/manage](https://marketplace.visualstudio.com/manage) and create the publisher with ID `AdrianMariusPopa`. |
| `Tag vX.Y.Z does not match package.json` | Pushed tag differs from `version` field in `package.json`. | Update `package.json` to match the tag, or tag the commit that has the matching version. |
| `scripts/release-notes.mjs exited with 1` | `CHANGELOG.md` does not have a section header matching the release version. | Add `## <version> - YYYY-MM-DD` with release notes to `CHANGELOG.md`. |
| `Namespace 'AdrianMariusPopa' does not exist` (Open VSX) | Namespace has not been claimed on Open VSX. | Run `npx ovsx create-namespace AdrianMariusPopa -p <TOKEN>` once before publishing. |
| PAT expired | Azure DevOps PAT reached its expiration date. | Generate a new PAT in Azure DevOps and update the `VSCE_PAT` repository secret in GitHub Settings. |
