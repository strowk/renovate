import URL from 'url';
import is from '@sindresorhus/is';
import JSON5 from 'json5';
import semver from 'semver';
import { PlatformId } from '../../../constants';
import {
  REPOSITORY_ACCESS_FORBIDDEN,
  REPOSITORY_ARCHIVED,
  REPOSITORY_BLOCKED,
  REPOSITORY_CHANGED,
  REPOSITORY_EMPTY,
  REPOSITORY_MIRRORED,
} from '../../../constants/error-messages';
import { logger } from '../../../logger';
import { BranchStatus, PrState, VulnerabilityAlert } from '../../../types';
import * as git from '../../../util/git';
import * as hostRules from '../../../util/host-rules';
import { setBaseUrl } from '../../../util/http/gitea';
import { sanitize } from '../../../util/sanitize';
import { ensureTrailingSlash } from '../../../util/url';
import type {
  BranchStatusConfig,
  CreatePRConfig,
  EnsureCommentConfig,
  EnsureCommentRemovalConfig,
  EnsureIssueConfig,
  FindPRConfig,
  Issue,
  MergePRConfig,
  Platform,
  PlatformParams,
  PlatformResult,
  Pr,
  RepoParams,
  RepoResult,
  UpdatePrConfig,
} from '../types';
import { smartTruncate } from '../utils/pr-body';
import * as helper from './gitea-helper';
import { smartLinks } from './utils';

interface GiteaRepoConfig {
  repository: string;
  mergeMethod: helper.PRMergeMethod;

  prList: Promise<Pr[]> | null;
  issueList: Promise<Issue[]> | null;
  labelList: Promise<helper.Label[]> | null;
  defaultBranch: string;
  cloneSubmodules: boolean;
}

const defaults = {
  hostType: PlatformId.Gitea,
  endpoint: 'https://gitea.com/api/v1/',
  version: '0.0.0',
};

let config: GiteaRepoConfig = {} as any;
let botUserID: number;
let botUserName: string;

function toRenovateIssue(data: helper.Issue): Issue {
  return {
    number: data.number,
    state: data.state,
    title: data.title,
    body: data.body,
  };
}

function toRenovatePR(data: helper.PR): Pr | null {
  if (!data) {
    return null;
  }

  if (
    !data.base?.ref ||
    !data.head?.label ||
    !data.head?.sha ||
    !data.head?.repo?.full_name
  ) {
    logger.trace(
      `Skipping Pull Request #${data.number} due to missing base and/or head branch`
    );
    return null;
  }

  const createdBy = data.user?.username;
  if (createdBy && botUserName && createdBy !== botUserName) {
    return null;
  }

  return {
    number: data.number,
    displayNumber: `Pull Request #${data.number}`,
    state: data.state,
    title: data.title,
    body: data.body,
    sha: data.head.sha,
    sourceBranch: data.head.label,
    targetBranch: data.base.ref,
    sourceRepo: data.head.repo.full_name,
    createdAt: data.created_at,
    cannotMergeReason: data.mergeable
      ? undefined
      : `pr.mergeable="${data.mergeable}"`,
    hasAssignees: !!(data.assignee?.login || is.nonEmptyArray(data.assignees)),
  };
}

function matchesState(actual: string, expected: string): boolean {
  if (expected === PrState.All) {
    return true;
  }
  if (expected.startsWith('!')) {
    return actual !== expected.substring(1);
  }

  return actual === expected;
}

function findCommentByTopic(
  comments: helper.Comment[],
  topic: string
): helper.Comment | null {
  return comments.find((c) => c.body.startsWith(`### ${topic}\n\n`)) ?? null;
}

function findCommentByContent(
  comments: helper.Comment[],
  content: string
): helper.Comment | null {
  return comments.find((c) => c.body.trim() === content) ?? null;
}

function getLabelList(): Promise<helper.Label[]> {
  if (config.labelList === null) {
    const repoLabels = helper
      .getRepoLabels(config.repository, {
        useCache: false,
      })
      .then((labels) => {
        logger.debug(`Retrieved ${labels.length} repo labels`);
        return labels;
      });

    const orgLabels = helper
      .getOrgLabels(config.repository.split('/')[0], {
        useCache: false,
      })
      .then((labels) => {
        logger.debug(`Retrieved ${labels.length} org labels`);
        return labels;
      })
      .catch((err) => {
        // Will fail if owner of repo is not org or Gitea version < 1.12
        logger.debug(`Unable to fetch organization labels`);
        return [] as helper.Label[];
      });

    config.labelList = Promise.all([repoLabels, orgLabels]).then((labels) =>
      ([] as helper.Label[]).concat(...labels)
    );
  }

  return config.labelList;
}

async function lookupLabelByName(name: string): Promise<number | null> {
  logger.debug(`lookupLabelByName(${name})`);
  const labelList = await getLabelList();
  return labelList.find((l) => l.name === name)?.id ?? null;
}

const platform: Platform = {
  async initPlatform({
    endpoint,
    token,
  }: PlatformParams): Promise<PlatformResult> {
    if (!token) {
      throw new Error('Init: You must configure a Gitea personal access token');
    }

    if (endpoint) {
      defaults.endpoint = ensureTrailingSlash(endpoint);
    } else {
      logger.debug('Using default Gitea endpoint: ' + defaults.endpoint);
    }
    setBaseUrl(defaults.endpoint);

    let gitAuthor: string;
    try {
      const user = await helper.getCurrentUser({ token });
      gitAuthor = `${user.full_name || user.username} <${user.email}>`;
      botUserID = user.id;
      botUserName = user.username;
      defaults.version = await helper.getVersion({ token });
    } catch (err) {
      logger.debug(
        { err },
        'Error authenticating with Gitea. Check your token'
      );
      throw new Error('Init: Authentication failure');
    }

    return {
      endpoint: defaults.endpoint,
      gitAuthor,
    };
  },

  async getRawFile(
    fileName: string,
    repoName?: string,
    branchOrTag?: string
  ): Promise<string | null> {
    const repo = repoName ?? config.repository;
    const contents = await helper.getRepoContents(repo, fileName, branchOrTag);
    return contents.contentString ?? null;
  },

  async getJsonFile(
    fileName: string,
    repoName?: string,
    branchOrTag?: string
  ): Promise<any | null> {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
    const raw = (await platform.getRawFile(
      fileName,
      repoName,
      branchOrTag
    )) as string;
    if (fileName.endsWith('.json5')) {
      return JSON5.parse(raw);
    }
    return JSON.parse(raw);
  },

  async initRepo({
    repository,
    cloneSubmodules,
  }: RepoParams): Promise<RepoResult> {
    let repo: helper.Repo;

    config = {} as any;
    config.repository = repository;
    config.cloneSubmodules = !!cloneSubmodules;

    // Attempt to fetch information about repository
    try {
      repo = await helper.getRepo(repository);
    } catch (err) {
      logger.debug({ err }, 'Unknown Gitea initRepo error');
      throw err;
    }

    // Ensure appropriate repository state and permissions
    if (repo.archived) {
      logger.debug(
        'Repository is archived - throwing error to abort renovation'
      );
      throw new Error(REPOSITORY_ARCHIVED);
    }
    if (repo.mirror) {
      logger.debug(
        'Repository is a mirror - throwing error to abort renovation'
      );
      throw new Error(REPOSITORY_MIRRORED);
    }
    if (!repo.permissions.pull || !repo.permissions.push) {
      logger.debug(
        'Repository does not permit pull and push - throwing error to abort renovation'
      );
      throw new Error(REPOSITORY_ACCESS_FORBIDDEN);
    }
    if (repo.empty) {
      logger.debug('Repository is empty - throwing error to abort renovation');
      throw new Error(REPOSITORY_EMPTY);
    }

    if (repo.allow_rebase) {
      config.mergeMethod = 'rebase';
    } else if (repo.allow_rebase_explicit) {
      config.mergeMethod = 'rebase-merge';
    } else if (repo.allow_squash_merge) {
      config.mergeMethod = 'squash';
    } else if (repo.allow_merge_commits) {
      config.mergeMethod = 'merge';
    } else {
      logger.debug(
        'Repository has no allowed merge methods - throwing error to abort renovation'
      );
      throw new Error(REPOSITORY_BLOCKED);
    }

    // Determine author email and branches
    config.defaultBranch = repo.default_branch;
    logger.debug(`${repository} default branch = ${config.defaultBranch}`);

    // Find options for current host and determine Git endpoint
    const opts = hostRules.find({
      hostType: PlatformId.Gitea,
      url: defaults.endpoint,
    });
    const gitEndpoint = URL.parse(repo.clone_url);
    gitEndpoint.auth = opts.token ?? null;

    // Initialize Git storage
    await git.initRepo({
      ...config,
      url: URL.format(gitEndpoint),
    });

    // Reset cached resources
    config.prList = null;
    config.issueList = null;
    config.labelList = null;

    return {
      defaultBranch: config.defaultBranch,
      isFork: !!repo.fork,
    };
  },

  async getRepos(): Promise<string[]> {
    logger.debug('Auto-discovering Gitea repositories');
    try {
      const repos = await helper.searchRepos({
        uid: botUserID,
        archived: false,
      });
      return repos.map((r) => r.full_name);
    } catch (err) {
      logger.error({ err }, 'Gitea getRepos() error');
      throw err;
    }
  },

  async setBranchStatus({
    branchName,
    context,
    description,
    state,
    url: target_url,
  }: BranchStatusConfig): Promise<void> {
    try {
      // Create new status for branch commit
      const branchCommit = git.getBranchCommit(branchName);
      // TODO: check branchCommit
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
      await helper.createCommitStatus(config.repository, branchCommit!, {
        state: helper.renovateToGiteaStatusMapping[state] || 'pending',
        context,
        description,
        ...(target_url && { target_url }),
      });

      // Refresh caches by re-fetching commit status for branch
      await helper.getCombinedCommitStatus(config.repository, branchName, {
        useCache: false,
      });
    } catch (err) {
      logger.warn({ err }, 'Failed to set branch status');
    }
  },

  async getBranchStatus(branchName: string): Promise<BranchStatus> {
    let ccs: helper.CombinedCommitStatus;
    try {
      ccs = await helper.getCombinedCommitStatus(config.repository, branchName);
    } catch (err) {
      if (err.statusCode === 404) {
        logger.debug(
          'Received 404 when checking branch status, assuming branch deletion'
        );
        throw new Error(REPOSITORY_CHANGED);
      }

      logger.debug('Unknown error when checking branch status');
      throw err;
    }

    logger.debug({ ccs }, 'Branch status check result');
    return (
      helper.giteaToRenovateStatusMapping[ccs.worstStatus] ||
      BranchStatus.yellow
    );
  },

  async getBranchStatusCheck(
    branchName: string,
    context: string
  ): Promise<BranchStatus | null> {
    const ccs = await helper.getCombinedCommitStatus(
      config.repository,
      branchName
    );
    const cs = ccs.statuses.find((s) => s.context === context);
    if (!cs) {
      return null;
    } // no status check exists
    const status = helper.giteaToRenovateStatusMapping[cs.status];
    if (status) {
      return status;
    }
    logger.warn(
      { check: cs },
      'Could not map Gitea status value to Renovate status'
    );
    return BranchStatus.yellow;
  },

  getPrList(): Promise<Pr[]> {
    if (config.prList === null) {
      config.prList = helper
        .searchPRs(
          config.repository,
          { state: PrState.All },
          { useCache: false }
        )
        .then((prs) => {
          const prList = prs.map(toRenovatePR).filter(is.truthy);
          logger.debug(`Retrieved ${prList.length} Pull Requests`);
          return prList;
        });
    }

    return config.prList;
  },

  async getPr(number: number): Promise<Pr | null> {
    // Search for pull request in cached list or attempt to query directly
    const prList = await platform.getPrList();
    let pr = prList.find((p) => p.number === number) ?? null;
    if (pr) {
      logger.debug('Returning from cached PRs');
    } else {
      logger.debug('PR not found in cached PRs - trying to fetch directly');
      const gpr = await helper.getPR(config.repository, number);
      pr = toRenovatePR(gpr);

      // Add pull request to cache for further lookups / queries
      if (config.prList !== null) {
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
        (await config.prList).push(pr!);
      }
    }

    // Abort and return null if no match was found
    if (!pr) {
      return null;
    }

    return pr;
  },

  async findPr({
    branchName,
    prTitle: title,
    state = PrState.All,
  }: FindPRConfig): Promise<Pr | null> {
    logger.debug(`findPr(${branchName}, ${title}, ${state})`);
    const prList = await platform.getPrList();
    const pr = prList.find(
      (p) =>
        p.sourceRepo === config.repository &&
        p.sourceBranch === branchName &&
        matchesState(p.state, state) &&
        (!title || p.title === title)
    );

    if (pr) {
      logger.debug(`Found PR #${pr.number}`);
    }
    return pr ?? null;
  },

  async createPr({
    sourceBranch,
    targetBranch,
    prTitle: title,
    prBody: rawBody,
    labels: labelNames,
  }: CreatePRConfig): Promise<Pr> {
    const base = targetBranch;
    const head = sourceBranch;
    const body = sanitize(rawBody);

    logger.debug(`Creating pull request: ${title} (${head} => ${base})`);
    try {
      const labels = Array.isArray(labelNames)
        ? await Promise.all(labelNames.map(lookupLabelByName))
        : [];
      const gpr = await helper.createPR(config.repository, {
        base,
        head,
        title,
        body,
        labels: labels.filter(is.number),
      });

      const pr = toRenovatePR(gpr);
      if (!pr) {
        throw new Error('Can not parse newly created Pull Request');
      }
      if (config.prList !== null) {
        (await config.prList).push(pr);
      }

      return pr;
    } catch (err) {
      // When the user manually deletes a branch from Renovate, the PR remains but is no longer linked to any branch. In
      // the most recent versions of Gitea, the PR gets automatically closed when that happens, but older versions do
      // not handle this properly and keep the PR open. As pushing a branch with the same name resurrects the PR, this
      // would cause a HTTP 409 conflict error, which we hereby gracefully handle.
      if (err.statusCode === 409) {
        logger.warn(
          `Attempting to gracefully recover from 409 Conflict response in createPr(${title}, ${sourceBranch})`
        );

        // Refresh cached PR list and search for pull request with matching information
        config.prList = null;
        const pr = await platform.findPr({
          branchName: sourceBranch,
          state: PrState.Open,
        });

        // If a valid PR was found, return and gracefully recover from the error. Otherwise, abort and throw error.
        if (pr) {
          if (pr.title !== title || pr.body !== body) {
            logger.debug(
              `Recovered from 409 Conflict, but PR for ${sourceBranch} is outdated. Updating...`
            );
            await platform.updatePr({
              number: pr.number,
              prTitle: title,
              prBody: body,
            });
            pr.title = title;
            pr.body = body;
          } else {
            logger.debug(
              `Recovered from 409 Conflict and PR for ${sourceBranch} is up-to-date`
            );
          }

          return pr;
        }
      }

      throw err;
    }
  },

  async updatePr({
    number,
    prTitle: title,
    prBody: body,
    state,
  }: UpdatePrConfig): Promise<void> {
    await helper.updatePR(config.repository, number, {
      title,
      ...(body && { body }),
      ...(state && { state }),
    });
  },

  async mergePr({ id }: MergePRConfig): Promise<boolean> {
    try {
      await helper.mergePR(config.repository, id, config.mergeMethod);
      return true;
    } catch (err) {
      logger.warn({ err, id }, 'Merging of PR failed');
      return false;
    }
  },

  getIssueList(): Promise<Issue[]> {
    if (config.issueList === null) {
      config.issueList = helper
        .searchIssues(config.repository, { state: 'all' }, { useCache: false })
        .then((issues) => {
          const issueList = issues.map(toRenovateIssue);
          logger.debug(`Retrieved ${issueList.length} Issues`);
          return issueList;
        });
    }

    return config.issueList;
  },

  async getIssue(number: number, useCache = true): Promise<Issue | null> {
    try {
      const body = (
        await helper.getIssue(config.repository, number, {
          useCache,
        })
      ).body;
      return {
        number,
        body,
      };
    } catch (err) /* istanbul ignore next */ {
      logger.debug({ err, number }, 'Error getting issue');
      return null;
    }
  },

  async findIssue(title: string): Promise<Issue | null> {
    const issueList = await platform.getIssueList();
    const issue = issueList.find(
      (i) => i.state === 'open' && i.title === title
    );

    if (!issue) {
      return null;
    }
    logger.debug(`Found Issue #${issue.number}`);
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
    return getIssue!(issue.number!);
  },

  async ensureIssue({
    title,
    reuseTitle,
    body: content,
    labels: labelNames,
    shouldReOpen,
    once,
  }: EnsureIssueConfig): Promise<'updated' | 'created' | null> {
    logger.debug(`ensureIssue(${title})`);
    try {
      const body = smartLinks(content);

      const issueList = await platform.getIssueList();
      let issues = issueList.filter((i) => i.title === title);
      if (!issues.length) {
        issues = issueList.filter((i) => i.title === reuseTitle);
      }

      const labels = Array.isArray(labelNames)
        ? (await Promise.all(labelNames.map(lookupLabelByName))).filter(
            is.number
          )
        : undefined;

      // Update any matching issues which currently exist
      if (issues.length) {
        let activeIssue = issues.find((i) => i.state === 'open');

        // If no active issue was found, decide if it shall be skipped, re-opened or updated without state change
        if (!activeIssue) {
          if (once) {
            logger.debug('Issue already closed - skipping update');
            return null;
          }
          if (shouldReOpen) {
            logger.debug('Reopening previously closed Issue');
          }

          // Pick the last issue in the list as the active one
          activeIssue = issues[issues.length - 1];
        }

        // Close any duplicate issues
        for (const issue of issues) {
          if (issue.state === 'open' && issue.number !== activeIssue.number) {
            logger.warn(`Closing duplicate Issue #${issue.number}`);
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
            await helper.closeIssue(config.repository, issue.number!);
          }
        }

        // Check if issue has already correct state
        if (
          activeIssue.title === title &&
          activeIssue.body === body &&
          activeIssue.state === 'open'
        ) {
          logger.debug(
            `Issue #${activeIssue.number} is open and up to date - nothing to do`
          );
          return null;
        }

        // Update issue body and re-open if enabled
        logger.debug(`Updating Issue #${activeIssue.number}`);
        const existingIssue = await helper.updateIssue(
          config.repository,
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
          activeIssue.number!,
          {
            body,
            title,
            state: shouldReOpen
              ? 'open'
              : (activeIssue.state as helper.IssueState),
          }
        );

        // Test whether the issues need to be updated
        const existingLabelIds = (existingIssue.labels ?? []).map(
          (label) => label.id
        );
        if (
          labels &&
          (labels.length !== existingLabelIds.length ||
            labels.filter((labelId) => !existingLabelIds.includes(labelId))
              .length !== 0)
        ) {
          await helper.updateIssueLabels(
            config.repository,
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
            activeIssue.number!,
            {
              labels,
            }
          );
        }

        return 'updated';
      }

      // Create new issue and reset cache
      const issue = await helper.createIssue(config.repository, {
        body,
        title,
        labels,
      });
      logger.debug(`Created new Issue #${issue.number}`);
      config.issueList = null;

      return 'created';
    } catch (err) {
      logger.warn({ err }, 'Could not ensure issue');
    }

    return null;
  },

  async ensureIssueClosing(title: string): Promise<void> {
    logger.debug(`ensureIssueClosing(${title})`);
    const issueList = await platform.getIssueList();
    for (const issue of issueList) {
      if (issue.state === 'open' && issue.title === title) {
        logger.debug({ number: issue.number }, 'Closing issue');
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
        await helper.closeIssue(config.repository, issue.number!);
      }
    }
  },

  async deleteLabel(issue: number, labelName: string): Promise<void> {
    logger.debug(`Deleting label ${labelName} from Issue #${issue}`);
    const label = await lookupLabelByName(labelName);
    if (label) {
      await helper.unassignLabel(config.repository, issue, label);
    } else {
      logger.warn({ issue, labelName }, 'Failed to lookup label for deletion');
    }
  },

  getRepoForceRebase(): Promise<boolean> {
    return Promise.resolve(false);
  },

  async ensureComment({
    number: issue,
    topic,
    content,
  }: EnsureCommentConfig): Promise<boolean> {
    try {
      let body = sanitize(content);
      const commentList = await helper.getComments(config.repository, issue);

      // Search comment by either topic or exact body
      let comment: helper.Comment | null = null;
      if (topic) {
        comment = findCommentByTopic(commentList, topic);
        body = `### ${topic}\n\n${body}`;
      } else {
        comment = findCommentByContent(commentList, body);
      }

      // Create a new comment if no match has been found, otherwise update if necessary
      if (!comment) {
        comment = await helper.createComment(config.repository, issue, body);
        logger.info(
          { repository: config.repository, issue, comment: comment.id },
          'Comment added'
        );
      } else if (comment.body === body) {
        logger.debug(`Comment #${comment.id} is already up-to-date`);
      } else {
        await helper.updateComment(config.repository, comment.id, body);
        logger.debug(
          { repository: config.repository, issue, comment: comment.id },
          'Comment updated'
        );
      }

      return true;
    } catch (err) {
      logger.warn({ err, issue, subject: topic }, 'Error ensuring comment');
      return false;
    }
  },

  async ensureCommentRemoval(
    deleteConfig: EnsureCommentRemovalConfig
  ): Promise<void> {
    const { number: issue } = deleteConfig;
    const key =
      deleteConfig.type === 'by-topic'
        ? deleteConfig.topic
        : deleteConfig.content;
    logger.debug(`Ensuring comment "${key}" in #${issue} is removed`);
    const commentList = await helper.getComments(config.repository, issue);

    let comment: helper.Comment | null = null;
    if (deleteConfig.type === 'by-topic') {
      comment = findCommentByTopic(commentList, deleteConfig.topic);
    } else if (deleteConfig.type === 'by-content') {
      const body = sanitize(deleteConfig.content);
      comment = findCommentByContent(commentList, body);
    }

    // Abort and do nothing if no matching comment was found
    if (!comment) {
      return;
    }

    // Attempt to delete comment
    try {
      await helper.deleteComment(config.repository, comment.id);
    } catch (err) {
      logger.warn(
        { err, issue, config: deleteConfig },
        'Error deleting comment'
      );
    }
  },

  async getBranchPr(branchName: string): Promise<Pr | null> {
    logger.debug(`getBranchPr(${branchName})`);
    const pr = await platform.findPr({ branchName, state: PrState.Open });
    return pr ? platform.getPr(pr.number) : null;
  },

  async addAssignees(number: number, assignees: string[]): Promise<void> {
    logger.debug(
      `Updating assignees '${assignees?.join(', ')}' on Issue #${number}`
    );
    await helper.updateIssue(config.repository, number, {
      assignees,
    });
  },

  async addReviewers(number: number, reviewers: string[]): Promise<void> {
    logger.debug(`Adding reviewers '${reviewers?.join(', ')}' to #${number}`);
    if (semver.lt(defaults.version, '1.14.0')) {
      logger.debug(
        { version: defaults.version },
        'Adding reviewer not yet supported.'
      );
      return;
    }
    try {
      await helper.requestPrReviewers(config.repository, number, { reviewers });
    } catch (err) {
      logger.warn({ err, number, reviewers }, 'Failed to assign reviewer');
    }
  },

  massageMarkdown(prBody: string): string {
    return smartTruncate(smartLinks(prBody), 1000000);
  },

  getVulnerabilityAlerts(): Promise<VulnerabilityAlert[]> {
    return Promise.resolve([]);
  },
};

// eslint-disable-next-line @typescript-eslint/unbound-method
export const {
  addAssignees,
  addReviewers,
  createPr,
  deleteLabel,
  ensureComment,
  ensureCommentRemoval,
  ensureIssue,
  ensureIssueClosing,
  findIssue,
  findPr,
  getBranchPr,
  getBranchStatus,
  getBranchStatusCheck,
  getIssue,
  getRawFile,
  getJsonFile,
  getIssueList,
  getPr,
  massageMarkdown,
  getPrList,
  getRepoForceRebase,
  getRepos,
  getVulnerabilityAlerts,
  initPlatform,
  initRepo,
  mergePr,
  setBranchStatus,
  updatePr,
} = platform;
