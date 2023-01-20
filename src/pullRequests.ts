import * as core from '@actions/core'
import {Octokit, RestEndpointMethodTypes} from '@octokit/rest'
import {Unpacked} from './utils'
import moment from 'moment'
import {Property, Sort} from './configuration'

export interface PullRequestInfo {
  number: number
  title: string
  htmlURL: string
  baseBranch: string
  branch?: string
  createdAt: moment.Moment
  mergedAt: moment.Moment | undefined
  mergeCommitSha: string
  author: string
  repoName: string
  labels: Set<string>
  milestone: string
  body: string
  assignees: string[]
  requestedReviewers: string[]
  approvedReviewers: string[]
  reviews?: ReviewInfo[]
  comments?: CommentInfo[]
  status: 'open' | 'merged'
}

export interface ReviewInfo {
  id: number
  htmlURL: string
  submittedAt: moment.Moment | undefined
  author: string
  body: string
  state: string | undefined
}

export interface CommentInfo {
  id: number
  htmlURL: string
  createdAt: moment.Moment | undefined
  author: string
  body: string
}

export const EMPTY_REVIEW_INFO: ReviewInfo = {
  id: 0,
  htmlURL: '',
  submittedAt: undefined,
  author: '',
  body: '',
  state: undefined
}

export const EMPTY_COMMENT_INFO: CommentInfo = {
  id: 0,
  htmlURL: '',
  createdAt: undefined,
  author: '',
  body: ''
}

type PullData = RestEndpointMethodTypes['pulls']['get']['response']['data']

type PullsListData = RestEndpointMethodTypes['pulls']['list']['response']['data']

type PullReviewData = RestEndpointMethodTypes['pulls']['listReviews']['response']['data']

type PullReviewsData = RestEndpointMethodTypes['pulls']['listReviews']['response']['data']

type PullCommentsData = RestEndpointMethodTypes['issues']['listComments']['response']['data']

export class PullRequests {
  constructor(private octokit: Octokit) {}

  async getSingle(owner: string, repo: string, prNumber: number): Promise<PullRequestInfo | null> {
    try {
      const {data} = await this.octokit.pulls.get({
        owner,
        repo,
        pull_number: prNumber
      })

      return mapPullRequest(data)
    } catch (e: any /* eslint-disable-line @typescript-eslint/no-explicit-any */) {
      core.warning(`⚠️ Cannot find PR ${owner}/${repo}#${prNumber} - ${e.message}`)
      return null
    }
  }

  async getBetweenDates(
    owner: string,
    repo: string,
    fromDate: moment.Moment,
    toDate: moment.Moment,
    maxPullRequests: number
  ): Promise<PullRequestInfo[]> {
    const mergedPRs: PullRequestInfo[] = []
    const options = this.octokit.pulls.list.endpoint.merge({
      owner,
      repo,
      state: 'closed',
      sort: 'merged',
      per_page: `${Math.min(100, maxPullRequests)}`,
      direction: 'desc'
    })

    for await (const response of this.octokit.paginate.iterator(options)) {
      const prs: PullsListData = response.data as PullsListData

      for (const pr of prs.filter(p => !!p.merged_at)) {
        mergedPRs.push(mapPullRequest(pr, 'merged'))
      }

      const firstPR = prs[0]
      if (
        firstPR === undefined ||
        (firstPR.merged_at && fromDate.isAfter(moment(firstPR.merged_at))) ||
        mergedPRs.length >= maxPullRequests
      ) {
        if (mergedPRs.length >= maxPullRequests) {
          core.warning(`⚠️ Reached 'maxPullRequests' count ${maxPullRequests}`)
        }

        // bail out early to not keep iterating on PRs super old
        return sortPrs(mergedPRs)
      }
    }

    return sortPrs(mergedPRs)
  }

  async getOpen(owner: string, repo: string, maxPullRequests: number): Promise<PullRequestInfo[]> {
    const openPrs: PullRequestInfo[] = []
    const options = this.octokit.pulls.list.endpoint.merge({
      owner,
      repo,
      state: 'open',
      sort: 'created',
      per_page: '100',
      direction: 'desc'
    })

    for await (const response of this.octokit.paginate.iterator(options)) {
      const prs: PullsListData = response.data as PullsListData

      for (const pr of prs) {
        openPrs.push(mapPullRequest(pr, 'open'))
      }

      const firstPR = prs[0]
      if (firstPR === undefined || openPrs.length >= maxPullRequests) {
        if (openPrs.length >= maxPullRequests) {
          core.warning(`⚠️ Reached 'maxPullRequests' count ${maxPullRequests}`)
        }

        // bail out early to not keep iterating on PRs super old
        return sortPrs(openPrs)
      }
    }

    return sortPrs(openPrs)
  }

  async getReviewers(owner: string, repo: string, pr: PullRequestInfo): Promise<void> {
    const options = this.octokit.pulls.listReviews.endpoint.merge({
      owner,
      repo,
      pull_number: pr.number
    })

    for await (const response of this.octokit.paginate.iterator(options)) {
      const reviews: PullReviewData = response.data as PullReviewData
      pr.approvedReviewers = reviews
        .filter(r => r.state === 'APPROVED')
        .map(r => r.user?.login)
        .filter(r => !!r) as string[]
    }
  }

  async getReviews(owner: string, repo: string, pr: PullRequestInfo): Promise<void> {
    const options = this.octokit.pulls.listReviews.endpoint.merge({
      owner,
      repo,
      pull_number: pr.number,
      sort: 'created',
      direction: 'desc'
    })
    const prReviews: ReviewInfo[] = []
    for await (const response of this.octokit.paginate.iterator(options)) {
      const comments: PullReviewsData = response.data as PullReviewsData

      for (const comment of comments) {
        prReviews.push(mapReview(comment))
      }
    }
    pr.reviews = prReviews
  }

  async getComments(owner: string, repo: string, pr: PullRequestInfo): Promise<void> {
    this.octokit.issues.listComments
    const options = this.octokit.issues.listComments.endpoint.merge({
      owner,
      repo,
      issue_number: pr.number,
      sort: 'created',
      direction: 'desc'
    })
    const prComments: CommentInfo[] = []
    for await (const response of this.octokit.paginate.iterator(options)) {
      const comments: PullCommentsData = response.data as PullCommentsData

      for (const comment of comments) {
        prComments.push(mapComment(comment))
      }
    }
    pr.comments = prComments
  }
}

function sortPrs(pullRequests: PullRequestInfo[]): PullRequestInfo[] {
  return sortPullRequests(pullRequests, {
    order: 'ASC',
    on_property: 'mergedAt'
  })
}

export function sortPullRequests(pullRequests: PullRequestInfo[], sort: Sort | string): PullRequestInfo[] {
  let sortConfig: Sort

  // legacy handling to support string sort config
  if (typeof sort === 'string') {
    let order: 'ASC' | 'DESC' = 'ASC'
    if (sort.toUpperCase() === 'DESC') order = 'DESC'
    sortConfig = {order, on_property: 'mergedAt'}
  } else {
    sortConfig = sort
  }

  if (sortConfig.order === 'ASC') {
    pullRequests.sort((a, b) => {
      return compare(a, b, sortConfig)
    })
  } else {
    pullRequests.sort((b, a) => {
      return compare(a, b, sortConfig)
    })
  }
  return pullRequests
}

export function compare(a: PullRequestInfo, b: PullRequestInfo, sort: Sort): number {
  if (sort.on_property === 'mergedAt') {
    const aa = a.mergedAt || a.createdAt
    const bb = b.mergedAt || b.createdAt
    if (aa.isBefore(bb)) {
      return -1
    } else if (bb.isBefore(aa)) {
      return 1
    }
    return 0
  } else {
    // only else for now `label`
    return a.title.localeCompare(b.title)
  }
}

/**
 * Helper function to retrieve a property from the PullRequestInfo
 */
export function retrieveProperty(pr: PullRequestInfo, property: Property, useCase: string): string {
  let value: string | Set<string> | string[] | undefined = pr[property]
  if (value === undefined) {
    core.warning(`⚠️ the provided property '${property}' for \`${useCase}\` is not valid. Fallback to 'body'`)
    value = pr['body']
  } else if (value instanceof Set) {
    value = Array.from(value).join(',') // join into single string
  } else if (Array.isArray(value)) {
    value = value.join(',') // join into single string
  }
  return value
}

// helper function to add a special open label to prs not merged.
function attachSpeciaLabels(status: 'open' | 'merged', labels: Set<string>): Set<string> {
  labels.add(`--rcba-${status}`)
  return labels
}

const mapPullRequest = (pr: PullData | Unpacked<PullsListData>, status: 'open' | 'merged' = 'open'): PullRequestInfo => ({
  number: pr.number,
  title: pr.title,
  htmlURL: pr.html_url,
  baseBranch: pr.base.ref,
  branch: pr.head.ref,
  createdAt: moment(pr.created_at),
  mergedAt: pr.merged_at ? moment(pr.merged_at) : undefined,
  mergeCommitSha: pr.merge_commit_sha || '',
  author: pr.user?.login || '',
  repoName: pr.base.repo.full_name,
  labels: attachSpeciaLabels(status, new Set(pr.labels?.map(lbl => lbl.name?.toLocaleLowerCase('en') || '') || [])),
  milestone: pr.milestone?.title || '',
  body: pr.body || '',
  assignees: pr.assignees?.map(asignee => asignee?.login || '') || [],
  requestedReviewers: pr.requested_reviewers?.map(reviewer => reviewer?.login || '') || [],
  approvedReviewers: [],
  reviews: undefined,
  status
})

const mapReview = (comment: Unpacked<PullReviewsData>): ReviewInfo => ({
  id: comment.id,
  htmlURL: comment.html_url,
  submittedAt: comment.submitted_at ? moment(comment.submitted_at) : undefined,
  author: comment.user?.login || '',
  body: comment.body,
  state: comment.state
})

const mapComment = (comment: Unpacked<PullCommentsData>): CommentInfo => ({
  id: comment.id,
  htmlURL: comment.html_url,
  createdAt: comment.created_at ? moment(comment.created_at) : undefined,
  author: comment.user?.login || '',
  body: comment.body || ''
})
