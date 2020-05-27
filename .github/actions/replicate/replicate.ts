import * as core from '@actions/core'
import * as github from '@actions/github'
import { WebhookPayload } from '@actions/github/lib/interfaces'
import { getIssueList, internalIssueAlreadyCreated, isUserAlreadyParticipant } from './issues'

export type Issue = {title: string, body: string, labels: string[]}
export const BOUNTY_LABELS: string[] = ['All For One', 'The Bug Slayer']
const COMMENT_TASK_LIST = `## Task List
- [ ] Initial assessment - Please record your decision in the comment below
  - [ ] CodeQL
  - [ ] Security Lab
- [ ] CodeQL: Generate result set and post the URL in the comment
- [ ] Security Lab assessment: 
  - [ ] Assess the Vulnerability Impact, the Vulnerability Scope, and the False Positive ratio based on the provided CodeQL result set
  - [ ] Provide feedback to the author in the PR
- [ ] CodeQL assessment:
  - [ ] Assess the Code Maturity and the Documentation
  - [ ] Provide feedback to the author in the PR
  - [ ] Merge the PR into the experimental folder
- [ ] Score - Both teams fill the score table according to the version of the PR merged into the repository
- [ ] Bounty Payment
`

const COMMENT_SCORING = `## Scoring
| Criterion | Score|
|--- | --- |
| Vulnerability Impact | | 
| Vulnerability Scope | | 
| False Positive | | 
| Code Maturity | | 
| Documentation | | 

- [ ] Reject
- [ ] Reject with thank you reward
- [ ] Reject with encouragement swag (Decision: Dev Advocacy)
- [ ] Accept
`

const COMMENT_FIRST_SUBMISSION = `## :tada: First submission for this user :tada:`

export const generateInternalIssueContentFromPayload = async (payload: WebhookPayload): Promise<Issue | undefined> => {
    const issue = payload.issue
    let result: Issue = {title: "none", body: "none", labels: []}
    let bountyIssue: boolean = false
    let bountyType = ''

    if(!issue || !issue.user || !issue.html_url) {
        core.debug("Invalid issue payload")
        return undefined
    }

    issue.labels.forEach((element:any) => {
        result.labels.push(element.name)
        if(!bountyIssue) {
            bountyIssue = BOUNTY_LABELS.includes(element.name)
            if(bountyIssue) {
                bountyType = element.name
            }
        }
    });

    if(!bountyIssue) {
        core.debug("Not a bounty")
        return undefined
    }

    result.title = `[${bountyType}] ${issue.title}`,
    // In order to differentiate immediately the issues from others in the repo
    // And with the current situation, the robot with Read access cannot add labels to the issue
    result.body = `Original external [issue](${issue.html_url})

Sumitted by [${issue.user.login}](${issue.user.html_url})

${issue.body? issue.body : ""}`

    return result
}

export const createInternalIssue = async (payload: WebhookPayload, issue: Issue) : Promise<number | undefined> => {
    const internalRepoAccessToken: string | undefined = process.env['INT_REPO_TOKEN']
    const token: string | undefined = process.env['GITHUB_TOKEN']
    let internal_ref: number | undefined = undefined

    if(!internalRepoAccessToken) {
        core.debug("No valid token for creating issues on the internal repo")
        return
    }
    try {
        const octokit: github.GitHub = new github.GitHub(internalRepoAccessToken)
        const internalRepo = core.getInput('internal_repo') || '/'
        const [owner, repo] = internalRepo.split('/')
        const issueResponse = await octokit.issues.create( {
            owner,
            repo,
            title: issue.title,
            body: issue.body,
            labels: issue.labels
        })        
        internal_ref = issueResponse.data.number
        core.debug(`issue created: ${internal_ref}`)

        const issueCommentResponse1 = await octokit.issues.createComment({
            owner,
            repo,
            issue_number: internal_ref,
            body: COMMENT_TASK_LIST,
        })
        core.debug(`comment created ${issueCommentResponse1.data.url}`)

        const issueCommentResponse2 = await octokit.issues.createComment({
            owner,
            repo,
            issue_number: internal_ref,
            body: COMMENT_SCORING,
        })
        core.debug(`comment created ${issueCommentResponse2.data.url}`)

        if(await isFirstSubmission(payload, token)) {
            const issueCommentResponse3 = await octokit.issues.createComment({
                owner,
                repo,
                issue_number: internal_ref,
                body: COMMENT_FIRST_SUBMISSION,
            })
            core.debug(`comment created ${issueCommentResponse3.data.url}`)
        }
    } catch(error) {
        core.debug(error.message)
    }
    return internal_ref
}

const commentOriginalIssue = async (payload: WebhookPayload, internal_issue: number): Promise<void> => {
    const repository = payload.repository
    const external_issue = payload.issue? payload.issue.number : 0
    const token: string | undefined = process.env['GITHUB_TOKEN']

    if(!token) {
        core.debug("No valid token for this repo")
        return
    }
    if(!repository || external_issue <=0) {
        core.debug("Invalid payload")
        return
    }
    try {
        const octokit: github.GitHub = new github.GitHub(token)
        const issueCommentResponseOriginal = await octokit.issues.createComment({
            owner: repository.owner.login,
            repo: repository.name,
            issue_number: external_issue,
            body: `Thanks for submitting this bounty :heart:!
            Your submission is tracked internally with the issue reference ${internal_issue}.`,
        })
        core.debug(`comment created ${issueCommentResponseOriginal.data.url}`)
    } catch (error) {
        core.debug(error.message)
    }
}

const checkDuplicates = async (payload: WebhookPayload): Promise<boolean> => {
    const internalRepoAccessToken: string | undefined = process.env['INT_REPO_TOKEN']
    const internalRepo = core.getInput('internal_repo') || '/'
    const [owner, repo] = internalRepo.split('/')
    const internalIssues = await getIssueList(owner, repo, internalRepoAccessToken, false)
    if(!internalIssues) {
        core.debug('Internal error. Cannot check for duplicates. Aborting')
            return true
    } else {
        const ref = internalIssueAlreadyCreated(payload.issue?.html_url, internalIssues)
        if(ref) {
            core.debug(`This issue has already been duplicated with reference ${ref}`)
            return true
        }
    }
    return false
}

export const isFirstSubmission = async (payload: WebhookPayload, token : string | undefined) : Promise<boolean> => {
    const repository = payload.repository
    if(!repository)
        return false
    const allSubmissions = await getIssueList(repository.owner.login, repository.name, token, false)
    return !isUserAlreadyParticipant(payload.issue?.user.login, allSubmissions)
}

const run = async (): Promise<void> => {
    const internalIssue = await generateInternalIssueContentFromPayload(github.context.payload)
    if(!internalIssue)
        return

    const existingIssue = core.getInput('existingIssue') || true
    if(existingIssue && await checkDuplicates(github.context.payload)) 
        return

    const internal_ref = await createInternalIssue(github.context.payload, internalIssue)
    if(!internal_ref)
        return
    
    if(!existingIssue) {
        commentOriginalIssue(github.context.payload, internal_ref)
    }
}

run()
